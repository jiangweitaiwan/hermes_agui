BEGIN;
CREATE TABLE hermes_agui_runtime.graph_jobs (
    id uuid PRIMARY KEY,
    ns text NOT NULL,
    source uuid NOT NULL,
    version integer NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','running','completed','failed','cancelled')),
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
    token uuid,
    lease timestamptz,
    available timestamptz NOT NULL DEFAULT clock_timestamp(),
    error text,
    created timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (ns,source,version),
    FOREIGN KEY (ns,source,version) REFERENCES hermes_agui_runtime.graph_sources(ns,id,version)
);
CREATE INDEX graph_jobs_dispatch ON hermes_agui_runtime.graph_jobs(ns,state,available,lease);
CREATE TABLE hermes_agui_runtime.graph_ingest_keys (
    ns text NOT NULL REFERENCES hermes_agui_runtime.graph_namespaces(id),
    key text NOT NULL,
    fingerprint text NOT NULL,
    job uuid NOT NULL REFERENCES hermes_agui_runtime.graph_jobs(id),
    PRIMARY KEY (ns,key)
);
CREATE TABLE hermes_agui_runtime.graph_session_knowledge (
    ns text NOT NULL REFERENCES hermes_agui_runtime.graph_namespaces(id),
    hash text NOT NULL,
    job uuid NOT NULL REFERENCES hermes_agui_runtime.graph_jobs(id),
    PRIMARY KEY (ns,hash)
);
COMMIT;
