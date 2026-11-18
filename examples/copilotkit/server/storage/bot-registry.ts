import { randomUUID, createHmac } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { matchesAck, operationHash, type ManagementAck, type ManagementOperation, type DesiredState } from "../bots/operations";
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
      spec: { id, name, description, templateId, skills, toolsets, principal, projectId, ownerId: owner.ownerId, token, memoryKey } };
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

  async beginOperation(bot: StoredBot, state: DesiredState): Promise<ManagementOperation> {
    if (!this.writer || !bot.spec) throw new Error("Operation requires a lifecycle lock and native spec");
    const { token: _token, memoryKey: _memoryKey, ...spec } = bot.spec;
    const operation = { operationId: randomUUID(), desiredRevision: "", state, specHash: operationHash(state, spec), spec };
    await this.writer.query("BEGIN");
    try {
      await this.put(bot);
      const { rows: prior } = await this.writer.query<ManagementOperation>(`SELECT o.operation_id AS "operationId",
        o.desired_revision::text AS "desiredRevision",o.desired_state AS state,o.spec_hash AS "specHash",o.spec
        FROM hermes_agui_runtime.bot_operations o JOIN hermes_agui_runtime.bot_registry b
          ON b.id=o.bot AND b.desired_revision=o.desired_revision WHERE b.id=$1`, [spec.id]);
      if (prior[0]?.state === state && prior[0].specHash === operation.specHash) {
        await this.writer.query("COMMIT"); return prior[0];
      }
      const { rows } = await this.writer.query<{ desired_revision: string }>(
        "UPDATE hermes_agui_runtime.bot_registry SET desired_revision=desired_revision+1 WHERE id=$1 RETURNING desired_revision", [spec.id]);
      operation.desiredRevision = rows[0].desired_revision;
      await this.writer.query(`INSERT INTO hermes_agui_runtime.bot_operations
        (operation_id,bot,principal,project,owner_id,desired_revision,desired_state,spec_hash,spec,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
      [operation.operationId, spec.id, spec.principal, spec.projectId, spec.ownerId, operation.desiredRevision, state, operation.specHash, spec]);
      await this.writer.query("COMMIT");
      return operation;
    } catch (error) { await this.writer.query("ROLLBACK"); await this.refresh(); throw error; }
  }
  async provisioningStatus() {
    const { rows } = await (this.writer ?? this.pool).query<{ id: string; desiredRevision: string; status: string; attempt: number; error: string | null }>(`
      SELECT o.bot AS id,o.desired_revision::text AS "desiredRevision",o.status,o.attempt,o.error
      FROM hermes_agui_runtime.bot_operations o JOIN hermes_agui_runtime.bot_registry b
        ON b.id=o.bot AND b.desired_revision=o.desired_revision ORDER BY o.bot`);
    return rows;
  }
  async operations() {
    const { rows } = await (this.writer ?? this.pool).query<ManagementOperation>(`SELECT o.operation_id AS "operationId",
      o.desired_revision::text AS "desiredRevision",o.desired_state AS state,o.spec_hash AS "specHash",o.spec
      FROM hermes_agui_runtime.bot_operations o JOIN hermes_agui_runtime.bot_registry b
        ON b.id=o.bot AND b.desired_revision=o.desired_revision ORDER BY o.bot`);
    return rows;
  }
  async acknowledge(operation: ManagementOperation, ack: ManagementAck) {
    if (!this.writer || !matchesAck(operation, ack)) throw new Error("Host acknowledgement does not match desired operation");
    await this.writer.query("BEGIN");
    try {
      await this.writer.query(`UPDATE hermes_agui_runtime.bot_operations SET status='applied',error=NULL,updated_at=clock_timestamp()
        WHERE operation_id=$1 AND bot=$2 AND desired_revision=$3 AND spec_hash=$4`,
      [operation.operationId, operation.spec.id, operation.desiredRevision, operation.specHash]);
      await this.writer.query(`UPDATE hermes_agui_runtime.bot_registry SET record=jsonb_set(record,'{status}',to_jsonb($3::text))
        WHERE id=$1 AND desired_revision=$2`, [operation.spec.id, operation.desiredRevision, operation.state === "active" ? "active" : "disabled"]);
      await this.writer.query("COMMIT");
      await this.refresh();
    } catch (error) { await this.writer.query("ROLLBACK"); throw error; }
  }
  async operationAttempt(operation: ManagementOperation) {
    await (this.writer ?? this.pool).query(`UPDATE hermes_agui_runtime.bot_operations SET attempt=attempt+1,updated_at=clock_timestamp()
      WHERE operation_id=$1`, [operation.operationId]);
  }
  async operationFailure(operation: ManagementOperation, conflict: boolean) {
    const client = this.writer ?? await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE hermes_agui_runtime.bot_operations SET status=$2,
      error=$3,updated_at=clock_timestamp() WHERE operation_id=$1 AND (status<>'applied' OR $2='conflict')`,
    [operation.operationId, conflict ? "conflict" : "unknown", conflict ? "operation_conflict" : "result_unknown"]);
      if (conflict) await client.query(`UPDATE hermes_agui_runtime.bot_registry SET record=jsonb_set(record,'{status}','"failed"')
        WHERE id=$1 AND desired_revision=$2 AND record->>'status'<>'disabled'`, [operation.spec.id, operation.desiredRevision]);
      await client.query("COMMIT");
      await this.refresh();
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { if (!this.writer) client.release(); }
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
