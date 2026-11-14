import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { DelegationCoordinator } from "../server/delegation";

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
  const coordinator = new DelegationCoordinator({ a: { agentUrl: `${url}/bots/a/agent`, token: "a-token" },
    b: { agentUrl: `${url}/bots/b/agent`, token: "b-token" } }, {
    token: "internal", allow: { a: ["b"], b: ["a"] }, timeoutMs: options.timeout ?? 2000, maxRecords: options.maxRecords,
  });
  const call = { sourceBotId: "a", targetBotId: "b", threadId: "parent", runId: "root", toolCallId: "tool", task: "short task" };
  const request = (value = call, token = "a-token", signal?: AbortSignal) => coordinator.handle(new Request(`${url}/internal/delegations`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(value), signal,
  }));
  return { runs, cancels, call, request, started };
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
