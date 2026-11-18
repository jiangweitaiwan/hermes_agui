import { createCompletionApi } from "./graph/completion-api";
import { createGraphApi } from "./graph/api";
import { MemoryEvolution, type EvolutionOptions } from "./graph/evolution";
import type { Namespace } from "./graph/types";
import { RuntimeMemoryManager } from "./memory/runtime-memory-manager";
import { MemoryRetriever } from "./memory/retriever";
import { RuntimeMemoryMiddleware } from "./memory/middleware";
import { prepareRunInput } from "./memory/pipeline";
import { createGraphMemory, type GraphMemoryOptions } from "./graph-memory";
import { DelegationCoordinator, type DelegationSettings } from "./delegation";
import { createRuntimeHandler, type RuntimeSettings, type RuntimeThreads } from "./runtime";
import { createBotManagement, type BotManagementSettings } from "./bots/application";
import type { ThreadMappings } from "./storage/thread-mappings";
import { sameOrigin } from "./bots/api";

/** Shared server-owned composition for interactive, managed and delegated runs. */
export function createApplication(initialBots: Record<string, RuntimeSettings>, options: {
  delegation?: DelegationSettings; graph?: GraphMemoryOptions; management?: BotManagementSettings; evolution?: EvolutionOptions; threadMappings?: ThreadMappings; graphCompletionToken?: string;
} = {}) {
  if (options.management?.postgres && options.evolution) throw new Error("PostgreSQL Bot registry requires durable Graph evolution");
  if (options.graph && options.management?.users.some(user => options.management!.users.some(other =>
    other.ownerId !== user.ownerId && other.principal === user.principal && other.projectId === user.projectId))) {
    throw new Error("Graph memory requires distinct owner principals within a project");
  }
  if (options.threadMappings && !options.management && Object.values(initialBots).some(settings => {
    const scope = settings.threadScope ?? settings.memory;
    return !scope?.principal || !scope.projectId;
  })) throw new Error("Configure a trusted thread scope for each static Bot");
  const bots = { ...initialBots };
  const allow = { ...options.delegation?.allow };
  const management = options.management ? createBotManagement(options.management, bots, allow) : undefined;
  const graph = createGraphMemory({ ...options.graph, authorize: (scope, operation) => {
    if (options.graph && !options.graph.authorize(scope, operation)) return false;
    if (management) {
      const bot = management.manager.options.registry.get(scope.botId);
      return bot?.record.status === "active" && !bot.record.deletedAt &&
        bot.runtime.memory?.principal === scope.principal && bot.record.projectId === scope.projectId;
    }
    const bot = bots[scope.botId];
    return Object.hasOwn(bots, scope.botId) && (bot.memory
      ? bot.memory.principal === scope.principal && bot.memory.projectId === scope.projectId
      : scope.principal === "local-owner");
  } });
  const retained = (ns: Namespace, id: string) => {
    const stored = management?.manager.options.registry.get(id);
    const bot = management ? stored?.runtime : bots[id];
    const ownerAllowed = !management || !!options.management?.users.some(user => user.ownerId === stored?.record.ownerId &&
      user.principal === ns.principal && user.projectId === ns.projectId);
    return !!bot?.memory && !stored?.record.deletedAt && ownerAllowed &&
      bot.memory.principal === ns.principal && bot.memory.projectId === ns.projectId &&
      (!options.graph || options.graph.authorize({ principal: ns.principal, projectId: ns.projectId, botId: id }, "write"));
  };
  const evolution = options.evolution ? new MemoryEvolution(options.evolution, ns => {
    const ids = ns.visibility === "project_shared" ? Object.keys(bots) : [ns.botId];
    return ids.some(id => !!bots[id] && retained(ns, id));
  }, retained) : undefined;
  if (options.graphCompletionToken !== undefined && !evolution) {
    throw new Error("Graph completions require Graph evolution");
  }
  const receiveCompletion = options.graphCompletionToken !== undefined
    ? createCompletionApi(evolution!.sessions, options.graphCompletionToken) : undefined;
  const streamIngestion = receiveCompletion ? undefined : evolution?.sessions;
  if (management && evolution) management.manager.options.onChange = () => evolution.reconcile();
  const memory = new RuntimeMemoryMiddleware(new RuntimeMemoryManager(new MemoryRetriever(graph)), graph.scope);
  const threads: RuntimeThreads | undefined = options.threadMappings && {
    store: options.threadMappings,
    scope: (botId, settings) => {
      const stored = management?.manager.options.registry.get(botId);
      const owner = options.management?.users.find(user => user.ownerId === stored?.record.ownerId &&
        user.projectId === stored?.record.projectId);
      const scope = management ? owner : settings.threadScope ?? settings.memory;
      if (!scope?.principal || !scope.projectId) throw new Error("Missing trusted scope for Runtime thread mapping");
      return { botId, principal: scope.principal, projectId: scope.projectId };
    },
  };
  const runtime = createRuntimeHandler(bots, memory, management ? { allowed: (request, id) => {
    const identity = management.auth.authenticate(request);
    if (!identity) return false;
    try { return management.manager.owned(id, identity).record.status === "active"; } catch { return false; }
  } } : undefined, streamIngestion, threads);
  const refresh = (handler: (request: Request) => Promise<Response>) => async (request: Request) => {
    try { await management?.manager.sync(); }
    catch { return new Response("Bot registry unavailable", { status: 503 }); }
    return handler(request);
  };
  const delegation = options.delegation ? new DelegationCoordinator(bots, { ...options.delegation, allow },
    (id, input) => prepareRunInput(id, bots[id], input, memory), streamIngestion, threads) : undefined;
  const dispatchRuntime = refresh(runtime);
  return {
    runtime: async (request: Request) => {
      if (management && (!management.auth.authenticate(request) || !sameOrigin(request))) {
        return Promise.resolve(new Response("Authentication required", { status: 401 }));
      }
      return dispatchRuntime(request);
    },
    graph, management, evolution, graphCompletion: receiveCompletion && refresh(receiveCompletion),
    graphApi: createGraphApi({ management, provider: options.graph?.provider, evolution, retained: (ns, id) => retained(ns, id) &&
      (!options.graph || options.graph.authorize({ principal: ns.principal, projectId: ns.projectId, botId: id }, "query")) }),
    ready: (management ? management.restore() : Promise.resolve()).then(() => { evolution?.reconcile(); evolution?.start(); }),
    close: () => {
      if (!evolution) return Promise.resolve(management?.close());
      return evolution.close().then(() => management?.close());
    },
    delegation: delegation && { handle: refresh(request => delegation.handle(request)) },
  };
}
