import { createGraphMemory, type GraphMemoryOptions } from "./graph-memory";
import { DelegationCoordinator, type DelegationSettings } from "./delegation";
import { createRuntimeHandler, type RuntimeSettings } from "./runtime";

/** Backend composition seam: inject a future graph adapter here, never from browser input. */
export function createApplication(bots: Record<string, RuntimeSettings>, options: {
  delegation?: DelegationSettings; graph?: GraphMemoryOptions;
} = {}) {
  return {
    runtime: createRuntimeHandler(bots),
    graph: createGraphMemory(options.graph ?? { authorize: scope =>
      scope.principal === "local-owner" && Object.hasOwn(bots, scope.botId) }),
    delegation: options.delegation ? new DelegationCoordinator(bots, options.delegation) : undefined,
  };
}
