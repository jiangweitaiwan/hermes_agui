import type { PoolClient } from "pg";

// Only historical migrations can be adopted without a ledger entry. New files
// must run normally and commit atomically with their ledger row.
const legacyRelations: Record<string, string[]> = {
  "001_threads.sql": ["hermes_agui_runtime.thread_mappings"],
  "002_delegations.sql": ["hermes_agui_runtime.delegation_mappings"],
  "003_bot_registry.sql": ["hermes_agui_runtime.bot_registry"],
  "004_graph_wiki.sql": [
    "hermes_agui_runtime.graph_namespaces",
    "hermes_agui_runtime.graph_revisions",
    "hermes_agui_runtime.graph_pages",
    "hermes_agui_runtime.graph_page_owners",
    "hermes_agui_runtime.graph_edges",
    "hermes_agui_runtime.graph_edges_incoming",
    "hermes_agui_runtime.graph_sections",
    "hermes_agui_runtime.graph_sections_tokens",
    "hermes_agui_runtime.graph_embeddings",
  ],
  "005_graph_sources.sql": [
    "hermes_agui_runtime.graph_sources",
    "hermes_agui_runtime.graph_sources_content",
    "hermes_agui_runtime.graph_source_owners",
    "hermes_agui_runtime.graph_session_origins",
    "hermes_agui_runtime.graph_session_provenance",
    "hermes_agui_runtime.graph_revision_provenance",
    "hermes_agui_runtime.graph_revision_provenance_source",
  ],
  "006_graph_jobs.sql": [
    "hermes_agui_runtime.graph_jobs",
    "hermes_agui_runtime.graph_jobs_dispatch",
    "hermes_agui_runtime.graph_ingest_keys",
    "hermes_agui_runtime.graph_session_knowledge",
  ],
  "007_bot_operations.sql": [
    "hermes_agui_runtime.bot_operations",
    "hermes_agui_runtime.bot_operations_reconcile",
  ],
  "008_task_deliveries.sql": ["hermes_agui_runtime.task_deliveries"],
  "009_graph_memory_v2.sql": [
    "hermes_agui_runtime.graph_subjects",
    "hermes_agui_runtime.graph_subject_aliases",
    "hermes_agui_runtime.graph_subject_alias_lookup",
    "hermes_agui_runtime.graph_events",
    "hermes_agui_runtime.graph_fact_edges",
    "hermes_agui_runtime.graph_fact_from",
    "hermes_agui_runtime.graph_fact_to",
    "hermes_agui_runtime.graph_fact_event",
    "hermes_agui_runtime.graph_fact_state",
    "hermes_agui_runtime.graph_edge_evidence",
    "hermes_agui_runtime.graph_edge_evidence_source",
    "hermes_agui_runtime.graph_subject_attribute_evidence",
    "hermes_agui_runtime.graph_attribute_source",
    "hermes_agui_runtime.graph_edge_embeddings",
    "hermes_agui_runtime.graph_compiler_namespaces",
    "hermes_agui_runtime.graph_source_times",
  ],
  "010_graph_fact_tokens.sql": ["hermes_agui_runtime.graph_fact_tokens"],
};

export async function legacyMigrationApplied(client: PoolClient, name: string): Promise<boolean> {
  const relations = legacyRelations[name];
  if (!relations) return false;
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT bool_and(to_regclass(relation) IS NOT NULL) AS present FROM unnest($1::text[]) AS relation",
    [relations],
  );
  if (!rows[0].present) return false;
  if (name === "007_bot_operations.sql") {
    const result = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'hermes_agui_runtime'
       AND table_name = 'bot_registry' AND column_name = 'desired_revision'`,
    );
    if (!result.rowCount) return false;
  }
  if (name === "008_task_deliveries.sql") {
    const result = await client.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('hermes_agui_runtime.graph_jobs')
       AND tgname = 'schedule_graph_job' AND NOT tgisinternal
       AND tgfoid = to_regprocedure('hermes_agui_runtime.schedule_graph_job()')`,
    );
    if (!result.rowCount) return false;
  }
  return true;
}
