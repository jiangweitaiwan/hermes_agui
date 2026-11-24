import { ControlSettings } from "../../server/llm/control-contract";
export function controlFixture() {
  const llm = { version: 1, providers: [{ id: "google", driver: "vertex", project: "hermes-test",
    location: "us-central1", auth: "adc", capabilities: ["chat", "structured_output", "embedding"] }],
  models: ["agent_primary", "graph_parser", "graph_matcher", "graph_relations", "graph_query", "graph_story", "graph_embedding"].map(alias =>
    ({ alias, provider: "google", model: alias === "graph_embedding" ? "gemini-embedding-001" : "gemini-2.5-flash",
      timeoutMs: 2000, retries: 0, maxTokens: 1024, fallback: [] as string[],
      ...(alias === "graph_embedding" ? { dimension: 3, version: "v1" } : {}) })) };
  const approved = structuredClone(llm);
  approved.models[0].model = "gemini-2.5-pro";
  const policy = ControlSettings.parse({ mode: "managed", scope: "deployment", admins: ["deployment-admin"], approved });
  // Approve both concrete model IDs without introducing a new execution role.
  policy.approved.models.push({ ...policy.approved.models[1], alias: "approved_flash" });
  policy.approved.models[1].fallback = ["approved_flash"];
  return { llm, policy };
}
