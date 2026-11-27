BEGIN;
CREATE TABLE hermes_agui_runtime.deployment_fence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  closed boolean NOT NULL DEFAULT false,
  jobs_closed boolean NOT NULL DEFAULT false
);
INSERT INTO hermes_agui_runtime.deployment_fence VALUES (true,false,false);
CREATE FUNCTION hermes_agui_runtime.check_deployment_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM hermes_agui_runtime.deployment_fence WHERE singleton FOR SHARE;
  IF COALESCE((SELECT CASE WHEN TG_TABLE_NAME='graph_jobs' THEN jobs_closed ELSE closed END
      FROM hermes_agui_runtime.deployment_fence WHERE singleton),true) THEN
    RAISE EXCEPTION 'Deployment maintenance: new tasks paused';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hermes_agui_runtime.check_deployment_fence() FROM PUBLIC;
CREATE TRIGGER deployment_admission BEFORE INSERT ON hermes_agui_runtime.llm_run_pins
FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.check_deployment_fence();
CREATE TRIGGER deployment_admission BEFORE INSERT ON hermes_agui_runtime.graph_jobs
FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.check_deployment_fence();
-- The existing control administrator may inspect the fence, but cannot open it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_llm_admin') THEN
    GRANT SELECT ON hermes_agui_runtime.deployment_fence TO hermes_llm_admin;
  END IF;
END $$;
COMMIT;
