import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../server/application";
import type { DelegationSettings } from "../server/delegation";
import { PostgresThreadMappings } from "../server/storage/thread-mappings";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
  server.close(() => resolve()); server.closeAllConnections();
}))); });
async function setup(options: { depth?: number; mode?: string; timeout?: number; maxRecords?: number } = {}) {
  const runs: Record<string, unknown>[] = [], cancels: string[] = [];
  let notify!: () => void;
  const started = new Promise<void>(resolve => { notify = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url?.includes("/delegation/parent?")) { res.writeHead(200).end(JSON.stringify({ depth: options.depth ?? 0 })); return; }
    if (req.url?.endsWith("/cancel")) { cancels.push(req.url); res.writeHead(200).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); runs.push({ ...input, auth: req.headers.authorization, marker: req.headers["x-hermes-delegation"] });
    notify();
    if (options.mode === "busy") { res.writeHead(503).end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (options.mode === "slow") { res.write(": waiting\n\n"); return; }
    for (const event of [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: options.mode === "large" ? "x".repeat(32769) : "child answer" },
      options.mode === "error" ? { type: "RUN_ERROR" } : { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId,
        ...(options.mode === "human" ? { outcome: { type: "interrupt" } } : {}) },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  const url = `http://127.0.0.1:${address.port}`;
  const projectId = randomUUID();
  const withRuntime = (threadMappings?: PostgresThreadMappings, principal = "alice", project = projectId) => {
    const threadScope = { projectId: project, principal };
    const delegation: DelegationSettings = {
      token: "internal", allow: { a: ["b"], b: ["a"] }, timeoutMs: options.timeout ?? 2000, maxRecords: options.maxRecords,
    };
    const application = createApplication({ a: { agentUrl: `${url}/bots/a/agent`, token: "a-token", threadScope },
      b: { agentUrl: `${url}/bots/b/agent`, token: "b-token", threadScope } }, { delegation, threadMappings });
    return (value = call, token = "a-token", signal?: AbortSignal) => application.delegation!.handle(new Request(`${url}/internal/delegations`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(value), signal,
    }));
  };
  const call = { sourceBotId: "a", targetBotId: "b", threadId: "parent", runId: "root", toolCallId: "tool", task: "short task" };
  return { runs, cancels, call, request: withRuntime(), withRuntime, started };
}
test("directional authorization, independent child IDs, bounded result, and parent/tool dedup", async () => {
  const { request, call, runs } = await setup({ maxRecords: 1 });
  const result = await (await request()).json();
  expect(result).toMatchObject({ status: "completed", text: "child answer" });
  expect(result.threadId).not.toBe(call.threadId); expect(result.runId).not.toBe(call.runId);
  expect(runs[0]).toMatchObject({ auth: "Bearer b-token", marker: "internal", messages: [{ role: "user", content: call.task }] });
  expect(await (await request()).json()).toEqual(result); expect(runs).toHaveLength(1);
  expect(await (await request({ ...call, task: "changed" })).json()).toEqual({ status: "invalid_request" });
  expect((await request(call, "b-token")).status).toBe(403);
  expect((await request({ ...call, targetBotId: "a" })).status).toBe(403);
  expect(await (await request({ ...call, toolCallId: "next" })).json()).toEqual({ status: "capacity" });
});
test.each([["human", "human_required"], ["large", "result_too_large"], ["busy", "busy"], ["error", "failed"], ["slow", "timeout"]])(
  "%s returns terminal status and cooperatively cancels child", async (mode, status) => {
    const { request, cancels } = await setup({ mode, timeout: 2000 });
    expect(await (await request()).json()).toMatchObject({ status }); expect(cancels).toHaveLength(1);
  });
test("child depth and caller cancellation are enforced", async () => {
  const child = await setup({ depth: 1 });
  expect(await (await child.request()).json()).toEqual({ status: "depth_exceeded" }); expect(child.runs).toHaveLength(0);
  const pending = await setup({ mode: "slow" }); const controller = new AbortController(); controller.abort();
  expect(await (await pending.request(pending.call, "a-token", controller.signal)).json()).toEqual({ status: "cancelled" });
});

test("disconnect after child admission cancels its stream and execution", async () => {
  const fixture = await setup({ mode: "slow" });
  const controller = new AbortController();
  const result = fixture.request(fixture.call, "a-token", controller.signal);
  await fixture.started;
  controller.abort();
  expect(await (await result).json()).toMatchObject({ status: "cancelled" });
  expect(fixture.cancels).toHaveLength(1);
});

const database = process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
test.skipIf(!database)("delegation mapping admits one child across Runtimes and isolates authenticated scopes", async () => {
  const { call, runs, cancels, withRuntime } = await setup();
  const first = new PostgresThreadMappings(database!);
  const second = new PostgresThreadMappings(database!);
  try {
    await Promise.all([first.ready(true), second.ready(true)]);
    const requests = [withRuntime(first), withRuntime(second)];
    expect((await requests[0](call, "b-token")).status).toBe(403);
    const outcomes = await Promise.all(requests.map(async request => (await request()).json()));
    const completed = outcomes.find(outcome => outcome.status === "completed");
    expect(completed).toMatchObject({ status: "completed", text: "child answer" });
    const { text, ...ids } = completed;
    expect(outcomes).toContainEqual({ ...ids, status: "busy" });
    expect(runs).toHaveLength(1);

    const replacement = withRuntime(second);
    expect(await (await replacement()).json()).toEqual({ ...ids, status: "busy" });
    expect(await (await replacement({ ...call, task: "changed" })).json()).toEqual({ status: "invalid_request" });
    expect(await (await withRuntime(second, "bob")()).json()).toMatchObject({ status: "completed" });
    expect(await (await withRuntime(second, "alice", randomUUID())()).json()).toMatchObject({ status: "completed" });
    expect(new Set(runs.map(run => run.threadId)).size).toBe(3);

    const offline = new PostgresThreadMappings(database!);
    await offline.close();
    expect(await (await withRuntime(offline)({ ...call, toolCallId: "another-tool" })).json()).toEqual({ status: "failed" });
    expect(runs).toHaveLength(3);
    expect(cancels).toHaveLength(0);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
