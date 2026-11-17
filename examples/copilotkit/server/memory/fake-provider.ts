import type { GraphMemoryPort, GraphHit, GraphScope, GraphQuery } from "../graph-memory";
/** Read-only fixture provider; never learns or writes conversation data. */
export class FakeGraphProvider implements GraphMemoryPort {
  constructor(readonly hits: GraphHit[]) {}
  async query(scope: GraphScope, request: GraphQuery) {
    return { status: "ok" as const, hits: this.hits.filter(hit => hit.principal === scope.principal &&
      hit.projectId === scope.projectId && (hit.visibility === "project_shared" || hit.source.botId === scope.botId))
      .slice(0, request.limit) };
  }
  async write() { return { status: "disabled" as const }; }
}
