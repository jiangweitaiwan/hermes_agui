import { RunCompletionObserver, type SessionIngestor } from "./graph/session-ingestor";
import { defer, switchMap, tap } from "rxjs";
import { prepareRunInput } from "./memory/pipeline";
import type { RuntimeMemoryMiddleware, MemoryBridgeSettings } from "./memory/middleware";
import { BotRunner } from "./bot-runner";
import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";

export interface RuntimeSettings {
  agentUrl: string;
  token: string;
  memory?: MemoryBridgeSettings;
  ownerId?: string;
}

function createHermesAgent({ agentUrl, token, memory }: RuntimeSettings, botId: string, middleware?: RuntimeMemoryMiddleware, ingestion?: SessionIngestor) {
  const agent = new HttpAgent({ url: agentUrl, headers: { Authorization: `Bearer ${token}` } });
  agent.use((input, next) => defer(() => {
    const observer = ingestion ? new RunCompletionObserver(botId, { agentUrl, token, memory }, input, ingestion) : undefined;
    return defer(() => prepareRunInput(botId, { agentUrl, token, memory }, input, middleware))
      .pipe(switchMap(prepared => next.run(prepared)), tap({ next: event => observer?.event(event), complete: () => observer?.complete() }));
  }));
  return agent;
}

function singleHandler(settings: Record<string, RuntimeSettings>, botId = "info", middleware?: RuntimeMemoryMiddleware, runner = new BotRunner(botId), ingestion?: SessionIngestor) {
  for (const { agentUrl, token, memory } of Object.values(settings)) {
    if (memory && (!memory.key || memory.key === token || !memory.principal || !memory.projectId)) {
      throw new Error("Memory requires a separate Runtime signing key and trusted scope");
    }
    if (!token || !["http:", "https:"].includes(new URL(agentUrl).protocol)) {
      throw new Error("Configure a valid AG-UI endpoint and AGUI_API_KEY");
    }
  }
  const runtime = new CopilotRuntime({
    agents: () => Object.fromEntries(Object.entries(settings).map(([id, value]) => [id, createHermesAgent(value, id, middleware, ingestion)])),
    runner,
    forwardHeaders: { deny: ["authorization"], denyPrefixes: ["x-"] },
    identifyUser: () => ({ id: Object.values(settings)[0]?.ownerId ?? "local-owner", name: "Bot owner" }),
    generativeUI: false,
  });
  return createCopilotRuntimeHandler({ runtime, basePath: "/api/copilotkit" });
}

export interface RuntimeAccess {
  allowed: (request: Request, botId: string) => boolean;
}
export function createRuntimeHandler(settings: RuntimeSettings | Record<string, RuntimeSettings>,
  middleware?: RuntimeMemoryMiddleware, access?: RuntimeAccess, ingestion?: SessionIngestor) {
  const bots: Record<string, RuntimeSettings> = "agentUrl" in settings && typeof settings.agentUrl === "string"
    ? { hermes: settings as RuntimeSettings } : settings as Record<string, RuntimeSettings>;
  if (Object.keys(bots).some(id => !/^[a-z][a-z0-9_-]{0,63}$/.test(id))) throw new Error("Invalid Bot registry");
  const handlers = new Map<string, { settings: RuntimeSettings; handle: ReturnType<typeof singleHandler> }>();
  const runners = new Map<string, BotRunner>();
  return (request: Request) => {
    const path = new URL(request.url).pathname;
    const match = path.match(/^\/api\/copilotkit\/agent\/([^/]+)(?:\/|$)/);
    if (!match) {
      if (request.method !== "GET") return Promise.resolve(new Response("Use agent routes", { status: 405 }));
      const visible = Object.fromEntries(Object.entries(bots).filter(([id]) => !access || access.allowed(request, id)));
      return singleHandler(visible, "info", middleware, undefined, ingestion)(request);
    }
    const id = decodeURIComponent(match[1]);
    if (!Object.hasOwn(bots, id) || (access && !access.allowed(request, id))) {
      return Promise.resolve(new Response("Unknown or inactive Bot", { status: 404 }));
    }
    const value = bots[id];
    let cached = handlers.get(id);
    if (!cached || cached.settings !== value) {
      const runner = runners.get(id) ?? new BotRunner(id);
      runners.set(id, runner);
      cached = { settings: value, handle: singleHandler({ [id]: value }, id, middleware, runner, ingestion) };
      handlers.set(id, cached);
    }
    return cached.handle(request);
  };
}
