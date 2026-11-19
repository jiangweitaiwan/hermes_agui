BEGIN;
CREATE TABLE hermes_agui_runtime.task_deliveries (
  job uuid PRIMARY KEY REFERENCES hermes_agui_runtime.graph_jobs(id),
  next_delivery timestamptz NOT NULL DEFAULT clock_timestamp(),
  deliveries bigint NOT NULL DEFAULT 0
);
CREATE FUNCTION hermes_agui_runtime.schedule_graph_job() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO hermes_agui_runtime.task_deliveries(job) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER schedule_graph_job AFTER INSERT ON hermes_agui_runtime.graph_jobs
FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.schedule_graph_job();
INSERT INTO hermes_agui_runtime.task_deliveries(job) SELECT id FROM hermes_agui_runtime.graph_jobs ON CONFLICT DO NOTHING;
COMMIT;
