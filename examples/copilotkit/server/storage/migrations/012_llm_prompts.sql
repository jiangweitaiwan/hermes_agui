BEGIN;
ALTER TABLE hermes_agui_runtime.llm_admin_events DROP CONSTRAINT llm_admin_events_action_check;
ALTER TABLE hermes_agui_runtime.llm_admin_events ADD CONSTRAINT llm_admin_events_action_check
 CHECK(action IN ('bootstrap','draft_update','validate','publish','rollback','probe','bot_opt_in','playground','embedding_plan'));
ALTER TABLE hermes_agui_runtime.llm_drafts ADD COLUMN prompts jsonb;
CREATE TABLE hermes_agui_runtime.llm_prompt_versions (
  scope text NOT NULL, task_id text NOT NULL, version_id text NOT NULL,
  parent_id text, editable_text text NOT NULL,
  protected_contract_id text NOT NULL, protected_contract_hash text NOT NULL,
  effective_prompt_hash text NOT NULL, schema_version integer NOT NULL, validator_version text NOT NULL,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), change_reason text NOT NULL,
  PRIMARY KEY(scope,task_id,version_id)
);
CREATE TRIGGER llm_prompt_immutable BEFORE UPDATE OR DELETE ON hermes_agui_runtime.llm_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.llm_immutable();
CREATE TABLE hermes_agui_runtime.llm_prompt_evaluations (
  scope text NOT NULL, candidate_hash text NOT NULL, draft_revision integer NOT NULL, suite_version text NOT NULL,
  result jsonb NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope,candidate_hash,draft_revision,suite_version)
);
CREATE TRIGGER llm_evaluation_immutable BEFORE UPDATE OR DELETE ON hermes_agui_runtime.llm_prompt_evaluations
  FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.llm_immutable();
CREATE TABLE hermes_agui_runtime.llm_embedding_plans (
  scope text NOT NULL CHECK(scope='deployment'), plan_id text NOT NULL, plan jsonb NOT NULL,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope,plan_id)
);
CREATE TRIGGER llm_embedding_plan_immutable BEFORE UPDATE OR DELETE ON hermes_agui_runtime.llm_embedding_plans
  FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.llm_immutable();
COMMIT;
