import type { GraphEntry, GraphMemoryPort, GraphQuery, GraphQueryResult, GraphScope, GraphWriteResult } from "../graph-memory";
import { WikiStore } from "./wiki-store";
import { WikiRetriever } from "./retriever";
import type { WikiOptions } from "./types";

export class WikiGraphProvider implements GraphMemoryPort {
  readonly retriever: WikiRetriever;
  constructor(readonly store: WikiStore, timeoutMs = 2000) { this.retriever = new WikiRetriever(store, timeoutMs); }
  async query(scope: GraphScope, query: GraphQuery, signal: AbortSignal): Promise<GraphQueryResult> {
    try { return { status: "ok", hits: await this.retriever.query(scope, query, signal) }; }
    catch { return { status: "unavailable" }; }
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
    return new WikiGraphProvider(store, timeout);
  } catch {
    store?.close();
    return { query: async () => ({ status: "unavailable" }), write: async () => ({ status: "disabled" }), close() {} };
  }
}
