BEGIN;

CREATE TABLE hermes_agui_runtime.bot_registry (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{0,63}$'),
    principal text NOT NULL CHECK (octet_length(principal) BETWEEN 1 AND 256),
    record jsonb NOT NULL CHECK ((record->>'id') IS NOT DISTINCT FROM id)
);

COMMIT;
