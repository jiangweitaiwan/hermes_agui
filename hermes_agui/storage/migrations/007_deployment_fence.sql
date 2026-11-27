BEGIN;
CREATE TABLE hermes_agui_host.deployment_fence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  closed boolean NOT NULL DEFAULT false
);
INSERT INTO hermes_agui_host.deployment_fence VALUES (true,false);
CREATE FUNCTION hermes_agui_host.check_deployment_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  -- Row lock serializes admission with maintenance fencing, including old Images.
  PERFORM 1 FROM hermes_agui_host.deployment_fence WHERE singleton FOR SHARE;
  IF COALESCE((SELECT closed FROM hermes_agui_host.deployment_fence WHERE singleton),true) THEN
    RAISE EXCEPTION 'Deployment maintenance: new runs paused';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hermes_agui_host.check_deployment_fence() FROM PUBLIC;
CREATE TRIGGER deployment_admission BEFORE INSERT ON hermes_agui_host.runs
FOR EACH ROW EXECUTE FUNCTION hermes_agui_host.check_deployment_fence();
INSERT INTO hermes_agui_host.schema_version VALUES (7);
COMMIT;
