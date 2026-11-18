BEGIN;
ALTER TABLE hermes_agui_host.managed_bots
  ADD COLUMN applied_revision bigint NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
  ADD COLUMN applied_operation uuid,
  ADD COLUMN applied_spec_hash text;
CREATE TABLE hermes_agui_host.management_operations (
    operation_id uuid PRIMARY KEY,
    project text NOT NULL,
    principal text NOT NULL,
    bot text NOT NULL,
    desired_revision bigint NOT NULL CHECK (desired_revision > 0),
    spec_hash text NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('active','disabled','deleted')),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (project,bot,desired_revision),
    FOREIGN KEY (project,bot) REFERENCES hermes_agui_host.managed_bots(project,bot)
);
INSERT INTO hermes_agui_host.schema_version VALUES (5);
COMMIT;
