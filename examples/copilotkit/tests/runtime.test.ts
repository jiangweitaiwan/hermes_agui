import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { createRuntimeHandler } from "../server/runtime";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

test("official Runtime reaches HttpAgent, pins credentials and removes only correlation metadata", async () => {
  let received: { headers: Record<string, unknown>; body: Record<string, unknown> } | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    received = { headers: req.headers, body: input };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "hello browser" },
      { type: "TEXT_MESSAGE_END", messageId: "answer" },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const handler = createRuntimeHandler({ agentUrl: `http://127.0.0.1:${address.port}/agent`, token: "host-token" });
  const info = await handler(new Request("http://localhost/api/copilotkit/info"));
  expect(info.status).toBe(200);
  expect(await info.text()).toContain("hermes");
  const input = {
    threadId: randomUUID(), runId: randomUUID(), state: {}, tools: [], context: [],
    messages: [{ id: randomUUID(), role: "user", content: "hello" }],
    forwardedProps: { __copilotkitRequestId: "correlation", unsupported: "preserved-for-Hermes-to-reject" },
  };
  const response = await handler(new Request("http://localhost/api/copilotkit/agent/hermes/run", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer browser-token", "X-Api-Key": "untrusted" },
    body: JSON.stringify(input),
  }));
  expect(response.status).toBe(200);
  const output = await response.text();
  expect(output).toContain("hello browser");
  expect(output).toContain("RUN_FINISHED");
  expect(output).not.toContain("host-token");
  expect(received?.headers.authorization).toBe("Bearer host-token");
  expect(received?.headers["x-api-key"]).toBeUndefined();
  expect(received?.body).toMatchObject({ ...input, forwardedProps: { unsupported: "preserved-for-Hermes-to-reject" } });
  expect(received?.body.forwardedProps).not.toHaveProperty("__copilotkitRequestId");
});
