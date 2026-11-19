-- Run as the schema owner after migrations. Create LOGIN roles and passwords separately.
GRANT USAGE ON SCHEMA hermes_agui_host TO hermes_host;
GRANT SELECT ON hermes_agui_host.schema_version TO hermes_host;
GRANT SELECT,INSERT,UPDATE ON hermes_agui_host.bot_state,hermes_agui_host.runs,
  hermes_agui_host.run_outbox,hermes_agui_host.managed_bots TO hermes_host;
GRANT SELECT,INSERT ON hermes_agui_host.management_operations TO hermes_host;
GRANT EXECUTE ON FUNCTION hermes_agui_host.begin_run(text,text,text,text,text,uuid,integer) TO hermes_host;
GRANT USAGE ON SCHEMA hermes_agui_runtime TO hermes_runtime;
GRANT SELECT,INSERT ON hermes_agui_runtime.thread_mappings,hermes_agui_runtime.delegation_mappings,
  hermes_agui_runtime.graph_revisions,hermes_agui_runtime.graph_revision_provenance,
  hermes_agui_runtime.graph_source_owners,hermes_agui_runtime.graph_session_origins,
  hermes_agui_runtime.graph_ingest_keys,hermes_agui_runtime.graph_session_knowledge TO hermes_runtime;
GRANT SELECT,INSERT,UPDATE ON hermes_agui_runtime.bot_registry,hermes_agui_runtime.bot_operations,
  hermes_agui_runtime.graph_namespaces,hermes_agui_runtime.graph_sources,hermes_agui_runtime.graph_jobs TO hermes_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON hermes_agui_runtime.graph_pages,hermes_agui_runtime.graph_embeddings TO hermes_runtime;
GRANT SELECT,INSERT,DELETE ON hermes_agui_runtime.graph_page_owners,hermes_agui_runtime.graph_edges,
  hermes_agui_runtime.graph_sections TO hermes_runtime;

GRANT SELECT,INSERT,DELETE ON hermes_agui_host.run_events TO hermes_host;
GRANT SELECT,INSERT,UPDATE ON hermes_agui_runtime.task_deliveries TO hermes_runtime;
