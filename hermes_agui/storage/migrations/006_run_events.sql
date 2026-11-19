BEGIN;
ALTER TABLE hermes_agui_host.runs ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE hermes_agui_host.runs ADD COLUMN input jsonb;
CREATE TABLE hermes_agui_host.run_events (
  project text NOT NULL, principal text NOT NULL, bot text NOT NULL, run_id text NOT NULL,
  attempt uuid NOT NULL, seq bigint NOT NULL CHECK(seq>0),
  event_type text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project,principal,bot,run_id,seq),
  FOREIGN KEY(project,principal,bot,run_id) REFERENCES hermes_agui_host.runs
);
INSERT INTO hermes_agui_host.schema_version VALUES(6);
COMMIT;
