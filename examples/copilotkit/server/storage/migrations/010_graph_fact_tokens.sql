BEGIN;
CREATE TABLE IF NOT EXISTS hermes_agui_runtime.graph_fact_tokens (
 ns text NOT NULL,edge_id text NOT NULL,token text NOT NULL CHECK(length(token) BETWEEN 1 AND 1000),
 PRIMARY KEY(ns,token,edge_id),FOREIGN KEY(ns,edge_id) REFERENCES hermes_agui_runtime.graph_fact_edges(ns,edge_id));
COMMIT;
