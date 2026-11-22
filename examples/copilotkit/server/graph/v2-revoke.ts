import type { GraphConnection } from "./v2-store";
/** Evidence remains immutable. Reads join live source versions; indexes are invalidated synchronously. */
export async function revokeGraph(db: GraphConnection, ns: string, source: string) {
  const pages = await db.rows(`SELECT DISTINCT s.wiki_page_id FROM graph_subject_attribute_evidence a
    JOIN graph_subjects s ON s.ns=a.ns AND s.subject_id=a.subject_id WHERE a.ns=$1 AND a.source_id=$2`,[ns,source]);
  await db.rows(`DELETE FROM graph_edge_embeddings WHERE ns=$1 AND edge_id IN
    (SELECT edge_id FROM graph_edge_evidence WHERE ns=$2 AND source_id=$3)`,[ns,ns,source]);
  return pages.map(row => String(row.wiki_page_id));
}
