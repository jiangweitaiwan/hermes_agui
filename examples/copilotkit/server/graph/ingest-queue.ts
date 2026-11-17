import { SessionSourceSchema, type Provenance } from "./provenance";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WikiStore, namespaceKey, digest } from "./wiki-store";
import { NamespaceSchema, type Namespace } from "./types";

const UploadSchema = z.object({
  sourceId: z.string().uuid().optional(), title: z.string().trim().min(1).max(512).refine(value => Buffer.byteLength(value) <= 512),
  mime: z.enum(["text/plain", "text/markdown"]), content: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
}).strict();
export interface Job {
  id: string; ns: string; source: string; version: number; state: string; attempt: number;
  token: string | null; lease: number; available: number; error: string | null;
}
export interface RawSource { id: string; ns: string; version: number; hash: string; title: string; content: string; deleted: number; botId?: string; provenance?: Provenance; classification?: string; evidence?: { user: string; confirmed: boolean; assistants: string[] } }

/** Only server-resolved namespaces enter this service. No browser/LLM scope is accepted. */
export class DocumentIngestor {
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
  }
  enqueue(namespace: Namespace, value: unknown, origin?: { provenance: Provenance; classification: string; knowledgeHash?: string; evidence?: RawSource["evidence"] }): string {
    if (origin) SessionSourceSchema.parse(origin.provenance);
    const ns = namespaceKey(NamespaceSchema.parse(namespace));
    const input = UploadSchema.parse(value);
    if (Buffer.byteLength(input.content) > 1048576 || input.content.includes("\0")) throw new Error("Invalid document size/text");
    const hash = digest(input.content);
    const fingerprint = digest(JSON.stringify([input.sourceId ?? null, hash, input.title, input.mime, origin ?? null]));
    return this.store.transaction(() => {
      const prior = this.store.db.prepare("SELECT * FROM ingest_keys WHERE ns=? AND key=?").get(ns, input.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Idempotency conflict");
        this.source(this.status(namespace, String(prior.job)));
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
        if (origin?.evidence) this.store.db.prepare("INSERT INTO session_evidence VALUES (?,?,?)").run(ns, id, JSON.stringify(origin.evidence));
        if (origin) this.store.db.prepare("INSERT INTO session_origins VALUES (?,?,?,?)")
          .run(ns, id, JSON.stringify(origin.provenance), origin.classification);
        this.store.db.prepare("INSERT INTO ingest_jobs(id,ns,source,version,state) VALUES (?,?,?,?, 'pending')").run(job, ns, id, version);
      }
      this.store.db.prepare("INSERT OR IGNORE INTO namespaces VALUES (?,?)").run(ns, JSON.stringify(namespace));
      if (origin?.knowledgeHash) this.store.db.prepare("INSERT INTO session_knowledge VALUES (?,?,?)").run(ns, origin.knowledgeHash, job);
      this.store.db.prepare("INSERT OR IGNORE INTO completion_times VALUES (?,?,?)").run(ns, job, Date.now());
      this.store.db.prepare("INSERT INTO ingest_keys VALUES (?,?,?,?)").run(ns, input.idempotencyKey, fingerprint, job);
      return job;
    });
  }
  status(ns: Namespace, id: string): Job {
    const row = this.store.db.prepare("SELECT * FROM ingest_jobs WHERE ns=? AND id=?").get(namespaceKey(ns), id);
    if (!row) throw new Error("Unknown job in namespace");
    return row as unknown as Job;
  }
  claim(ns: Namespace, now = Date.now(), leaseMs = 30000): Job | undefined {
    return this.store.transaction(() => {
      // Expired final attempts enter dead-letter rather than spinning forever.
      this.store.db.prepare("UPDATE ingest_jobs SET state='failed',error='lease_expired',token=NULL WHERE ns=? AND state='running' AND lease<=? AND attempt>=3")
        .run(namespaceKey(ns), now);
      const row = this.store.db.prepare(`SELECT * FROM ingest_jobs WHERE ns=? AND attempt<3 AND
        ((state='pending' AND available<=?) OR (state='running' AND lease<=?)) ORDER BY rowid LIMIT 1`)
        .get(namespaceKey(ns), now, now) as unknown as Job | undefined;
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
    const evidence = this.store.db.prepare("SELECT content FROM session_evidence WHERE ns=? AND source=?").get(job.ns, job.source);
    return { ...source, ...(evidence ? { evidence: JSON.parse(String(evidence.content)) } : {}), ...(owner ? { botId: String(owner.bot) } : {}), ...(origin ? { provenance: SessionSourceSchema.parse(JSON.parse(String(origin.provenance))), classification: String(origin.classification) } : {}) } as unknown as RawSource;
  }
  complete(job: Job) {
    this.source(job);
    const result = this.store.db.prepare("UPDATE ingest_jobs SET state='completed',token=NULL,error=NULL WHERE id=? AND token=? AND state='running' AND lease>?")
      .run(job.id, job.token, Date.now());
    if (!result.changes) throw new Error("Lost job lease");
  }
  fail(job: Job) {
    this.store.db.prepare("UPDATE ingest_jobs SET state=?,error='compile_failed',token=NULL,available=? WHERE id=? AND token=? AND state='running'")
      .run(job.attempt >= 3 ? "failed" : "pending", Date.now() + 1000 * 2 ** job.attempt, job.id, job.token);
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
      for (const row of this.store.db.prepare("SELECT page FROM pages WHERE ns=?").all(key)) {
        const page = this.store.read(this.store.active(key, String(row.page))!);
        if (!page.sources.some(s => "kind" in s ? s.sourceId === sourceId : this.sessionSource(key, s) === sourceId)) continue;
        // Conservatively withdraw the whole derived page, including mixed-source claims.
        this.withdraw(key, page.id);
      }
    });
  }
}
