BEGIN;

CREATE TABLE hermes_agui_runtime.delegation_mappings (
    project text NOT NULL CHECK (octet_length(project) BETWEEN 1 AND 256),
    principal text NOT NULL CHECK (octet_length(principal) BETWEEN 1 AND 256),
    source_bot text NOT NULL CHECK (source_bot ~ '^[a-z][a-z0-9_-]{0,63}$'),
    target_bot text NOT NULL CHECK (target_bot ~ '^[a-z][a-z0-9_-]{0,63}$' AND target_bot <> source_bot),
    parent_call bytea NOT NULL CHECK (octet_length(parent_call) = 32),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    delegation_id uuid NOT NULL UNIQUE,
    child_thread uuid NOT NULL UNIQUE,
    child_run uuid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project, principal, source_bot, parent_call)
);

COMMIT;
