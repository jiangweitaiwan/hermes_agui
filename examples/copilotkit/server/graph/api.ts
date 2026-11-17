import { BotError } from "../bots/types";
import { sameOrigin } from "../bots/api";
import type { createBotManagement } from "../bots/application";
import { WikiGraphProvider } from "./provider";
import type { Namespace } from "./types";
import { GraphBrowser } from "./browser";
import { pageId, parseQuery } from "./browser-query";
import type { MemoryEvolution } from "./evolution";

interface BrowserOptions {
  management?: ReturnType<typeof createBotManagement>; provider?: unknown; evolution?: MemoryEvolution;
  retained: (ns: Namespace, bot: string) => boolean;
}
const json = (value: unknown, status = 200) => {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new BotError(503, "Browser response budget exceeded");
  return new Response(body, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
};
function resolveRoute(request: Request) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/graph\/([a-z][a-z0-9_-]{0,63})\/(stats|network|pages|search|health|jobs)(?:\/(bot_private|project_shared)\/([^/]+))?$/);
  if (!match) throw new BotError(400, "Invalid graph route");
  const [, botId, route, visibility, encodedId] = match;
  if (visibility && route !== "pages") throw new BotError(400, "Invalid graph route");
  let id: string | undefined;
  if (encodedId) {
    try { id = pageId.parse(decodeURIComponent(encodedId)); }
    catch { throw new BotError(400, "Invalid page ID"); }
  }
  const endpoint = id ? "detail" : route, query = parseQuery(url, endpoint);
  return { botId, route, visibility, id, endpoint, query };
}
/** Read-only surface, independent of GraphMemoryPort and agent run/thread scopes. */
export function createGraphApi(options: BrowserOptions) {
  return (request: Request): Response => {
    try {
      const management = options.management;
      if (!management) return json({ status: "unavailable", error: "Managed authentication required" }, 503);
      if (!sameOrigin(request)) throw new BotError(403, "Origin denied");
      const identity = management.auth.authenticate(request);
      if (!identity) throw new BotError(401, "Authentication required");
      if (request.method !== "GET") return new Response(JSON.stringify({ error: "Read-only API" }), {
        status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Allow: "GET" },
      });
      const { botId, route, visibility, id, endpoint, query } = resolveRoute(request);
      const bot = management.manager.owned(botId, identity), memory = bot.runtime.memory;
      if (!memory || memory.principal !== identity.principal || memory.projectId !== identity.projectId) throw new BotError(404, "Unknown Bot");
      const namespace = { principal: memory.principal, projectId: memory.projectId, botId };
      if (!options.retained({ ...namespace, visibility: "bot_private" }, botId)) throw new BotError(404, "Unknown Bot");
      if (!options.provider) return json({ status: "disabled", error: "Graph disabled" }, 503);
      if (!(options.provider instanceof WikiGraphProvider)) return json({ status: "unavailable", error: "Graph unavailable" }, 503);
      if (["health", "jobs"].includes(route) && !options.evolution) return json({ status: "unavailable", error: "Evolution disabled" }, 503);
      options.evolution?.reconcile();
      const store = options.provider.store;
      // A short, bounded writer snapshot serializes with publication/revocation in other processes.
      return store.transaction(() => {
        const browser = new GraphBrowser(store, namespace, query, options.retained);
        const binding = JSON.stringify([identity.ownerId, namespace, endpoint]);
        const actions: Record<string, () => unknown> = {
          stats: () => browser.stats(), network: () => browser.network(binding), pages: () => browser.list(binding),
          search: () => browser.list(binding, true), detail: () => browser.detail(visibility as "bot_private" | "project_shared", id!),
          health: () => browser.health(), jobs: () => browser.jobs(),
        };
        const value = actions[endpoint]();
        // Synchronous assembly has no await boundary; still re-read the registry before serialization.
        management.manager.owned(botId, identity);
        if (!options.retained({ ...namespace, visibility: "bot_private" }, botId)) throw new BotError(404, "Unknown Bot");
        browser.revalidate();
        return json(value);
      });
    } catch (error) {
      const status = error instanceof BotError ? error.status : 503;
      return json({ ...(status === 503 ? { status: "unavailable" } : {}),
        error: error instanceof BotError ? error.message : "Graph unavailable" }, status);
    }
  };
}
