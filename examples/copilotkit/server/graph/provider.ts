import { performance } from "node:perf_hooks";
import { OpenAIEncoder, VectorIndex } from "./embedding";
import type { GraphEntry, GraphMemoryPort, GraphQuery, GraphQueryResult, GraphScope, GraphWriteResult } from "../graph-memory";
import { PostgresWikiStore } from "./postgres-wiki-store";
import { GcsGraphObjects } from "./objects";
import { WikiStore, namespaceKey } from "./wiki-store";
import { WikiRetriever } from "./retriever";
import type { WikiOptions } from "./types";

export class WikiGraphProvider<T extends WikiStore | PostgresWikiStore = WikiStore> implements GraphMemoryPort {
  readonly retriever: WikiRetriever;
  beforeQuery?: () => void | Promise<void>;
  readonly metrics = { queries: 0, hits: 0, errors: 0, totalMs: 0, lastMs: 0 };
  constructor(readonly store: T, timeoutMs = 2000, readonly retrieval: ConstructorParameters<typeof WikiRetriever>[2] = {}) {
    this.retriever = new WikiRetriever(store, timeoutMs, retrieval);
  }
  async query(scope: GraphScope, query: GraphQuery, signal: AbortSignal): Promise<GraphQueryResult> {
    const start = performance.now(); this.metrics.queries++;
    try {
      await this.beforeQuery?.();
      const candidates = await this.retriever.query(scope, query, signal);
      // Recheck ACL/active pointers after awaiting an external encoder.
      await this.beforeQuery?.();
      const hits = [];
      for (const hit of candidates) {
        const ns = { principal: scope.principal, projectId: scope.projectId, botId: scope.botId, visibility: hit.visibility };
        if (!await this.store.validateRead(ns, hit.recordId.split(":")[0], true)) continue;
        hits.push(hit);
      }
      this.metrics.hits += hits.length;
      return { status: "ok", hits };
    } catch { this.metrics.errors++; return { status: "unavailable" }; }
    finally { this.metrics.lastMs = performance.now() - start; this.metrics.totalMs += this.metrics.lastMs; }
  }
  async write(_scope: GraphScope, _entry: GraphEntry, _signal: AbortSignal): Promise<GraphWriteResult> {
    return { status: "disabled" };
  }
  close() { return this.store.close(); }
}
export function loadWiki(options?: WikiOptions): (GraphMemoryPort & { close(): void }) | undefined {
  if (!options?.enabled) return undefined;
  if (!options.dataRoot) throw new Error("Wiki dataRoot required");
  const timeout = options.timeoutMs ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error("Invalid wiki timeout");
  let store: WikiStore | undefined;
  try {
    store = new WikiStore(options.dataRoot, options);
    store.cleanup();
    const encoder = options.embedding ? new OpenAIEncoder(options.embedding) : undefined;
    const vectors = encoder ? new VectorIndex(store, encoder, encoder.options.retries) : undefined;
    return new WikiGraphProvider(store, timeout, { ...options.retrieval, vectors });
  } catch {
    store?.close();
    return { query: async () => ({ status: "unavailable" }), write: async () => ({ status: "disabled" }), close() {} };
  }
}

/** Cloud startup is fail-fast and never opens wiki.sqlite or an application-local Markdown root. */
export async function loadDurableWiki(options?: WikiOptions) {
  if (!options?.enabled) return undefined;
  const timeout = options.timeoutMs ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error("Invalid wiki timeout");
  const objects = new GcsGraphObjects(process.env.AGUI_GCS_BUCKET ?? "");
  await objects.ready();
  const store = new PostgresWikiStore(process.env.AGUI_RUNTIME_DATABASE_URL ?? "", objects, options);
  try {
    await store.ready();
    const encoder = options.embedding ? new OpenAIEncoder(options.embedding) : undefined;
    const vectors = encoder ? new VectorIndex(store, encoder, encoder.options.retries) : undefined;
    return new WikiGraphProvider(store, timeout, { ...options.retrieval, vectors });
  } catch (error) { await store.close(); throw error; }
}
