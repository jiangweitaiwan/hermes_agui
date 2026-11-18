import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { createApplication } from "../server/application";
import { PostgresThreadMappings } from "../server/storage/thread-mappings";

const database = process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
test.skipIf(!database)("PostgreSQL thread mappings survive Runtime replacement and preserve scope under contention", async () => {
  const scope = { projectId: randomUUID(), principal: "alice", botId: "a" };
  const first = new PostgresThreadMappings(database!);
  const second = new PostgresThreadMappings(database!);
  const browser = randomUUID();
  const hostThread = "legacy-host-id";
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const { threadId, runId } = JSON.parse(Buffer.concat(chunks).toString());
    received.push(threadId);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const type of ["RUN_STARTED", "RUN_FINISHED"]) {
      response.write(`data: ${JSON.stringify({ type, threadId, runId })}\n\n`);
    }
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing Host port");
  const bot = { agentUrl: `http://127.0.0.1:${address.port}/agent`, token: "host-test-token",
    memory: { principal: scope.principal, projectId: scope.projectId, key: "memory-test-key" } };
  const run = async (store?: PostgresThreadMappings, threadId = browser, expected = "RUN_FINISHED") => {
    const application = createApplication({ a: bot }, { threadMappings: store });
    try {
      await application.ready;
      const response = await application.runtime(new Request("http://localhost/api/copilotkit/agent/a/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: "user", content: "Hello" }], tools: [], context: [], forwardedProps: {}, state: {} }),
      }));
      const output = await response.text();
      expect(output).toContain(expected);
      if (expected === "RUN_FINISHED") expect(output).toContain(`"threadId":"${threadId}"`);
    } finally { await application.close(); }
  };

  try {
    await Promise.all([first.ready(), second.ready()]);
    const names = await Promise.all([first.resolve(scope, "racing", "one"), second.resolve(scope, "racing", "two")]);
    expect(names[0]).toBe(names[1]);
    for (const other of [{ ...scope, principal: "bob" }, { ...scope, botId: "b" }, { ...scope, projectId: "other" }]) {
      expect(await second.resolve(other, "racing", "separate")).toBe("separate");
    }
    await first.resolve(scope, browser, hostThread);
    await run(first);
    await run(second);
    const existing = randomUUID();
    await run(undefined, existing);
    await run(second, existing);
    const offline = new PostgresThreadMappings(database!);
    await offline.close();
    await run(offline, browser, "Runtime thread mapping unavailable");
    expect(received).toEqual([hostThread, hostThread, existing, existing]);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
