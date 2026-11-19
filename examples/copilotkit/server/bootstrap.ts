import { CloudTasksDelivery, TasksSchema } from "./graph/tasks";
import { PostgresWikiStore } from "./graph/postgres-wiki-store";
import { WikiGraphProvider } from "./graph/provider";
import { configureCloud } from "./cloud";
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
  const cloud = configureCloud(registry?.cloud);
  if (process.env.K_SERVICE && !cloud) throw new Error("Cloud Run requires explicit cloud settings");
  if (cloud && cloud.members.some(member => !registry?.management?.users?.some((user: { ownerId: string; principal: string; projectId: string }) => user.ownerId === member.ownerId && user.principal === member.principal && user.projectId === member.projectId))) throw new Error("Firebase members must match server management identities");
  if (cloud && (process.env.AGUI_STORAGE_BACKEND !== "gcp" || registry?.storage?.botRegistry !== "postgres" || registry?.storage?.threadMappings !== "postgres" || !registry?.storage?.graphCompletions || !registry?.graph?.enabled || !registry?.graph?.evolution?.enabled)) throw new Error("Cloud mode requires durable registry, threads, Graph and completions");
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
      evolutionTimer: cloud ? false : execution.evolutionTimer, threadMappings, graphCompletionToken: completionToken(registry),
      graph: registry?.graph?.enabled ? { provider: wiki, timeoutMs: registry.graph.timeoutMs, authorize: () => true } : undefined,
      evolution: loadEvolution(wiki, registry?.graph?.evolution), management: managementSettings(registry),
      delegation: registry?.delegation ? { ...registry.delegation, token: process.env[registry.delegation.tokenEnv] ?? "" } : undefined,
    });
    await application.ready;
    const tasks = cloud && wiki instanceof WikiGraphProvider && wiki.store instanceof PostgresWikiStore
      ? new CloudTasksDelivery(wiki.store.pool, TasksSchema.parse(registry.tasks)) : undefined;
    await tasks?.ready();
    if (tasks && application.evolution) {
      const queue = application.evolution.queue;
      const enqueue = queue.enqueue.bind(queue);
      queue.enqueue = async (ns, value, origin) => {
        const id = await enqueue(ns, value, origin);
        try { await tasks.enqueue(id); } catch { /* Durable delivery row is retried by Scheduler. */ }
        return id;
      };
    }
    return { application, wiki, threadMappings, settings, tasks };
  } catch (error) { await application?.close(); await wiki?.close(); await threadMappings?.close(); throw error; }
}
