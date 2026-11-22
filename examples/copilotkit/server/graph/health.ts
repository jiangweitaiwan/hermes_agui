import { namespaceKey, WikiStore } from "./wiki-store";
import type { Namespace } from "./types";
import { DocumentIngestor } from "./ingest-queue";
import { terms } from "./markdown";

/** Counts only, scoped to the administrator-selected namespace. Never auto-delete knowledge. */
export function wikiHealth(queue: DocumentIngestor, namespace: Namespace) {
  const store = queue.store, ns = namespaceKey(namespace);
  const result = { pages: 0, brokenLinks: 0, isolated: 0, staleProvenance: 0, conflicts: 0, indexDrift: 0,
    pending: 0, failed: 0, lagMs: 0 };
  for (const row of store.db.prepare("SELECT page FROM pages WHERE ns=?").all(ns)) {
    result.pages++;
    const page = store.read(store.active(ns, String(row.page))!);
    result.brokenLinks += page.links.filter(target => !store.active(ns, target)).length;
    if (!store.db.prepare("SELECT 1 FROM edges WHERE ns=? AND (source=? OR target=?) LIMIT 1").get(ns, page.id, page.id)) result.isolated++;
    if (page.verification === "disputed") result.conflicts++;
    for (const source of page.sources) {
      const id = "kind" in source ? source.sourceId : queue.sessionSource(ns, source);
      const valid = "kind" in source
        ? store.db.prepare("SELECT 1 FROM document_sources WHERE ns=? AND id=? AND version=? AND hash=? AND deleted=0").get(ns, source.sourceId, source.version, source.hash)
        : id && store.db.prepare("SELECT 1 FROM document_sources WHERE ns=? AND id=? AND deleted=0").get(ns, id);
      if (!valid) result.staleProvenance++;
    }
    const sections = store.db.prepare("SELECT content,tokens FROM sections WHERE ns=? AND page=? ORDER BY CAST(ordinal AS INTEGER)").all(ns, page.id);
    if (sections.length !== page.sections.length || sections.some((s, i) => s.content !== page.sections[i] ||
      s.tokens !== terms(`${page.title} ${page.tags.join(" ")} ${page.sections[i]}`).join(" "))) result.indexDrift++;
    const indexed = store.db.prepare("SELECT target FROM edges WHERE ns=? AND source=? ORDER BY target").all(ns, page.id).map(r => String(r.target));
    if (JSON.stringify(indexed) !== JSON.stringify([...new Set(page.links)].sort())) result.indexDrift++;
  }
  const states = store.db.prepare("SELECT state,count(*) AS n FROM ingest_jobs WHERE ns=? GROUP BY state").all(ns);
  result.pending = Number(states.find(r => r.state === "pending")?.n ?? 0);
  result.failed = Number(states.find(r => r.state === "failed")?.n ?? 0);
  const oldest = store.db.prepare(`SELECT min(created) AS t FROM completion_times WHERE ns=? AND job IN
    (SELECT id FROM ingest_jobs WHERE ns=? AND state IN ('pending','running'))`).get(ns, ns)?.t;
  result.lagMs = oldest ? Math.max(0, Date.now() - Number(oldest)) : 0;
  const count = (table: string) => Number(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ns=?`).get(ns)?.n ?? 0);
  return {...result,subjects:count("graph_subjects"),factEdges:count("graph_fact_edges"),events:count("graph_events"),
    edgeEvidence:count("graph_edge_evidence"),attributeEvidence:count("graph_subject_attribute_evidence"),edgeEmbeddings:count("graph_edge_embeddings")};
}
export function scopedReindex(store: WikiStore, ns: Namespace) { store.reindex(ns); }
