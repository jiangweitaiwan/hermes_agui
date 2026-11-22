import type { VectorIndex } from "./embedding";
import { performance } from "node:perf_hooks";
import type { GraphHit, GraphQuery, GraphScope } from "../graph-memory";
import { namespaceKey, WikiStore } from "./wiki-store";
import { LocalRetrievalStore, type IndexedSection as Section, type RetrievalStore } from "./retrieval-store";
import { terms } from "./markdown";

export class WikiRetriever {
  readonly storage: RetrievalStore;
  constructor(store: WikiStore | RetrievalStore, readonly timeoutMs = 2000,
    readonly options: { vectors?: VectorIndex; rrfK?: number; seedLimit?: number; neighbors?: number } = {}) {
    this.storage = store instanceof WikiStore ? new LocalRetrievalStore(store) : store;
    for (const n of [options.rrfK ?? 60, options.seedLimit ?? 8, options.neighbors ?? 3]) {
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error("Invalid retrieval configuration");
    }
    if ((options.seedLimit ?? 8) < 1 || (options.rrfK ?? 60) < 1) throw new Error("Invalid retrieval configuration");
  }
  async query(scope: GraphScope, request: GraphQuery, signal: AbortSignal, subjectPages: {ns:string;page:string}[] = []): Promise<GraphHit[]> {
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
    const profiles = await this.profileSeeds(subjectPages,check);
    const lexical = [...profiles,...(await Promise.all(namespaces.map(ns => this.storage.lexical(ns, tokens)))).flat()].sort(compare);
    const vectors = await this.options.vectors?.search(namespaces, request.text, signal) ?? [];
    check();
    const seeds = (vectors.length ? fuse(lexical, vectors, this.options.rrfK ?? 60) : lexical).slice(0, this.seedLimit());
    if (!seeds.length) return [];
    const candidates = new Map<string, Section>();
    const add = (row: Section) => {
      const key = `${row.ns}/${row.page}/${row.revision}/${row.ordinal}`;
      if ((candidates.get(key)?.score ?? -1) < row.score) candidates.set(key, row);
    };
    seeds.forEach(add);
    for (const seed of seeds) {
      check();
      const edges = await this.storage.neighbors(seed.ns, seed.page, this.options.neighbors ?? 3);
      for (const { target, degree } of edges) {
        const neighbors = vectors.length > 0 ? await this.storage.firstSection(seed.ns, target, seed.score)
          : (await this.storage.lexical(seed.ns, tokens, target)).slice(0, 1);
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
      const active = await this.storage.activePage(row.ns, row.page, row.revision);
      if (!active) continue;
      const { page, revision } = active;
      const content = page.sections[Number(row.ordinal)];
      if (!content || content !== row.content) throw new Error("Stale wiki index; reindex required");
      if (seen.has(content)) continue;
      seen.add(content);
      const hit: GraphHit = { recordId: `${revision}:${row.ordinal}`, content,
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
  private async profileSeeds(subjectPages:{ns:string;page:string}[],check:()=>void) {
    const profiles:Section[]=[];
    for (const subject of subjectPages.slice(0,64)) {
      check();profiles.push(...await this.storage.firstSection(subject.ns,subject.page,2));
    }
    return profiles;
  }
  private seedLimit() { return this.options.seedLimit ?? 8; }

}
function compare(a: Section, b: Section) {
  return b.score - a.score || a.ns.localeCompare(b.ns) || a.page.localeCompare(b.page) || Number(a.ordinal) - Number(b.ordinal);
}

function fuse(keyword: Section[], vector: Section[], k: number): Section[] {
  const rows = new Map<string, Section>();
  for (const list of [keyword, vector]) list.slice(0, 64).forEach((row, rank) => {
    const key = `${row.ns}/${row.page}/${row.revision}/${row.ordinal}`;
    const old = rows.get(key);
    rows.set(key, { ...row, score: (old?.score ?? 0) + 1 / (k + rank + 1) });
  });
  return [...rows.values()].sort(compare);
}
