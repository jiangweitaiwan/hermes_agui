BEGIN;
ALTER TABLE hermes_agui_host.deployment_fence ADD COLUMN deliveries_closed boolean NOT NULL DEFAULT false;
CREATE FUNCTION hermes_agui_host.acquire_completion_delivery() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed boolean;
BEGIN
  SELECT NOT deliveries_closed INTO allowed FROM hermes_agui_host.deployment_fence WHERE singleton FOR SHARE;
  RETURN COALESCE(allowed,false);
END $$;
REVOKE ALL ON FUNCTION hermes_agui_host.acquire_completion_delivery() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_host') THEN
    GRANT EXECUTE ON FUNCTION hermes_agui_host.acquire_completion_delivery() TO hermes_host;
  END IF;
END $$;
INSERT INTO hermes_agui_host.schema_version VALUES (8);
COMMIT;
