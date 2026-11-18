import type { Page } from "./types";
import type { WikiStore } from "./wiki-store";

export interface IndexedSection {
  ns: string; page: string; ordinal: number; content: string; score: number;
  revision: string;
}

export interface RetrievalStore {
  lexical(ns: string, tokens: string[], page?: string): Promise<IndexedSection[]>;
  neighbors(ns: string, page: string, limit: number): Promise<{ target: string; degree: number }[]>;
  firstSection(ns: string, page: string, score: number): Promise<IndexedSection[]>;
  activePage(ns: string, page: string, revision?: string): Promise<{ page: Page; revision: string } | undefined>;
}

export class LocalRetrievalStore implements RetrievalStore {
  constructor(readonly store: WikiStore) {}

  async lexical(ns: string, tokens: string[], page?: string) {
    const match = tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    const score = tokens.map(() => "CASE WHEN instr(' ' || tokens || ' ', ?) > 0 THEN 1 ELSE 0 END").join(" + ");
    const parameters = tokens.map(t => ` ${t} `);
    return this.store.db.prepare(`SELECT s.ns,s.page,s.ordinal,s.content,p.revision,
      (${score}) AS score FROM sections s JOIN pages p ON p.ns=s.ns AND p.page=s.page
      WHERE sections MATCH ? AND s.ns=? ${page ? "AND s.page=?" : ""}
      ORDER BY score DESC,s.page,CAST(s.ordinal AS INTEGER) LIMIT 64`)
      .all(...parameters, match, ns, ...(page ? [page] : [])) as unknown as IndexedSection[];
  }

  async neighbors(ns: string, page: string, limit: number) {
    return this.store.db.prepare(`SELECT e.target, (SELECT count(*) FROM edges incoming
      WHERE incoming.ns=e.ns AND incoming.target=e.target) AS degree
      FROM edges e JOIN pages p ON p.ns=e.ns AND p.page=e.target
      WHERE e.ns=? AND e.source=? ORDER BY e.target LIMIT ?`).all(ns, page, limit)
      .map(row => ({ target: String(row.target), degree: Number(row.degree) }));
  }

  async firstSection(ns: string, page: string, score: number) {
    return this.store.db.prepare(`SELECT s.ns,s.page,s.ordinal,s.content,p.revision FROM sections s
      JOIN pages p ON p.ns=s.ns AND p.page=s.page WHERE s.ns=? AND s.page=? ORDER BY CAST(s.ordinal AS INTEGER) LIMIT 1`)
      .all(ns, page).map(row => ({ ...row, score } as unknown as IndexedSection));
  }

  async activePage(ns: string, page: string, revision?: string) {
    const row = this.store.active(ns, page);
    if (!row || (revision && row.revision !== revision)) return;
    return { page: this.store.read(row), revision: row.revision };
  }
}
