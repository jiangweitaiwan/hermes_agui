import { createHash } from "node:crypto";
import { Pool } from "pg";

export interface ThreadScope {
  projectId: string;
  principal: string;
  botId: string;
}

export interface DelegationIds {
  delegationId: string;
  threadId: string;
  runId: string;
}

export interface DelegationMapping {
  parentThread: string;
  parentRun: string;
  toolCallId: string;
  targetBotId: string;
  task: string;
}

export type DelegationAdmission =
  | { status: "created" | "existing"; ids: DelegationIds }
  | { status: "conflict" };

export interface ThreadMappings {
  admitDelegation(scope: ThreadScope, call: DelegationMapping): Promise<DelegationAdmission>;
  resolve(scope: ThreadScope, browserThread: string, legacyHostThread: string): Promise<string>;
}

export class PostgresThreadMappings implements ThreadMappings {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    if (!connectionString) throw new Error("AGUI_RUNTIME_DATABASE_URL is required for PostgreSQL thread mappings");
    this.pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    // Idle connections can be dropped by PostgreSQL. The pool discards them and opens replacements.
    this.pool.on("error", () => console.error("Runtime thread mapping pool lost an idle connection"));
  }

  async ready(delegationEnabled = false) {
    await this.pool.query("SELECT project, principal, bot, browser_thread, host_thread FROM hermes_agui_runtime.thread_mappings LIMIT 0");
    if (delegationEnabled) await this.pool.query("SELECT delegation_id FROM hermes_agui_runtime.delegation_mappings LIMIT 0");
  }

  async resolve(scope: ThreadScope, browserThread: string, legacyHostThread: string) {
    const key = [scope.projectId, scope.principal, scope.botId, browserThread];
    await this.pool.query(`INSERT INTO hermes_agui_runtime.thread_mappings
      (project, principal, bot, browser_thread, host_thread) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (project, principal, bot, browser_thread) DO NOTHING`, [...key, legacyHostThread]);
    // Use a fresh statement snapshot so a competing insert that won is visible.
    const result = await this.pool.query<{ host_thread: string }>(`SELECT host_thread
      FROM hermes_agui_runtime.thread_mappings WHERE (project, principal, bot, browser_thread)=($1,$2,$3,$4)`, key);
    if (result.rows.length !== 1) throw new Error("Runtime thread mapping is missing");
    return result.rows[0].host_thread;
  }

  async admitDelegation(scope: ThreadScope, call: DelegationMapping): Promise<DelegationAdmission> {
    const parentCall = createHash("sha256").update(JSON.stringify([call.parentThread, call.parentRun, call.toolCallId])).digest();
    const fingerprint = createHash("sha256").update(JSON.stringify([call.targetBotId, call.task])).digest();
    const key = [scope.projectId, scope.principal, scope.botId, parentCall];
    const ids = `delegation_id AS "delegationId", 'delegation-' || child_thread AS "threadId", child_run AS "runId"`;
    const created = await this.pool.query<DelegationIds>(`INSERT INTO hermes_agui_runtime.delegation_mappings
      (project, principal, source_bot, parent_call, fingerprint, target_bot, delegation_id, child_thread, child_run)
      VALUES ($1, $2, $3, $4, $5, $6, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())
      ON CONFLICT (project, principal, source_bot, parent_call) DO NOTHING RETURNING ${ids}`, [...key, fingerprint, call.targetBotId]);
    if (created.rows[0]) return { status: "created", ids: created.rows[0] };
    const existing = await this.pool.query<DelegationIds & { matches: boolean }>(`SELECT ${ids}, fingerprint=$5 AS matches
      FROM hermes_agui_runtime.delegation_mappings WHERE (project, principal, source_bot, parent_call)=($1,$2,$3,$4)`, [...key, fingerprint]);
    const row = existing.rows[0];
    if (!row) throw new Error("Runtime delegation mapping is missing");
    const { matches, ...existingIds } = row;
    return matches ? { status: "existing", ids: existingIds } : { status: "conflict" };
  }

  async list(scope: ThreadScope) {
    const { rows } = await this.pool.query<{ threadId: string }>(`SELECT browser_thread AS "threadId" FROM hermes_agui_runtime.thread_mappings
      WHERE (project,principal,bot)=($1,$2,$3) ORDER BY created_at DESC LIMIT 100`, [scope.projectId, scope.principal, scope.botId]);
    return rows;
  }

  close() { return this.pool.end(); }
}
