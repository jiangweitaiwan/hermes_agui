import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { EmbeddingSection, EmbeddingStore } from "./embedding";
import type { IndexedSection, RetrievalStore } from "./retrieval-store";
import { parsePage, terms } from "./markdown";
import type { GraphObject, GraphObjects } from "./objects";
import { NamespaceSchema, type Namespace, type Page, type WikiOptions } from "./types";
import { namespaceKey, wikiLimits } from "./wiki-store";

const schema = "hermes_agui_runtime";
export interface ActiveRevision extends GraphObject {
  ns: string;
  page: string;
  revision: string;
}
interface PageInput { markdown: string; expectedRevision: string | null }
interface StagedPage { page: Page; revision: string; expectedRevision: string | null; object: GraphObject }

/** PostgreSQL holds the published pointers. Object writes finish before publication takes any locks. */
export class PostgresWikiStore implements RetrievalStore, EmbeddingStore {
  readonly pool: Pool;
  readScope?: (ns: Namespace) => string[];
  authorizePublication?: (client: PoolClient, ns: Namespace, bots: string[]) => Promise<void>;
  private readonly limits: ReturnType<typeof wikiLimits>;

  constructor(databaseUrl: string, readonly objects: GraphObjects, options: WikiOptions = {}) {
    if (!databaseUrl) throw new Error("AGUI_RUNTIME_DATABASE_URL is required for PostgreSQL Graph storage");
    this.limits = wikiLimits(options);
    this.pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    this.pool.on("error", () => console.error("Graph storage pool lost an idle connection"));
  }

  async ready() {
    await this.pool.query(`SELECT r.generation FROM ${schema}.graph_revisions r
      JOIN ${schema}.graph_pages p USING (ns,page,revision)
      JOIN ${schema}.graph_namespaces n ON n.id=p.ns
      JOIN ${schema}.graph_sections s USING (ns,page)
      JOIN ${schema}.graph_page_owners o USING (ns,page)
      JOIN ${schema}.graph_embeddings v USING (ns,page)
      JOIN ${schema}.graph_edges e ON e.ns=p.ns AND e.source=p.page
      JOIN ${schema}.graph_revision_provenance provenance ON provenance.ns=r.ns AND provenance.page=r.page AND provenance.revision=r.revision
      JOIN ${schema}.graph_sources sources ON sources.ns=r.ns LIMIT 0`);
  }

  async import(namespace: Namespace, inputs: PageInput[], publish?: (client: PoolClient) => Promise<void>) {
    const ns = NamespaceSchema.parse(namespace);
    const key = namespaceKey(ns);
    const pages = inputs.map(input => {
      if (Buffer.byteLength(input.markdown) > this.limits.maxPageBytes) throw new Error("Page size limit");
      const page = parsePage(input.markdown);
      if (ns.visibility === "bot_private" && page.sources.some(source => source.botId !== ns.botId)) {
        throw new Error("Page source outside owning scope");
      }
      return { ...input, page, revision: randomUUID() };
    });
    if (!pages.length || new Set(pages.map(input => input.page.id)).size !== pages.length) throw new Error("Duplicate or empty pages");
    if (pages.length > this.limits.maxPages) throw new Error("Namespace page limit");
    const staged: StagedPage[] = [];
    for (const input of pages) {
      const object = await this.objects.create(`wiki/${key}/${input.revision}.md`, Buffer.from(input.markdown));
      staged.push({ ...input, object });
    }
    return this.transaction(ns, async client => {
      const { rows } = await client.query<{ page: string; revision: string }>(
        `SELECT page,revision FROM ${schema}.graph_pages WHERE ns=$1`, [key]);
      const current = new Map(rows.map(row => [row.page, row.revision]));
      let additions = 0;
      for (const input of staged) {
        const revision = current.get(input.page.id);
        if ((revision ?? null) !== input.expectedRevision) throw new Error("Revision conflict");
        if (!revision) additions++;
      }
      if (current.size + additions > this.limits.maxPages) throw new Error("Namespace page limit");
      await this.authorizePublication?.(client, ns, [...new Set(staged.flatMap(input => input.page.sources.map(source => source.botId)))].sort());
      for (const input of staged) {
        for (const source of input.page.sources) {
          if (!await this.sourceValid(key, source, client)) throw new Error("Revoked provenance");
        }
        await this.publish(client, key, input);
      }
      await publish?.(client);
      return staged.map(input => input.revision);
    });
  }

  async transaction<T>(ns: Namespace, action: (client: PoolClient) => Promise<T>, additional: Namespace[] = []): Promise<T> {
    const key = namespaceKey(ns);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const namespaces = new Map([ns, ...additional].map(value => [namespaceKey(value), NamespaceSchema.parse(value)]));
      for (const id of [...namespaces.keys()].sort()) {
        await client.query(`INSERT INTO ${schema}.graph_namespaces VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, JSON.stringify(namespaces.get(id))]);
        await client.query(`SELECT id FROM ${schema}.graph_namespaces WHERE id=$1 FOR UPDATE`, [id]);
      }
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async publish(client: PoolClient, ns: string, { page, revision, object }: StagedPage) {
    const binding = [ns, page.id];
    await client.query(`INSERT INTO ${schema}.graph_revisions VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [...binding, revision, object.key, object.generation, object.hash, object.size]);
    for (const source of page.sources) await client.query(`INSERT INTO ${schema}.graph_revision_provenance VALUES ($1,$2,$3,$4)
      ON CONFLICT DO NOTHING`, [ns, page.id, revision, JSON.stringify(source)]);
    await client.query(`INSERT INTO ${schema}.graph_pages VALUES ($1,$2,$3)
      ON CONFLICT (ns,page) DO UPDATE SET revision=excluded.revision`, [...binding, revision]);
    await this.index(client, ns, page);
  }

  private async index(client: PoolClient, ns: string, page: Page) {
    const binding = [ns, page.id];
    await client.query(`DELETE FROM ${schema}.graph_page_owners WHERE ns=$1 AND page=$2`, binding);
    await client.query(`DELETE FROM ${schema}.graph_edges WHERE ns=$1 AND source=$2`, binding);
    await client.query(`DELETE FROM ${schema}.graph_sections WHERE ns=$1 AND page=$2`, binding);
    await client.query(`INSERT INTO ${schema}.graph_page_owners
      SELECT $1,$2,bot FROM unnest($3::text[]) AS owners(bot)`, [...binding, [...new Set(page.sources.map(source => source.botId))]]);
    await client.query(`INSERT INTO ${schema}.graph_edges
      SELECT $1,$2,target FROM unnest($3::text[]) AS edges(target)`, [...binding, page.links]);
    const sections = page.sections.map((content, ordinal) => ({
      ordinal, content, tokens: terms(`${page.title} ${page.tags.join(" ")} ${content}`),
    }));
    await client.query(`INSERT INTO ${schema}.graph_sections
      SELECT $1,$2,ordinal,content,tokens FROM jsonb_to_recordset($3::jsonb)
        AS sections(ordinal integer,content text,tokens text[])`, [...binding, JSON.stringify(sections)]);
  }

  async reindex(namespace: Namespace) {
    const ns = namespaceKey(namespace);
    const ids = await this.pageIds(ns, "", "", [], this.limits.maxPages);
    const staged: { row: ActiveRevision; page: Page }[] = [];
    for (const id of ids) {
      const row = await this.active(ns, id);
      if (!row) throw new Error("Revision conflict");
      staged.push({ row, page: await this.read(row) });
    }
    await this.transaction(namespace, async client => {
      const { rows } = await client.query<{ page: string; revision: string }>(`SELECT page,revision FROM ${schema}.graph_pages WHERE ns=$1`, [ns]);
      if (rows.length !== staged.length || staged.some(({ row }) => !rows.some(active => active.page === row.page && active.revision === row.revision))) throw new Error("Revision conflict");
      for (const { page } of staged) await this.index(client, ns, page);
    });
  }
  async diagnostics() {
    const { rows } = await this.pool.query(`SELECT
      (SELECT count(*)::integer FROM ${schema}.graph_namespaces) AS namespaces,
      (SELECT count(*)::integer FROM ${schema}.graph_pages) AS pages,
      (SELECT count(*)::integer FROM ${schema}.graph_revisions) AS revisions,
      (SELECT count(*)::integer FROM ${schema}.graph_sections) AS sections,
      (SELECT count(*)::integer FROM ${schema}.graph_edges) AS edges,
      (SELECT count(*)::integer FROM ${schema}.graph_subjects) AS subjects,
      (SELECT count(*)::integer FROM ${schema}.graph_fact_edges) AS fact_edges,
      (SELECT count(*)::integer FROM ${schema}.graph_edge_evidence) AS edge_evidence`);
    return { schema: 1, ...rows[0] };
  }

  async active(ns: string, page: string): Promise<ActiveRevision | undefined> {
    const { rows } = await this.pool.query<ActiveRevision>(`SELECT r.ns,r.page,r.revision,r.object_key AS key,r.generation,r.hash,r.size
      FROM ${schema}.graph_pages p JOIN ${schema}.graph_revisions r USING (ns,page,revision) WHERE p.ns=$1 AND p.page=$2`, [ns, page]);
    return rows[0];
  }

  async read(row: ActiveRevision): Promise<Page> {
    if (!/^[a-f0-9]{64}$/.test(row.ns) || !/^[a-f0-9-]{36}$/.test(row.revision) ||
      row.key !== `wiki/${row.ns}/${row.revision}.md`) throw new Error("Invalid Graph revision object");
    const page = parsePage((await this.objects.read(row)).toString("utf8"));
    if (page.id !== row.page) throw new Error("Graph page mismatch");
    return page;
  }

  async lexical(ns: string, tokens: string[], page?: string): Promise<IndexedSection[]> {
    const { rows } = await this.pool.query<IndexedSection>(`SELECT s.ns,s.page,s.ordinal,s.content,p.revision,
      cardinality(ARRAY(SELECT token FROM unnest($2::text[]) token WHERE token=ANY(s.tokens))) AS score
      FROM ${schema}.graph_sections s JOIN ${schema}.graph_pages p USING (ns,page)
      WHERE s.ns=$1 AND s.tokens && $2::text[] AND ($3::text IS NULL OR s.page=$3)
      ORDER BY score DESC,s.page,s.ordinal LIMIT 64`, [ns, tokens, page ?? null]);
    return rows;
  }

  async neighbors(ns: string, page: string, limit: number) {
    const { rows } = await this.pool.query<{ target: string; degree: number }>(`SELECT e.target,
      (SELECT count(*)::integer FROM ${schema}.graph_edges incoming
        WHERE incoming.ns=e.ns AND incoming.target=e.target) AS degree
      FROM ${schema}.graph_edges e JOIN ${schema}.graph_pages p ON p.ns=e.ns AND p.page=e.target
      WHERE e.ns=$1 AND e.source=$2 ORDER BY e.target LIMIT $3`, [ns, page, limit]);
    return rows;
  }

  async firstSection(ns: string, page: string, score: number) {
    const { rows } = await this.pool.query<Omit<IndexedSection, "score">>(`SELECT s.ns,s.page,s.ordinal,s.content,p.revision
      FROM ${schema}.graph_sections s JOIN ${schema}.graph_pages p USING (ns,page)
      WHERE s.ns=$1 AND s.page=$2 ORDER BY s.ordinal LIMIT 1`, [ns, page]);
    return rows.map(row => ({ ...row, score }));
  }

  async activePage(ns: string, id: string, revision?: string) {
    const row = await this.active(ns, id);
    if (!row || (revision && row.revision !== revision)) return;
    const page = await this.read(row);
    if ((await this.active(ns, id))?.revision !== row.revision) return;
    return { page, revision: row.revision };
  }

  async unindexedSections(ns: string, model: string) {
    const { rows } = await this.pool.query<EmbeddingSection>(`SELECT s.ns,s.page,s.ordinal,s.content,p.revision
      FROM ${schema}.graph_sections s JOIN ${schema}.graph_pages p USING (ns,page)
      LEFT JOIN ${schema}.graph_embeddings e ON e.ns=s.ns AND e.page=s.page AND e.ordinal=s.ordinal
        AND e.model=$2 AND e.revision=p.revision
      WHERE s.ns=$1 AND e.revision IS NULL ORDER BY s.page,s.ordinal LIMIT 32`, [ns, model]);
    return rows;
  }

  async indexEmbeddings(model: string, sections: EmbeddingSection[], vectors: number[][]) {
    if (!sections.length) return 0;
    const ns = sections[0].ns;
    if (sections.some(section => section.ns !== ns)) throw new Error("Mixed embedding namespaces");
    const { rows } = await this.pool.query<{ metadata: Namespace }>(
      `SELECT metadata FROM ${schema}.graph_namespaces WHERE id=$1`, [ns]);
    if (!rows[0]) return 0;
    return this.transaction(rows[0].metadata, async client => {
      const owners = await client.query<{ bot: string }>(`SELECT DISTINCT bot FROM ${schema}.graph_page_owners
        WHERE ns=$1 AND page=ANY($2::text[]) ORDER BY bot`, [ns, sections.map(section => section.page)]);
      await this.authorizePublication?.(client, rows[0].metadata, owners.rows.map(row => row.bot));
      let indexed = 0;
      for (const [i, section] of sections.entries()) {
        const result = await client.query(`INSERT INTO ${schema}.graph_embeddings
          SELECT s.ns,s.page,s.ordinal,p.revision,$5,$6 FROM ${schema}.graph_sections s
          JOIN ${schema}.graph_pages p USING (ns,page)
          WHERE s.ns=$1 AND s.page=$2 AND s.ordinal=$3 AND p.revision=$4
          ON CONFLICT (ns,page,ordinal,model) DO UPDATE SET revision=excluded.revision,vector=excluded.vector`,
        [ns, section.page, section.ordinal, section.revision, model, JSON.stringify(vectors[i])]);
        indexed += result.rowCount ?? 0;
      }
      return indexed;
    });
  }

  async indexedEmbeddings(ns: string, model: string) {
    const { rows } = await this.pool.query<EmbeddingSection & { vector: string }>(`SELECT e.*,s.content
      FROM ${schema}.graph_embeddings e JOIN ${schema}.graph_pages p USING (ns,page,revision)
      JOIN ${schema}.graph_sections s USING (ns,page,ordinal)
      WHERE e.ns=$1 AND e.model=$2 ORDER BY e.page,e.ordinal LIMIT 4096`, [ns, model]);
    return rows;
  }

  async clearEmbeddings(ns: string) {
    await this.pool.query(`DELETE FROM ${schema}.graph_embeddings WHERE ns=$1`, [ns]);
  }

  async browserJobs(ns: string) {
    const { rows } = await this.pool.query<import("./browser-store").BrowserJob>(`SELECT j.id,j.ns,j.source,j.state,
      (extract(epoch FROM j.created)*1000)::float8 AS created,
      ARRAY(SELECT bot FROM ${schema}.graph_source_owners o WHERE o.ns=j.ns AND o.source=j.source ORDER BY bot) AS owners
      FROM ${schema}.graph_jobs j WHERE ns=$1 ORDER BY created DESC,id DESC LIMIT 50`, [ns]);
    return rows;
  }

  async validateRead(namespace: Namespace, revision: string, activeRequester = false) {
    const ns = namespaceKey(namespace), owners = this.readScope?.(namespace);
    const result = await this.pool.query(`SELECT 1 FROM ${schema}.graph_pages p WHERE p.ns=$1 AND p.revision=$2
      AND EXISTS (SELECT 1 FROM ${schema}.graph_revision_provenance r WHERE r.ns=p.ns AND r.page=p.page AND r.revision=p.revision)
      AND ($3::text[] IS NULL OR (EXISTS (SELECT 1 FROM ${schema}.bot_registry b WHERE b.id=$4 AND b.principal=$5
        AND b.record->>'projectId'=$6 AND b.record->>'ownerId'=ANY($3) AND b.record->>'deletedAt' IS NULL
        AND (NOT $7::boolean OR b.record->>'status'='active'))
        AND NOT EXISTS (SELECT 1 FROM ${schema}.graph_page_owners o WHERE o.ns=p.ns AND o.page=p.page AND NOT EXISTS (
          SELECT 1 FROM ${schema}.bot_registry b WHERE b.id=o.bot AND b.principal=$5 AND b.record->>'projectId'=$6
          AND b.record->>'ownerId'=ANY($3) AND b.record->>'deletedAt' IS NULL))))
      AND NOT EXISTS (SELECT 1 FROM ${schema}.graph_revision_provenance r WHERE r.ns=p.ns AND r.page=p.page AND r.revision=p.revision
        AND ((r.provenance->>'kind'='document' AND NOT EXISTS (SELECT 1 FROM ${schema}.graph_sources s
          WHERE s.ns=r.ns AND s.id=(r.provenance->>'sourceId')::uuid AND s.version=(r.provenance->>'version')::integer
          AND s.hash=r.provenance->>'hash' AND s.bot=r.provenance->>'botId' AND NOT s.deleted))
        OR (NOT (r.provenance ? 'kind') AND EXISTS (SELECT 1 FROM ${schema}.graph_session_origins o WHERE o.ns=r.ns
          AND o.provenance=r.provenance AND NOT EXISTS (SELECT 1 FROM ${schema}.graph_sources s WHERE s.ns=o.ns AND s.id=o.source AND NOT s.deleted)))))`,
    [ns, revision, owners ?? null, namespace.botId, namespace.principal, namespace.projectId, activeRequester]);
    return !!result.rowCount;
  }

  async hasRevision(ns: string, revision: string) {
    const result = await this.pool.query(`SELECT 1 FROM ${schema}.graph_pages WHERE ns=$1 AND revision=$2`, [ns, revision]);
    return !!result.rowCount;
  }

  pageBytes(row: ActiveRevision) { return row.size; }

  async sourceValid(ns: string, source: Page["sources"][number], client: PoolClient | Pool = this.pool) {
    if ("kind" in source) {
      const result = await client.query(`SELECT 1 FROM ${schema}.graph_sources
        WHERE ns=$1 AND id=$2 AND version=$3 AND hash=$4 AND bot=$5 AND NOT deleted`,
      [ns, source.sourceId, source.version, source.hash, source.botId]);
      return !!result.rowCount;
    }
    const { rows } = await client.query<{ valid: boolean }>(`SELECT NOT EXISTS (
      SELECT 1 FROM ${schema}.graph_session_origins o WHERE o.ns=$1 AND o.provenance=$2::jsonb
        AND NOT EXISTS (SELECT 1 FROM ${schema}.graph_sources s WHERE s.ns=o.ns AND s.id=o.source AND NOT s.deleted)
      ) AS valid`, [ns, JSON.stringify(source)]);
    return rows[0].valid;
  }

  async matchesTokens(ns: string, page: string, tokens: string[]) {
    const result = await this.pool.query(`SELECT 1 FROM ${schema}.graph_sections WHERE ns=$1 AND page=$2 AND tokens && $3::text[] LIMIT 1`, [ns, page, tokens]);
    return !!result.rowCount;
  }

  async pageIds(ns: string, prefix: string, after: string, tokens: string[], limit: number) {
    const { rows } = await this.pool.query<{ page: string }>(`SELECT page FROM ${schema}.graph_pages p
      WHERE ns=$1 AND ($2 || page) COLLATE "C">$3 COLLATE "C"
      AND (cardinality($4::text[])=0 OR EXISTS (SELECT 1 FROM ${schema}.graph_sections s
        WHERE s.ns=p.ns AND s.page=p.page AND s.tokens && $4::text[])) ORDER BY page LIMIT $5`,
    [ns, prefix, after, tokens, limit]);
    return rows.map(row => row.page);
  }

  async edgeCount(ns: string, pages: string[]) {
    const { rows } = await this.pool.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${schema}.graph_edges
      WHERE ns=$1 AND source=ANY($2::text[]) AND target=ANY($2::text[])`, [ns, pages]);
    return rows[0].n;
  }

  async linkedPages(ns: string, page: string, incoming: boolean, limit: number) {
    const { rows } = await this.pool.query<{ page: string }>(`SELECT target AS page FROM ${schema}.graph_edges WHERE ns=$1 AND source=$2
      ${incoming ? `UNION SELECT source AS page FROM ${schema}.graph_edges WHERE ns=$1 AND target=$2` : ""}
      ORDER BY page LIMIT $3`, [ns, page, limit]);
    return rows.map(row => row.page);
  }

  async sectionIndex(ns: string, page: string) {
    const { rows } = await this.pool.query<{ content: string; tokens: string[] }>(
      `SELECT content,tokens FROM ${schema}.graph_sections WHERE ns=$1 AND page=$2 ORDER BY ordinal LIMIT 129`, [ns, page]);
    return rows.map(row => ({ content: row.content, tokens: row.tokens.join(" ") }));
  }

  close() { return this.pool.end(); }
}
