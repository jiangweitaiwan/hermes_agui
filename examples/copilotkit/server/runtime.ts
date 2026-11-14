import { BotRunner } from "./bot-runner";
import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";

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

function singleHandler(settings: Record<string, RuntimeSettings>, botId = "info") {
  for (const { agentUrl, token } of Object.values(settings)) {
    if (!token || !["http:", "https:"].includes(new URL(agentUrl).protocol)) {
      throw new Error("Configure a valid AG-UI endpoint and AGUI_API_KEY");
    }
  }
  const runtime = new CopilotRuntime({
    agents: () => Object.fromEntries(Object.entries(settings).map(([id, value]) => [id, createHermesAgent(value)])),
    runner: new BotRunner(botId),
    forwardHeaders: { deny: ["authorization"], denyPrefixes: ["x-"] },
    identifyUser: () => ({ id: "local-owner", name: "Local owner" }),
    generativeUI: false,
  });
  return createCopilotRuntimeHandler({ runtime, basePath: "/api/copilotkit" });
}

export function createRuntimeHandler(settings: RuntimeSettings | Record<string, RuntimeSettings>) {
  const bots: Record<string, RuntimeSettings> = "agentUrl" in settings && typeof settings.agentUrl === "string"
    ? { hermes: settings as RuntimeSettings } : settings as Record<string, RuntimeSettings>;
  if (!Object.keys(bots).length || Object.keys(bots).some(id => !/^[a-z][a-z0-9_-]{0,63}$/.test(id))) {
    throw new Error("Invalid Bot registry");
  }
  const info = singleHandler(bots);
  const handlers = new Map(Object.entries(bots).map(([id, value]) => [id, singleHandler({ [id]: value }, id)]));
  return (request: Request) => {
    const path = new URL(request.url).pathname;
    const match = path.match(/^\/api\/copilotkit\/agent\/([^/]+)(?:\/|$)/);
    if (!match) {
      // This example uses explicit agent URLs for every stateful operation.
      // Reject single-endpoint dispatch so it cannot bypass the Bot runner scope.
      if (request.method !== "GET") return Promise.resolve(new Response("Use agent routes", { status: 405 }));
      return info(request);
    }
    const handler = handlers.get(decodeURIComponent(match[1]));
    return handler ? handler(request) : Promise.resolve(new Response("Unknown Bot", { status: 404 }));
  };
}
