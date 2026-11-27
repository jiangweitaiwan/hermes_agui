BEGIN;
-- New readers claim only the current contract. Historical pins remain immutable.
CREATE OR REPLACE FUNCTION hermes_agui_runtime.llm_job_pin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.llm_scope IS DISTINCT FROM OLD.llm_scope OR NEW.llm_release_id IS DISTINCT FROM OLD.llm_release_id THEN
    RAISE EXCEPTION 'immutable job release pin';
  END IF;
  IF NEW.llm_release_id IS NOT NULL AND NEW.state='running' AND NEW.token IS DISTINCT FROM OLD.token
      AND current_setting('hermes.llm_contract',true) IS DISTINCT FROM 'management-part-2' THEN
    RAISE EXCEPTION 'pinned job requires current reader';
  END IF;
  IF NEW.llm_release_id IS NOT NULL AND NEW.state='completed' AND OLD.state<>'completed'
      AND current_setting('hermes.llm_release_id',true) IS DISTINCT FROM NEW.llm_release_id THEN
    RAISE EXCEPTION 'pinned job requires verified release publication';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
