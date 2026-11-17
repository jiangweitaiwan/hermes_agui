import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { safePath } from "./wiki-store";

export function diagnoseWiki(root: string) {
  const db = new DatabaseSync(safePath(join(root, "wiki.sqlite")), { readOnly: true });
  try {
    const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    return { schema: Number(db.prepare("SELECT version FROM schema_version").get()?.version),
      namespaces: count("namespaces"), pages: count("pages"), revisions: count("revisions"),
      sections: count("sections"), edges: count("edges") };
  } finally { db.close(); }
}
