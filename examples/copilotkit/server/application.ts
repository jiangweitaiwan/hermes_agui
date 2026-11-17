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
  delegation?: DelegationSettings; graph?: GraphMemoryOptions; management?: BotManagementSettings;
} = {}) {
  const bots = { ...initialBots };
  const allow = { ...options.delegation?.allow };
  const management = options.management ? createBotManagement(options.management, bots, allow) : undefined;
  const graph = createGraphMemory(options.graph ?? { authorize: scope => {
    if (management) {
      const bot = management.manager.options.registry.get(scope.botId);
      return bot?.record.status === "active" && !bot.record.deletedAt &&
        bot.runtime.memory?.principal === scope.principal && bot.record.projectId === scope.projectId;
    }
    return scope.principal === "local-owner" && Object.hasOwn(bots, scope.botId);
  } });
  const memory = new RuntimeMemoryMiddleware(new RuntimeMemoryManager(new MemoryRetriever(graph)), graph.scope);
  const runtime = createRuntimeHandler(bots, memory, management ? { allowed: (request, id) => {
    const identity = management.auth.authenticate(request);
    if (!identity) return false;
    try { return management.manager.owned(id, identity).record.status === "active"; } catch { return false; }
  } } : undefined);
  return {
    runtime: (request: Request) => {
      if (management && (!management.auth.authenticate(request) || !sameOrigin(request))) {
        return Promise.resolve(new Response("Authentication required", { status: 401 }));
      }
      return runtime(request);
    },
    graph, management,
    ready: management ? management.manager.restore() : Promise.resolve(),
    close: () => management?.close(),
    delegation: options.delegation ? new DelegationCoordinator(bots, { ...options.delegation, allow },
      (id, input) => prepareRunInput(id, bots[id], input, memory)) : undefined,
  };
}
