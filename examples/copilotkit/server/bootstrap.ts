import { createApplication } from "./application";
import { loadManagement, loadDeployedBots } from "./bots/deployment";
import { loadWiki, loadDurableWiki } from "./graph/provider";
import { loadEvolution } from "./graph/evolution";
import { PostgresThreadMappings } from "./storage/thread-mappings";
import type { RuntimeSettings } from "./runtime";

function validateDeployment(registry: any) {
  if (!registry) return;
  if (!Array.isArray(registry.bots) || (!registry.management && registry.bots.length === 0) ||
    new Set(registry.bots.map((bot: { id: string }) => bot.id)).size !== registry.bots.length) throw new Error("Configure unique Bot IDs");
}
function graphProvider(registry: any) {
  const backend = process.env.AGUI_STORAGE_BACKEND ?? "local";
  if (!["local", "gcp"].includes(backend)) throw new Error("Invalid storage backend");
  return backend === "gcp" ? loadDurableWiki(registry?.graph) : loadWiki(registry?.graph);
}
async function threadStorage(registry: any) {
  const backend = registry?.storage?.threadMappings ?? "local";
  if (!["local", "postgres"].includes(backend)) throw new Error("Invalid Runtime thread mapping backend");
  const threads = backend === "postgres" ? new PostgresThreadMappings(process.env.AGUI_RUNTIME_DATABASE_URL ?? "") : undefined;
  try { await threads?.ready(!!registry?.delegation); return threads; }
  catch (error) { await threads?.close(); throw error; }
}
function managementSettings(registry: any) {
  const backend = registry?.storage?.botRegistry ?? "local";
  if (!["local", "postgres"].includes(backend)) throw new Error("Invalid Runtime Bot registry backend");
  const settings = loadManagement(registry?.management);
  if (backend === "postgres") {
    if (!settings) throw new Error("PostgreSQL Bot registry requires Bot management");
    settings.postgres = { url: process.env.AGUI_RUNTIME_DATABASE_URL ?? "", credentialSeed: process.env.AGUI_BOT_CREDENTIAL_SEED ?? "" };
  }
  return settings;
}
function completionToken(registry: any) {
  const enabled = registry?.storage?.graphCompletions ?? false;
  if (typeof enabled !== "boolean") throw new Error("Invalid Runtime Graph completion mode");
  return enabled ? process.env.AGUI_GRAPH_COMPLETION_TOKEN ?? "" : undefined;
}

/** Shared composition for the HTTP Runtime and trusted one-shot worker commands. */
export async function bootstrap(registry: any, execution: { evolutionTimer?: boolean } = {}) {
  validateDeployment(registry);
  const settings: Record<string, RuntimeSettings> = registry ? loadDeployedBots(registry.bots) : { hermes: {
    agentUrl: process.env.AGUI_URL ?? "http://127.0.0.1:8000/agent", token: process.env.AGUI_API_KEY ?? "",
  } };
  const wiki = await graphProvider(registry);
  let threadMappings: PostgresThreadMappings | undefined;
  let application: ReturnType<typeof createApplication> | undefined;
  try {
    threadMappings = await threadStorage(registry);
    application = createApplication(settings, {
      evolutionTimer: execution.evolutionTimer, threadMappings, graphCompletionToken: completionToken(registry),
      graph: registry?.graph?.enabled ? { provider: wiki, timeoutMs: registry.graph.timeoutMs, authorize: () => true } : undefined,
      evolution: loadEvolution(wiki, registry?.graph?.evolution), management: managementSettings(registry),
      delegation: registry?.delegation ? { ...registry.delegation, token: process.env[registry.delegation.tokenEnv] ?? "" } : undefined,
    });
    await application.ready;
    return { application, wiki, threadMappings, settings };
  } catch (error) { await application?.close(); await wiki?.close(); await threadMappings?.close(); throw error; }
}
