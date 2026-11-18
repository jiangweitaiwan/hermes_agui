/** Offline import of Bot metadata from a quiescent Runtime SQLite backup. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { z } from "zod";
import { BotInputSchema } from "../bots/types";
import { loadManagement } from "../bots/deployment";

const recordSchema = BotInputSchema.extend({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  ownerId: z.string().min(1),
  projectId: z.string().min(1),
  status: z.enum(["active", "disabled", "failed", "provisioning"]),
  model: z.string(),
  provider: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional(),
}).strip();

const { values } = parseArgs({ options: {
  source: { type: "string" }, config: { type: "string" }, "dry-run": { type: "boolean" },
} });
if (!values.source || !values.config) throw new Error("Specify --source and --config");
const management = loadManagement(JSON.parse(await readFile(values.config, "utf8")).management);
if (!management) throw new Error("The target deployment must have Bot management configured");

const source = new DatabaseSync(values.source, { readOnly: true });
const entries = (() => {
  try {
    return source.prepare("SELECT id, value FROM bots ORDER BY id").all().map(({ id, value }) => {
      const bot = JSON.parse(String(value));
      const record = recordSchema.parse(bot.record);
      const owner = management.users.find(user => user.ownerId === record.ownerId && user.projectId === record.projectId);
      const template = management.templates.find(item => item.id === record.templateId && item.harness === record.harness);
      const principal = bot.spec?.principal ?? bot.principal ?? bot.runtime?.memory?.principal;
      if (id !== record.id || !owner || !template || (principal !== undefined && owner.principal !== principal) ||
          (record.harness === "hermes" && (!bot.spec || bot.spec.id !== id || bot.spec.projectId !== record.projectId))) {
        throw new Error("Bot source identity or target template mismatch");
      }
      if (record.skills.some(skill => !template.skills.includes(skill)) ||
          record.toolsets.some(tool => !template.toolsets.includes(tool))) {
        throw new Error("Bot source capability is unavailable on the target");
      }
      return { record, principal: owner.principal };
    });
  } finally {
    source.close();
  }
})();
const byId = new Map(entries.map(entry => [entry.record.id, entry.record]));
for (const { record } of entries) {
  for (const id of record.delegationTargets) {
    const target = byId.get(id);
    if (!target || target.ownerId !== record.ownerId || target.projectId !== record.projectId || id === record.id) {
      throw new Error("Orphaned or out-of-scope delegation target");
    }
  }
}

if (!values["dry-run"]) {
  const connectionString = process.env.AGUI_RUNTIME_DATABASE_URL;
  if (!connectionString) throw new Error("Set AGUI_RUNTIME_DATABASE_URL");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(53859273, 1)");
      const existing = await client.query<{ id: string }>("SELECT id FROM hermes_agui_runtime.bot_registry");
      if (existing.rows.some(({ id }) => !byId.has(id))) throw new Error("Target contains unrelated Bots");
      for (const { record, principal } of entries) {
        await client.query(`INSERT INTO hermes_agui_runtime.bot_registry (id, principal, record)
          VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [record.id, principal, record]);
        const verified = await client.query(`SELECT 1 FROM hermes_agui_runtime.bot_registry
          WHERE id=$1 AND principal=$2 AND record=$3::jsonb`, [record.id, principal, record]);
        if (verified.rowCount !== 1) throw new Error("Target Bot metadata conflicts with the backup");
      }
      await client.query("COMMIT");
    } finally {
      // Closing the connection also rolls back a failed transaction.
      client.release(true);
    }
  } finally {
    await pool.end();
  }
}
console.log(JSON.stringify({
  dryRun: !!values["dry-run"], bots: entries.length,
  sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
}));
