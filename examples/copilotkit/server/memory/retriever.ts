import type { createGraphMemory, GraphScope } from "../graph-memory";
export class MemoryRetriever {
  constructor(readonly graph: ReturnType<typeof createGraphMemory>) {}
  async retrieve(scope: GraphScope, query: string, signal?:AbortSignal) {
    const result = await this.graph.query(scope, { text: Buffer.from(query).subarray(0, 4093).toString("utf8"), limit: 50 },signal);
    if (result.status === "rejected") throw new Error(`Graph request rejected: ${result.reason}`);
    return result.status === "ok" ? result.hits : [];
  }
}
