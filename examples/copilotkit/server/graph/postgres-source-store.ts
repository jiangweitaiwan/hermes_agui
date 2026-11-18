import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { SessionSourceSchema } from "./provenance";
import { NamespaceSchema, type Namespace } from "./types";
import { digest, namespaceKey } from "./wiki-store";
import type { RawSource } from "./ingest-queue";
import type { GraphObject } from "./objects";
import type { SourceInput, SourceOrigin, SourceStore } from "./source-store";
import { PostgresWikiStore } from "./postgres-wiki-store";

const schema = "hermes_agui_runtime";
const Input = z.object({ sourceId: z.string().uuid().optional(), title: z.string().trim().min(1).max(512)
  .refine(title => Buffer.byteLength(title) <= 512), content: z.string().min(1)
  .refine(content => Buffer.byteLength(content) <= 1048576 && !content.includes("\0")) }).strict();
interface SourceRow extends GraphObject {
  ns: string; id: string; version: number; title: string; bot: string; deleted: boolean;
  provenance: SourceOrigin["provenance"] | null; classification: string | null; evidence: RawSource["evidence"] | null;
}

export class PostgresSourceStore implements SourceStore {
  constructor(readonly wiki: PostgresWikiStore) {}

  async ready() {
    // Deployment runs migrations separately; no application DDL or local fallback.
    await this.wiki.pool.query(`SELECT s.object_key,o.provenance,r.revision FROM ${schema}.graph_sources s
      JOIN ${schema}.graph_source_owners owners ON owners.ns=s.ns AND owners.source=s.id
      JOIN ${schema}.graph_session_origins o ON o.ns=s.ns AND o.source=s.id
      JOIN ${schema}.graph_revision_provenance r ON r.ns=s.ns LIMIT 0`);
  }

  async put(namespace: Namespace, value: SourceInput, origin?: SourceOrigin): Promise<RawSource> {
    const ns = NamespaceSchema.parse(namespace), input = Input.parse(value);
    if (origin) {
      const provenance = SessionSourceSchema.parse(origin.provenance);
      if (provenance.botId !== ns.botId) throw new Error("Source outside owning scope");
    }
    const object = await this.wiki.objects.create(`sources/${namespaceKey(ns)}/${randomUUID()}.md`, Buffer.from(input.content));
    const identity = await this.wiki.transaction(ns, client => this.publish(client, ns, input, object, origin));
    return this.get(ns, identity.id, identity.version);
  }

  /** Object upload precedes this short transaction. The caller may enqueue a job on the same client. */
  async publish(client: PoolClient, namespace: Namespace, input: SourceInput, object: GraphObject, origin?: SourceOrigin) {
    const ns = namespaceKey(namespace);
    const duplicate = !input.sourceId && !origin ? await client.query<{ id: string }>(`SELECT s.id FROM ${schema}.graph_sources s
      WHERE ns=$1 AND hash=$2 AND title=$3 AND NOT deleted AND NOT EXISTS (
        SELECT 1 FROM ${schema}.graph_session_origins o WHERE o.ns=s.ns AND o.source=s.id) ORDER BY id LIMIT 1`, [ns, object.hash, input.title]) : undefined;
    const id = input.sourceId ?? duplicate?.rows[0]?.id ?? randomUUID();
    const { rows } = await client.query<SourceRow>(`SELECT * FROM ${schema}.graph_sources WHERE ns=$1 AND id=$2 ORDER BY version DESC`, [ns, id]);
    if (input.sourceId) {
      if (!rows.length) throw new Error("Unknown source in namespace");
      if (namespace.visibility === "bot_private" && rows.some(row => row.bot !== namespace.botId)) throw new Error("Source outside owning scope");
      const session = await client.query(`SELECT 1 FROM ${schema}.graph_session_origins WHERE ns=$1 AND source=$2`, [ns, id]);
      if (session.rowCount) throw new Error("Session completion is immutable");
    }
    if (rows.some(row => row.deleted)) throw new Error("Source revoked");
    const same = rows.find(row => row.hash === object.hash && row.title === input.title);
    if (same) return { id, version: same.version };
    const version = (rows[0]?.version ?? 0) + 1;
    await client.query(`INSERT INTO ${schema}.graph_sources
      (ns,id,version,title,hash,object_key,generation,size,bot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ns, id, version, input.title, object.hash, object.key, object.generation, object.size, namespace.botId]);
    await client.query(`INSERT INTO ${schema}.graph_source_owners VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ns, id, namespace.botId]);
    if (origin) await client.query(`INSERT INTO ${schema}.graph_session_origins VALUES ($1,$2,$3,$4,$5)`,
      [ns, id, JSON.stringify(origin.provenance), origin.classification, origin.evidence ? JSON.stringify(origin.evidence) : null]);
    return { id, version };
  }

  async get(namespace: Namespace, id: string, version?: number): Promise<RawSource> {
    z.string().uuid().parse(id);
    NamespaceSchema.parse(namespace);
    const { rows } = await this.wiki.pool.query<SourceRow>(`SELECT s.*,s.object_key AS key,o.provenance,o.classification,o.evidence
        FROM ${schema}.graph_sources s LEFT JOIN ${schema}.graph_session_origins o ON o.ns=s.ns AND o.source=s.id
        WHERE s.ns=$1 AND s.id=$2 AND ($3::integer IS NULL OR s.version=$3) AND NOT s.deleted ORDER BY s.version DESC LIMIT 1`,
      [namespaceKey(namespace), id, version ?? null]);
    const row = rows[0];
    if (!row) throw new Error("Source revoked or unknown in namespace");
    if (namespace.visibility === "bot_private" && row.bot !== namespace.botId) throw new Error("Source outside owning scope");
    if (!new RegExp(`^sources/${namespaceKey(namespace)}/[a-f0-9-]{36}\\.md$`).test(row.key)) throw new Error("Invalid source object key");
    const content = (await this.wiki.objects.read(row)).toString("utf8");
    // A revocation may commit while the immutable object is downloading.
    const valid = await this.wiki.sourceValid(row.ns, { kind: "document", botId: row.bot, sourceId: row.id,
      version: row.version, hash: row.hash, title: row.title });
    if (!valid || digest(content) !== row.hash) throw new Error("Source revoked or corrupt");
    return { id: row.id, ns: row.ns, version: row.version, hash: row.hash, title: row.title, content, deleted: 0, botId: row.bot,
      ...(row.provenance ? { provenance: SessionSourceSchema.parse(row.provenance), classification: row.classification! } : {}),
      ...(row.evidence ? { evidence: row.evidence } : {}) };
  }

  async revoke(namespace: Namespace, id: string) {
    z.string().uuid().parse(id);
    await this.wiki.transaction(namespace, client => this.withdraw(client, namespace, id));
  }

  async revokeCopies(namespace: Namespace, id: string) {
    const origin = await this.wiki.pool.query<{ provenance: SourceOrigin["provenance"] }>(
      `SELECT provenance FROM ${schema}.graph_session_origins WHERE ns=$1 AND source=$2`, [namespaceKey(namespace), id]);
    if (!origin.rows[0]) return this.revoke(namespace, id);
    const privateNs = { ...namespace, botId: SessionSourceSchema.parse(origin.rows[0].provenance).botId, visibility: "bot_private" as const };
    const sharedNs = { ...namespace, visibility: "project_shared" as const };
    await this.wiki.transaction(privateNs, async client => {
      const { rows } = await client.query<{ ns: string; source: string; metadata: Namespace }>(`SELECT o.ns,o.source,n.metadata
        FROM ${schema}.graph_session_origins o JOIN ${schema}.graph_namespaces n ON n.id=o.ns
        WHERE n.metadata->>'principal'=$1 AND n.metadata->>'projectId'=$2
        AND o.provenance=(SELECT provenance FROM ${schema}.graph_session_origins WHERE ns=$3 AND source=$4)`,
      [namespace.principal, namespace.projectId, namespaceKey(namespace), id]);
      await this.withdraw(client, namespace, id);
      for (const row of rows) if (row.ns !== namespaceKey(namespace) || row.source !== id) {
        await this.withdraw(client, NamespaceSchema.parse(row.metadata), row.source);
      }
    }, [sharedNs]);
  }

  private async withdraw(client: PoolClient, namespace: Namespace, id: string) {
      const ns = namespaceKey(namespace);
      const { rows } = await client.query<{ bot: string }>(`SELECT bot FROM ${schema}.graph_sources WHERE ns=$1 AND id=$2`, [ns, id]);
      if (!rows.length) throw new Error("Unknown source in namespace");
      if (namespace.visibility === "bot_private" && rows.some(row => row.bot !== namespace.botId)) throw new Error("Source outside owning scope");
      await client.query(`UPDATE ${schema}.graph_sources SET deleted=true WHERE ns=$1 AND id=$2`, [ns, id]);
      // Provenance is indexed at publication, so withdrawal never downloads objects under SQL locks.
      const withdrawn = await client.query<{ page: string }>(`DELETE FROM ${schema}.graph_pages p WHERE p.ns=$1 AND EXISTS (
        SELECT 1 FROM ${schema}.graph_revision_provenance r WHERE r.ns=p.ns AND r.page=p.page AND r.revision=p.revision
        AND (r.provenance->>'sourceId'=$2 OR r.provenance IN (
          SELECT provenance FROM ${schema}.graph_session_origins WHERE ns=$1 AND source=$2::uuid))) RETURNING p.page`, [ns, id]);
      await client.query(`UPDATE ${schema}.graph_jobs SET state='cancelled',token=NULL,lease=NULL
        WHERE ns=$1 AND source=$2 AND state IN ('pending','running','failed','completed')`, [ns, id]);
      await client.query(`DELETE FROM ${schema}.graph_edges WHERE ns=$1 AND target=ANY($2::text[])`,
        [ns, withdrawn.rows.map(row => row.page)]);
  }
}
