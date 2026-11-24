import { readSubjects, readAttributes, postgresGraphConnection, writeGraph } from "./v2-store";
import type { GraphPublication } from "./v2-types";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { UploadSchema, type Job } from "./ingest-queue";
import type { IngestOrigin, IngestStore, Publication } from "./ingest-store";
import { PostgresWikiStore } from "./postgres-wiki-store";
import { PostgresSourceStore } from "./postgres-source-store";
import { NamespaceSchema, type Namespace } from "./types";
import { SessionSourceSchema } from "./provenance";
import { digest, namespaceKey } from "./wiki-store";
import { terms } from "./markdown";
import type { ControlStore } from "../llm/control-store";
import { executionRelease } from "../llm/execution-release";
import { databaseTarget } from "../llm/database-target";

const schema = "hermes_agui_runtime";
const jobColumns = `id,ns,source,version,state,attempt,token,error,
  COALESCE(extract(epoch FROM lease)*1000,0)::float8 AS lease,
  (extract(epoch FROM available)*1000)::float8 AS available`;
function leaseDuration(ms: number) {
  if (!Number.isInteger(ms) || ms < 1 || ms > 30000) throw new Error("Invalid job lease duration");
  return ms;
}
/** Same queue/compiler contract as SQLite; every mutation uses the database clock and claim token. */
export class PostgresDocumentIngestor implements IngestStore {
  releases?: ControlStore;
  readonly sources: PostgresSourceStore;
  constructor(readonly store: PostgresWikiStore) { this.sources = new PostgresSourceStore(store); }
  useReleases(releases:ControlStore){
    if(databaseTarget(this.store.pool.options.connectionString!)!==releases.target)throw new Error("Graph ledger/control database destinations must match");
    this.releases=releases;
  }
  async graphSubjects(ns: Namespace) {
    const client = await this.store.pool.connect();
    try { return await readSubjects(postgresGraphConnection(client),namespaceKey(ns)); } finally { client.release(); }
  }
  async graphAttributes(ns: Namespace,page: string) {
    const client = await this.store.pool.connect();
    try { return await readAttributes(postgresGraphConnection(client),namespaceKey(ns),page); } finally { client.release(); }
  }
  async ready() {
    await this.sources.ready();
    await this.store.pool.query(`SELECT s.subject_id,e.edge_id,a.attribute_id FROM ${schema}.graph_subjects s
      JOIN ${schema}.graph_fact_edges e ON e.ns=s.ns JOIN ${schema}.graph_subject_attribute_evidence a ON a.ns=s.ns LIMIT 0`);
    await this.store.pool.query(`SELECT j.id,k.key,h.hash FROM ${schema}.graph_jobs j
      JOIN ${schema}.graph_ingest_keys k ON k.job=j.id JOIN ${schema}.graph_session_knowledge h ON h.job=j.id LIMIT 0`);
  }
  async enqueue(namespace: Namespace, value: unknown, origin?: IngestOrigin) {
    this.checkControlDatabase();
    const ns = NamespaceSchema.parse(namespace), key = namespaceKey(ns), input = UploadSchema.parse(value);
    if (origin && SessionSourceSchema.parse(origin.provenance).botId !== ns.botId) throw new Error("Source outside owning scope");
    if (Buffer.byteLength(input.content) > 1048576 || input.content.includes("\0")) throw new Error("Invalid document size/text");
    const hash = digest(input.content);
    const fingerprint = digest(JSON.stringify([input.sourceId ?? null, hash, input.title, input.mime, origin ? {...origin,referenceTime:undefined} : null]));
    const object = await this.store.objects.create(`sources/${key}/${randomUUID()}.md`, Buffer.from(input.content));
    const originalNs = origin && ns.visibility === "project_shared"
      ? { ...ns, visibility: "bot_private" as const, botId: origin.provenance.botId } : undefined;
    return this.store.transaction(ns, async client => {
      if (originalNs) {
        const valid = await client.query(`SELECT 1 FROM ${schema}.graph_session_origins o JOIN ${schema}.graph_sources s
          ON s.ns=o.ns AND s.id=o.source WHERE o.ns=$1 AND o.provenance=$2::jsonb AND NOT s.deleted`,
        [namespaceKey(originalNs), JSON.stringify(origin!.provenance)]);
        if (!valid.rowCount) throw new Error("Original session source revoked");
      }
      const { rows: prior } = await client.query<{ fingerprint: string; job: string }>(
        `SELECT fingerprint,job FROM ${schema}.graph_ingest_keys WHERE ns=$1 AND key=$2`, [key, input.idempotencyKey]);
      if (prior[0]) {
        if (prior[0].fingerprint !== fingerprint) throw new Error("Idempotency conflict");
        if (!origin?.knowledgeHash) {
          const valid = await client.query(`SELECT 1 FROM ${schema}.graph_jobs j JOIN ${schema}.graph_sources s
            ON s.ns=j.ns AND s.id=j.source AND s.version=j.version WHERE j.id=$1 AND NOT s.deleted`, [prior[0].job]);
          if (!valid.rowCount) throw new Error("Source revoked");
        }
        return prior[0].job;
      }
      const { rows: known } = await client.query<{ job: string }>(
        `SELECT job FROM ${schema}.graph_session_knowledge WHERE ns=$1 AND hash=$2`, [key, origin?.knowledgeHash ?? null]);
      let job = known[0]?.job;
      if (job) {
        const valid = await client.query(`SELECT 1 FROM ${schema}.graph_jobs j JOIN ${schema}.graph_sources s
          ON s.ns=j.ns AND s.id=j.source AND s.version=j.version WHERE j.id=$1 AND NOT s.deleted`, [job]);
        if (!valid.rowCount) throw new Error("Source revoked");
      } else {
        const source = await this.sources.publish(client, ns, input, object, origin);
        const { rows } = this.releases
          ? await client.query<{id:string}>(`INSERT INTO ${schema}.graph_jobs (id,ns,source,version,state,llm_scope,llm_release_id)
              SELECT $1,$2,$3,$4,'pending',scope,release_id FROM ${schema}.llm_active_release WHERE scope=$5
              ON CONFLICT (ns,source,version) DO UPDATE SET source=excluded.source RETURNING id`,
            [randomUUID(),key,source.id,source.version,this.releases.policy.scope])
          : await client.query<{ id: string }>(`INSERT INTO ${schema}.graph_jobs (id,ns,source,version,state)
              VALUES ($1,$2,$3,$4,'pending') ON CONFLICT (ns,source,version) DO UPDATE SET source=excluded.source RETURNING id`,
            [randomUUID(), key, source.id, source.version]);
        if(!rows[0])throw new Error("Active LLM release unavailable");
        job = rows[0].id;
        if (origin?.knowledgeHash) await client.query(`INSERT INTO ${schema}.graph_session_knowledge VALUES ($1,$2,$3)`, [key, origin.knowledgeHash, job]);
      }
      await client.query(`INSERT INTO ${schema}.graph_ingest_keys VALUES ($1,$2,$3,$4)`, [key, input.idempotencyKey, fingerprint, job]);
      return job;
    }, originalNs ? [originalNs] : []);
  }
  async namespaceForJob(id: string) {
    const { rows } = await this.store.pool.query<{ metadata: Namespace }>(`SELECT n.metadata FROM ${schema}.graph_jobs j
      JOIN ${schema}.graph_namespaces n ON n.id=j.ns WHERE j.id=$1`, [id]);
    if (!rows[0]) throw new Error("Unknown job");
    return NamespaceSchema.parse(rows[0].metadata);
  }
  async releaseForJob(job: Job) {
    this.checkControlDatabase();
    // to_jsonb keeps pre-011 static databases readable without referencing absent columns.
    const {rows}=await this.store.pool.query(`SELECT to_jsonb(j)->>'llm_scope' AS llm_scope,to_jsonb(j)->>'llm_release_id' AS llm_release_id
      FROM ${schema}.graph_jobs j WHERE ns=$1 AND id=$2`,[job.ns,job.id]);
    if(!this.releases){
      if(rows[0]?.llm_release_id)throw new Error("Pinned job requires a compatible managed reader");
      return undefined;
    }
    if(rows[0]?.llm_scope!==this.releases.policy.scope || !rows[0]?.llm_release_id)throw new Error("Unpinned managed job; drain legacy jobs before activation");
    return this.releases.resolve(rows[0].llm_release_id);
  }
  private checkControlDatabase(){
    if(this.releases && databaseTarget(this.store.pool.options.connectionString!)!==this.releases.target)throw new Error("Graph ledger/control database destinations must match");
  }
  async status(ns: Namespace, id: string) {
    const { rows } = await this.store.pool.query<Job>(`SELECT ${jobColumns} FROM ${schema}.graph_jobs WHERE ns=$1 AND id=$2`, [namespaceKey(ns), id]);
    if (!rows[0]) throw new Error("Unknown job in namespace");
    return rows[0];
  }
  async claim(ns: Namespace, _now?: number, leaseMs = 30000, jobId: string | null = null) {
    leaseDuration(leaseMs);
    return this.store.transaction(ns, async client => {
      await client.query("SELECT set_config('hermes.llm_contract','management-part-1',true)");
      const key = namespaceKey(ns);
      await client.query(`UPDATE ${schema}.graph_jobs SET state='failed',error='lease_expired',token=NULL,lease=NULL
        WHERE ns=$1 AND state='running' AND lease<=clock_timestamp() AND attempt>=3 AND ($2::uuid IS NULL OR id=$2)`, [key, jobId]);
      const { rows } = await client.query<Job>(`WITH candidate AS (
        SELECT id FROM ${schema}.graph_jobs WHERE ns=$1 AND attempt<3 AND ($2::uuid IS NULL OR id=$2)
        AND ((state='pending' AND available<=clock_timestamp()) OR (state='running' AND lease<=clock_timestamp()))
        ORDER BY created,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE ${schema}.graph_jobs j SET state='running',attempt=attempt+1,token=$3,
          lease=clock_timestamp()+$4 * interval '1 millisecond' FROM candidate c WHERE j.id=c.id RETURNING
          j.id,j.ns,j.source,j.version,j.state,j.attempt,j.token,j.error,
          (extract(epoch FROM j.lease)*1000)::float8 AS lease,(extract(epoch FROM j.available)*1000)::float8 AS available`,
      [key, jobId, randomUUID(), leaseMs]);
      return rows[0];
    });
  }
  async heartbeat(job: Job, _now?: number, leaseMs = 30000) {
    leaseDuration(leaseMs);
    const result = await this.store.pool.query(`UPDATE ${schema}.graph_jobs
      SET lease=clock_timestamp()+$4 * interval '1 millisecond' WHERE ns=$1 AND id=$2 AND token=$3
      AND state='running' AND lease>clock_timestamp()`, [job.ns, job.id, job.token, leaseMs]);
    if (!result.rowCount) throw new Error("Lost job lease");
  }
  async source(job: Job) {
    const { rows } = await this.store.pool.query<{ metadata: Namespace }>(`SELECT metadata FROM ${schema}.graph_namespaces WHERE id=$1`, [job.ns]);
    if (!rows[0]) throw new Error("Unknown namespace");
    return this.sources.get(NamespaceSchema.parse(rows[0].metadata), job.source, job.version);
  }
  latestSource(ns: Namespace, source: string) { return this.sources.get(ns, source); }
  async current(ns: Namespace, page: string) { return this.store.activePage(namespaceKey(ns), page); }
  async candidates(ns: Namespace, query: string) {
    const tokens = terms(query).slice(0, 32);
    if (!tokens.length) return [];
    const pages = await this.store.pageIds(namespaceKey(ns), "", "", tokens, 8);
    const results = [];
    for (const id of pages) {
      const active = await this.current(ns, id);
      if (active) results.push({ id, title: active.page.title, body: active.page.body.slice(0, 4000) });
    }
    return results;
  }
  async publish(ns: Namespace, job: Job, publication: Publication[] | GraphPublication, check: () => void) {
    if (job.ns !== namespaceKey(ns)) throw new Error("Job scope mismatch");
    const inputs = Array.isArray(publication) ? publication : publication.pages;
    const raw = !Array.isArray(publication) ? await this.source(job) : undefined;
    const complete = async (client: PoolClient) => {
      check();
      await this.checkPublicationPin(client,job);
      const mode = await client.query(`SELECT version FROM ${schema}.graph_compiler_namespaces WHERE ns=$1`,[job.ns]);
      const version = Array.isArray(publication) ? "v1" : "v2";
      if (mode.rows[0] && mode.rows[0].version !== version) throw new Error("Namespace compiler version conflict");
      await client.query(`INSERT INTO ${schema}.graph_compiler_namespaces VALUES ($1,$2) ON CONFLICT DO NOTHING`,[job.ns,version]);
      if (!Array.isArray(publication)) await writeGraph(postgresGraphConnection(client),job.ns,publication,raw!);
      const source = await client.query<{ bot: string }>(`SELECT bot FROM ${schema}.graph_sources WHERE ns=$1 AND id=$2 AND version=$3`, [job.ns, job.source, job.version]);
      await this.store.authorizePublication?.(client, ns, source.rows.map(row => row.bot));
      const result = await client.query(`UPDATE ${schema}.graph_jobs j SET state='completed',token=NULL,lease=NULL,error=NULL
        WHERE ns=$1 AND id=$2 AND token=$3 AND state='running' AND lease>clock_timestamp()
        AND EXISTS (SELECT 1 FROM ${schema}.graph_sources s WHERE s.ns=j.ns AND s.id=j.source AND s.version=j.version AND NOT s.deleted)`,
      [job.ns, job.id, job.token]);
      if (!result.rowCount) throw new Error("Lost job lease or revoked source");
    };
    if (inputs.length) await this.store.import(ns, inputs, complete);
    else await this.store.transaction(ns, complete);
  }
  private async checkPublicationPin(client:PoolClient,job:Job){
    const {rows}=await client.query(`SELECT to_jsonb(j)->>'llm_release_id' AS release_id FROM ${schema}.graph_jobs j WHERE ns=$1 AND id=$2`,[job.ns,job.id]);
    if(rows[0]?.release_id && executionRelease()?.release_id!==rows[0].release_id)throw new Error("Publication requires the persisted release pin");
    if(rows[0]?.release_id){
      const release=await client.query(`SELECT release_fingerprint FROM ${schema}.llm_releases WHERE scope='deployment' AND release_id=$1`,[rows[0].release_id]);
      if(release.rows[0]?.release_fingerprint!==executionRelease()?.release_fingerprint)throw new Error("Publication release fingerprint mismatch");
      await client.query("SELECT set_config('hermes.llm_release_id',$1,true)",[rows[0].release_id]);
    }
  }
  async fail(job: Job, validation?: import("../llm/validation/pipeline").ValidationResult) {
    await this.store.pool.query(`UPDATE ${schema}.graph_jobs SET state=CASE WHEN attempt>=3 THEN 'failed' ELSE 'pending' END,
      error=$4,token=NULL,lease=NULL,available=clock_timestamp()+power(2,attempt)*interval '1 second'
      WHERE ns=$1 AND id=$2 AND token=$3 AND state='running' AND lease>clock_timestamp()`, [job.ns, job.id, job.token, validation ? JSON.stringify(validation) : "compile_failed"]);
  }
  async cancelClaim(job: Job) {
    await this.store.pool.query(`UPDATE ${schema}.graph_jobs SET state='cancelled',token=NULL,lease=NULL
      WHERE ns=$1 AND id=$2 AND token=$3 AND state='running' AND lease>clock_timestamp()`, [job.ns, job.id, job.token]);
  }
  async cancel(ns: Namespace, id: string) {
    await this.status(ns, id);
    await this.store.transaction(ns, async client => {
      await client.query(`UPDATE ${schema}.graph_jobs SET state='cancelled',token=NULL,lease=NULL
        WHERE ns=$1 AND id=$2 AND state IN ('pending','running','failed')`, [namespaceKey(ns), id]);
    });
  }
  async retry(ns: Namespace, id: string) {
    await this.store.transaction(ns, async client => {
      const result = await client.query(`UPDATE ${schema}.graph_jobs j SET state='pending',attempt=0,token=NULL,lease=NULL,error=NULL,available=clock_timestamp()
        WHERE ns=$1 AND id=$2 AND state IN ('failed','cancelled') AND EXISTS (
          SELECT 1 FROM ${schema}.graph_sources s WHERE s.ns=j.ns AND s.id=j.source AND s.version=j.version AND NOT s.deleted)`, [namespaceKey(ns), id]);
      if (!result.rowCount) throw new Error("Job is not retryable");
    });
  }
  async rebuild(ns: Namespace) {
    await this.store.transaction(ns, async client => {
      const key = namespaceKey(ns);
      const withdrawn = await client.query<{ page: string }>(`DELETE FROM ${schema}.graph_pages p WHERE p.ns=$1 AND EXISTS (
        SELECT 1 FROM ${schema}.graph_revision_provenance r WHERE r.ns=p.ns AND r.page=p.page AND r.revision=p.revision
        AND (r.provenance ? 'kind' OR EXISTS (SELECT 1 FROM ${schema}.graph_session_origins o
          WHERE o.ns=r.ns AND o.provenance=r.provenance))) RETURNING p.page`, [key]);
      await client.query(`DELETE FROM ${schema}.graph_edges WHERE ns=$1 AND target=ANY($2::text[])`, [key, withdrawn.rows.map(row => row.page)]);
      await client.query(`UPDATE ${schema}.graph_jobs j SET state='pending',attempt=0,token=NULL,lease=NULL,error=NULL,available=clock_timestamp()
        WHERE ns=$1 AND EXISTS (SELECT 1 FROM ${schema}.graph_sources s WHERE s.ns=j.ns AND s.id=j.source AND s.version=j.version AND NOT s.deleted)`, [key]);
    });
  }
  async namespaces() {
    const { rows } = await this.store.pool.query<{ metadata: Namespace }>(`SELECT metadata FROM ${schema}.graph_namespaces ORDER BY id`);
    return rows.map(row => NamespaceSchema.parse(row.metadata));
  }
  async ownerships() {
    const { rows } = await this.store.pool.query<{ metadata: Namespace; bot: string; source: string | null; page: string | null }>(`
      SELECT DISTINCT n.metadata,o.bot,o.source,NULL::text AS page FROM ${schema}.graph_source_owners o
      JOIN ${schema}.graph_namespaces n ON n.id=o.ns JOIN ${schema}.graph_sources s ON s.ns=o.ns AND s.id=o.source WHERE NOT s.deleted
      UNION ALL SELECT n.metadata,o.bot,NULL::uuid AS source,o.page FROM ${schema}.graph_page_owners o
      JOIN ${schema}.graph_namespaces n ON n.id=o.ns`);
    return rows;
  }
  async withdraw(ns: Namespace, page: string) {
    await this.store.transaction(ns, async client => {
      await client.query(`DELETE FROM ${schema}.graph_pages WHERE ns=$1 AND page=$2`, [namespaceKey(ns), page]);
      await client.query(`DELETE FROM ${schema}.graph_edges WHERE ns=$1 AND target=$2`, [namespaceKey(ns), page]);
    });
  }
  revoke(ns: Namespace, source: string) { return this.sources.revoke(ns, source); }
  revokeCopies(ns: Namespace, source: string) { return this.sources.revokeCopies(ns, source); }
  async metrics() {
    const { rows } = await this.store.pool.query<{ state: string; n: number; lag: number }>(`SELECT state,count(*)::integer AS n,
      greatest(0,extract(epoch FROM clock_timestamp()-min(created))*1000)::float8 AS lag FROM ${schema}.graph_jobs GROUP BY state`);
    return { states: Object.fromEntries(rows.map(row => [row.state, row.n])),
      lagMs: Math.max(0, ...rows.filter(row => ["pending","running"].includes(row.state)).map(row => row.lag)) };
  }

}
