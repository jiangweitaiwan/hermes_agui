import { expect, test } from "vitest";
import { createApplication } from "../server/application";
import { createGraphMemory, type GraphMemoryPort, type GraphHit, type GraphScope, type GraphEntry } from "../server/graph-memory";

const identity = (botId = "researcher", projectId = "p") => ({ principal: "owner", botId, projectId, threadId: "t", runId: "r" });
const entry = (scope: GraphScope, visibility: GraphEntry["visibility"] = "bot_private"): GraphEntry => ({
  content: "graph fact", visibility, idempotencyKey: visibility,
  source: { botId: scope.botId, threadId: scope.threadId, runId: scope.runId },
});
class MemoryProvider implements GraphMemoryPort {
  records = new Map<string, GraphHit>();
  async query(scope: GraphScope, request: { text: string; limit: number }) {
    return { status: "ok" as const, hits: [...this.records.values()].filter(hit =>
      hit.principal === scope.principal && hit.projectId === scope.projectId &&
      (hit.visibility === "project_shared" || hit.source.botId === scope.botId) &&
      hit.content.includes(request.text)).slice(0, request.limit) };
  }
  async write(scope: GraphScope, value: GraphEntry) {
    const recordId = JSON.stringify([scope.principal, scope.projectId, scope.botId, value.idempotencyKey]);
    if (!this.records.has(recordId)) this.records.set(recordId, { ...value, recordId,
      principal: scope.principal, projectId: scope.projectId });
    return { status: "accepted" as const, recordId };
  }
}
test("disabled graph validates trusted scopes and input before reporting disabled", async () => {
  const graph = createGraphMemory({ authorize: scope => scope.principal === "owner" });
  const scope = graph.scope(identity());
  expect(await graph.query(scope, { text: "q", limit: 5 })).toEqual({ status: "disabled" });
  expect(await graph.write(scope, entry(scope))).toEqual({ status: "disabled" });
  expect(await graph.query({ ...scope }, { text: "q", limit: 5 })).toMatchObject({ status: "rejected", reason: "unauthorized" });
  expect(await graph.query(scope, { text: "q", limit: 51 })).toMatchObject({ status: "rejected", reason: "invalid_request" });
  expect(await graph.write(scope, { ...entry(scope), content: "x".repeat(16385) })).toMatchObject({ status: "rejected" });
  expect(await graph.write(scope, { ...entry(scope), source: { botId: "other", threadId: "t", runId: "r" } })).toMatchObject({ status: "rejected" });
  expect(await graph.query(graph.scope({ ...identity(), principal: "outsider" }), { text: "q", limit: 1 })).toMatchObject({ reason: "unauthorized" });
});
test("injected provider preserves provenance, idempotency and bot/project visibility", async () => {
  const provider = new MemoryProvider();
  const graph = createGraphMemory({ provider, authorize: () => true });
  const a = graph.scope(identity()), b = graph.scope(identity("reviewer")), other = graph.scope(identity("reviewer", "other"));
  const accepted = await graph.write(a, entry(a));
  expect(await graph.write(a, entry(a))).toEqual(accepted);
  await graph.write(a, entry(a, "project_shared"));
  expect(provider.records.size).toBe(2);
  expect(await graph.query(a, { text: "graph", limit: 5 })).toMatchObject({ status: "ok", hits: [{ source: { botId: "researcher" } }, {}] });
  expect(await graph.query(b, { text: "graph", limit: 5 })).toMatchObject({ status: "ok", hits: [{ visibility: "project_shared" }] });
  expect(await graph.query(other, { text: "graph", limit: 5 })).toEqual({ status: "ok", hits: [] });
  expect(await graph.query(a, { text: "absent", limit: 5 })).toEqual({ status: "ok", hits: [] });
});
test("boundary rejects provider leaks and bounds provider failures and timeout", async () => {
  const memory = new MemoryProvider();
  await memory.write(identity("other", "foreign"), entry(identity("other", "foreign")));
  const graph = createGraphMemory({ authorize: () => true, provider: {
    query: async () => ({ status: "ok", hits: [...memory.records.values()] }), write: async () => { throw new Error("secret"); },
  } });
  const scope = graph.scope(identity());
  expect(await graph.query(scope, { text: "q", limit: 1 })).toEqual({ status: "rejected", reason: "unauthorized" });
  expect(await graph.write(scope, entry(scope))).toEqual({ status: "unavailable" });
  let signal: AbortSignal | undefined;
  const slow = createGraphMemory({ authorize: () => true, timeoutMs: 5, provider: {
    query: async (_scope, _request, abort) => { signal = abort; return new Promise(() => {}); },
    write: async () => ({ status: "rejected", reason: "unauthorized" }),
  } });
  const s = slow.scope(identity());
  expect(await slow.query(s, { text: "q", limit: 1 })).toEqual({ status: "unavailable" });
  expect(signal?.aborted).toBe(true);
  expect(await slow.write(s, entry(s))).toEqual({ status: "rejected", reason: "unauthorized" });
});

test("application composition defaults to disabled and accepts an injected provider", async () => {
  const bots = { researcher: { agentUrl: "http://127.0.0.1:8000/agent", token: "secret" } };
  const application = createApplication(bots);
  const scope = application.graph.scope({ ...identity(), principal: "local-owner" });
  expect(await application.graph.query(scope, { text: "q", limit: 1 })).toEqual({ status: "disabled" });
  const injected = createApplication(bots, { graph: { provider: new MemoryProvider(), authorize: () => true } });
  const s = injected.graph.scope({ ...identity(), principal: "local-owner" });
  expect(await injected.graph.write(s, entry(s))).toMatchObject({ status: "accepted" });
  expect(await injected.graph.query(s, { text: "graph", limit: 1 })).toMatchObject({ status: "ok", hits: [{}] });
});
