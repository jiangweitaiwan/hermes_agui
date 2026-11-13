import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, InMemoryAgentRunner, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";

export interface RuntimeSettings {
  agentUrl: string;
  token: string;
}

function createHermesAgent({ agentUrl, token }: RuntimeSettings) {
  const agent = new HttpAgent({ url: agentUrl, headers: { Authorization: `Bearer ${token}` } });
  // CopilotKit adds a transport correlation ID; it is not model context.
  agent.use((input, next) => {
    const { __copilotkitRequestId: _requestId, ...forwardedProps } = input.forwardedProps ?? {};
    return next.run({ ...input, forwardedProps });
  });
  return agent;
}

export function createRuntimeHandler({ agentUrl, token }: RuntimeSettings) {
  if (!token || !["http:", "https:"].includes(new URL(agentUrl).protocol)) {
    throw new Error("Configure a valid AG-UI endpoint and AGUI_API_KEY");
  }
  const runtime = new CopilotRuntime({
    agents: () => ({
      hermes: createHermesAgent({ agentUrl, token }),
    }),
    runner: new InMemoryAgentRunner({ maxThreads: 64, maxRunsPerThread: 64, maxBytes: 16 * 1024 * 1024 }),
    forwardHeaders: { deny: ["authorization"], denyPrefixes: ["x-"] },
    identifyUser: () => ({ id: "local-owner", name: "Local owner" }),
    generativeUI: false,
  });
  return createCopilotRuntimeHandler({ runtime, basePath: "/api/copilotkit" });
}
