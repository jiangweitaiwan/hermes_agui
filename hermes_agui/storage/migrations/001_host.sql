-- Apply once with the Host schema owner. Grant runtime DML separately.
BEGIN;

CREATE SCHEMA hermes_agui_host;
CREATE TABLE hermes_agui_host.schema_version (version integer PRIMARY KEY);
INSERT INTO hermes_agui_host.schema_version VALUES (1);

CREATE TABLE hermes_agui_host.bot_state (
    project text NOT NULL CHECK (project <> ''),
    principal text NOT NULL CHECK (principal <> ''),
    bot text NOT NULL CHECK (bot <> ''),
    fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
    active_run text,
    expires_at timestamptz,
    profile jsonb CHECK (profile IS NULL OR jsonb_typeof(profile) = 'object'),
    PRIMARY KEY (project, principal, bot),
    CHECK ((active_run IS NULL) = (expires_at IS NULL))
);

CREATE TABLE hermes_agui_host.runs (
    project text NOT NULL,
    principal text NOT NULL,
    bot text NOT NULL,
    run_id text NOT NULL CHECK (run_id <> ''),
    thread_id text NOT NULL CHECK (thread_id <> ''),
    attempt uuid NOT NULL,
    fence bigint NOT NULL CHECK (fence > 0),
    status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
    created_at timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL,
    finished_at timestamptz,
    reason text,
    PRIMARY KEY (project, principal, bot, run_id),
    FOREIGN KEY (project, principal, bot) REFERENCES hermes_agui_host.bot_state,
    CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX runs_by_thread ON hermes_agui_host.runs
    (project, principal, bot, thread_id, created_at DESC, run_id);

CREATE FUNCTION hermes_agui_host.begin_run(
    p_project text, p_principal text, p_bot text, p_thread text, p_run text,
    p_attempt uuid, p_seconds integer
) RETURNS bigint LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    bot_row hermes_agui_host.bot_state%ROWTYPE;
    current_time_db timestamptz;
BEGIN
    IF p_seconds IS NULL OR p_seconds < 1 OR p_seconds > 300 THEN
        RAISE EXCEPTION 'Invalid lease duration';
    END IF;
    SELECT * INTO STRICT bot_row FROM hermes_agui_host.bot_state
        WHERE (project, principal, bot) = (p_project, p_principal, p_bot) FOR UPDATE;
    current_time_db := clock_timestamp();
    IF bot_row.active_run IS NOT NULL AND bot_row.expires_at <= current_time_db THEN
        UPDATE hermes_agui_host.runs SET status = 'interrupted',
            reason = 'lease_expired', finished_at = current_time_db
            WHERE (project, principal, bot, run_id) = (p_project, p_principal, p_bot, bot_row.active_run)
                AND status = 'running';
        UPDATE hermes_agui_host.bot_state SET active_run = NULL, expires_at = NULL
            WHERE (project, principal, bot) = (p_project, p_principal, p_bot);
        bot_row.active_run := NULL;
    END IF;
    IF bot_row.active_run IS NOT NULL OR EXISTS (
        SELECT 1 FROM hermes_agui_host.runs
        WHERE (project, principal, bot, run_id) = (p_project, p_principal, p_bot, p_run)
    ) THEN
        RETURN NULL;
    END IF;
    UPDATE hermes_agui_host.bot_state SET fence = fence + 1, active_run = p_run,
        expires_at = current_time_db + make_interval(secs => p_seconds)
        WHERE (project, principal, bot) = (p_project, p_principal, p_bot)
        RETURNING fence INTO bot_row.fence;
    INSERT INTO hermes_agui_host.runs (project, principal, bot, run_id, thread_id,
        attempt, fence, status, created_at, heartbeat_at)
    VALUES (p_project, p_principal, p_bot, p_run, p_thread,
        p_attempt, bot_row.fence, 'running', current_time_db, current_time_db);
    RETURN bot_row.fence;
END;
$$;
COMMIT;
