BEGIN;
ALTER TABLE hermes_agui_host.run_outbox ADD COLUMN evidence_generation text
    CHECK (length(evidence_generation) BETWEEN 1 AND 128);
INSERT INTO hermes_agui_host.schema_version VALUES (3);
COMMIT;
