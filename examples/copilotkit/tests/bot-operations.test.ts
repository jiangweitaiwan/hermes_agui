import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createApplication } from "../server/application";
import { matchesAck, type ManagementOperation, type ManagementAck } from "../server/bots/operations";
import { PostgresBotRegistry } from "../server/storage/bot-registry";

const databaseUrl = process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
test.skipIf(!databaseUrl)("ACK loss, process restart and stale acknowledgements converge without replacing newer intent", async () => {
  const identity = { ownerId: randomUUID(), principal: randomUUID(), projectId: "project" };
  const applied = new Map<string, ManagementAck>();
  let loseAck = true;
  const server = createServer(async (req, res) => {
    const id = req.url!.split("/")[3];
    if (req.method === "GET") {
      const ack = applied.get(id);
      res.writeHead(ack ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(ack)); return;
    }
    let body = ""; for await (const chunk of req) body += chunk;
    const operation: ManagementOperation = JSON.parse(body);
    expect(body).not.toMatch(/memoryKey|"token"/);
    const { spec, state } = operation;
    const ack = { id, principal: spec.principal, projectId: spec.projectId, ownerId: spec.ownerId!,
      desiredRevision: operation.desiredRevision, operationId: operation.operationId, specHash: operation.specHash, state };
    applied.set(id, ack);
    if (loseAck) { loseAck = false; req.socket.destroy(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(ack));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const settings = { postgres: { url: databaseUrl!, credentialSeed: "c".repeat(64) }, hostUrl: endpoint, hostToken: "manager-token",
    users: [{ ...identity, token: "owner-token" }], templates: [{ id: "native", name: "Native", harness: "hermes" as const,
      model: "mock", provider: "mock", skills: [], toolsets: ["memory"] }] };
  const open = () => createApplication({}, { management: settings });
  let app = open();
  try {
    await app.ready;
    const manager = app.management!.manager;
    await expect(manager.createBot({ name: "Research", harness: "hermes", templateId: "native", toolsets: ["memory"] }, identity)).rejects.toMatchObject({ status: 503 });
    const [unknown] = manager.listBots(identity);
    expect(unknown.status).toBe("provisioning");
    expect(applied.get(unknown.id)?.state).toBe("active");
    await app.close(); app = open(); await app.ready;
    expect(app.management!.manager.listBots(identity)[0].status).toBe("active");
    const registry = app.management!.manager.options.registry as PostgresBotRegistry;
    const currentOperation = async () => (await registry.operations()).find(operation => operation.spec.id === unknown.id)!;
    const first = await currentOperation();
    await app.management!.manager.updateBot(unknown.id, { name: "Updated" }, identity);
    const second = await currentOperation(); expect(BigInt(second.desiredRevision)).toBeGreaterThan(BigInt(first.desiredRevision));
    await app.management!.manager.updateBot(unknown.id, { name: "Updated" }, identity);
    expect((await currentOperation()).operationId).toBe(second.operationId);
    // An old successful response arrives after a new disable intent commits.
    const oldAck = applied.get(unknown.id)!;
    loseAck = true;
    await expect(app.management!.manager.deactivate(unknown.id, identity, false)).rejects.toMatchObject({ status: 503 });
    expect(app.management!.manager.listBots(identity)[0].status).toBe("disabled");
    expect(matchesAck(second, oldAck)).toBe(true);
    await registry.write(() => registry.acknowledge(second, oldAck));
    expect(registry.get(unknown.id)!.record.status).toBe("disabled");
    await app.management!.manager.reconcileNow();
    const third = await currentOperation(); expect(third.state).toBe("disabled");
    expect(applied.get(unknown.id)).toMatchObject({ desiredRevision: third.desiredRevision, state: "disabled" });
  } finally {
    await app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}, 30000);
