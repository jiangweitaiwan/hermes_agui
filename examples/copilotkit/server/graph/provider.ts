import { performance } from "node:perf_hooks";
import { OpenAIEncoder, VectorIndex } from "./embedding";
import type { GraphEntry, GraphMemoryPort, GraphQuery, GraphQueryResult, GraphScope, GraphWriteResult } from "../graph-memory";
import { WikiStore, namespaceKey } from "./wiki-store";
import { WikiRetriever } from "./retriever";
import type { WikiOptions } from "./types";

export class WikiGraphProvider implements GraphMemoryPort {
  readonly retriever: WikiRetriever;
  beforeQuery?: () => void;
  readonly metrics = { queries: 0, hits: 0, errors: 0, totalMs: 0, lastMs: 0 };
  constructor(readonly store: WikiStore, timeoutMs = 2000, readonly retrieval: ConstructorParameters<typeof WikiRetriever>[2] = {}) {
    this.retriever = new WikiRetriever(store, timeoutMs, retrieval);
  }
  async query(scope: GraphScope, query: GraphQuery, signal: AbortSignal): Promise<GraphQueryResult> {
    const start = performance.now(); this.metrics.queries++;
    try {
      this.beforeQuery?.();
      const candidates = await this.retriever.query(scope, query, signal);
      // Recheck ACL/active pointers after awaiting an external encoder.
      this.beforeQuery?.();
      const hits = candidates.filter(hit => this.store.db.prepare("SELECT 1 FROM pages WHERE ns=? AND revision=?")
        .get(namespaceKey({ principal: scope.principal, projectId: scope.projectId, botId: scope.botId, visibility: hit.visibility }), hit.recordId.split(":")[0]));
      this.metrics.hits += hits.length;
      return { status: "ok", hits };
    } catch { this.metrics.errors++; return { status: "unavailable" }; }
    finally { this.metrics.lastMs = performance.now() - start; this.metrics.totalMs += this.metrics.lastMs; }
  }
  async write(_scope: GraphScope, _entry: GraphEntry, _signal: AbortSignal): Promise<GraphWriteResult> {
    return { status: "disabled" };
  }
  close() { this.store.close(); }
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
