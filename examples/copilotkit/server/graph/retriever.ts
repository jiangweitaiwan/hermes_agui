import type { VectorIndex } from "./embedding";
import { performance } from "node:perf_hooks";
import type { GraphHit, GraphQuery, GraphScope } from "../graph-memory";
import { namespaceKey, WikiStore } from "./wiki-store";
import { terms } from "./markdown";

interface Section { ns: string; page: string; ordinal: number; content: string; score: number }
export class WikiRetriever {
  constructor(readonly store: WikiStore, readonly timeoutMs = 2000,
    readonly options: { vectors?: VectorIndex; rrfK?: number; seedLimit?: number; neighbors?: number } = {}) {
    for (const n of [options.rrfK ?? 60, options.seedLimit ?? 8, options.neighbors ?? 3]) {
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error("Invalid retrieval configuration");
    }
    if ((options.seedLimit ?? 8) < 1 || (options.rrfK ?? 60) < 1) throw new Error("Invalid retrieval configuration");
  }
  async query(scope: GraphScope, request: GraphQuery, signal: AbortSignal): Promise<GraphHit[]> {
    const deadline = performance.now() + this.timeoutMs;
    const check = () => { signal.throwIfAborted(); if (performance.now() >= deadline) throw new Error("Wiki query timeout"); };
    check();
    // Yield before synchronous, bounded SQLite work so an already scheduled abort can run.
    await new Promise<void>(resolve => setImmediate(resolve));
    check();
    const tokens = terms(request.text);
    if (!tokens.length) return [];
    const identity = { principal: scope.principal, projectId: scope.projectId, botId: scope.botId };
    const namespaces = [namespaceKey({ ...identity, visibility: "bot_private" }), namespaceKey({ ...identity, visibility: "project_shared" })];
    const match = tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    const score = tokens.map(() => "CASE WHEN instr(' ' || tokens || ' ', ?) > 0 THEN 1 ELSE 0 END").join(" + ");
    const parameters = tokens.map(t => ` ${t} `);
    // Score is lexical coverage inside each section, independent of other owners' corpora.
    const find = (ns: string, page?: string): Section[] => this.store.db.prepare(`SELECT ns,page,ordinal,content,
      (${score}) AS score FROM sections WHERE sections MATCH ? AND ns=? ${page ? "AND page=?" : ""}
      ORDER BY score DESC,page,CAST(ordinal AS INTEGER) LIMIT 64`)
      .all(...parameters, match, ns, ...(page ? [page] : [])) as unknown as Section[];
    const lexical = namespaces.flatMap(ns => find(ns)).sort(compare);
    const vectors = await this.options.vectors?.search(namespaces, request.text, signal) ?? [];
    check();
    const seeds = (vectors.length ? fuse(lexical, vectors, this.options.rrfK ?? 60) : lexical).slice(0, this.seedLimit());
    if (!seeds.length) return [];
    const candidates = new Map<string, Section>();
    const add = (row: Section) => {
      const key = `${row.ns}/${row.page}/${row.ordinal}`;
      if ((candidates.get(key)?.score ?? -1) < row.score) candidates.set(key, row);
    };
    seeds.forEach(add);
    for (const seed of seeds) {
      check();
      // Join to active pages: broken, cross-namespace and unpublished targets cannot expand.
      const edges = this.store.db.prepare(`SELECT e.target FROM edges e JOIN pages p ON p.ns=e.ns AND p.page=e.target
        WHERE e.ns=? AND e.source=? ORDER BY e.target LIMIT ?`).all(seed.ns, seed.page, this.options.neighbors ?? 3);
      for (const edge of edges) {
        const degree = Number(this.store.db.prepare("SELECT count(*) AS n FROM edges WHERE ns=? AND target=?").get(seed.ns, edge.target)?.n);
        const neighbors = this.neighbors(seed, String(edge.target), vectors.length > 0, find);
        for (const neighbor of neighbors) {
          // Hybrid seeds may bring a bounded linked paragraph; penalize highly connected hubs.
          add({ ...neighbor, score: neighbor.score * 0.8 / (1 + Math.log1p(degree)) });
        }
      }
    }
    const hits: GraphHit[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const row of [...candidates.values()].sort(compare)) {
      check();
      const revision = this.store.active(row.ns, row.page);
      if (!revision) continue;
      const page = this.store.read(revision);
      const content = page.sections[Number(row.ordinal)];
      if (!content || content !== row.content) throw new Error("Stale wiki index; reindex required");
      if (seen.has(content)) continue;
      seen.add(content);
      const hit: GraphHit = { recordId: `${revision.revision}:${row.ordinal}`, content,
        principal: scope.principal, projectId: scope.projectId,
        visibility: row.ns === namespaces[0] ? "bot_private" : "project_shared", source: page.sources[0], ...(page.sources.length > 1 || "kind" in page.sources[0] ? { sources: page.sources } : {}) };
      const size = Buffer.byteLength(JSON.stringify(hit));
      if (bytes + size > 65536) continue;
      hits.push(hit); bytes += size;
      if (hits.length === Math.min(request.limit, 50)) break;
    }
    check();
    return hits;
  }
  private seedLimit() { return this.options.seedLimit ?? 8; }
  private neighbors(seed: Section, page: string, hybrid: boolean, find: (ns: string, page: string) => Section[]) {
    if (!hybrid) return find(seed.ns, page).slice(0, 1);
    return this.store.db.prepare("SELECT ns,page,ordinal,content FROM sections WHERE ns=? AND page=? ORDER BY CAST(ordinal AS INTEGER) LIMIT 1")
      .all(seed.ns, page).map(r => ({ ...r, score: seed.score } as unknown as Section));
  }

}
function compare(a: Section, b: Section) {
  return b.score - a.score || a.ns.localeCompare(b.ns) || a.page.localeCompare(b.page) || Number(a.ordinal) - Number(b.ordinal);
}

function fuse(keyword: Section[], vector: Section[], k: number): Section[] {
  const rows = new Map<string, Section>();
  for (const list of [keyword, vector]) list.slice(0, 64).forEach((row, rank) => {
    const key = `${row.ns}/${row.page}/${row.ordinal}`;
    const old = rows.get(key);
    rows.set(key, { ...row, score: (old?.score ?? 0) + 1 / (k + rank + 1) });
  });
  return [...rows.values()].sort(compare);
}
