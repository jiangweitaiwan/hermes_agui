import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { BotRegistry } from "../server/bots/registry";
import { BotManager } from "../server/bots/manager";
import { PostgresBotRegistry } from "../server/storage/bot-registry";

const databaseUrl = process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
test.skipIf(!databaseUrl)("legacy Runtime import retains stable metadata, omits secrets and preserves later desired operations on rerun", async () => {
  const name = "import_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const root = await mkdtemp(join(tmpdir(), "part1-import-"));
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
  const url = new URL(databaseUrl!); url.pathname = "/" + name;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    const migrations = new URL("../server/storage/migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql")).sort()) await pool.query(await readFile(new URL(file, migrations), "utf8"));
    const owner = { ownerId: "owner", principal: "owner", projectId: "project" };
    const templates = [{ id: "native", name: "Native", harness: "hermes" as const, model: "mock", provider: "mock", skills: [], toolsets: ["memory"] }];
    const source = join(root, "legacy.sqlite"), registry = new BotRegistry(source);
    let bot;
    try {
      bot = await new BotManager({ registry, templates, agentUrl: () => "http://127.0.0.1:8000/agent",
        host: { register: async () => {}, disable: async () => {}, delete: async () => {} } }, {}, {}).createBot({ name: "Legacy", harness: "hermes", templateId: "native", toolsets: ["memory"] }, owner);
    } finally { registry.close(); }
    const config = join(root, "deployment.json");
    await writeFile(config, JSON.stringify({ management: { hostUrl: "http://127.0.0.1:8000", hostTokenEnv: "IMPORT_MANAGER",
      users: [{ ...owner, tokenEnv: "IMPORT_OWNER" }], templates } }));
    const run = async (dry = false) => JSON.parse((await promisify(execFile)(process.execPath, ["--import", "tsx", "server/storage/import-bot-registry.ts",
      "--source", source, "--config", config, ...(dry ? ["--dry-run"] : [])], { env: { ...process.env, AGUI_RUNTIME_DATABASE_URL: url.toString(), IMPORT_MANAGER: "manager", IMPORT_OWNER: "owner" }, timeout: 30000 })).stdout);
    const preview = await run(true), imported = await run();
    expect(imported).toMatchObject({ bots: 1, sha256: preview.sha256 });
    const durable = new PostgresBotRegistry(url.toString(), "d".repeat(64), templates, [owner], () => "http://127.0.0.1:8000/agent");
    try {
      let operation;
      await durable.write(async () => { const saved = durable.get(bot.id)!; expect(saved.record).toEqual(bot); operation = await durable.beginOperation(saved, "active"); });
      expect(operation).toMatchObject({ desiredRevision: "1" });
      expect(await run()).toEqual(imported);
      expect((await pool.query("SELECT desired_revision FROM hermes_agui_runtime.bot_registry WHERE id=$1", [bot.id])).rows[0].desired_revision).toBe("1");
      expect(JSON.stringify((await pool.query("SELECT spec FROM hermes_agui_runtime.bot_operations")).rows)).not.toMatch(/memoryKey|"token"/);
    } finally { await durable.close(); }
  } finally {
    await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); await rm(root, { recursive: true, force: true });
  }
}, 60000);
