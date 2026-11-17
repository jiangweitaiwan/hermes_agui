import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, openSync, closeSync, fsyncSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { NamespaceSchema, type Namespace, type Page, type WikiOptions } from "./types";
import { parsePage, terms } from "./markdown";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function safePath(path: string): string {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const component of absolute.slice(cursor.length).split("/")) {
    cursor = join(cursor, component);
    if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Symlink forbidden");
  }
  return absolute;
}
export const namespaceKey = (value: Namespace) => {
  const ns = NamespaceSchema.parse(value);
  return digest(JSON.stringify([ns.principal, ns.projectId, ns.visibility,
    ns.visibility === "bot_private" ? ns.botId : ""]));
};
export interface RevisionRow { ns: string; page: string; revision: string; path: string; hash: string }

/** Markdown revisions are immutable; SQLite's committed manifest is the publication boundary. */
export class WikiStore {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly maxPages: number;
  readonly maxPageBytes: number;
  constructor(root: string, options: WikiOptions = {}) {
    this.root = safePath(root);
    this.maxPages = options.maxPages ?? 1000;
    this.maxPageBytes = options.maxPageBytes ?? 262144;
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 10000 ||
      !Number.isInteger(this.maxPageBytes) || this.maxPageBytes < 1 || this.maxPageBytes > 1048576) throw new Error("Invalid namespace limits");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const filename = safePath(join(this.root, "wiki.sqlite"));
    for (const suffix of ["-wal", "-shm", "-journal"]) safePath(filename + suffix);
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS namespaces (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (revision TEXT PRIMARY KEY, ns TEXT NOT NULL, page TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pages (ns TEXT NOT NULL, page TEXT NOT NULL, revision TEXT NOT NULL REFERENCES revisions(revision),
        PRIMARY KEY(ns,page));
      CREATE TABLE IF NOT EXISTS edges (ns TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
        PRIMARY KEY(ns,source,target));
      CREATE VIRTUAL TABLE IF NOT EXISTS sections USING fts5(ns UNINDEXED, page UNINDEXED,
        ordinal UNINDEXED, content UNINDEXED, tokens, tokenize='unicode61');`);
    if (this.db.prepare("SELECT version FROM schema_version").get()?.version !== 1) {
      this.db.close();
      throw new Error("Unsupported wiki schema");
    }
  }
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  import(ns: Namespace, inputs: { markdown: string; expectedRevision: string | null }[], publish?: () => void): string[] {
    ns = NamespaceSchema.parse(ns);
    const key = namespaceKey(ns);
    const parsed = inputs.map(input => {
      if (Buffer.byteLength(input.markdown) > this.maxPageBytes) throw new Error("Page size limit");
      const page = parsePage(input.markdown);
      // Scope belongs to the server, never to generated Markdown.
      if (ns.visibility === "bot_private" && page.sources.some(source => source.botId !== ns.botId)) {
        throw new Error("Page source outside owning scope");
      }
      return { ...input, page, revision: randomUUID() };
    });
    if (!parsed.length || new Set(parsed.map(p => p.page.id)).size !== parsed.length) throw new Error("Duplicate or empty pages");
    return this.transaction(() => {
      const count = Number(this.db.prepare("SELECT count(*) AS n FROM pages WHERE ns=?").get(key)?.n);
      let additions = 0;
      for (const input of parsed) {
        const current = this.db.prepare("SELECT revision FROM pages WHERE ns=? AND page=?").get(key, input.page.id);
        if ((current?.revision ?? null) !== input.expectedRevision) throw new Error("Revision conflict");
        if (!current) additions++;
      }
      if (count + additions > this.maxPages) throw new Error("Namespace page limit");
      this.db.prepare("INSERT OR IGNORE INTO namespaces VALUES (?,?)").run(key, JSON.stringify(ns));
      for (const input of parsed) {
        const relative = `${key}/${input.revision}.md`;
        const filename = safePath(join(this.root, relative));
        mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
        const temporary = safePath(filename + ".tmp");
        writeFileSync(temporary, input.markdown, { flag: "wx", mode: 0o600 });
        // Validate the on-disk artifact before publishing a pointer to it.
        parsePage(readFileSync(temporary, "utf8"));
        syncPath(temporary);
        renameSync(temporary, filename);
        syncPath(dirname(filename));
        syncPath(this.root);
        this.db.prepare("INSERT INTO revisions VALUES (?,?,?,?,?)")
          .run(input.revision, key, input.page.id, relative, digest(input.markdown));
        this.db.prepare("INSERT INTO pages VALUES (?,?,?) ON CONFLICT(ns,page) DO UPDATE SET revision=excluded.revision")
          .run(key, input.page.id, input.revision);
        this.index(key, input.page);
      }
      publish?.();
      return parsed.map(p => p.revision);
    });
  }
  private index(ns: string, page: Page) {
    this.db.prepare("DELETE FROM sections WHERE ns=? AND page=?").run(ns, page.id);
    this.db.prepare("DELETE FROM edges WHERE ns=? AND source=?").run(ns, page.id);
    page.sections.forEach((content, ordinal) => this.db.prepare("INSERT INTO sections VALUES (?,?,?,?,?)")
      .run(ns, page.id, ordinal, content, terms(`${page.title} ${page.tags.join(" ")} ${content}`).join(" ")));
    for (const target of page.links) this.db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,?)").run(ns, page.id, target);
  }
  read(row: RevisionRow): Page {
    // Paths come from the committed manifest but are still constrained to opaque IDs.
    if (row.path !== `${row.ns}/${row.revision}.md` || !/^[a-f0-9]{64}$/.test(row.ns) ||
      !/^[a-f0-9-]{36}$/.test(row.revision)) throw new Error("Invalid revision path");
    const markdown = readFileSync(safePath(join(this.root, row.path)), "utf8");
    if (digest(markdown) !== row.hash) throw new Error("Revision checksum mismatch");
    return parsePage(markdown);
  }
  active(ns: string, page: string): RevisionRow | undefined {
    return this.db.prepare(`SELECT r.* FROM pages p JOIN revisions r ON r.revision=p.revision
      WHERE p.ns=? AND p.page=?`).get(ns, page) as unknown as RevisionRow | undefined;
  }
  reindex() {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT r.* FROM pages p JOIN revisions r ON p.revision=r.revision ORDER BY r.ns,r.page").all();
      this.db.exec("DELETE FROM sections; DELETE FROM edges;");
      for (const row of rows) this.index(String(row.ns), this.read(row as unknown as RevisionRow));
    });
  }
  /** Only counts: diagnostic output never includes scope names or private text. */
  diagnostics() {
    const count = (table: string) => Number(this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    return { schema: 1, namespaces: count("namespaces"), pages: count("pages"), revisions: count("revisions"), sections: count("sections"), edges: count("edges") };
  }
  cleanup() {
    this.transaction(() => {
      const referenced = new Set(this.db.prepare("SELECT path FROM revisions").all().map(r => String(r.path)));
      for (const ns of readdirSync(this.root)) {
        if (!/^[a-f0-9]{64}$/.test(ns)) continue;
        const directory = safePath(join(this.root, ns));
        for (const name of readdirSync(directory)) {
          const path = safePath(join(directory, name));
          if (/^[a-f0-9-]{36}\.md(?:\.tmp)?$/.test(name) && !referenced.has(`${ns}/${name}`)) rmSync(path);
        }
      }
    });
  }
  close() { this.db.close(); }
}

function syncPath(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
