import { v2SqliteSchema } from "./v2-sqlite-schema";
import { readSubjects, readAttributes, sqliteGraphConnection, writeGraphSqlite } from "./v2-store";
import type { GraphPublication } from "./v2-types";
import type { IngestStore, IngestOrigin, Publication } from "./ingest-store";
import { parsePage, terms } from "./markdown";
import { SessionSourceSchema, type Provenance } from "./provenance";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WikiStore, namespaceKey, digest } from "./wiki-store";
import { NamespaceSchema, type Namespace } from "./types";

export const UploadSchema = z.object({
  sourceId: z.string().uuid().optional(), title: z.string().trim().min(1).max(512).refine(value => Buffer.byteLength(value) <= 512),
  mime: z.enum(["text/plain", "text/markdown"]), content: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
}).strict();
export interface Job {
  id: string; ns: string; source: string; version: number; state: string; attempt: number;
  token: string | null; lease: number; available: number; error: string | null;
}
export interface RawSource { id: string; ns: string; version: number; hash: string; title: string; content: string; deleted: number; botId?: string; provenance?: Provenance; classification?: string; referenceTime?: import("./temporal-resolver").ReferenceTime; evidence?: { user: string; confirmed: boolean; assistants: string[] } }

/** Only server-resolved namespaces enter this service. No browser/LLM scope is accepted. */
export class DocumentIngestor implements IngestStore {
  constructor(readonly store: WikiStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS document_sources (
      id TEXT NOT NULL, ns TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
      title TEXT NOT NULL, content TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(ns,id,version));
      CREATE TABLE IF NOT EXISTS ingest_jobs (
      id TEXT PRIMARY KEY, ns TEXT NOT NULL, source TEXT NOT NULL, version INTEGER NOT NULL,
      state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, token TEXT,
      lease INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 0, error TEXT,
      UNIQUE(ns,source,version));
      CREATE TABLE IF NOT EXISTS session_evidence (ns TEXT NOT NULL, source TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(ns,source));
      CREATE TABLE IF NOT EXISTS source_versions (ns TEXT NOT NULL, source TEXT NOT NULL, version INTEGER NOT NULL, bot TEXT NOT NULL, PRIMARY KEY(ns,source,version));
      CREATE TABLE IF NOT EXISTS source_owners (ns TEXT NOT NULL, source TEXT NOT NULL, bot TEXT NOT NULL, PRIMARY KEY(ns,source,bot));
      CREATE TABLE IF NOT EXISTS completion_times (ns TEXT NOT NULL, job TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_knowledge (ns TEXT NOT NULL, hash TEXT NOT NULL, job TEXT NOT NULL, PRIMARY KEY(ns,hash));
      CREATE TABLE IF NOT EXISTS session_origins (ns TEXT NOT NULL, source TEXT NOT NULL,
      provenance TEXT NOT NULL, classification TEXT NOT NULL, PRIMARY KEY(ns,source));
      CREATE TABLE IF NOT EXISTS ingest_keys (ns TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      job TEXT NOT NULL REFERENCES ingest_jobs(id), PRIMARY KEY(ns,key));`);
    store.db.exec(v2SqliteSchema);
  }
  graphSubjects(ns: Namespace) { return readSubjects(sqliteGraphConnection(this.store.db),namespaceKey(ns)); }
  graphAttributes(ns: Namespace, page: string) { return readAttributes(sqliteGraphConnection(this.store.db),namespaceKey(ns),page); }
  enqueue(namespace: Namespace, value: unknown, origin?: { provenance: Provenance; classification: string; knowledgeHash?: string; referenceTime?: RawSource["referenceTime"]; evidence?: RawSource["evidence"] }): string {
    if (origin) SessionSourceSchema.parse(origin.provenance);
    const ns = namespaceKey(NamespaceSchema.parse(namespace));
    const input = UploadSchema.parse(value);
    if (Buffer.byteLength(input.content) > 1048576 || input.content.includes("\0")) throw new Error("Invalid document size/text");
    const hash = digest(input.content);
    const fingerprint = digest(JSON.stringify([input.sourceId ?? null, hash, input.title, input.mime, origin ? {...origin,referenceTime:undefined} : null]));
    return this.store.transaction(() => {
      this.store.db.prepare("INSERT OR IGNORE INTO namespaces VALUES (?,?)").run(ns,JSON.stringify(namespace));
      const prior = this.store.db.prepare("SELECT * FROM ingest_keys WHERE ns=? AND key=?").get(ns, input.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Idempotency conflict");
        // A lost delivery acknowledgement must not reopen a revoked session source.
        const job = this.status(namespace, String(prior.job));
        if (!origin?.knowledgeHash) this.source(job);
        return String(prior.job);
      }
      const known = origin?.knowledgeHash ? this.store.db.prepare("SELECT job FROM session_knowledge WHERE ns=? AND hash=?").get(ns, origin.knowledgeHash) : undefined;
      if (known) {
        this.source(this.status(namespace, String(known.job)));
        this.store.db.prepare("INSERT INTO ingest_keys VALUES (?,?,?,?)").run(ns, input.idempotencyKey, fingerprint, known.job);
        return String(known.job);
      }
      const duplicate = !input.sourceId && !origin ? this.store.db.prepare("SELECT id FROM document_sources s WHERE ns=? AND hash=? AND title=? AND deleted=0 AND NOT EXISTS (SELECT 1 FROM session_origins o WHERE o.ns=s.ns AND o.source=s.id) LIMIT 1").get(ns, hash, input.title) : undefined;
      const id = input.sourceId ?? (duplicate ? String(duplicate.id) : randomUUID());
      const versions = this.store.db.prepare("SELECT * FROM document_sources WHERE ns=? AND id=? ORDER BY version DESC").all(ns, id);
      if (input.sourceId && this.store.db.prepare("SELECT 1 FROM session_origins WHERE ns=? AND source=?").get(ns, id)) throw new Error("Session completion is immutable");
      if (input.sourceId && !versions.length) throw new Error("Unknown source in namespace");
      if (versions.some(v => v.deleted)) throw new Error("Source revoked");
      // Content repeats, even under another request key, never create another publication.
      const same = versions.find(v => v.hash === hash && v.title === input.title);
      const version = same ? Number(same.version) : Number(versions[0]?.version ?? 0) + 1;
      let job: string;
      if (same) job = String(this.store.db.prepare("SELECT id FROM ingest_jobs WHERE ns=? AND source=? AND version=?").get(ns, id, version)!.id);
      else {
        job = randomUUID();
        this.store.db.prepare("INSERT INTO document_sources(id,ns,version,hash,title,content) VALUES (?,?,?,?,?,?)")
          .run(id, ns, version, hash, input.title, input.content);
        this.store.db.prepare("INSERT OR IGNORE INTO source_owners VALUES (?,?,?)").run(ns, id, namespace.botId);
        this.store.db.prepare("INSERT INTO source_versions VALUES (?,?,?,?)").run(ns, id, version, namespace.botId);
        this.recordOrigin(ns,id,version,origin);
        this.store.db.prepare("INSERT INTO ingest_jobs(id,ns,source,version,state) VALUES (?,?,?,?, 'pending')").run(job, ns, id, version);
      }
      this.store.db.prepare("INSERT OR IGNORE INTO namespaces VALUES (?,?)").run(ns, JSON.stringify(namespace));
      if (origin?.knowledgeHash) this.store.db.prepare("INSERT INTO session_knowledge VALUES (?,?,?)").run(ns, origin.knowledgeHash, job);
      this.store.db.prepare("INSERT OR IGNORE INTO completion_times VALUES (?,?,?)").run(ns, job, Date.now());
      this.store.db.prepare("INSERT INTO ingest_keys VALUES (?,?,?,?)").run(ns, input.idempotencyKey, fingerprint, job);
      return job;
    });
  }
  private recordOrigin(ns: string, id: string, version: number, origin?: IngestOrigin) {
    if (origin?.referenceTime) this.store.db.prepare("INSERT INTO graph_source_times VALUES (?,?,?,?,?)").run(ns,id,version,origin.referenceTime.instant,origin.referenceTime.timezone);
    if (origin?.evidence) this.store.db.prepare("INSERT INTO session_evidence VALUES (?,?,?)").run(ns, id, JSON.stringify(origin.evidence));
    if (origin) this.store.db.prepare("INSERT INTO session_origins VALUES (?,?,?,?)")
      .run(ns, id, JSON.stringify(origin.provenance), origin.classification);
  }
  current(ns: Namespace, page: string) {
    const row = this.store.active(namespaceKey(ns), page);
    return row ? { page: this.store.read(row), revision: row.revision } : undefined;
  }
  candidates(ns: Namespace, query: string) {
    const tokens = terms(query).slice(0, 32);
    if (!tokens.length) return [];
    return this.store.db.prepare(`SELECT DISTINCT page FROM sections WHERE ns=? AND sections MATCH ? ORDER BY page LIMIT 8`)
      .all(namespaceKey(ns), tokens.map(t => `"${t}"`).join(" OR ")).map(row => {
        const page = this.current(ns, String(row.page))!.page;
        return { id: page.id, title: page.title, body: page.body.slice(0, 4000) };
      });
  }
  publish(ns: Namespace, job: Job, publication: Publication[] | GraphPublication, check: () => void) {
    if (job.ns !== namespaceKey(ns)) throw new Error("Job scope mismatch");
    const inputs = Array.isArray(publication) ? publication : publication.pages;
    const complete = () => {
      check();
      const mode = this.store.db.prepare("SELECT version FROM graph_compiler_namespaces WHERE ns=?").get(job.ns);
      const version = Array.isArray(publication) ? "v1" : "v2";
      if (mode && mode.version !== version) throw new Error("Namespace compiler version conflict");
      this.store.db.prepare("INSERT OR IGNORE INTO graph_compiler_namespaces VALUES (?,?)").run(job.ns,version);
      if (!Array.isArray(publication)) writeGraphSqlite(this.store.db,job.ns,publication,this.source(job));
      for (const input of inputs) for (const source of parsePage(input.markdown).sources) {
        if (!this.store.sourceValid(namespaceKey(ns), source)) throw new Error("Revoked provenance");
      }
      this.complete(job);
    };
    if (inputs.length) this.store.import(ns, inputs, complete);
    else this.store.transaction(complete);
  }
  latestSource(ns: Namespace, id: string) {
    const row = this.store.db.prepare("SELECT * FROM document_sources WHERE ns=? AND id=? AND deleted=0 ORDER BY version DESC LIMIT 1")
      .get(namespaceKey(ns), id);
    if (!row) throw new Error("Source unavailable");
    return this.source({ ns: namespaceKey(ns), source: id, version: Number(row.version) } as Job);
  }
  status(ns: Namespace, id: string): Job {
    const row = this.store.db.prepare("SELECT * FROM ingest_jobs WHERE ns=? AND id=?").get(namespaceKey(ns), id);
    if (!row) throw new Error("Unknown job in namespace");
    return row as unknown as Job;
  }
  claim(ns: Namespace, now = Date.now(), leaseMs = 30000, jobId: string | null = null): Job | undefined {
    return this.store.transaction(() => {
      const namespace = namespaceKey(ns);
      // Expired final attempts enter dead-letter rather than spinning forever.
      this.store.db.prepare(`UPDATE ingest_jobs SET state='failed',error='lease_expired',token=NULL
        WHERE ns=? AND state='running' AND lease<=? AND attempt>=3 AND (? IS NULL OR id=?)`)
        .run(namespace, now, jobId, jobId);
      const row = this.store.db.prepare(`SELECT * FROM ingest_jobs WHERE ns=? AND attempt<3
        AND (? IS NULL OR id=?) AND ((state='pending' AND available<=?) OR (state='running' AND lease<=?))
        ORDER BY rowid LIMIT 1`)
        .get(namespace, jobId, jobId, now, now) as unknown as Job | undefined;
      if (!row) return undefined;
      const token = randomUUID();
      this.store.db.prepare("UPDATE ingest_jobs SET state='running',attempt=attempt+1,token=?,lease=? WHERE id=?").run(token, now + leaseMs, row.id);
      return this.status(ns, row.id);
    });
  }
  heartbeat(job: Job, now = Date.now(), leaseMs = 30000) {
    const result = this.store.db.prepare("UPDATE ingest_jobs SET lease=? WHERE id=? AND token=? AND state='running' AND lease>?")
      .run(now + leaseMs, job.id, job.token, now);
    if (!result.changes) throw new Error("Lost job lease");
  }
  source(job: Job): RawSource {
    const source = this.store.db.prepare("SELECT * FROM document_sources WHERE ns=? AND id=? AND version=? AND deleted=0")
      .get(job.ns, job.source, job.version);
    if (!source) throw new Error("Source revoked");
    const origin = this.store.db.prepare("SELECT * FROM session_origins WHERE ns=? AND source=?").get(job.ns, job.source);
    const owners = this.store.db.prepare("SELECT bot FROM source_owners WHERE ns=? AND source=? ORDER BY bot").all(job.ns, job.source);
    const versionOwner = this.store.db.prepare("SELECT bot FROM source_versions WHERE ns=? AND source=? AND version=?").get(job.ns, job.source, job.version);
    if (!versionOwner && owners.length > 1) throw new Error("Ambiguous historical source owner; reimport required");
    const owner = versionOwner ?? owners[0];
    const time = this.store.db.prepare("SELECT instant,timezone FROM graph_source_times WHERE ns=? AND source_id=? AND source_version=?").get(job.ns,job.source,job.version);
    const evidence = this.store.db.prepare("SELECT content FROM session_evidence WHERE ns=? AND source=?").get(job.ns, job.source);
    return { ...source, ...(time ? { referenceTime: {instant:String(time.instant),timezone:String(time.timezone)} } : {}), ...(evidence ? { evidence: JSON.parse(String(evidence.content)) } : {}), ...(owner ? { botId: String(owner.bot) } : {}), ...(origin ? { provenance: SessionSourceSchema.parse(JSON.parse(String(origin.provenance))), classification: String(origin.classification) } : {}) } as unknown as RawSource;
  }
  complete(job: Job) {
    this.source(job);
    const result = this.store.db.prepare("UPDATE ingest_jobs SET state='completed',token=NULL,error=NULL WHERE id=? AND token=? AND state='running' AND lease>?")
      .run(job.id, job.token, Date.now());
    if (!result.changes) throw new Error("Lost job lease");
  }
  fail(job: Job, validation?: import("../llm/validation/pipeline").ValidationResult) {
    this.store.db.prepare("UPDATE ingest_jobs SET state=?,error=?,token=NULL,available=? WHERE id=? AND token=? AND state='running' AND lease>?")
      .run(job.attempt >= 3 ? "failed" : "pending", validation ? JSON.stringify(validation) : "compile_failed", Date.now() + 1000 * 2 ** job.attempt, job.id, job.token, Date.now());
  }
  cancelClaim(job: Job) {
    this.store.db.prepare(`UPDATE ingest_jobs SET state='cancelled',token=NULL
      WHERE ns=? AND id=? AND token=? AND state='running' AND lease>?`)
      .run(job.ns, job.id, job.token, Date.now());
  }
  cancel(ns: Namespace, id: string) {
    this.status(ns, id);
    this.store.db.prepare("UPDATE ingest_jobs SET state='cancelled',token=NULL WHERE id=? AND state IN ('pending','running','failed')").run(id);
  }
  retry(ns: Namespace, id: string) {
    const job = this.status(ns, id);
    this.source(job);
    if (!["failed", "cancelled"].includes(job.state)) throw new Error("Job is not retryable");
    this.store.db.prepare("UPDATE ingest_jobs SET state='pending',attempt=0,available=0,error=NULL WHERE id=?").run(id);
  }
  rebuild(ns: Namespace) {
    const key = namespaceKey(ns);
    this.store.transaction(() => {
      for (const row of this.store.db.prepare("SELECT page FROM pages WHERE ns=?").all(key)) {
        const page = this.store.read(this.store.active(key, String(row.page))!);
        if (page.sources.some(s => "kind" in s || this.sessionSource(key, s))) this.withdraw(key, page.id);
      }
      this.store.db.prepare(`UPDATE ingest_jobs SET state='pending',attempt=0,token=NULL,available=0,error=NULL
        WHERE ns=? AND EXISTS (SELECT 1 FROM document_sources s WHERE s.ns=ingest_jobs.ns
        AND s.id=ingest_jobs.source AND s.version=ingest_jobs.version AND s.deleted=0)`).run(key);
    });
  }
  withdraw(ns: string, page: string) {
    for (const table of ["pages", "sections", "page_owners", "embeddings"]) this.store.db.prepare(`DELETE FROM ${table} WHERE ns=? AND page=?`).run(ns, page);
    this.store.db.prepare("DELETE FROM edges WHERE ns=? AND (source=? OR target=?)").run(ns, page, page);
  }
  metrics() {
    const rows = this.store.db.prepare("SELECT state,count(*) AS n FROM ingest_jobs GROUP BY state").all();
    const oldest = this.store.db.prepare(`SELECT min(t.created) AS t FROM completion_times t JOIN ingest_jobs j ON j.id=t.job
      WHERE j.state IN ('pending','running')`).get()?.t;
    return { states: Object.fromEntries(rows.map(r => [r.state, Number(r.n)])),
      lagMs: oldest ? Math.max(0, Date.now() - Number(oldest)) : 0 };
  }
  revokeCopies(ns: Namespace, source: string) {
    const origin = this.store.db.prepare("SELECT provenance FROM session_origins WHERE ns=? AND source=?").get(namespaceKey(ns), source);
    this.revoke(ns, source);
    if (!origin) return;
    for (const row of this.store.db.prepare(`SELECT o.source,n.metadata FROM session_origins o
      JOIN namespaces n ON n.id=o.ns WHERE o.provenance=?`).all(origin.provenance)) {
      const target = NamespaceSchema.parse(JSON.parse(String(row.metadata)));
      if (target.principal === ns.principal && target.projectId === ns.projectId) this.revoke(target, String(row.source));
    }
  }
  sessionSource(ns: string, provenance: Provenance): string | undefined {
    if ("kind" in provenance) return undefined;
    const row = this.store.db.prepare("SELECT source FROM session_origins WHERE ns=? AND provenance=?")
      .get(ns, JSON.stringify(SessionSourceSchema.parse(provenance)));
    return row ? String(row.source) : undefined;
  }
  revoke(ns: Namespace, sourceId: string) {
    const key = namespaceKey(ns);
    this.store.transaction(() => {
      if (!this.store.db.prepare("SELECT 1 FROM document_sources WHERE ns=? AND id=?").get(key, sourceId)) throw new Error("Unknown source in namespace");
      this.store.db.prepare("UPDATE document_sources SET deleted=1 WHERE ns=? AND id=?").run(key, sourceId);
      this.store.db.prepare("UPDATE ingest_jobs SET state='cancelled',token=NULL WHERE ns=? AND source=?").run(key, sourceId);
      this.store.db.prepare(`DELETE FROM graph_edge_embeddings WHERE ns=? AND edge_id IN
        (SELECT edge_id FROM graph_edge_evidence WHERE ns=? AND source_id=?)`).run(key,key,sourceId);
      const affected = this.store.db.prepare(`SELECT DISTINCT s.wiki_page_id FROM graph_subject_attribute_evidence a
        JOIN graph_subjects s ON s.ns=a.ns AND s.subject_id=a.subject_id WHERE a.ns=? AND a.source_id=?`).all(key,sourceId);
      for (const row of affected) {
        this.withdraw(key,String(row.wiki_page_id));
        this.store.db.prepare(`UPDATE ingest_jobs SET state='pending',attempt=0,token=NULL,available=0,error=NULL
          WHERE ns=? AND source<>? AND EXISTS (SELECT 1 FROM graph_subject_attribute_evidence a
            JOIN graph_subjects s ON s.ns=a.ns AND s.subject_id=a.subject_id
            JOIN document_sources d ON d.ns=a.ns AND d.id=a.source_id AND d.version=a.source_version
            WHERE a.ns=ingest_jobs.ns AND a.source_id=ingest_jobs.source AND a.source_version=ingest_jobs.version
              AND s.wiki_page_id=? AND NOT d.deleted)`).run(key,sourceId,row.wiki_page_id);
      }
      for (const row of this.store.db.prepare("SELECT page FROM pages WHERE ns=?").all(key)) {
        const page = this.store.read(this.store.active(key, String(row.page))!);
        if (!page.sources.some(s => "kind" in s ? s.sourceId === sourceId : this.sessionSource(key, s) === sourceId)) continue;
        // Conservatively withdraw the whole derived page, including mixed-source claims.
        this.withdraw(key, page.id);
      }
    });
  }
}
