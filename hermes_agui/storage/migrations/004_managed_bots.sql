BEGIN;

CREATE TABLE hermes_agui_host.managed_bots (
    project text NOT NULL,
    principal text NOT NULL,
    bot text NOT NULL,
    revision uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
    session_home_identity text CHECK (session_home_identity <> ''),
    spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND NOT (spec ?| ARRAY['token', 'memoryKey'])),
    PRIMARY KEY (project, bot),
    FOREIGN KEY (project, principal, bot) REFERENCES hermes_agui_host.bot_state
);
INSERT INTO hermes_agui_host.schema_version VALUES (4);
COMMIT;
