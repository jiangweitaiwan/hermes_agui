-- Disposable scenario roles. Production supplies passwords through secret storage.
CREATE ROLE fixture_host LOGIN PASSWORD 'part1-fixture-only';
CREATE ROLE fixture_runtime LOGIN PASSWORD 'part1-fixture-only';
GRANT USAGE ON SCHEMA hermes_agui_host TO fixture_host;
GRANT SELECT ON hermes_agui_host.schema_version TO fixture_host;
GRANT SELECT,INSERT,UPDATE ON hermes_agui_host.bot_state,hermes_agui_host.runs,
  hermes_agui_host.run_outbox,hermes_agui_host.managed_bots TO fixture_host;
GRANT SELECT,INSERT ON hermes_agui_host.management_operations TO fixture_host;
GRANT EXECUTE ON FUNCTION hermes_agui_host.begin_run(text,text,text,text,text,uuid,integer) TO fixture_host;
GRANT USAGE ON SCHEMA hermes_agui_runtime TO fixture_runtime;
GRANT SELECT,INSERT ON hermes_agui_runtime.thread_mappings,hermes_agui_runtime.delegation_mappings,
  hermes_agui_runtime.graph_revisions,hermes_agui_runtime.graph_revision_provenance,
  hermes_agui_runtime.graph_source_owners,hermes_agui_runtime.graph_session_origins,
  hermes_agui_runtime.graph_ingest_keys,hermes_agui_runtime.graph_session_knowledge TO fixture_runtime;
GRANT SELECT,INSERT,UPDATE ON hermes_agui_runtime.bot_registry,hermes_agui_runtime.bot_operations,
  hermes_agui_runtime.graph_namespaces,hermes_agui_runtime.graph_sources,hermes_agui_runtime.graph_jobs TO fixture_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON hermes_agui_runtime.graph_pages,hermes_agui_runtime.graph_embeddings TO fixture_runtime;
GRANT SELECT,INSERT,DELETE ON hermes_agui_runtime.graph_page_owners,hermes_agui_runtime.graph_edges,
  hermes_agui_runtime.graph_sections TO fixture_runtime;
