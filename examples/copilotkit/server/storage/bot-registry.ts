import { createHmac } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Registry } from "../bots/registry";
import type { BotRecord, BotTemplate, Identity, StoredBot } from "../bots/types";

export class PostgresBotRegistry implements Registry {
  private readonly pool: Pool;
  private records = new Map<string, StoredBot>();
  private writer?: PoolClient;

  constructor(connectionString: string, private secret: string,
    private templates: BotTemplate[], private users: Identity[], private agentUrl: (id: string) => string) {
    if (!connectionString || !/^[0-9a-f]{64}$/i.test(secret)) {
      throw new Error("Configure the Runtime database and a 32-byte hex Bot credential seed");
    }
    this.pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    this.pool.on("error", () => console.error("Runtime Bot registry lost an idle connection"));
  }
  credentials(id: string, identity: Identity) {
    const derive = (purpose: string) => createHmac("sha256", Buffer.from(this.secret, "hex"))
      .update(JSON.stringify([purpose, identity.ownerId, identity.projectId, identity.principal, id])).digest("hex");
    return { token: derive("host-token"), memoryKey: derive("memory-key") };
  }
  private owner(record: BotRecord) {
    return this.users.find(user => user.ownerId === record.ownerId && user.projectId === record.projectId);
  }
  private materialize(record: BotRecord, storedPrincipal: string): StoredBot {
    const owner = this.owner(record);
    const template = this.templates.find(item => item.id === record.templateId && item.harness === record.harness);
    if (!owner || owner.principal !== storedPrincipal || !template || (record.harness === "remote_ag_ui" && !template.remote?.token)) {
      // Keep metadata and tombstones visible while denying runs with missing deployment references.
      return { principal: storedPrincipal, record: { ...record, status: record.status === "disabled" ? "disabled" : "failed" },
        runtime: { agentUrl: "", token: "" } };
    }
    if (template.remote && record.harness === "remote_ag_ui") return { principal: storedPrincipal, record, runtime: structuredClone(template.remote) };
    const { id, name, description, templateId, skills, toolsets } = record;
    const { principal, projectId } = owner;
    const { token, memoryKey } = this.credentials(id, owner);
    return { principal: storedPrincipal, record, runtime: { agentUrl: this.agentUrl(id), token, memory: { key: memoryKey, principal, projectId } },
      spec: { id, name, description, templateId, skills, toolsets, principal, projectId, token, memoryKey } };
  }
  async refresh() {
    const { rows } = await (this.writer ?? this.pool).query<{ record: BotRecord; principal: string }>(
      "SELECT record, principal FROM hermes_agui_runtime.bot_registry ORDER BY id");
    this.records = new Map(rows.map(({ record, principal }) => [record.id, this.materialize(record, principal)]));
  }
  all() { return structuredClone([...this.records.values()]); }
  get(id: string) { return structuredClone(this.records.get(id)); }

  async put(bot: StoredBot) {
    if (!this.writer) throw new Error("Bot registry write requires a lifecycle lock");
    const principal = this.owner(bot.record)?.principal;
    if (!principal) throw new Error("Unknown Bot principal");
    const result = await this.writer.query(`INSERT INTO hermes_agui_runtime.bot_registry AS b (id, principal, record)
      VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET record=excluded.record
      WHERE b.principal=excluded.principal AND b.record->>'ownerId'=excluded.record->>'ownerId'
        AND b.record->>'projectId'=excluded.record->>'projectId'`, [bot.record.id, principal, bot.record]);
    if (result.rowCount !== 1) throw new Error("Bot scope cannot change");
    this.records.set(bot.record.id, this.materialize(bot.record, principal));
  }

  async write<T>(work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      // Session lock spans committed state transitions and the existing bounded Host request.
      await client.query("SELECT pg_advisory_lock(53859273, 1)");
      this.writer = client;
      await this.refresh();
      return await work();
    } finally {
      this.writer = undefined;
      // Closing the connection releases the lock even after a statement or network failure.
      client.release(true);
    }
  }
  close() { return this.pool.end(); }
}
