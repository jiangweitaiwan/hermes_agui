import { statSync } from "node:fs";
import { join } from "node:path";
import type { Visibility } from "../graph-memory";
import type { Namespace, Page } from "./types";
import { namespaceKey, safePath, type WikiStore } from "./wiki-store";
import { terms } from "./markdown";
import type { BrowserQuery } from "./browser-query";
import { pagination } from "./browser-query";
import { BotError } from "../bots/types";
import type { PageSummary, PageDetail, NetworkResult, StatsResult, HealthResult, JobsResult } from "./browser-types";

interface VisiblePage { ns: Namespace; key: string; revision: string; page: Page; summary: PageSummary }
const MAX_SCAN = 300, MAX_BYTES = 8 * 1024 * 1024;
/** All methods run synchronously inside the caller's SQLite snapshot. No model/encoder calls. */
export class GraphBrowser {
  private bytes = 0;
  private parsed = 0;
  private jobsPartial = false;
  private cache = new Map<string, VisiblePage | undefined>();
  private owners = new Map<string, { ns: Namespace; bot: string }>();
  readonly namespaces: Namespace[];
  readonly hasSources: boolean;
  readonly hasOrigins: boolean;
  constructor(readonly store: WikiStore, namespace: Omit<Namespace, "visibility">, readonly query: BrowserQuery,
    readonly retained: (ns: Namespace, bot: string) => boolean) {
    this.namespaces = (["bot_private", "project_shared"] as Visibility[])
      .filter(v => query.scope === "all" || query.scope === v).map(visibility => ({ ...namespace, visibility }));
    this.hasSources = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_sources'").get();
    this.hasOrigins = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_origins'").get();
  }
  private ownerAllowed(ns: Namespace, bot: string) {
    if (!this.retained(ns, bot)) return false;
    this.owners.set(`${namespaceKey(ns)}:${bot}`, { ns, bot });
    return true;
  }
  revalidate() {
    for (const { ns, bot } of this.owners.values()) {
      if (!this.retained(ns, bot)) throw new BotError(404, "Memory access changed");
    }
  }
  private sourceAllowed(ns: Namespace, source: Page["sources"][number]) {
    if ((ns.visibility === "bot_private" && source.botId !== ns.botId) || !this.ownerAllowed(ns, source.botId)) return false;
    const key = namespaceKey(ns);
    if ("kind" in source) return this.hasSources && !!this.store.db.prepare(`SELECT 1 FROM document_sources
      WHERE ns=? AND id=? AND version=? AND hash=? AND deleted=0`).get(key, source.sourceId, source.version, source.hash);
    if (!this.hasOrigins) return true; // Legacy session provenance is administrator-attested, as in WikiStore imports.
    const origin = this.store.db.prepare("SELECT source FROM session_origins WHERE ns=? AND provenance=?").get(key, JSON.stringify(source));
    return !origin || (this.hasSources && !!this.store.db.prepare("SELECT 1 FROM document_sources WHERE ns=? AND id=? AND deleted=0")
      .get(key, origin.source));
  }
  private read(ns: Namespace, id: string): VisiblePage | undefined {
    const cacheKey = `${ns.visibility}:${id}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const key = namespaceKey(ns), revision = this.store.active(key, id);
    if (!revision) return;
    // Test the immutable artifact size before parsing, including deployments with larger page limits.
    if (!/^[a-f0-9-]{36}$/.test(revision.revision)) throw new BotError(503, "Invalid active revision");
    const size = statSync(safePath(join(this.store.root, key, `${revision.revision}.md`))).size;
    if (this.parsed >= MAX_SCAN * 2 + 50 || this.bytes + size > MAX_BYTES) throw new BotError(503, "Browser work budget exceeded");
    const page = this.store.read(revision);
    this.bytes += Buffer.byteLength(JSON.stringify(page)); this.parsed++;
    if (this.bytes > MAX_BYTES) throw new BotError(503, "Browser work budget exceeded");
    if (!page.sources.every(source => this.sourceAllowed(ns, source))) { this.cache.set(cacheKey, undefined); return; }
    const result: VisiblePage = { ns, key, revision: revision.revision, page, summary: {
      id: `${ns.visibility}:${page.id}`, pageId: page.id, title: page.title, type: page.type,
      visibility: ns.visibility, verification: page.verification ?? "unverified",
    } };
    this.cache.set(cacheKey, result);
    return result;
  }
  private matches(row: VisiblePage) {
    const q = this.query;
    if (q.q) {
      const match = terms(q.q).map(t => `"${t.replaceAll('"', '""')}"`).join(" OR ");
      if (!match || !this.store.db.prepare("SELECT 1 FROM sections WHERE sections MATCH ? AND ns=? AND page=? LIMIT 1")
        .get(match, row.key, row.page.id)) return false;
    }
    return (!q.type || row.page.type === q.type) && (!q.verification || row.summary.verification === q.verification);
  }
  private candidates(after: string) {
    const q = this.query, tokens = q.q ? terms(q.q) : [];
    if (q.q && !tokens.length) return [];
    const match = tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    return this.namespaces.flatMap(ns => {
      const key = namespaceKey(ns), prefix = `${ns.visibility}:`;
      const sql = `SELECT p.page FROM pages p WHERE p.ns=? AND (? || p.page)>?
        ${q.q ? "AND p.page IN (SELECT page FROM sections WHERE sections MATCH ? AND ns=?)" : ""}
        ORDER BY p.page LIMIT ?`;
      return this.store.db.prepare(sql).all(key, prefix, after, ...(q.q ? [match, key] : []), MAX_SCAN + 1)
        .map(r => ({ ns, id: String(r.page), sort: prefix + r.page }));
    }).sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort))).slice(0, MAX_SCAN + 1);
  }
  list(binding: string, search = false) {
    const cursor = pagination(this.query, binding), candidates = this.candidates(cursor.after);
    const pages: (PageSummary & { snippet?: string })[] = [];
    let last = cursor.after, processed = 0;
    for (const candidate of candidates.slice(0, MAX_SCAN)) {
      const row = this.read(candidate.ns, candidate.id);
      last = candidate.sort; processed++;
      if (!row || !this.matches(row)) continue;
      const snippet = search ? this.snippet(row.page) : undefined;
      pages.push({ ...row.summary, ...(snippet === undefined ? {} : { snippet }) });
      if (pages.length >= this.query.limit) break;
    }
    return { pages, nextCursor: processed < candidates.length ? cursor.encode(last) : null,
      partial: processed < candidates.length };
  }
  private snippet(page: Page) {
    const tokens = terms(this.query.q ?? "");
    const text = page.sections.find(s => terms(s).some(t => tokens.includes(t))) ?? page.body;
    return [...text].slice(0, 320).join("");
  }
  detail(visibility: Visibility, id: string): PageDetail {
    const ns = this.namespaces.find(n => n.visibility === visibility);
    const row = ns && this.read(ns, id);
    if (!row) throw new BotError(404, "Unknown page");
    const related = row.page.links.map(target => this.read(ns!, target)).filter((r): r is VisiblePage => !!r).map(r => r.summary);
    return { ...row.summary, revisionId: row.revision, tags: row.page.tags, body: row.page.body,
      related, provenance: row.page.sources };
  }
  private corpus() {
    const candidates = this.candidates("");
    const rows = candidates.slice(0, MAX_SCAN).map(c => this.read(c.ns, c.id)).filter((r): r is VisiblePage => !!r);
    return { rows, partial: candidates.length > MAX_SCAN };
  }
  private edges(rows: VisiblePage[]) {
    const ids = new Set(rows.map(r => r.summary.id));
    const edges: { source: string; target: string }[] = [];
    for (const row of rows) {
      const localIds = rows.filter(r => r.key === row.key).map(r => r.page.id);
      const targets = this.store.db.prepare(`SELECT target FROM edges WHERE ns=? AND source=?
        AND target IN (${localIds.map(() => "?").join(",")}) ORDER BY target LIMIT 1501`)
        .all(row.key, row.page.id, ...localIds);
      for (const target of targets) {
        const edge = { source: row.summary.id, target: `${row.ns.visibility}:${target.target}` };
        if (ids.has(edge.target)) edges.push(edge);
        if (edges.length > 1500) return edges;
      }
    }
    return edges;
  }
  private edgeCount(rows: VisiblePage[]) {
    return this.namespaces.reduce((count, ns) => {
      const ids = rows.filter(r => r.ns.visibility === ns.visibility).map(r => r.page.id);
      if (!ids.length) return count;
      const placeholders = ids.map(() => "?").join(",");
      return count + Number(this.store.db.prepare(`SELECT count(*) AS n FROM edges WHERE ns=?
        AND source IN (${placeholders}) AND target IN (${placeholders})`).get(namespaceKey(ns), ...ids, ...ids)?.n ?? 0);
    }, 0);
  }

  stats(): StatsResult {
    const { rows, partial } = this.corpus();
    return { pages: rows.length, edges: this.edgeCount(rows),
      private: rows.filter(r => r.ns.visibility === "bot_private").length,
      shared: rows.filter(r => r.ns.visibility === "project_shared").length, partial };
  }
  network(binding: string): NetworkResult {
    const cursor = pagination(this.query, binding);
    const focused = this.query.pageId ? this.focus() : undefined;
    const candidates = focused ? focused.filter(c => Buffer.compare(Buffer.from(c.sort), Buffer.from(cursor.after)) > 0)
      : this.candidates(cursor.after);
    const rows: VisiblePage[] = [];
    let last = cursor.after, processed = 0;
    for (const c of candidates.slice(0, MAX_SCAN)) {
      const row = this.read(c.ns, c.id); processed++; last = c.sort;
      if (row && this.matches(row)) rows.push(row);
      if (rows.length === this.query.limit) break;
    }
    const edges = this.edges(rows), more = processed < candidates.length;
    return { nodes: rows.map(r => r.summary), edges: edges.slice(0, 1500),
      nextCursor: more ? cursor.encode(last) : null, truncated: more || (!!focused && focused.length > MAX_SCAN) || edges.length > 1500 };
  }
  private focus() {
    const ns = this.namespaces.find(n => n.visibility === this.query.visibility)!;
    const key = namespaceKey(ns), ids = new Set([this.query.pageId!]);
    let frontier = [...ids];
    for (let depth = 0; depth < this.query.depth; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (!this.read(ns, id)) continue;
        const edges = this.store.db.prepare(`SELECT target AS page FROM edges WHERE ns=? AND source=?
          UNION SELECT source AS page FROM edges WHERE ns=? AND target=? ORDER BY page LIMIT 301`).all(key, id, key, id);
        for (const edge of edges) {
          if (!ids.has(String(edge.page))) { ids.add(String(edge.page)); next.push(String(edge.page)); }
          if (ids.size >= MAX_SCAN + 1) break;
        }
        if (ids.size >= MAX_SCAN + 1) break;
      }
      frontier = next;
      if (ids.size >= MAX_SCAN + 1) break;
    }
    return [...ids].map(id => ({ ns, id, sort: `${ns.visibility}:${id}` })).sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  }
  private indexDrift(row: VisiblePage) {
    const sections = this.store.db.prepare("SELECT content,tokens FROM sections WHERE ns=? AND page=? ORDER BY CAST(ordinal AS INTEGER) LIMIT 129")
      .all(row.key, row.page.id);
    return sections.length !== row.page.sections.length || sections.some((s, i) => s.content !== row.page.sections[i] ||
      s.tokens !== terms(`${row.page.title} ${row.page.tags.join(" ")} ${row.page.sections[i]}`).join(" "));
  }
  health(): HealthResult {
    const corpus = this.corpus(), rows = corpus.rows, edges = this.edges(rows);
    const jobs = this.jobs().jobs;
    const partial = corpus.partial || edges.length > 1500 || this.jobsPartial;
    const ids = new Set(rows.map(r => r.summary.id));
    return { status: "ok", pages: rows.length, partial,
      brokenLinks: partial ? null : rows.reduce((n, r) => n + r.page.links.filter(t => !ids.has(`${r.ns.visibility}:${t}`)).length, 0),
      isolated: partial ? null : rows.filter(r => !edges.some(e => e.source === r.summary.id || e.target === r.summary.id)).length,
      conflicts: rows.filter(r => r.page.verification === "disputed").length, staleProvenance: 0, indexDrift: rows.filter(r => this.indexDrift(r)).length,
      pending: jobs.filter(j => j.state === "pending").length, failed: jobs.filter(j => j.state === "failed").length,
      lagMs: Math.max(0, ...jobs.filter(j => ["pending", "running"].includes(j.state) && j.createdAt != null)
        .map(j => Date.now() - j.createdAt!)) };
  }
  jobs(): JobsResult {
    const rows = this.namespaces.flatMap(ns => {
      const candidates = this.store.db.prepare(`SELECT j.id,j.state,t.created,j.source,j.ns FROM ingest_jobs j
      LEFT JOIN completion_times t ON t.job=j.id AND t.ns=j.ns WHERE j.ns=? ORDER BY COALESCE(t.created,0) DESC,j.id DESC LIMIT 50`)
      .all(namespaceKey(ns));
      if (candidates.length === 50) this.jobsPartial = true;
      return candidates.filter(job => {
        const owners = this.store.db.prepare("SELECT bot FROM source_owners WHERE ns=? AND source=?").all(job.ns, job.source);
        return owners.length > 0 && owners.every(owner => this.ownerAllowed(ns, String(owner.bot)));
      });
    });
    const states = new Set(["pending", "running", "completed", "failed", "cancelled"]);
    return { status: "ok", jobs: rows.filter(r => states.has(String(r.state)))
      .sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0) || String(b.id).localeCompare(String(a.id)))
      .slice(0, Math.min(this.query.limit, 50)).map(r => ({ id: String(r.id), state: String(r.state) as JobsResult["jobs"][number]["state"],
        ...(r.created == null ? {} : { createdAt: Number(r.created) }) })) };
  }
}
