import type { Visibility } from "../graph-memory";
import type { Namespace, Page } from "./types";
import { namespaceKey } from "./wiki-store";
import type { BrowserStore, BrowserRevision } from "./browser-store";
import { terms } from "./markdown";
import type { BrowserQuery } from "./browser-query";
import { pagination } from "./browser-query";
import { BotError } from "../bots/types";
import type { PageSummary, PageDetail, NetworkResult, StatsResult, HealthResult, JobsResult } from "./browser-types";

interface VisiblePage { ns: Namespace; key: string; revision: string; page: Page; summary: PageSummary }
const MAX_SCAN = 300, MAX_BYTES = 8 * 1024 * 1024;
/** Bounded immutable reads; revalidate pointers, provenance and ACL after every asynchronous assembly. */
export class GraphBrowser<R extends BrowserRevision> {
  private bytes = 0;
  private parsed = 0;
  private jobsPartial = false;
  private cache = new Map<string, VisiblePage | undefined>();
  private owners = new Map<string, { ns: Namespace; bot: string }>();
  readonly namespaces: Namespace[];
  constructor(readonly store: BrowserStore<R>, namespace: Omit<Namespace, "visibility">, readonly query: BrowserQuery,
    readonly retained: (ns: Namespace, bot: string) => boolean) {
    this.namespaces = (["bot_private", "project_shared"] as Visibility[])
      .filter(v => query.scope === "all" || query.scope === v).map(visibility => ({ ...namespace, visibility }));
  }
  private ownerAllowed(ns: Namespace, bot: string) {
    if (!this.retained(ns, bot)) return false;
    this.owners.set(`${namespaceKey(ns)}:${bot}`, { ns, bot });
    return true;
  }
  async revalidate() {
    for (const { ns, bot } of this.owners.values()) {
      if (!this.retained(ns, bot)) throw new BotError(404, "Memory access changed");
    }
    for (const row of this.cache.values()) {
      if (!row) continue;
      if (!await this.store.validateRead(row.ns, row.revision)) throw new BotError(503, "Memory revision or authorization changed");
    }
  }
  private async sourceAllowed(ns: Namespace, source: Page["sources"][number]) {
    return (ns.visibility !== "bot_private" || source.botId === ns.botId) && this.ownerAllowed(ns, source.botId) &&
      await this.store.sourceValid(namespaceKey(ns), source);
  }
  private async read(ns: Namespace, id: string): Promise<VisiblePage | undefined> {
    const cacheKey = `${ns.visibility}:${id}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const key = namespaceKey(ns), revision = await this.store.active(key, id);
    if (!revision) return;
    // Test the immutable artifact size before parsing, including deployments with larger page limits.
    if (!/^[a-f0-9-]{36}$/.test(revision.revision)) throw new BotError(503, "Invalid active revision");
    const size = await this.store.pageBytes(revision);
    if (this.parsed >= MAX_SCAN * 2 + 50 || this.bytes + size > MAX_BYTES) throw new BotError(503, "Browser work budget exceeded");
    const page = await this.store.read(revision);
    this.bytes += Buffer.byteLength(JSON.stringify(page)); this.parsed++;
    if (this.bytes > MAX_BYTES) throw new BotError(503, "Browser work budget exceeded");
    if (!(await Promise.all(page.sources.map(source => this.sourceAllowed(ns, source)))).every(Boolean)) { this.cache.set(cacheKey, undefined); return; }
    const result: VisiblePage = { ns, key, revision: revision.revision, page, summary: {
      id: `${ns.visibility}:${page.id}`, pageId: page.id, title: page.title, type: page.type,
      visibility: ns.visibility, verification: page.verification ?? "unverified",
    } };
    this.cache.set(cacheKey, result);
    return result;
  }
  private async matches(row: VisiblePage) {
    const q = this.query;
    if (q.q) {
      const tokens = terms(q.q);
      if (!tokens.length || !await this.store.matchesTokens(row.key, row.page.id, tokens)) return false;
    }
    return (!q.type || row.page.type === q.type) && (!q.verification || row.summary.verification === q.verification);
  }
  private async candidates(after: string) {
    const tokens = this.query.q ? terms(this.query.q) : [];
    if (this.query.q && !tokens.length) return [];
    const rows = await Promise.all(this.namespaces.map(async ns => {
      const prefix = `${ns.visibility}:`;
      return (await this.store.pageIds(namespaceKey(ns), prefix, after, tokens, MAX_SCAN + 1))
        .map(id => ({ ns, id, sort: prefix + id }));
    }));
    return rows.flat().sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort))).slice(0, MAX_SCAN + 1);
  }
  async list(binding: string, search = false) {
    const cursor = pagination(this.query, binding), candidates = await this.candidates(cursor.after);
    const pages: (PageSummary & { snippet?: string })[] = [];
    let last = cursor.after, processed = 0;
    for (const candidate of candidates.slice(0, MAX_SCAN)) {
      const row = await this.read(candidate.ns, candidate.id);
      last = candidate.sort; processed++;
      if (!row || !await this.matches(row)) continue;
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
  async detail(visibility: Visibility, id: string): Promise<PageDetail> {
    const ns = this.namespaces.find(n => n.visibility === visibility);
    const row = ns && await this.read(ns, id);
    if (!row) throw new BotError(404, "Unknown page");
    const related = (await Promise.all(row.page.links.map(target => this.read(ns!, target)))).filter((r): r is VisiblePage => !!r).map(r => r.summary);
    return { ...row.summary, revisionId: row.revision, tags: row.page.tags, body: row.page.body,
      related, provenance: row.page.sources };
  }
  private async readCandidates(candidates: { ns: Namespace; id: string }[]) {
    const rows = [];
    for (const c of candidates) rows.push(await this.read(c.ns, c.id));
    return rows;
  }
  private async corpus() {
    const candidates = await this.candidates("");
    const rows = (await this.readCandidates(candidates.slice(0, MAX_SCAN))).filter((r): r is VisiblePage => !!r);
    return { rows, partial: candidates.length > MAX_SCAN };
  }
  private async edges(rows: VisiblePage[]) {
    const ids = new Set(rows.map(r => r.summary.id));
    const edges: { source: string; target: string }[] = [];
    for (const row of rows) {
      for (const target of await this.store.linkedPages(row.key, row.page.id, false, 1501)) {
        const edge = { source: row.summary.id, target: `${row.ns.visibility}:${target}` };
        if (ids.has(edge.target)) edges.push(edge);
        if (edges.length > 1500) return edges;
      }
    }
    return edges;
  }
  async stats(): Promise<StatsResult> {
    const { rows, partial } = await this.corpus();
    return { pages: rows.length, edges: (await Promise.all(this.namespaces.map(ns => this.store.edgeCount(namespaceKey(ns),
      rows.filter(row => row.ns.visibility === ns.visibility).map(row => row.page.id))))).reduce((a, b) => a + b, 0),
      private: rows.filter(r => r.ns.visibility === "bot_private").length,
      shared: rows.filter(r => r.ns.visibility === "project_shared").length, partial };
  }
  async network(binding: string): Promise<NetworkResult> {
    const cursor = pagination(this.query, binding);
    const focused = this.query.pageId ? await this.focus() : undefined;
    const candidates = focused ? focused.filter(c => Buffer.compare(Buffer.from(c.sort), Buffer.from(cursor.after)) > 0)
      : await this.candidates(cursor.after);
    const rows: VisiblePage[] = [];
    let last = cursor.after, processed = 0;
    for (const c of candidates.slice(0, MAX_SCAN)) {
      const row = await this.read(c.ns, c.id); processed++; last = c.sort;
      if (row && await this.matches(row)) rows.push(row);
      if (rows.length === this.query.limit) break;
    }
    const edges = await this.edges(rows), more = processed < candidates.length;
    return { nodes: rows.map(r => r.summary), edges: edges.slice(0, 1500),
      nextCursor: more ? cursor.encode(last) : null, truncated: more || (!!focused && focused.length > MAX_SCAN) || edges.length > 1500 };
  }
  private async focus() {
    const ns = this.namespaces.find(n => n.visibility === this.query.visibility)!;
    const key = namespaceKey(ns), ids = new Set([this.query.pageId!]);
    let frontier = [...ids];
    for (let depth = 0; depth < this.query.depth; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (!await this.read(ns, id)) continue;
        const edges = await this.store.linkedPages(key, id, true, MAX_SCAN + 1);
        for (const page of edges) {
          if (!ids.has(page)) { ids.add(page); next.push(page); }
          if (ids.size >= MAX_SCAN + 1) break;
        }
        if (ids.size >= MAX_SCAN + 1) break;
      }
      frontier = next;
      if (ids.size >= MAX_SCAN + 1) break;
    }
    return [...ids].map(id => ({ ns, id, sort: `${ns.visibility}:${id}` })).sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  }
  private async indexDrift(row: VisiblePage) {
    const sections = await this.store.sectionIndex(row.key, row.page.id);
    return sections.length !== row.page.sections.length || sections.some((s, i) => s.content !== row.page.sections[i] ||
      s.tokens !== terms(`${row.page.title} ${row.page.tags.join(" ")} ${row.page.sections[i]}`).join(" "));
  }
  async health(): Promise<HealthResult> {
    const corpus = await this.corpus(), rows = corpus.rows, edges = await this.edges(rows);
    const jobs = (await this.jobs()).jobs;
    const partial = corpus.partial || edges.length > 1500 || this.jobsPartial;
    const ids = new Set(rows.map(r => r.summary.id));
    return { status: "ok", pages: rows.length, partial,
      brokenLinks: partial ? null : rows.reduce((n, r) => n + r.page.links.filter(t => !ids.has(`${r.ns.visibility}:${t}`)).length, 0),
      isolated: partial ? null : rows.filter(r => !edges.some(e => e.source === r.summary.id || e.target === r.summary.id)).length,
      conflicts: rows.filter(r => r.page.verification === "disputed").length, staleProvenance: 0, indexDrift: (await Promise.all(rows.map(r => this.indexDrift(r)))).filter(Boolean).length,
      pending: jobs.filter(j => j.state === "pending").length, failed: jobs.filter(j => j.state === "failed").length,
      lagMs: Math.max(0, ...jobs.filter(j => ["pending", "running"].includes(j.state) && j.createdAt != null)
        .map(j => Date.now() - j.createdAt!)) };
  }
  async jobs(): Promise<JobsResult> {
    const rows = (await Promise.all(this.namespaces.map(async ns => {
      const candidates = await this.store.browserJobs(namespaceKey(ns));
      if (candidates.length === 50) this.jobsPartial = true;
      return candidates.filter(job => job.owners.length > 0 && job.owners.every(bot => this.ownerAllowed(ns, bot)));
    }))).flat();
    const states = new Set(["pending", "running", "completed", "failed", "cancelled"]);
    return { status: "ok", jobs: rows.filter(r => states.has(String(r.state)))
      .sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0) || String(b.id).localeCompare(String(a.id)))
      .slice(0, Math.min(this.query.limit, 50)).map(r => ({ id: String(r.id), state: String(r.state) as JobsResult["jobs"][number]["state"],
        ...(r.created == null ? {} : { createdAt: Number(r.created) }) })) };
  }
}
