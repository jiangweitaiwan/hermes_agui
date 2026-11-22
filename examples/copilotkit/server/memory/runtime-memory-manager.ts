import type { GraphScope } from "../graph-memory";
import { MemoryRetriever } from "./retriever";
import { ContextAssembler } from "./assembler";
import { V3Orchestrator } from "./v3-orchestrator";
export class RuntimeMemoryManager {
  constructor(readonly retriever: MemoryRetriever, readonly assembler = new ContextAssembler(), readonly v3 = new V3Orchestrator(retriever.graph)) {}
  async prepare(scope: GraphScope, query: string) {
    const context = await this.v3.prepare(scope, query, this.assembler);
    if (context) return context;
    return this.assembler.assemble(await this.retriever.retrieve(scope, query));
  }
}
