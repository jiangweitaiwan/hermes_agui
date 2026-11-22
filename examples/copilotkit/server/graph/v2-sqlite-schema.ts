export const v2SqliteSchema = `CREATE TABLE IF NOT EXISTS graph_subjects (
 ns text NOT NULL REFERENCES namespaces(id), subject_id text NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 200),
 identity_key text NOT NULL CHECK(length(identity_key) BETWEEN 1 AND 512), wiki_page_id text NOT NULL,
 parent_subject_id text, section_key text NOT NULL, data text NOT NULL,
 canonical_name text NOT NULL CHECK(length(canonical_name) BETWEEN 1 AND 1000),
 subject_type text NOT NULL CHECK(subject_type IN ('person','system','component','concept','role','document','value')),
 created_at text NOT NULL,updated_at text NOT NULL,
 PRIMARY KEY(ns,subject_id), UNIQUE(ns,identity_key), UNIQUE(ns,wiki_page_id,section_key),
 FOREIGN KEY(ns,parent_subject_id) REFERENCES graph_subjects(ns,subject_id));
CREATE TABLE IF NOT EXISTS graph_subject_aliases (
 ns text NOT NULL REFERENCES namespaces(id), subject_id text NOT NULL, alias_normalized text NOT NULL, source_id text NOT NULL, source_version integer NOT NULL,
 PRIMARY KEY(ns,subject_id,alias_normalized,source_id,source_version),
 FOREIGN KEY(ns,subject_id) REFERENCES graph_subjects(ns,subject_id),
 FOREIGN KEY(ns,source_id,source_version) REFERENCES document_sources(ns,id,version));
CREATE INDEX IF NOT EXISTS graph_subject_alias_lookup ON graph_subject_aliases(ns,alias_normalized);
CREATE TABLE IF NOT EXISTS graph_events (
 ns text NOT NULL REFERENCES namespaces(id),event_id text NOT NULL,data text NOT NULL, PRIMARY KEY(ns,event_id));
CREATE TABLE IF NOT EXISTS graph_fact_edges (
 ns text NOT NULL REFERENCES namespaces(id),edge_id text NOT NULL,event_id text,from_subject_id text NOT NULL,to_subject_id text NOT NULL,
 relation text NOT NULL CHECK(relation IN ('reported_issue','caused_degradation','rolled_back','restored','drafted','delivered_to','deployed_version','related_to')),
 fact_kind text NOT NULL CHECK(fact_kind IN ('event','state')),state_slot_key text,occurred_from text,
 semantic_hash text NOT NULL CHECK(length(semantic_hash)=64),data text NOT NULL,
 PRIMARY KEY(ns,edge_id),UNIQUE(ns,semantic_hash),
 CHECK((fact_kind='state' AND state_slot_key IS NOT NULL) OR (fact_kind='event' AND state_slot_key IS NULL)),
 FOREIGN KEY(ns,event_id) REFERENCES graph_events(ns,event_id),
 FOREIGN KEY(ns,from_subject_id) REFERENCES graph_subjects(ns,subject_id),
 FOREIGN KEY(ns,to_subject_id) REFERENCES graph_subjects(ns,subject_id));
CREATE INDEX IF NOT EXISTS graph_fact_from ON graph_fact_edges(ns,from_subject_id);
CREATE INDEX IF NOT EXISTS graph_fact_to ON graph_fact_edges(ns,to_subject_id);
CREATE INDEX IF NOT EXISTS graph_fact_event ON graph_fact_edges(ns,event_id);
CREATE INDEX IF NOT EXISTS graph_fact_state ON graph_fact_edges(ns,fact_kind,state_slot_key,occurred_from);
CREATE TABLE IF NOT EXISTS graph_edge_evidence (
 ns text NOT NULL REFERENCES namespaces(id),edge_id text NOT NULL,source_id text NOT NULL,source_version integer NOT NULL,
 quote_hash text NOT NULL CHECK(length(quote_hash)=64),data text NOT NULL,
 PRIMARY KEY(ns,edge_id,source_id,source_version,quote_hash),
 FOREIGN KEY(ns,edge_id) REFERENCES graph_fact_edges(ns,edge_id),
 FOREIGN KEY(ns,source_id,source_version) REFERENCES document_sources(ns,id,version));
CREATE INDEX IF NOT EXISTS graph_edge_evidence_source ON graph_edge_evidence(ns,source_id,source_version);
CREATE TABLE IF NOT EXISTS graph_subject_attribute_evidence (
 ns text NOT NULL REFERENCES namespaces(id),attribute_id text NOT NULL,subject_id text NOT NULL,source_id text NOT NULL,source_version integer NOT NULL,data text NOT NULL,
 PRIMARY KEY(ns,attribute_id,source_id,source_version),
 FOREIGN KEY(ns,subject_id) REFERENCES graph_subjects(ns,subject_id),
 FOREIGN KEY(ns,source_id,source_version) REFERENCES document_sources(ns,id,version));
CREATE INDEX IF NOT EXISTS graph_attribute_source ON graph_subject_attribute_evidence(ns,source_id,source_version);
CREATE TABLE IF NOT EXISTS graph_edge_embeddings (
 ns text NOT NULL REFERENCES namespaces(id),edge_id text NOT NULL,model text NOT NULL,dimension integer NOT NULL CHECK(dimension BETWEEN 1 AND 8192),
 vector text NOT NULL,content_hash text NOT NULL CHECK(length(content_hash)=64),indexed_at text NOT NULL,
 PRIMARY KEY(ns,edge_id,model),FOREIGN KEY(ns,edge_id) REFERENCES graph_fact_edges(ns,edge_id));
CREATE TABLE IF NOT EXISTS graph_compiler_namespaces (ns text PRIMARY KEY REFERENCES namespaces(id),version text NOT NULL CHECK(version IN ('v1','v2')));
CREATE TABLE IF NOT EXISTS graph_source_times (
 ns text NOT NULL REFERENCES namespaces(id),source_id text NOT NULL,source_version integer NOT NULL,instant text NOT NULL,timezone text NOT NULL,
 PRIMARY KEY(ns,source_id,source_version),FOREIGN KEY(ns,source_id,source_version) REFERENCES document_sources(ns,id,version));
CREATE TABLE IF NOT EXISTS graph_fact_tokens (
 ns text NOT NULL,edge_id text NOT NULL,token text NOT NULL CHECK(length(token) BETWEEN 1 AND 1000),
 PRIMARY KEY(ns,token,edge_id),FOREIGN KEY(ns,edge_id) REFERENCES graph_fact_edges(ns,edge_id));
`;
