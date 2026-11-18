BEGIN;

CREATE TABLE hermes_agui_host.run_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project text NOT NULL,
    principal text NOT NULL,
    bot text NOT NULL,
    run_id text NOT NULL,
    profile_revision text NOT NULL CHECK (profile_revision ~ '^[0-9a-f]{32}$'),
    profile jsonb NOT NULL CHECK (profile->>'revision' IS NOT DISTINCT FROM profile_revision),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivered_at timestamptz,
    UNIQUE (project, principal, bot, run_id),
    FOREIGN KEY (project, principal, bot, run_id) REFERENCES hermes_agui_host.runs,
    CHECK ((status = 'leased') = (lease_until IS NOT NULL)),
    CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

CREATE INDEX run_outbox_pending ON hermes_agui_host.run_outbox (available_at, id)
    WHERE status = 'pending';
CREATE INDEX run_outbox_expired ON hermes_agui_host.run_outbox (lease_until, id)
    WHERE status = 'leased';
INSERT INTO hermes_agui_host.schema_version VALUES (2);

COMMIT;
