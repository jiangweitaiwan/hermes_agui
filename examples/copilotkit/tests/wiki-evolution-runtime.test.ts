import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApplication } from "../server/application";
import { WikiStore, namespaceKey } from "../server/graph/wiki-store";
import { WikiGraphProvider } from "../server/graph/provider";
import { WikiCompiler } from "../server/graph/compiler";

const finding = "Research finding: PostgreSQL write ahead logging provides durable database recovery after a crash.";
test.each(["standard", "delegation"])("%s run → durable queue → compiler → next thread → authorized B sharing smoke", async route => {
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(200).end(JSON.stringify({ depth: 0 })); return; }
    if (req.url?.endsWith("cancel")) { res.end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); received.push(input);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: finding },
      { type: "TEXT_MESSAGE_END", messageId: "answer" },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const root = mkdtempSync(join(realpathSync(tmpdir()), "evolution-runtime-"));
  const store = new WikiStore(root); const provider = new WikiGraphProvider(store);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  const bot = { agentUrl: `http://127.0.0.1:${address.port}/agent`, token: "upstream", memory: { key: "signing-secret", principal: "owner", projectId: "project" } };
  const app = createApplication({ a: bot, b: bot, c: { ...bot, memory: { ...bot.memory, projectId: "other" } } }, {
    graph: { provider, authorize: () => true }, delegation: { token: "internal", allow: { b: ["a"] } },
    evolution: { provider, pollMs: 60000, compiler: { async json(stage) {
      if (stage === "analysis") return { claims: [{ text: finding, quote: finding, certainty: "fact", conflict: false }] };
      if (stage === "generation") return { pages: [{ id: "recovery", title: "Recovery", type: "finding", tags: [], related: [], claims: [0] }] };
      return { claims: [0], conflict: false };
    } } },
  });
  const ns = { principal: "owner", projectId: "project", visibility: "bot_private" as const, botId: "a" };
  const run = async (id: string, query = "Research database recovery") => {
    const input = { threadId: randomUUID(), runId: randomUUID(), state: {}, tools: [], context: [], forwardedProps: {},
      messages: [{ id: randomUUID(), role: "user", content: query }] };
    const response = await app.runtime(new Request(`http://localhost/api/copilotkit/agent/${id}/run`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    }));
    expect(await response.text()).toContain("RUN_FINISHED");
    return input;
  };
  const context = () => JSON.parse(Buffer.from(received.at(-1).forwardedProps.runtimeMemory.payload, "base64url").toString()).context;
  try {
    await app.ready;
    if (route === "standard") {
      const initial = await run("a");
      const before = app.evolution!.sessions.metrics.accepted, upstreamRuns = received.length;
      const replay = await app.runtime(new Request("http://localhost/api/copilotkit/agent/a/connect", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(initial),
      }));
      expect(await replay.text()).toContain("RUN_FINISHED");
      expect(app.evolution!.sessions.metrics.accepted).toBe(before);
      expect(received.length).toBe(upstreamRuns);
    }
    else {
      const call = { sourceBotId: "b", targetBotId: "a", threadId: "parent", runId: "parent-run", toolCallId: "tool", task: "Research database recovery" };
      const request = () => app.delegation!.handle(new Request("http://localhost/internal/delegations", {
        method: "POST", headers: { Authorization: "Bearer upstream" }, body: JSON.stringify(call),
      }));
      expect(await (await request()).json()).toMatchObject({ status: "completed" });
      const n = received.length; await request(); expect(received.length).toBe(n);
    }
    const source = store.db.prepare("SELECT * FROM ingest_jobs").get()!;
    expect(source.state).toBe("pending"); // completion did not await the LLM
    await app.evolution!.tick();
    expect((await app.evolution!.queue.status(ns, String(source.id))).state).toBe("completed");
    const original = await run("a");
    expect(context().records.some((r: any) => r.content.includes(finding))).toBe(true);
    expect(received.at(-1).messages).toEqual(original.messages);
    await run("b"); expect(context().records).toEqual([]);
    const shareJob = await app.evolution!.sessions.share(ns, String(source.source));
    const shared = { ...ns, visibility: "project_shared" as const };
    await new WikiCompiler(app.evolution!.queue, app.evolution!.options.compiler).runNext(shared);
    expect((await app.evolution!.queue.status(shared, shareJob)).state).toBe("completed");
    await run("b"); expect(context().records.some((r: any) => r.content.includes(finding))).toBe(true);
    await run("c"); expect(context().records).toEqual([]);
    expect(store.read(store.active(namespaceKey(shared), "recovery")!).sources[0]).toMatchObject({ botId: "a" });
    await app.evolution!.revoke(ns, String(source.source));
    await run("b"); expect(context().records).toEqual([]);
  } finally {
    await app.close(); store.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});
