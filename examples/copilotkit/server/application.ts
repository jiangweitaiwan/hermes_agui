import { MemoryEvolution, type EvolutionOptions } from "./graph/evolution";
import type { Namespace } from "./graph/types";
import { RuntimeMemoryManager } from "./memory/runtime-memory-manager";
import { MemoryRetriever } from "./memory/retriever";
import { RuntimeMemoryMiddleware } from "./memory/middleware";
import { prepareRunInput } from "./memory/pipeline";
import { createGraphMemory, type GraphMemoryOptions } from "./graph-memory";
import { DelegationCoordinator, type DelegationSettings } from "./delegation";
import { createRuntimeHandler, type RuntimeSettings } from "./runtime";
import { createBotManagement, type BotManagementSettings } from "./bots/application";
import { sameOrigin } from "./bots/api";

/** Shared server-owned composition for interactive, managed and delegated runs. */
export function createApplication(initialBots: Record<string, RuntimeSettings>, options: {
  delegation?: DelegationSettings; graph?: GraphMemoryOptions; management?: BotManagementSettings; evolution?: EvolutionOptions;
} = {}) {
  if (options.evolution && options.management?.users.some(user => options.management!.users.some(other =>
    other.ownerId !== user.ownerId && other.principal === user.principal && other.projectId === user.projectId))) {
    throw new Error("Graph memory requires distinct owner principals within a project");
  }
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
      (!options.graph || options.graph.authorize({ principal: ns.principal, projectId: ns.projectId, botId: id, threadId: "ingest", runId: "ingest" }, "write"));
  };
  const evolution = options.evolution ? new MemoryEvolution(options.evolution, ns => {
    const ids = ns.visibility === "project_shared" ? Object.keys(bots) : [ns.botId];
    return ids.some(id => !!bots[id] && retained(ns, id));
  }, retained) : undefined;
  if (management && evolution) management.manager.options.onChange = () => evolution.reconcile();
  const memory = new RuntimeMemoryMiddleware(new RuntimeMemoryManager(new MemoryRetriever(graph)), graph.scope);
  const runtime = createRuntimeHandler(bots, memory, management ? { allowed: (request, id) => {
    const identity = management.auth.authenticate(request);
    if (!identity) return false;
    try { return management.manager.owned(id, identity).record.status === "active"; } catch { return false; }
  } } : undefined, evolution?.sessions);
  return {
    runtime: (request: Request) => {
      if (management && (!management.auth.authenticate(request) || !sameOrigin(request))) {
        return Promise.resolve(new Response("Authentication required", { status: 401 }));
      }
      return runtime(request);
    },
    graph, management, evolution,
    ready: (management ? management.manager.restore() : Promise.resolve()).then(() => { evolution?.reconcile(); evolution?.start(); }),
    close: () => {
      if (!evolution) { management?.close(); return Promise.resolve(); }
      return evolution.close().then(() => management?.close());
    },
    delegation: options.delegation ? new DelegationCoordinator(bots, { ...options.delegation, allow },
      (id, input) => prepareRunInput(id, bots[id], input, memory), evolution?.sessions) : undefined,
  };
}
