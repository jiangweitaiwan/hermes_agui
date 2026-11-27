-- Additive consumer fence privileges; application roles cannot open deployment admission.
GRANT EXECUTE ON FUNCTION hermes_agui_host.acquire_completion_delivery() TO hermes_host;
GRANT EXECUTE ON FUNCTION hermes_agui_runtime.acquire_graph_delivery() TO hermes_runtime;
