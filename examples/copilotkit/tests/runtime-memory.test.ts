import { expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { createGraphMemory, type GraphHit } from "../server/graph-memory";
import { ContextAssembler } from "../server/memory/assembler";
import { FakeGraphProvider } from "../server/memory/fake-provider";
import { MemoryRetriever } from "../server/memory/retriever";
import { RuntimeMemoryManager } from "../server/memory/runtime-memory-manager";
import { RuntimeMemoryMiddleware } from "../server/memory/middleware";

const identity = { principal: "owner", projectId: "alpha", botId: "researcher", threadId: "t", runId: "r" };
const hit = (recordId: string, visibility: GraphHit["visibility"] = "bot_private"): GraphHit => ({
  recordId, content: `Project Alpha 使用 PostgreSQL ${recordId}`, visibility, principal: "owner", projectId: "alpha",
  source: { botId: "researcher", threadId: "source", runId: "source-run" },
});
test("retrieval isolates bot/principal/project, shares authorized project data and deduplicates", async () => {
  const provider = new FakeGraphProvider([hit("private"), hit("shared", "project_shared"), hit("shared", "project_shared")]);
  const graph = createGraphMemory({ provider, authorize: () => true });
  const manager = new RuntimeMemoryManager(new MemoryRetriever(graph));
  const prepare = (changes = {}) => manager.prepare(graph.scope({ ...identity, ...changes }), "database?");
  expect((await prepare()).records.map(r => r.id)).toEqual(["private", "shared"]);
  expect((await prepare({ botId: "reviewer" })).records.map(r => r.id)).toEqual(["shared"]);
  expect((await prepare({ principal: "other" })).records).toEqual([]);
  expect((await prepare({ projectId: "other" })).records).toEqual([]);
  expect(new ContextAssembler(32).assemble([hit("large")]).records).toEqual([]);
});
test("disabled and timeout degrade, authorization rejection stops the run", async () => {
  for (const provider of [undefined, {
    query: async () => new Promise<never>(() => {}), write: async () => ({ status: "disabled" as const }),
  }]) {
    const graph = createGraphMemory({ provider, authorize: () => true, timeoutMs: 5 });
    const manager = new RuntimeMemoryManager(new MemoryRetriever(graph));
    expect((await manager.prepare(graph.scope(identity), "q")).records).toEqual([]);
  }
  const graph = createGraphMemory({ authorize: () => false });
  await expect(new RuntimeMemoryManager(new MemoryRetriever(graph)).prepare(graph.scope(identity), "q"))
    .rejects.toThrow("unauthorized");
});
test("each run produces a fresh bounded signed envelope with server-owned identity", async () => {
  const provider = new FakeGraphProvider([hit("first")]);
  const graph = createGraphMemory({ provider, authorize: () => true });
  const middleware = new RuntimeMemoryMiddleware(new RuntimeMemoryManager(new MemoryRetriever(graph)), graph.scope);
  const settings = { key: "secret", principal: "owner", projectId: "alpha" };
  const first = await middleware.prepare("researcher", settings, "thread-a", "run-a", "q");
  expect(first.signature).toBe(createHmac("sha256", settings.key).update(first.payload).digest("hex"));
  const decoded = JSON.parse(Buffer.from(first.payload, "base64url").toString());
  expect(decoded).toMatchObject({ botId: "researcher", threadId: "thread-a", runId: "run-a" });
  expect(decoded.context.records[0].content).toContain("PostgreSQL");
  provider.hits.splice(0);
  const second = await middleware.prepare("researcher", settings, "thread-b", "run-b", "q");
  expect(JSON.parse(Buffer.from(second.payload, "base64url").toString()).context.records).toEqual([]);
});
