import { V2Browser } from "./v2-browser";
import { BotError } from "../bots/types";
import { sameOrigin } from "../bots/api";
import type { createBotManagement } from "../bots/application";
import { WikiGraphProvider } from "./provider";
import type { BrowserStore, BrowserRevision } from "./browser-store";
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
  const match = url.pathname.match(/^\/api\/graph\/([a-z][a-z0-9_-]{0,63})\/(stats|network|pages|search|health|jobs|facts)(?:\/(bot_private|project_shared)\/([^/]+))?$/);
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
  return async (request: Request): Promise<Response> => {
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
      await management.manager.sync();
      const bot = management.manager.owned(botId, identity), memory = bot.runtime.memory;
      if (!memory || memory.principal !== identity.principal || memory.projectId !== identity.projectId) throw new BotError(404, "Unknown Bot");
      const namespace = { principal: memory.principal, projectId: memory.projectId, botId };
      if (!options.retained({ ...namespace, visibility: "bot_private" }, botId)) throw new BotError(404, "Unknown Bot");
      if (!options.provider) return json({ status: "disabled", error: "Graph disabled" }, 503);
      if (!(options.provider instanceof WikiGraphProvider)) return json({ status: "unavailable", error: "Graph unavailable" }, 503);
      if (["health", "jobs"].includes(route) && !options.evolution) return json({ status: "unavailable", error: "Evolution disabled" }, 503);
      await options.evolution?.reconcile();
      const provider = options.provider;
      const store = provider.store;
      {
        const browser = new GraphBrowser(store as BrowserStore<BrowserRevision>, namespace, query, options.retained);
        const facts = new V2Browser(options.provider.facts,browser.namespaces,{...query,view:endpoint === "health" ? "history":query.view},options.retained);
        const binding = JSON.stringify([identity.ownerId, namespace, endpoint]);
        const overlays: V2Browser[] = [];
        const actions: Record<string, () => unknown> = {
          facts: () => facts.list(binding),
          stats: () => browser.stats(), network: async () => {
            const network = await browser.network(binding);
            const overlay = new V2Browser(provider.facts,
              browser.namespaces,{...query,cursor:undefined,limit:100},options.retained);
            overlays.push(overlay);
            const values = await overlay.list(`${binding}:facts`);
            const nodes = new Set(network.nodes.map(n=>n.id));
            network.factEdges = values.edges.filter(e=>nodes.has(`${e.visibility}:${e.fromSubject.wikiPageId}`) && nodes.has(`${e.visibility}:${e.toSubject.wikiPageId}`));
            network.subjects = values.subjects.filter(s=>nodes.has(`${s.visibility}:${s.wikiPageId}`));
            network.truncated ||= values.partial;
            await overlay.revalidate();
            return network;
          }, pages: () => browser.list(binding),
          search: () => browser.list(binding, true), detail: () => browser.detail(visibility as "bot_private" | "project_shared", id!),
          health: async () => {
            const health=await browser.health();
            const window=await facts.list(`${binding}:health-facts`);
            return {...health,facts:{edges:window.edges.length,subjects:window.subjects.length,
              events:new Set(window.edges.map(e=>e.eventId).filter(Boolean)).size,partial:window.partial,
              vectorEnabled:!!provider.edgeVectors}};
          }, jobs: () => browser.jobs(),
        };
        const value = await actions[endpoint]();
        await management.manager.sync();
        management.manager.owned(botId, identity);
        if (!options.retained({ ...namespace, visibility: "bot_private" }, botId)) throw new BotError(404, "Unknown Bot");
        await browser.revalidate();
        await facts.revalidate();
        for (const overlay of overlays) await overlay.revalidate();
        return json(value);
      }
    } catch (error) {
      const status = error instanceof BotError ? error.status : 503;
      return json({ ...(status === 503 ? { status: "unavailable" } : {}),
        error: error instanceof BotError ? error.message : "Graph unavailable" }, status);
    }
  };
}
