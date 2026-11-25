-- Schema owner applies after Runtime 011/012. Operators create LOGIN identities separately.
-- No Host database-owner identity is granted access to the Runtime control plane.
BEGIN;
GRANT USAGE ON SCHEMA hermes_agui_runtime TO hermes_llm_admin,hermes_llm_runtime,hermes_llm_reader,hermes_llm_host_reader;
GRANT SELECT ON hermes_agui_runtime.llm_drafts,hermes_agui_runtime.llm_releases,
  hermes_agui_runtime.llm_active_release,hermes_agui_runtime.llm_admin_events,
  hermes_agui_runtime.llm_run_pins,hermes_agui_runtime.llm_bot_roles
  TO hermes_llm_admin,hermes_llm_runtime,hermes_llm_reader;
GRANT SELECT ON hermes_agui_runtime.llm_releases,hermes_agui_runtime.llm_run_pins,
  hermes_agui_runtime.llm_active_release TO hermes_llm_host_reader;
GRANT SELECT ON hermes_agui_runtime.bot_registry TO hermes_llm_admin;
GRANT SELECT(id,principal,record) ON hermes_agui_runtime.bot_registry TO hermes_llm_runtime;
GRANT SELECT(llm_release_id) ON hermes_agui_runtime.graph_jobs TO hermes_llm_admin;
GRANT INSERT ON hermes_agui_runtime.llm_drafts,hermes_agui_runtime.llm_releases,
  hermes_agui_runtime.llm_active_release,hermes_agui_runtime.llm_admin_events,
  hermes_agui_runtime.llm_bot_roles TO hermes_llm_admin;
GRANT UPDATE ON hermes_agui_runtime.llm_drafts,hermes_agui_runtime.llm_active_release TO hermes_llm_admin;
GRANT USAGE ON SEQUENCE hermes_agui_runtime.llm_admin_events_event_id_seq TO hermes_llm_admin;
GRANT INSERT ON hermes_agui_runtime.llm_run_pins TO hermes_llm_runtime;
-- Graph enqueue reads the pointer inside its existing source/job transaction.
GRANT SELECT ON hermes_agui_runtime.llm_active_release TO hermes_runtime;
GRANT SELECT(scope,release_id,release_fingerprint) ON hermes_agui_runtime.llm_releases TO hermes_runtime;
COMMIT;
-- Apply after additive Runtime 012; consumers only need immutable snapshot reads.
GRANT SELECT,INSERT ON hermes_agui_runtime.llm_prompt_versions,
  hermes_agui_runtime.llm_prompt_evaluations,hermes_agui_runtime.llm_embedding_plans TO hermes_llm_admin;
