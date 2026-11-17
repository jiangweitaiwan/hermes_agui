import type { GraphHit } from "../graph-memory";
import { MemoryContextSchema, type MemoryContext } from "./types";
/** UTF-8 bytes upper-bound token count, including JSON metadata. */
export class ContextAssembler {
  constructor(readonly tokenBudget = 4096, readonly maxRecords = 20) {
    if (!Number.isInteger(tokenBudget) || tokenBudget < 32 || tokenBudget > 8192 ||
      !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 20) throw new Error("Invalid memory budget");
  }
  assemble(hits: GraphHit[]): MemoryContext {
    const v2 = hits.some(h => h.sources || "kind" in h.source);
    const records: Record<string, unknown>[] = [];
    const context = { version: v2 ? 2 : 1, records };
    const ids = new Set<string>(), contents = new Set<string>();
    for (const hit of hits) {
      if (ids.has(hit.recordId) || contents.has(hit.content)) continue;
      const record = { id: hit.recordId, content: hit.content, sourceBotId: hit.source.botId,
        visibility: hit.visibility, ...(v2 ? { sources: hit.sources ?? [hit.source] } :
          { sourceThreadId: "threadId" in hit.source ? hit.source.threadId : undefined }) };
      if (Buffer.byteLength(JSON.stringify({ ...context, records: [...context.records, record] })) > this.tokenBudget) continue;
      context.records.push(record); ids.add(hit.recordId); contents.add(hit.content);
      if (context.records.length === this.maxRecords) break;
    }
    return MemoryContextSchema.parse(context);
  }
}
