BEGIN;
CREATE FUNCTION hermes_agui_runtime.acquire_graph_delivery() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed boolean;
BEGIN
  SELECT NOT jobs_closed INTO allowed FROM hermes_agui_runtime.deployment_fence WHERE singleton FOR SHARE;
  RETURN COALESCE(allowed,false);
END $$;
REVOKE ALL ON FUNCTION hermes_agui_runtime.acquire_graph_delivery() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_runtime') THEN
    GRANT EXECUTE ON FUNCTION hermes_agui_runtime.acquire_graph_delivery() TO hermes_runtime;
  END IF;
END $$;
COMMIT;
