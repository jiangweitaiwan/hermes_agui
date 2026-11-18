import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../server/application";
import { BotRegistry } from "../server/bots/registry";
import { BotManager } from "../server/bots/manager";
import { BotError, type HostSpec } from "../server/bots/types";
import { BotAuthentication } from "../server/bots/auth";
import { createBotApi } from "../server/bots/api";
import type { RuntimeSettings } from "../server/runtime";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); });
const identity = { ownerId: "owner", principal: "owner", projectId: "alpha" };
const input = { name: "Researcher", description: "Research", harness: "hermes", templateId: "native", toolsets: ["memory"] };
function fixture(maxBotsPerOwner = 32) {
  const root = mkdtempSync(join(tmpdir(), "hermes-bot-manager-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const filename = join(root, "registry.db"), registry = new BotRegistry(filename);
  cleanup.push(() => registry.close());
  const bots: Record<string, RuntimeSettings> = {}, allow: Record<string, string[]> = {};
  const calls: HostSpec[] = [];
  let failure = false, busy = false;
  const host = {
    async register(spec: HostSpec) { if (failure) throw new BotError(503, "offline"); calls.push(spec); },
    async disable() { if (failure) throw new BotError(503, "offline"); if (busy) throw new BotError(409, "busy"); },
    async delete() { if (busy) throw new BotError(409, "busy"); },
  };
  const options = { registry, host, maxBotsPerOwner, agentUrl: (id: string) => `http://127.0.0.1/bots/${id}/agent`,
    templates: [{ id: "native", name: "Native", harness: "hermes" as const, model: "model", provider: "custom",
      skills: ["research"], toolsets: ["memory"] }] };
  const manager = new BotManager(options, bots, allow);
  return { manager, options, registry, filename, bots, allow, calls, fail: (value: boolean) => { failure = value; },
    busy: (value: boolean) => { busy = value; } };
}
test("create, update, disable, restore, enable and soft delete preserve identity and hide credentials", async () => {
  const f = fixture();
  const bot = await f.manager.createBot(input, identity);
  expect(bot.status).toBe("active");
  expect(JSON.stringify(bot)).not.toContain(f.calls[0].token);
  expect(f.bots[bot.id].memory).toMatchObject({ principal: "owner", projectId: "alpha" });
  await f.manager.updateBot(bot.id, { name: "Updated", skills: ["research"] }, identity);
  expect(f.calls[1].skills).toEqual(["research"]);
  f.busy(true);
  await expect(f.manager.deactivate(bot.id, identity, false)).rejects.toMatchObject({ status: 409 });
  expect(f.bots[bot.id]).toBeDefined();
  f.busy(false);
  await f.manager.deactivate(bot.id, identity, false);
  expect(f.bots[bot.id]).toBeUndefined();
  const reopened = new BotRegistry(f.filename);
  cleanup.push(() => reopened.close());
  const restarted = new BotManager({ ...f.options, registry: reopened }, {}, {});
  await restarted.restore();
  expect(restarted.listBots(identity)[0]).toMatchObject({ id: bot.id, status: "disabled", name: "Updated" });
  await restarted.enableBot(bot.id, identity);
  expect(f.calls.at(-1)?.token).toBe(f.calls[0].token);
  await restarted.deactivate(bot.id, identity, true);
  expect(restarted.listBots(identity)).toEqual([]);
  expect(reopened.get(bot.id)?.record.deletedAt).toBeDefined();
  await expect(restarted.enableBot(bot.id, identity)).rejects.toMatchObject({ status: 404 });
});
test("quota, ownership, allowlists, failures and retries fail closed", async () => {
  const f = fixture(1);
  f.fail(true);
  await expect(f.manager.createBot(input, identity)).rejects.toMatchObject({ status: 503 });
  const failed = f.manager.listBots(identity)[0];
  expect(failed.status).toBe("failed");
  expect(f.bots[failed.id]).toBeUndefined();
  await expect(f.manager.createBot(input, identity)).rejects.toMatchObject({ status: 409 });
  f.fail(false);
  await f.manager.enableBot(failed.id, identity);
  expect(() => f.manager.owned(failed.id, { ...identity, ownerId: "other" })).toThrow("Unknown Bot");
  expect(() => f.manager.owned(failed.id, { ...identity, projectId: "other" })).toThrow("Unknown Bot");
  for (const patch of [{ home: "/etc" }, { ownerId: "other" }, { endpoint: "http://evil" },
    { toolsets: ["terminal"] }, { templateId: "unknown" }, { delegationTargets: ["unknown"] }]) {
    await expect(f.manager.updateBot(failed.id, patch, identity)).rejects.toBeInstanceOf(BotError);
  }
  expect(f.calls).toHaveLength(1);
});
test("API authenticates, scopes listings, prevents CSRF and supplies HttpOnly sessions", async () => {
  const f = fixture();
  const auth = new BotAuthentication([{ ...identity, token: "owner-token" },
    { ownerId: "other", principal: "other", projectId: "alpha", token: "other-token" }]);
  const api = createBotApi(f.manager, auth);
  const request = (path: string, method = "GET", body?: unknown, headers = {}) => api(new Request(`http://local${path}`, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  expect((await request("/api/bots")).status).toBe(401);
  const login = await request("/api/bot-session", "POST", { token: "owner-token" });
  expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0] };
  const created = await request("/api/bots", "POST", input, headers);
  expect(created.status).toBe(201);
  const bot = await created.json();
  expect((await request(`/api/bots/${bot.id}`, "GET", undefined, { Authorization: "Bearer other-token" })).status).toBe(404);
  expect(await (await request("/api/bots", "GET", undefined, { Authorization: "Bearer other-token" })).json()).toEqual([]);
  expect((await request(`/api/bots/${bot.id}`, "DELETE", undefined, { ...headers, Origin: "http://evil" })).status).toBe(403);
  expect((await request(`/api/bots/${bot.id}`, "DELETE", undefined, headers)).status).toBe(204);
});

test("an offline Host cannot reopen a durably disabled Bot during restore", async () => {
  const f = fixture();
  const bot = await f.manager.createBot(input, identity);
  f.fail(true);
  await expect(f.manager.deactivate(bot.id, identity, false)).rejects.toMatchObject({ status: 503 });
  expect(f.registry.get(bot.id)?.record.status).toBe("disabled");
  expect(f.bots[bot.id]).toBeUndefined();
  await f.manager.restore();
  expect(f.bots[bot.id]).toBeUndefined();
  f.fail(false);
  await f.manager.enableBot(bot.id, identity);
  expect(f.bots[bot.id]).toBeDefined();
});

const databaseUrl = process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
test.skipIf(!databaseUrl)("PostgreSQL registry persists Bot metadata, serializes quota, and restores credentials", async () => {
  const { PostgresBotRegistry } = await import("../server/storage/bot-registry");
  const { Pool } = await import("pg");
  const f = fixture(1);
  const pool = new Pool({ connectionString: databaseUrl });
  const seed = "56".repeat(32);
  const open = () => new PostgresBotRegistry(databaseUrl!, seed, f.options.templates, [identity], f.options.agentUrl);
  const first = open(), second = open();
  try {
    const a = new BotManager({ ...f.options, registry: first }, {}, {});
    const published: Record<string, RuntimeSettings> = {};
    const b = new BotManager({ ...f.options, registry: second }, published, {});
    const both = await Promise.allSettled([a.createBot(input, identity), b.createBot(input, identity)]);
    expect(both.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(both.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    await b.sync();
    const [record] = b.listBots(identity);
    expect(record).toMatchObject({ status: "active", name: input.name });
    expect(published[record.id].token).toBe(f.calls[0].token);
    const row = await pool.query("SELECT record FROM hermes_agui_runtime.bot_registry WHERE id=$1", [record.id]);
    expect(row.rows[0].record).toEqual(record);
    expect(JSON.stringify(row.rows)).not.toContain(f.calls[0].memoryKey);
    await a.deactivate(record.id, identity, false);
    const api = createBotApi(b, new BotAuthentication([{ ...identity, token: "user-token" }]));
    const response = await api(new Request("http://local/api/bots", { headers: { Authorization: "Bearer user-token" } }));
    expect(await response.json()).toEqual([expect.objectContaining({ id: record.id, status: "disabled" })]);
    expect(published[record.id]).toBeUndefined();
    const wrongOwner = new PostgresBotRegistry(databaseUrl!, seed, f.options.templates,
      [{ ...identity, principal: "replacement-principal" }], f.options.agentUrl);
    try {
      const changed = new BotManager({ ...f.options, registry: wrongOwner }, {}, {});
      await changed.restore();
      const replacement = { ...identity, principal: "replacement-principal" };
      expect(changed.listBots(replacement)).toEqual([]);
      await expect(changed.enableBot(record.id, replacement)).rejects.toMatchObject({ status: 404 });
    } finally { await wrongOwner.close(); }
    const reopened = open();
    try {
      const restarted = new BotManager({ ...f.options, registry: reopened }, {}, {});
      await restarted.restore();
      await restarted.enableBot(record.id, identity);
      expect(f.calls.at(-1)).toMatchObject({ id: record.id, token: f.calls[0].token, memoryKey: f.calls[0].memoryKey });
    } finally { await reopened.close(); }
  } finally {
    await Promise.all([first.close(), second.close(), pool.end()]);
  }
});

test.skipIf(!databaseUrl)("a live Runtime reads Bot lifecycle changes committed by another Runtime", async () => {
  const deployedId = "registry-runtime-test";
  const open = () => createApplication({
    [deployedId]: { agentUrl: "http://127.0.0.1:1/agent", token: "deployment-token" },
  }, { management: {
    postgres: { url: databaseUrl!, credentialSeed: "56".repeat(32) },
    hostUrl: "http://127.0.0.1:1", hostToken: "management-token",
    users: [{ ...identity, token: "user-token" }], templates: [],
  } });
  const a = open(), b = open();
  const headers = { Authorization: "Bearer user-token" };
  const info = () => b.runtime(new Request("http://local/api/copilotkit/info", { headers }));
  try {
    await Promise.all([a.ready, b.ready]);
    expect(await (await info()).text()).toContain(deployedId);
    const disabled = await a.management!.api(new Request(`http://local/api/bots/${deployedId}/disable`, {
      method: "POST", headers,
    }));
    expect(disabled.status).toBe(204);
    expect(await (await info()).text()).not.toContain(deployedId);
    const direct = await b.runtime(new Request(`http://local/api/copilotkit/agent/${deployedId}/run`, { method: "POST", headers }));
    expect(direct.status).toBe(404);
  } finally { await Promise.all([a.close(), b.close()]); }
});
