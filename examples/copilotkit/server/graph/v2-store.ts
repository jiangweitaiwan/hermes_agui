import { terms } from "./markdown";
import type { PoolClient } from "pg";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { GraphData, Subject, Attribute, FactEdge } from "./v2-types";
import { GraphDataSchema } from "./v2-types";
import type { RawSource } from "./ingest-queue";
import { digest } from "./wiki-store";
export interface GraphConnection {
  rows(sql: string, args?: unknown[]): Promise<Record<string, any>[]>;
}
export function sqliteGraphConnection(db: DatabaseSync): GraphConnection {
  return { async rows(sql, args = []) {
    const statement = db.prepare(sql.replace(/\$\d+/g, "?"));
    if (/^SELECT/i.test(sql)) return statement.all(...args as SQLInputValue[]);
    statement.run(...args as SQLInputValue[]); return [];
  } };
}
export function postgresGraphConnection(client: PoolClient): GraphConnection {
  return { async rows(sql, args = []) { return (await client.query(sql.replace(/\bgraph_\w+/g, name => `hermes_agui_runtime.${name}`).replace(/document_sources/g, "hermes_agui_runtime.graph_sources"), args)).rows; } };
}
export async function readSubjects(db: GraphConnection, ns: string): Promise<Subject[]> {
  const rows = await db.rows(`SELECT s.data FROM graph_subjects s WHERE s.ns=$1 AND EXISTS (SELECT 1 FROM graph_subject_aliases a
    JOIN document_sources d ON d.ns=a.ns AND d.id=a.source_id AND d.version=a.source_version
    WHERE a.ns=s.ns AND a.subject_id=s.subject_id AND NOT d.deleted) ORDER BY s.subject_id LIMIT 1001`, [ns]);
  if (rows.length > 1000) throw new Error("Subject matching budget; narrow namespace required");
  const aliases = await db.rows(`SELECT DISTINCT a.subject_id,a.alias_normalized FROM graph_subject_aliases a
    JOIN document_sources d ON d.ns=a.ns AND d.id=a.source_id AND d.version=a.source_version
    WHERE a.ns=$1 AND NOT d.deleted ORDER BY a.subject_id,a.alias_normalized LIMIT 20001`,[ns]);
  if (aliases.length > 20000) throw new Error("Alias matching budget");
  return rows.map(r => { const s:Subject = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    return {...s,aliases:aliases.filter(a=>a.subject_id===s.subjectId).map(a=>String(a.alias_normalized))}; });
}
export async function readAttributes(db: GraphConnection, ns: string, page: string): Promise<Attribute[]> {
  const rows = await db.rows(`SELECT a.data FROM graph_subject_attribute_evidence a
    JOIN graph_subjects s ON s.ns=a.ns AND s.subject_id=a.subject_id
    JOIN document_sources d ON d.ns=a.ns AND d.id=a.source_id AND d.version=a.source_version
    WHERE a.ns=$1 AND s.wiki_page_id=$2 AND NOT d.deleted ORDER BY a.attribute_id LIMIT 1001`, [ns, page]);
  if (rows.length > 1000) throw new Error("Attribute budget");
  return rows.map(r => typeof r.data === "string" ? JSON.parse(r.data) : r.data);
}
function* lexicalStatements(ns:string,edge:FactEdge):Generator<{sql:string;args:unknown[]},void,Record<string,any>[]> {
  for (const token of terms(`${edge.description} ${edge.relation}`))
    yield {sql:"INSERT INTO graph_fact_tokens VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",args:[ns,edge.edgeId,token]};
}
/** Must run inside the same transaction as Wiki CAS and lease completion. */
function* graphStatements(ns: string, input: GraphData, source: RawSource): Generator<{ sql: string; args: unknown[] }, void, Record<string, any>[]> {
  const data = GraphDataSchema.parse({subjects:input.subjects,events:input.events,edges:input.edges,attributes:input.attributes});
  const mode = (yield { sql: "SELECT version FROM graph_compiler_namespaces WHERE ns=$1", args: [ns] });
  if (mode[0] && mode[0].version !== "v2") throw new Error("Namespace compiler version conflict");
  (yield { sql: "INSERT INTO graph_compiler_namespaces VALUES ($1,'v2') ON CONFLICT DO NOTHING", args: [ns] });
  const check = (e: import("./v2-types").Evidence) => {
    if (e.sourceId !== source.id || e.sourceVersion !== source.version || digest(e.quote) !== e.quoteHash ||
      source.content.slice(e.position, e.position + e.quote.length) !== e.quote) throw new Error("Invalid publication evidence");
  };
  const remaining = [...data.subjects]; const inserted = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex(s => !s.parentSubjectId || inserted.has(s.parentSubjectId) || !remaining.some(p => p.subjectId === s.parentSubjectId));
    if (index < 0) throw new Error("Subject parent cycle");
    const s = remaining.splice(index, 1)[0];
    const old = (yield { sql: "SELECT data FROM graph_subjects WHERE ns=$1 AND subject_id=$2", args: [ns, s.subjectId] });
    if (old[0]) {
      const prior: Subject = typeof old[0].data === "string" ? JSON.parse(old[0].data) : old[0].data;
      if (prior.identityKey !== s.identityKey || prior.wikiPageId !== s.wikiPageId || prior.sectionKey !== s.sectionKey) throw new Error("Subject identity conflict");
    }
    (yield { sql: `INSERT INTO graph_subjects VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, args: [ns,s.subjectId,s.identityKey,s.wikiPageId,s.parentSubjectId ?? null,s.sectionKey,JSON.stringify(s),s.canonicalName,s.type,new Date().toISOString(),new Date().toISOString()] });
    for (const alias of [s.canonicalName, ...s.aliases]) (yield { sql: `INSERT INTO graph_subject_aliases VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, args: [ns,s.subjectId,alias.normalize("NFKC").toLowerCase(),source.id,source.version] });
    inserted.add(s.subjectId);
  }
  for (const event of data.events) (yield { sql: "INSERT INTO graph_events VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", args: [ns,event.eventId,JSON.stringify(event)] });
  for (const edge of data.edges) {
    for (const e of edge.evidence) check(e);
    const { evidence: _, ...record } = edge;
    (yield { sql: "INSERT INTO graph_fact_edges VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING", args: [ns,edge.edgeId,edge.eventId ?? null,edge.fromSubjectId,edge.toSubjectId,edge.relation,edge.factKind,edge.stateSlotKey ?? null,edge.time.occurredFrom ?? null,edge.semanticHash,JSON.stringify(record)] });
    yield* lexicalStatements(ns,edge);
    for (const e of edge.evidence) (yield { sql: "INSERT INTO graph_edge_evidence VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", args: [ns,edge.edgeId,e.sourceId,e.sourceVersion,e.quoteHash,JSON.stringify(e)] });
  }
  for (const a of data.attributes) {
    check(a.evidence);
    (yield { sql: "INSERT INTO graph_subject_attribute_evidence VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", args: [ns,a.attributeId,a.subjectId,a.evidence.sourceId,a.evidence.sourceVersion,JSON.stringify(a)] });
  }
}
export async function writeGraph(db: GraphConnection, ns: string, input: GraphData, source: RawSource) {
  const steps = graphStatements(ns, input, source); let step = steps.next();
  while (!step.done) step = steps.next(await db.rows(step.value.sql, step.value.args));
}
export function writeGraphSqlite(db: DatabaseSync, ns: string, input: GraphData, source: RawSource) {
  const steps = graphStatements(ns, input, source); let step = steps.next();
  while (!step.done) {
    const { sql, args } = step.value; const statement = db.prepare(sql.replace(/\$\d+/g, "?"));
    const rows = /^SELECT/i.test(sql) ? statement.all(...args as SQLInputValue[]) : (statement.run(...args as SQLInputValue[]), []);
    step = steps.next(rows);
  }
}
/** Bounded storage inspection for Part 1 acceptance; Runtime retrieval remains V1. */
export async function activeEdges(db: GraphConnection, ns: string, subjectId: string): Promise<FactEdge[]> {
  const rows = await db.rows(`SELECT f.data,e.data AS evidence FROM graph_fact_edges f JOIN graph_edge_evidence e ON e.ns=f.ns AND e.edge_id=f.edge_id
    JOIN document_sources s ON s.ns=e.ns AND s.id=e.source_id AND s.version=e.source_version
    WHERE f.ns=$1 AND (f.from_subject_id=$2 OR f.to_subject_id=$3) AND NOT s.deleted ORDER BY f.edge_id LIMIT 200`, [ns,subjectId,subjectId]);
  const edges = new Map<string, FactEdge>();
  for (const row of rows) {
    const record = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    const evidence = typeof row.evidence === "string" ? JSON.parse(row.evidence) : row.evidence;
    if (record.status === "retracted") continue;
    const edge = edges.get(record.edgeId) ?? { ...record, evidence: [] };
    edge.evidence.push(evidence); edges.set(edge.edgeId, edge);
  }
  return [...edges.values()];
}
