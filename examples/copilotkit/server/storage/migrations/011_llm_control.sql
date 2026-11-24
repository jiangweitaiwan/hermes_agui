BEGIN;
-- An aggregate draft prevents torn provider/model reads. Prompt versions remain code-owned in Part 1.
CREATE TABLE hermes_agui_runtime.llm_drafts (
  scope text PRIMARY KEY CHECK (scope='deployment'),
  config jsonb NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE hermes_agui_runtime.llm_releases (
  scope text NOT NULL CHECK (scope='deployment'),
  release_id text NOT NULL,
  parent_release_id text,
  snapshot jsonb NOT NULL,
  model_fingerprint text NOT NULL CHECK (model_fingerprint ~ '^[a-f0-9]{64}$'),
  task_fingerprint text NOT NULL CHECK (task_fingerprint ~ '^[a-f0-9]{64}$'),
  release_fingerprint text NOT NULL CHECK (release_fingerprint ~ '^[a-f0-9]{64}$'),
  validated boolean NOT NULL CHECK (validated),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  PRIMARY KEY (scope,release_id),
  UNIQUE (scope,release_id,validated),
  FOREIGN KEY (scope,parent_release_id) REFERENCES hermes_agui_runtime.llm_releases(scope,release_id)
);
CREATE TABLE hermes_agui_runtime.llm_active_release (
  scope text PRIMARY KEY CHECK (scope='deployment'),
  release_id text NOT NULL,
  validated boolean NOT NULL DEFAULT true CHECK (validated),
  generation integer NOT NULL CHECK (generation>0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (scope,release_id,validated) REFERENCES hermes_agui_runtime.llm_releases(scope,release_id,validated)
);
CREATE TABLE hermes_agui_runtime.llm_admin_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope text NOT NULL CHECK (scope='deployment'),
  action text NOT NULL CHECK (action IN ('bootstrap','draft_update','validate','publish','rollback','probe','bot_opt_in')),
  actor text NOT NULL, request_id uuid NOT NULL,
  old_release text, new_release text, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION hermes_agui_runtime.llm_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable LLM history';
END $$;
CREATE TRIGGER llm_release_immutable BEFORE UPDATE OR DELETE ON hermes_agui_runtime.llm_releases
  FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.llm_immutable();
CREATE TRIGGER llm_audit_immutable BEFORE UPDATE OR DELETE ON hermes_agui_runtime.llm_admin_events
  FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.llm_immutable();
CREATE TABLE hermes_agui_runtime.llm_run_pins (
  scope text NOT NULL, principal text NOT NULL, bot text NOT NULL, thread text NOT NULL, run text NOT NULL,
  release_id text NOT NULL,
  PRIMARY KEY (scope,principal,bot,thread,run),
  FOREIGN KEY (scope,release_id) REFERENCES hermes_agui_runtime.llm_releases(scope,release_id)
);
CREATE TRIGGER llm_run_pin_immutable BEFORE UPDATE OR DELETE ON hermes_agui_runtime.llm_run_pins
  FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.llm_immutable();
CREATE TABLE hermes_agui_runtime.llm_bot_roles (
  scope text NOT NULL CHECK (scope='deployment'), bot text NOT NULL REFERENCES hermes_agui_runtime.bot_registry(id),
  principal text NOT NULL, template text NOT NULL, role text NOT NULL CHECK (role='agent_primary'),
  legacy_model text NOT NULL, legacy_provider text NOT NULL, created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope,bot)
);
CREATE TRIGGER llm_bot_role_immutable BEFORE UPDATE OR DELETE ON hermes_agui_runtime.llm_bot_roles
  FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.llm_immutable();
ALTER TABLE hermes_agui_runtime.graph_jobs ADD COLUMN llm_scope text;
ALTER TABLE hermes_agui_runtime.graph_jobs ADD COLUMN llm_release_id text;
ALTER TABLE hermes_agui_runtime.graph_jobs ADD CONSTRAINT graph_job_release_pair
  CHECK ((llm_scope IS NULL) = (llm_release_id IS NULL));
ALTER TABLE hermes_agui_runtime.graph_jobs ADD CONSTRAINT graph_job_release_fk
  FOREIGN KEY (llm_scope,llm_release_id) REFERENCES hermes_agui_runtime.llm_releases(scope,release_id);
CREATE FUNCTION hermes_agui_runtime.llm_job_pin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.llm_scope IS DISTINCT FROM OLD.llm_scope OR NEW.llm_release_id IS DISTINCT FROM OLD.llm_release_id THEN
    RAISE EXCEPTION 'immutable job release pin';
  END IF;
  IF NEW.llm_release_id IS NOT NULL AND NEW.state='running' AND NEW.token IS DISTINCT FROM OLD.token
      AND current_setting('hermes.llm_contract',true) IS DISTINCT FROM 'management-part-1' THEN
    RAISE EXCEPTION 'pinned job requires compatible reader';
  END IF;
  IF NEW.llm_release_id IS NOT NULL AND NEW.state='completed' AND OLD.state<>'completed'
      AND current_setting('hermes.llm_release_id',true) IS DISTINCT FROM NEW.llm_release_id THEN
    RAISE EXCEPTION 'pinned job requires verified release publication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER llm_job_pin_immutable BEFORE UPDATE ON hermes_agui_runtime.graph_jobs
  FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.llm_job_pin_immutable();
COMMIT;
