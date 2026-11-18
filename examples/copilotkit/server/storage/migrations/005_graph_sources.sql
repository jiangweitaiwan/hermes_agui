BEGIN;
CREATE TABLE hermes_agui_runtime.graph_sources (
    ns text NOT NULL REFERENCES hermes_agui_runtime.graph_namespaces(id),
    id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    title text NOT NULL,
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    object_key text NOT NULL UNIQUE,
    generation text NOT NULL,
    size integer NOT NULL CHECK (size BETWEEN 1 AND 1048576),
    bot text NOT NULL,
    deleted boolean NOT NULL DEFAULT false,
    PRIMARY KEY (ns,id,version)
);
CREATE INDEX graph_sources_content ON hermes_agui_runtime.graph_sources(ns,hash,title) WHERE NOT deleted;
CREATE TABLE hermes_agui_runtime.graph_source_owners (
    ns text NOT NULL REFERENCES hermes_agui_runtime.graph_namespaces(id),
    source uuid NOT NULL,
    bot text NOT NULL,
    PRIMARY KEY (ns,source,bot)
);
CREATE TABLE hermes_agui_runtime.graph_session_origins (
    ns text NOT NULL REFERENCES hermes_agui_runtime.graph_namespaces(id),
    source uuid NOT NULL,
    provenance jsonb NOT NULL,
    classification text NOT NULL,
    evidence jsonb,
    PRIMARY KEY (ns,source)
);
CREATE INDEX graph_session_provenance ON hermes_agui_runtime.graph_session_origins(ns,provenance);
CREATE TABLE hermes_agui_runtime.graph_revision_provenance (
    ns text NOT NULL,
    page text COLLATE "C" NOT NULL,
    revision uuid NOT NULL,
    provenance jsonb NOT NULL,
    PRIMARY KEY (ns,page,revision,provenance),
    FOREIGN KEY (ns,page,revision) REFERENCES hermes_agui_runtime.graph_revisions(ns,page,revision)
);
CREATE INDEX graph_revision_provenance_source ON hermes_agui_runtime.graph_revision_provenance(ns,(provenance->>'sourceId'));
COMMIT;
