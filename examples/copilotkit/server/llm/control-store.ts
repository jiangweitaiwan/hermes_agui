import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { candidate, ControlError, hash, verifySnapshot, type ControlPolicy, type Snapshot } from "./control-contract";
import { z } from "zod";
import { databaseTarget } from "./database-target";

const schema = "hermes_agui_runtime";
function historyCursor(value?:string){
  if(!value)return undefined;
  try{
    if(!/^[A-Za-z0-9_-]{1,512}$/.test(value))throw new Error("Invalid cursor");
    return z.object({at:z.string().datetime({offset:true}),id:z.string().min(1).max(100)}).strict().parse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));
  }catch{throw new ControlError(422,"Invalid cursor");}
}
export interface Release {
  release_id: string; snapshot: Snapshot; release_fingerprint: string;
  model_fingerprint: string; task_fingerprint: string;
}
export class ControlStore {
  readonly pool: Pool;
  readonly target:string;
  constructor(url: string, readonly policy: ControlPolicy) {
    if (!url) throw new ControlError(503, "Control database required");
    this.target=databaseTarget(url);
    this.pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 2000,
      query_timeout: 5000, statement_timeout: 5000, idle_in_transaction_session_timeout: 5000 });
    this.pool.on("error",()=>console.error("LLM control database connection unavailable"));
  }
  async ready() {
    await this.pool.query(`SELECT d.revision,a.generation,r.release_fingerprint FROM ${schema}.llm_drafts d
      LEFT JOIN ${schema}.llm_active_release a USING(scope) LEFT JOIN ${schema}.llm_releases r USING(scope,release_id) LIMIT 0`);
  }
  close() { return this.pool.end(); }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize writers including the first bootstrap, before a pointer row exists.
      await client.query("SELECT pg_advisory_xact_lock(92017011)");
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async audit(client: PoolClient | Pool, action: string, actor: string, reason = "", oldRelease?: string, newRelease?: string) {
    await client.query(`INSERT INTO ${schema}.llm_admin_events
      (scope,action,actor,request_id,reason,old_release,new_release) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [this.policy.scope, action, actor, randomUUID(), reason, oldRelease ?? null, newRelease ?? null]);
  }
  async draft() {
    const { rows } = await this.pool.query(`SELECT d.config,d.revision,COALESCE(a.generation,0) AS generation,a.release_id
      FROM ${schema}.llm_drafts d LEFT JOIN ${schema}.llm_active_release a USING(scope) WHERE d.scope=$1`, [this.policy.scope]);
    if (!rows[0]) throw new ControlError(503, "Bootstrap required");
    return rows[0] as { config: Snapshot["llm"]; revision: number; generation: number; release_id: string };
  }
  async update(raw: unknown, revision: number, actor: string) {
    const snapshot = candidate(raw, this.policy);
    return this.transaction(async client => {
      const { rows } = await client.query(`UPDATE ${schema}.llm_drafts SET config=$1,revision=revision+1,
        updated_by=$2,updated_at=clock_timestamp() WHERE scope=$3 AND revision=$4 RETURNING revision`,
      [snapshot.llm, actor, this.policy.scope, revision]);
      if (!rows[0]) throw new ControlError(409, "Draft changed; reload");
      await this.audit(client, "draft_update", actor);
      return { revision: rows[0].revision };
    });
  }
  async validate(actor: string) {
    const draft = await this.draft();
    const snapshot = candidate(draft.config, this.policy);
    const active = await this.active();
    await this.audit(this.pool, "validate", actor);
    return { candidateHash: hash(snapshot), revision: draft.revision, generation: draft.generation,
      issues: [], diff: snapshot.llm.models.filter(model => JSON.stringify(model) !==
        JSON.stringify(active.snapshot.llm.models.find(old => old.alias === model.alias))) };
  }
  private async insert(client: PoolClient, snapshot: Snapshot, actor: string, reason: string, parent: string | null, id: string) {
    await client.query(`INSERT INTO ${schema}.llm_releases
      (scope,release_id,parent_release_id,snapshot,model_fingerprint,task_fingerprint,release_fingerprint,validated,created_by,reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9)`,
    [this.policy.scope, id, parent, snapshot, snapshot.modelFingerprint, snapshot.taskFingerprint, hash(snapshot), actor, reason]);
  }
  async bootstrap(raw: unknown, actor: string, apply = false) {
    const snapshot = candidate(raw, this.policy);
    if (!apply) return { candidateHash: hash(snapshot), applied: false };
    return this.transaction(async client => {
      const existing = await client.query(`SELECT snapshot FROM ${schema}.llm_releases WHERE scope=$1 AND release_id='release-001'`, [this.policy.scope]);
      if (existing.rows[0]) {
        if (hash(existing.rows[0].snapshot) !== hash(snapshot)) throw new ControlError(409, "Bootstrap differs from existing release");
        return { candidateHash: hash(snapshot), applied: false };
      }
      await this.insert(client, snapshot, actor, "Explicit registry bootstrap", null, "release-001");
      await client.query(`INSERT INTO ${schema}.llm_drafts(scope,config,revision,updated_by) VALUES ($1,$2,1,$3)`, [this.policy.scope, snapshot.llm, actor]);
      await client.query(`INSERT INTO ${schema}.llm_active_release(scope,release_id,generation,updated_by) VALUES ($1,'release-001',1,$2)`, [this.policy.scope, actor]);
      await this.audit(client, "bootstrap", actor, "Explicit registry bootstrap", undefined, "release-001");
      return { candidateHash: hash(snapshot), applied: true };
    });
  }
  async publish(generation: number, revision: number, candidateHash: string, actor: string, reason: string) {
    return this.transaction(async client => {
      const draft = await client.query(`SELECT config,revision FROM ${schema}.llm_drafts WHERE scope=$1 FOR UPDATE`, [this.policy.scope]);
      if (draft.rows[0]?.revision !== revision) throw new ControlError(409, "Draft changed; reload");
      const snapshot = candidate(draft.rows[0].config, this.policy);
      if (hash(snapshot) !== candidateHash) throw new ControlError(409, "Candidate changed; validate again");
      const prior = await client.query(`SELECT release_id,generation FROM ${schema}.llm_active_release WHERE scope=$1 FOR UPDATE`, [this.policy.scope]);
      if (prior.rows[0]?.generation !== generation) throw new ControlError(409, "Active release changed; reload");
      const id = `release-${randomUUID()}`;
      await this.insert(client, snapshot, actor, reason, prior.rows[0].release_id, id);
      await this.switch(client, id, generation, actor);
      await this.audit(client, "publish", actor, reason, prior.rows[0].release_id, id);
      return { release_id: id, generation: generation + 1, release_fingerprint: hash(snapshot) };
    });
  }
  private async switch(client: PoolClient, id: string, generation: number, actor: string) {
    const result = await client.query(`UPDATE ${schema}.llm_active_release SET release_id=$1,generation=generation+1,
      updated_by=$2,updated_at=clock_timestamp() WHERE scope=$3 AND generation=$4`, [id, actor, this.policy.scope, generation]);
    if (!result.rowCount) throw new ControlError(409, "Active release changed; reload");
  }
  async rollback(id: string, generation: number, actor: string, reason: string) {
    const release = await this.resolve(id);
    return this.transaction(async client => {
      const old = await client.query(`SELECT release_id FROM ${schema}.llm_active_release WHERE scope=$1 FOR UPDATE`, [this.policy.scope]);
      await this.switch(client, id, generation, actor);
      await this.audit(client, "rollback", actor, reason, old.rows[0]?.release_id, id);
      return { release_id: id, generation: generation + 1, release_fingerprint: release.release_fingerprint };
    });
  }
  private verified(row?: Release) {
    if (!row) throw new ControlError(503, "Release unavailable");
    row.snapshot = verifySnapshot(row.snapshot, row.release_fingerprint, this.policy);
    if (row.model_fingerprint !== row.snapshot.modelFingerprint || row.task_fingerprint !== row.snapshot.taskFingerprint) {
      throw new ControlError(503, "Release fingerprint mismatch");
    }
    return row;
  }
  async active(): Promise<Release> {
    const { rows } = await this.pool.query(`SELECT r.* FROM ${schema}.llm_active_release a JOIN ${schema}.llm_releases r
      USING(scope,release_id) WHERE a.scope=$1`, [this.policy.scope]);
    return this.verified(rows[0]);
  }
  async resolve(id: string): Promise<Release> {
    const { rows } = await this.pool.query(`SELECT * FROM ${schema}.llm_releases WHERE scope=$1 AND release_id=$2`, [this.policy.scope, id]);
    return this.verified(rows[0]);
  }
  async pinRun(principal: string, bot: string, thread: string, run: string): Promise<Release> {
    const approved=await this.pool.query(`SELECT 1 FROM ${schema}.llm_bot_roles WHERE scope=$1 AND bot=$2 AND principal=$3`,[this.policy.scope,bot,principal]);
    if(!approved.rowCount)throw new ControlError(503,"Bot requires explicit role migration");
    const { rows } = await this.pool.query(`INSERT INTO ${schema}.llm_run_pins(scope,principal,bot,thread,run,release_id)
      SELECT scope,$2,$3,$4,$5,release_id FROM ${schema}.llm_active_release WHERE scope=$1
      ON CONFLICT DO NOTHING RETURNING release_id`, [this.policy.scope, principal, bot, thread, run]);
    const prior = rows[0] ?? (await this.pool.query(`SELECT release_id FROM ${schema}.llm_run_pins
      WHERE scope=$1 AND principal=$2 AND bot=$3 AND thread=$4 AND run=$5`, [this.policy.scope, principal, bot, thread, run])).rows[0];
    if (!prior) throw new ControlError(503, "Active release unavailable");
    return this.resolve(prior.release_id);
  }
  async optInBot(bot:string,actor:string,apply=false){
    return this.transaction(async client=>{
      const result=await client.query(`SELECT principal,record FROM ${schema}.bot_registry WHERE id=$1 FOR SHARE`,[bot]);
      const row=result.rows[0],record=row?.record.record ?? row?.record;
      if(!row || record.harness!=="hermes" || record.deletedAt)throw new ControlError(422,"Eligible native Bot required");
      const summary={bot,principal:row.principal,template:record.templateId,role:"agent_primary",legacyModel:record.model,legacyProvider:record.provider};
      if(apply){
        const inserted=await client.query(`INSERT INTO ${schema}.llm_bot_roles(scope,bot,principal,template,role,legacy_model,legacy_provider,created_by)
          VALUES ($1,$2,$3,$4,'agent_primary',$5,$6,$7) ON CONFLICT DO NOTHING RETURNING bot`,
        [this.policy.scope,bot,row.principal,record.templateId,record.model,record.provider,actor]);
        if(inserted.rowCount)await this.audit(client,"bot_opt_in",actor,`Opt in Bot ${bot}`);
      }
      return {...summary,applied:apply};
    });
  }
  async history(before?: string) {
    const cursor=historyCursor(before);
    const { rows } = await this.pool.query(`SELECT release_id,parent_release_id,model_fingerprint,task_fingerprint,
      release_fingerprint,created_by,created_at,reason,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM ${schema}.llm_releases WHERE scope=$1
      AND ($2::timestamptz IS NULL OR (created_at,release_id)<($2::timestamptz,$3::text))
      ORDER BY created_at DESC,release_id DESC LIMIT 25`, [this.policy.scope,cursor?.at??null,cursor?.id??null]);
    const events = await this.pool.query(`SELECT action,actor,request_id,old_release,new_release,reason,created_at
      FROM ${schema}.llm_admin_events WHERE scope=$1 ORDER BY event_id DESC LIMIT 50`, [this.policy.scope]);
    const last=rows.at(-1);
    return { releases: rows.map(({cursor_at:_at,...row})=>row), events: events.rows,
      next: rows.length===25?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.release_id})).toString("base64url"):null };
  }
}
