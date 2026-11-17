import type { GraphScope } from "../graph-memory";
import { MemoryRetriever } from "./retriever";
import { ContextAssembler } from "./assembler";
export class RuntimeMemoryManager {
  constructor(readonly retriever: MemoryRetriever, readonly assembler = new ContextAssembler()) {}
  async prepare(scope: GraphScope, query: string) {
    return this.assembler.assemble(await this.retriever.retrieve(scope, query));
  }
}
