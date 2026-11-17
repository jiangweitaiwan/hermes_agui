import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApplication } from "../server/application";
import { WikiStore } from "../server/graph/wiki-store";
import { WikiGraphProvider } from "../server/graph/provider";

// Source provenance comes from an actually completed local stub AG-UI run.
test("wiki hits reach signed ordinary/delegated AG-UI runs without mutating original messages", async () => {
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(200).end(JSON.stringify({ depth: 0 })); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); received.push(input);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "database reference confirmed" },
      { type: "TEXT_MESSAGE_END", messageId: "answer" },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-runtime-"));
  const store = new WikiStore(root);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
  const bot = { agentUrl: `http://127.0.0.1:${address.port}/agent`, token: "upstream", memory: { key: "signing-secret", principal: "owner", projectId: "project" } };
  const app = createApplication({ a: bot, b: bot }, {
    graph: { provider: new WikiGraphProvider(store), authorize: () => true },
    delegation: { token: "internal", allow: { b: ["a"] } },
  });
  const run = async (runId: string) => {
    const input = { threadId: "source-thread", runId, state: {}, tools: [], context: [], forwardedProps: {},
      messages: [{ id: "message", role: "user", content: "database" }] };
    const original = structuredClone(input);
    const response = await app.runtime(new Request("http://localhost/api/copilotkit/agent/a/run", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    }));
    expect(await response.text()).toContain("RUN_FINISHED");
    expect(input).toEqual(original);
    expect(received.at(-1).messages).toEqual(input.messages);
    return received.at(-1);
  };
  try {
    const source = await run("source-run");
    store.import({ principal: "owner", projectId: "project", visibility: "bot_private", botId: "a" }, [{ expectedRevision: null,
      markdown: `---\nid: database\ntitle: Database\ntype: note\nsources:\n  - botId: a\n    threadId: ${source.threadId}\n    runId: ${source.runId}\ntags: []\nrelated: []\ncreated: 2026-11-17T00:00:00.000Z\nupdated: 2026-11-17T00:00:00.000Z\n---\ndatabase reference confirmed`,
    }]);
    const ordinary = await run("retrieval-run");
    const response = await app.delegation!.handle(new Request("http://localhost/internal/delegations", {
      method: "POST", headers: { Authorization: "Bearer upstream" }, body: JSON.stringify({ sourceBotId: "b", targetBotId: "a",
        threadId: "parent-thread", runId: "parent-run", toolCallId: "tool", task: "database" }),
    }));
    expect(await response.json()).toMatchObject({ status: "completed" });
    for (const actual of [ordinary, received.at(-1)]) {
      const signed = actual.forwardedProps.runtimeMemory;
      expect(signed.signature).toBe(createHmac("sha256", bot.memory.key).update(signed.payload).digest("hex"));
      const decoded = JSON.parse(Buffer.from(signed.payload, "base64url").toString());
      expect(decoded).toMatchObject({ botId: "a", threadId: actual.threadId, runId: actual.runId });
      expect(decoded.context.records).toEqual([expect.objectContaining({ content: "database reference confirmed", sourceBotId: "a", sourceThreadId: source.threadId })]);
      expect(actual.messages.every((m: any) => !JSON.stringify(m).includes("reference confirmed"))).toBe(true);
    }
  } finally {
    app.close(); store.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});
