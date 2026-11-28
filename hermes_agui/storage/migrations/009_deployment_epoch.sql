-- NULL preserves the existing generation on ordinary rolling upgrades.
CREATE TABLE hermes_agui_host.deployment_epoch (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 epoch uuid,
 operation text,
 resumed boolean NOT NULL DEFAULT false
);
INSERT INTO hermes_agui_host.deployment_epoch(singleton) VALUES(true);
REVOKE ALL ON hermes_agui_host.deployment_epoch FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hermes_host') THEN
  GRANT SELECT ON hermes_agui_host.deployment_epoch TO hermes_host;
END IF; END $$;
INSERT INTO hermes_agui_host.schema_version VALUES (9);
