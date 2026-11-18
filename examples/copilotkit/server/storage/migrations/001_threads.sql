BEGIN;

CREATE SCHEMA hermes_agui_runtime;

CREATE TABLE hermes_agui_runtime.thread_mappings (
    project text NOT NULL CHECK (octet_length(project) BETWEEN 1 AND 256),
    principal text NOT NULL CHECK (octet_length(principal) BETWEEN 1 AND 256),
    bot text NOT NULL CHECK (bot ~ '^[a-z][a-z0-9_-]{0,63}$'),
    browser_thread text NOT NULL CHECK (char_length(browser_thread) BETWEEN 1 AND 512),
    host_thread text NOT NULL CHECK (char_length(host_thread) BETWEEN 1 AND 512),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project, principal, bot, browser_thread),
    UNIQUE (project, principal, bot, host_thread)
);

COMMIT;
