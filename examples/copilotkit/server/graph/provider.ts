import { chatClient, embeddingClient } from "../llm/client";
import { Storyteller } from "../memory/storyteller";
import { RetrievalConfig } from "./query-config";
import { QueryParser } from "./query-parser";
import { StructuredRetriever } from "./structured-retriever";
import { V2RetrievalStore } from "./v2-retrieval-store";
import { EdgeRetriever } from "./edge-retriever";
import { EdgeVectorIndex } from "./edge-embedding";
import { performance } from "node:perf_hooks";
import { VectorIndex } from "./embedding";
import type { GraphEntry, GraphMemoryPort, GraphQuery, GraphQueryResult, GraphScope, GraphWriteResult } from "../graph-memory";
import { PostgresWikiStore } from "./postgres-wiki-store";
import { GcsGraphObjects } from "./objects";
import { WikiStore, namespaceKey } from "./wiki-store";
import { WikiRetriever } from "./retriever";
import type { WikiOptions } from "./types";

export class WikiGraphProvider<T extends WikiStore | PostgresWikiStore = WikiStore> implements GraphMemoryPort {
  readonly retriever: WikiRetriever;
  readonly facts: V2RetrievalStore;
  readonly edgeRetriever: EdgeRetriever;
  readonly edgeVectors?: EdgeVectorIndex;
  structured?: StructuredRetriever;
  storyteller?: Storyteller;
  runtimeDeadlineMs?:number;
  beforeQuery?: () => void | Promise<void>;
  readonly metrics = { queries: 0, hits: 0, errors: 0, totalMs: 0, lastMs: 0 };
  constructor(readonly store: T, timeoutMs = 2000, readonly retrieval: ConstructorParameters<typeof WikiRetriever>[2] = {}) {
    this.retriever = new WikiRetriever(store, timeoutMs, retrieval);
    this.facts = new V2RetrievalStore(store);
    this.edgeVectors = retrieval.vectors ? new EdgeVectorIndex(this.facts,retrieval.vectors.encoder) : undefined;
    this.edgeRetriever = new EdgeRetriever(this.facts,this.edgeVectors);
  }
  async query(scope: GraphScope, query: GraphQuery, signal: AbortSignal): Promise<GraphQueryResult> {
    const start = performance.now(); this.metrics.queries++;
    try {
      await this.beforeQuery?.();
      const bounded = AbortSignal.any([signal,AbortSignal.timeout(this.retriever.timeoutMs)]);
      const subjectPages = [];
      for (const visibility of ["bot_private","project_shared"] as const) {
        const ns = {principal:scope.principal,projectId:scope.projectId,botId:scope.botId,visibility};
        if (!await this.facts.enabled(ns)) continue;
        for (const subject of await this.facts.subjects(ns,query.text)) subjectPages.push({ns:namespaceKey(ns),page:subject.wikiPageId});
      }
      const [edges,pages] = await Promise.all([this.edgeRetriever.query(scope,query,bounded),
        this.retriever.query(scope,query,bounded,subjectPages)]);
      const candidates = [...edges,...pages].slice(0,query.limit);
      // Recheck ACL/active pointers after awaiting an external encoder.
      await this.beforeQuery?.();
      const hits = [];
      let bytes = 0;
      for (const hit of candidates) {
        const ns = { principal: scope.principal, projectId: scope.projectId, botId: scope.botId, visibility: hit.visibility };
        if (hit.recordId.startsWith("fact:") ? !await this.edgeRetriever.validate(scope,hit)
          : !await this.store.validateRead(ns, hit.recordId.split(":")[0], true)) continue;
        const size = Buffer.byteLength(JSON.stringify(hit));
        if (bytes + size > 65536) continue;
        bytes += size; hits.push(hit);
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
  const config = RetrievalConfig.parse(options);
  const timeout = options.timeoutMs ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error("Invalid wiki timeout");
  let store: WikiStore | undefined;
  try {
    store = new WikiStore(options.dataRoot, options);
    store.cleanup();
    const encoder = options.embedding ? embeddingClient(options.embedding) : undefined;
    const vectors = encoder ? new VectorIndex(store, encoder, 1) : undefined;
    const provider = new WikiGraphProvider(store, timeout, { ...options.retrieval, vectors });
    provider.runtimeDeadlineMs=config.runtimeDeadlineMs;
    if(config.retrievalMode === "v3" && config.storyteller)provider.storyteller=new Storyteller(chatClient(config.storyteller),("registry" in config.storyteller ? undefined : config.storyteller.timeoutMs));
    if(config.retrievalMode === "v3")provider.structured = new StructuredRetriever(provider.facts,provider.retriever,
      new QueryParser(chatClient(config.queryParser!),("registry" in config.queryParser! ? undefined : config.queryParser!.timeoutMs)),
      encoder ? new EdgeVectorIndex(provider.facts,encoder,"v3"):undefined,()=>provider.beforeQuery?.());
    return provider;
  } catch {
    store?.close();
    return { query: async () => ({ status: "unavailable" }), write: async () => ({ status: "disabled" }), close() {} };
  }
}

/** Cloud startup is fail-fast and never opens wiki.sqlite or an application-local Markdown root. */
export async function loadDurableWiki(options?: WikiOptions) {
  if (!options?.enabled) return undefined;
  const config = RetrievalConfig.parse(options);
  const timeout = options.timeoutMs ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error("Invalid wiki timeout");
  const objects = new GcsGraphObjects(process.env.AGUI_GCS_BUCKET ?? "");
  await objects.ready();
  const store = new PostgresWikiStore(process.env.AGUI_RUNTIME_DATABASE_URL ?? "", objects, options);
  try {
    await store.ready();
    const encoder = options.embedding ? embeddingClient(options.embedding) : undefined;
    const vectors = encoder ? new VectorIndex(store, encoder, 1) : undefined;
    const provider = new WikiGraphProvider(store, timeout, { ...options.retrieval, vectors });
    provider.runtimeDeadlineMs=config.runtimeDeadlineMs;
    if(config.retrievalMode === "v3" && config.storyteller)provider.storyteller=new Storyteller(chatClient(config.storyteller),("registry" in config.storyteller ? undefined : config.storyteller.timeoutMs));
    if(config.retrievalMode === "v3")provider.structured = new StructuredRetriever(provider.facts,provider.retriever,
      new QueryParser(chatClient(config.queryParser!),("registry" in config.queryParser! ? undefined : config.queryParser!.timeoutMs)),
      encoder ? new EdgeVectorIndex(provider.facts,encoder,"v3"):undefined,()=>provider.beforeQuery?.());
    return provider;
  } catch (error) { await store.close(); throw error; }
}
