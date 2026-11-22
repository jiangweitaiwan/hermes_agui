import { WikiStore, namespaceKey } from "./wiki-store";
import { PostgresWikiStore } from "./postgres-wiki-store";
import { DocumentIngestor, type RawSource, type Job } from "./ingest-queue";
import { PostgresSourceStore } from "./postgres-source-store";
import { sqliteGraphConnection, postgresGraphConnection, type GraphConnection } from "./v2-store";
import { EdgeSchema, SubjectSchema, EvidenceSchema, type FactEdge, type Subject } from "./v2-types";
import type { Namespace } from "./types";
import { ProvenanceSchema, type Provenance } from "./provenance";

export const decode = (value: any) => typeof value === "string" ? JSON.parse(value) : value;
export interface ReadEdge { edge: FactEdge; sources: Provenance[]; from: Subject; to: Subject }
/** All callers supply a server-resolved namespace. No object download is needed for candidate discovery. */
export class V2RetrievalStore {
  readonly local?: DocumentIngestor;
  private readonly sourceCache = new Map<string,RawSource>();
  retained: (ns: Namespace, bot: string) => boolean = () => true;
  constructor(readonly wiki: WikiStore | PostgresWikiStore) {
    if (wiki instanceof WikiStore) this.local = new DocumentIngestor(wiki);
  }
  async connection<T>(action: (db: GraphConnection) => Promise<T>): Promise<T> {
    if (this.wiki instanceof WikiStore) return action(sqliteGraphConnection(this.wiki.db));
    const client = await this.wiki.pool.connect();
    try { return await action(postgresGraphConnection(client)); } finally { client.release(); }
  }
  async enabled(ns: Namespace) {
    return this.connection(async db => (await db.rows("SELECT version FROM graph_compiler_namespaces WHERE ns=$1", [namespaceKey(ns)]))[0]?.version === "v2");
  }
  async subjects(ns: Namespace, text: string, page?: string): Promise<Subject[]> {
    const normalized = text.normalize("NFKC").toLowerCase();
    return this.connection(async db => {
      const rows = await db.rows(`SELECT DISTINCT s.subject_id,s.data FROM graph_subjects s JOIN graph_subject_aliases a ON a.ns=s.ns AND a.subject_id=s.subject_id
        JOIN document_sources d ON d.ns=a.ns AND d.id=a.source_id AND d.version=a.source_version
        WHERE s.ns=$1 AND NOT d.deleted ${page ? "AND s.wiki_page_id=$2" : "AND (a.alias_normalized=$2 OR $3 LIKE '%' || a.alias_normalized || '%')"}
        ORDER BY s.subject_id LIMIT 65`, page ? [namespaceKey(ns), page] : [namespaceKey(ns), normalized, normalized]);
      if (rows.length > 64) throw new Error("Subject query budget exceeded");
      return rows.map(r => SubjectSchema.parse(decode(r.data)));
    });
  }
  async candidates(ns: Namespace, tokens: string[], subjects: string[], after = "", limit = 65, all = false): Promise<string[]> {
    return this.connection(async db => {
      const args: unknown[] = [namespaceKey(ns), after];
      const bind = (v: unknown) => { args.push(v); return `$${args.length}`; };
      const conditions: string[] = [];
      if (subjects.length) {
        const ids = subjects.map(bind).join(",");
        // Different placeholders are required by SQLite's anonymous-parameter adapter.
        const targets = subjects.map(bind).join(",");
        conditions.push(`f.from_subject_id IN (${ids}) OR f.to_subject_id IN (${targets})`);
      }
      if (tokens.length) conditions.push(`EXISTS (SELECT 1 FROM graph_fact_tokens t WHERE t.ns=f.ns AND t.edge_id=f.edge_id AND t.token IN (${tokens.map(bind).join(",")}))`);
      if (!conditions.length && !all) return [];
      return (await db.rows(`SELECT f.edge_id FROM graph_fact_edges f WHERE f.ns=$1 AND f.edge_id>$2
        ${all ? "" : `AND (${conditions.join(" OR ")})`} AND EXISTS (SELECT 1 FROM graph_edge_evidence e JOIN document_sources d
        ON d.ns=e.ns AND d.id=e.source_id AND d.version=e.source_version WHERE e.ns=f.ns AND e.edge_id=f.edge_id AND NOT d.deleted)
        ORDER BY f.edge_id LIMIT ${bind(limit)}`, args)).map(r => String(r.edge_id));
    });
  }
  async lexical(ns:Namespace,tokens:string[]):Promise<string[]> {
    if (!tokens.length) return [];
    return this.connection(async db=>{
      const args:unknown[]=[namespaceKey(ns),...tokens];
      const rows=await db.rows(`SELECT t.edge_id,count(*) AS score FROM graph_fact_tokens t
        WHERE t.ns=$1 AND t.token IN (${tokens.map((_,i)=>`$${i+2}`).join(",")}) AND EXISTS
        (SELECT 1 FROM graph_edge_evidence e JOIN document_sources d ON d.ns=e.ns AND d.id=e.source_id AND d.version=e.source_version
         WHERE e.ns=t.ns AND e.edge_id=t.edge_id AND NOT d.deleted)
        GROUP BY t.edge_id ORDER BY score DESC,t.edge_id LIMIT 64`,args);
      return rows.map(r=>String(r.edge_id));
    });
  }
  async related(ns: Namespace, edge: Pick<FactEdge,"factKind"|"stateSlotKey"|"eventId">) {
    return this.connection(async db => {
      const rows = edge.factKind === "state" ? await db.rows("SELECT edge_id FROM graph_fact_edges WHERE ns=$1 AND state_slot_key=$2 ORDER BY edge_id LIMIT 129", [namespaceKey(ns), edge.stateSlotKey])
        : edge.eventId ? await db.rows("SELECT edge_id FROM graph_fact_edges WHERE ns=$1 AND event_id=$2 ORDER BY edge_id LIMIT 129", [namespaceKey(ns), edge.eventId]) : [];
      if (rows.length > 128) throw new Error("Event/slot expansion budget exceeded");
      return rows.map(r => String(r.edge_id));
    });
  }
  async source(ns: Namespace, id: string, version: number): Promise<RawSource> {
    if (this.local) return this.local.source({ns:namespaceKey(ns),source:id,version} as Job);
    const key=`${namespaceKey(ns)}:${id}:${version}`,cached=this.sourceCache.get(key);
    if (cached) {
      const valid=await this.wiki.sourceValid(namespaceKey(ns),{kind:"document",botId:cached.botId!,sourceId:id,version,hash:cached.hash,title:cached.title});
      if (!valid) { this.sourceCache.delete(key);throw new Error("Source revoked"); }
      return cached;
    }
    const source=await new PostgresSourceStore(this.wiki as PostgresWikiStore).get(ns,id,version);
    // Raw objects are immutable. Recheck source validity and ownership on every reuse, never cache ACL decisions.
    if (this.sourceCache.size>=32)this.sourceCache.delete(this.sourceCache.keys().next().value!);
    this.sourceCache.set(key,source);return source;
  }
  async allowed(ns: Namespace, source: RawSource) {
    const bot = source.botId;
    if (!bot || (ns.visibility === "bot_private" && bot !== ns.botId) || !this.retained(ns, bot) || !this.retained(ns, ns.botId)) return false;
    if (this.wiki instanceof PostgresWikiStore && this.wiki.readScope) {
      const owners = this.wiki.readScope(ns);
      const result = await this.wiki.pool.query(`SELECT id FROM hermes_agui_runtime.bot_registry WHERE id=ANY($1::text[]) AND principal=$2
        AND record->>'projectId'=$3 AND record->>'ownerId'=ANY($4::text[]) AND record->>'deletedAt' IS NULL AND record->>'status'='active'`,
        [[...new Set([bot, ns.botId])], ns.principal, ns.projectId, owners]);
      if (result.rowCount !== new Set([bot, ns.botId]).size) return false;
    }
    return true;
  }
  async read(ns: Namespace, id: string): Promise<ReadEdge | undefined> {
    const record = await this.connection(async db => {
      const rows = await db.rows("SELECT data FROM graph_fact_edges WHERE ns=$1 AND edge_id=$2", [namespaceKey(ns), id]);
      if (!rows.length) return;
      const evidence = await db.rows(`SELECT e.data FROM graph_edge_evidence e JOIN document_sources d ON d.ns=e.ns AND d.id=e.source_id AND d.version=e.source_version
        WHERE e.ns=$1 AND e.edge_id=$2 AND NOT d.deleted ORDER BY e.source_id,e.source_version,e.quote_hash LIMIT 97`, [namespaceKey(ns),id]);
      if (evidence.length > 96) throw new Error("Edge evidence budget exceeded");
      if (!evidence.length) return;
      return EdgeSchema.parse({...decode(rows[0].data), evidence: evidence.map(e => EvidenceSchema.parse(decode(e.data)))});
    });
    if (!record || record.status === "retracted") return;
    const sources: Provenance[] = [];
    for (const e of record.evidence) {
      const source = await this.source(ns, e.sourceId, e.sourceVersion);
      if (!await this.allowed(ns, source)) return;
      if (source.content.slice(e.position, e.position + e.quote.length) !== e.quote) throw new Error("Invalid edge evidence");
      sources.push(ProvenanceSchema.parse(source.provenance ?? {kind:"document", botId:source.botId, sourceId:source.id, version:source.version, hash:source.hash, title:source.title}));
    }
    const from = await this.subject(ns,record.fromSubjectId), to = await this.subject(ns,record.toSubjectId);
    if (!from || !to) return;
    return {edge:record, sources, from, to};
  }
  async subject(ns:Namespace,id:string):Promise<Subject|undefined> {
    const rows=await this.connection(db=>db.rows(`SELECT s.data,a.alias_normalized,a.source_id,a.source_version FROM graph_subjects s
      JOIN graph_subject_aliases a ON a.ns=s.ns AND a.subject_id=s.subject_id JOIN document_sources d
      ON d.ns=a.ns AND d.id=a.source_id AND d.version=a.source_version
      WHERE s.ns=$1 AND s.subject_id=$2 AND NOT d.deleted ORDER BY a.alias_normalized,a.source_id,a.source_version LIMIT 97`,[namespaceKey(ns),id]));
    // Choose a display name backed by a currently authorized alias; the original canonical name may have been revoked.
    for (const row of rows.slice(0,96)) {
      const source=await this.source(ns,String(row.source_id),Number(row.source_version));
      if (!await this.allowed(ns,source)) continue;
      const subject=SubjectSchema.parse(decode(row.data));
      const canonical=subject.canonicalName.normalize("NFKC").toLowerCase();
      return {...subject,canonicalName:canonical===row.alias_normalized ? subject.canonicalName : String(row.alias_normalized),aliases:[]};
    }
  }
}
