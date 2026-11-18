BEGIN;

CREATE TABLE hermes_agui_runtime.graph_namespaces (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    metadata jsonb NOT NULL
);
CREATE TABLE hermes_agui_runtime.graph_revisions (
    ns text NOT NULL REFERENCES hermes_agui_runtime.graph_namespaces(id),
    page text COLLATE "C" NOT NULL,
    revision uuid NOT NULL,
    object_key text NOT NULL UNIQUE,
    generation text NOT NULL,
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    size integer NOT NULL CHECK (size BETWEEN 1 AND 1048576),
    PRIMARY KEY (ns, page, revision)
);
CREATE TABLE hermes_agui_runtime.graph_pages (
    ns text NOT NULL,
    page text COLLATE "C" NOT NULL,
    revision uuid NOT NULL,
    PRIMARY KEY (ns, page),
    FOREIGN KEY (ns, page, revision) REFERENCES hermes_agui_runtime.graph_revisions(ns, page, revision)
);
CREATE TABLE hermes_agui_runtime.graph_page_owners (
    ns text NOT NULL,
    page text COLLATE "C" NOT NULL,
    bot text NOT NULL,
    PRIMARY KEY (ns, page, bot),
    FOREIGN KEY (ns, page) REFERENCES hermes_agui_runtime.graph_pages(ns, page) ON DELETE CASCADE
);
CREATE TABLE hermes_agui_runtime.graph_edges (
    ns text NOT NULL,
    source text COLLATE "C" NOT NULL,
    target text COLLATE "C" NOT NULL,
    PRIMARY KEY (ns, source, target),
    FOREIGN KEY (ns, source) REFERENCES hermes_agui_runtime.graph_pages(ns, page) ON DELETE CASCADE
);
CREATE INDEX graph_edges_incoming ON hermes_agui_runtime.graph_edges(ns, target);
CREATE TABLE hermes_agui_runtime.graph_sections (
    ns text NOT NULL,
    page text COLLATE "C" NOT NULL,
    ordinal integer NOT NULL,
    content text NOT NULL,
    tokens text[] NOT NULL,
    PRIMARY KEY (ns, page, ordinal),
    FOREIGN KEY (ns, page) REFERENCES hermes_agui_runtime.graph_pages(ns, page) ON DELETE CASCADE
);
CREATE INDEX graph_sections_tokens ON hermes_agui_runtime.graph_sections USING gin(tokens);

CREATE TABLE hermes_agui_runtime.graph_embeddings (
    ns text NOT NULL,
    page text COLLATE "C" NOT NULL,
    ordinal integer NOT NULL,
    revision uuid NOT NULL,
    model text NOT NULL,
    vector text NOT NULL,
    PRIMARY KEY (ns, page, ordinal, model),
    FOREIGN KEY (ns, page, ordinal) REFERENCES hermes_agui_runtime.graph_sections(ns, page, ordinal) ON DELETE CASCADE,
    FOREIGN KEY (ns, page, revision) REFERENCES hermes_agui_runtime.graph_revisions(ns, page, revision)
);

COMMIT;
