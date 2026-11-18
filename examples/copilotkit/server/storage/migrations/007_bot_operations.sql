BEGIN;
ALTER TABLE hermes_agui_runtime.bot_registry ADD COLUMN desired_revision bigint NOT NULL DEFAULT 0 CHECK (desired_revision>=0);
CREATE TABLE hermes_agui_runtime.bot_operations (
    operation_id uuid PRIMARY KEY,
    bot text NOT NULL REFERENCES hermes_agui_runtime.bot_registry(id),
    principal text NOT NULL,
    project text NOT NULL,
    owner_id text NOT NULL,
    desired_revision bigint NOT NULL CHECK (desired_revision>0),
    desired_state text NOT NULL CHECK (desired_state IN ('active','disabled','deleted')),
    spec_hash text NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{64}$'),
    spec jsonb NOT NULL CHECK (jsonb_typeof(spec)='object' AND NOT (spec ?| ARRAY['token','memoryKey'])),
    status text NOT NULL CHECK (status IN ('pending','unknown','applied','conflict')),
    attempt integer NOT NULL DEFAULT 0,
    error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (bot,desired_revision)
);
CREATE INDEX bot_operations_reconcile ON hermes_agui_runtime.bot_operations(status,updated_at);
COMMIT;
