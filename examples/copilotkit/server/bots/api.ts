import type { BotManager } from "./manager";
import type { BotAuthentication } from "./auth";
import { BotError, publicBot, type Identity } from "./types";

/** Origin check supplements authentication for cookie-based browser mutations. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new BotError(422, "JSON body required");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16384) { await reader.cancel(); throw new BotError(413, "Request too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new BotError(422, "Invalid JSON"); }
}
type Action = (request: Request, identity: Identity, id: string) => Response | Promise<Response>;
function routes(manager: BotManager) {
  const enable: Action = async (_request, identity, id) => Response.json(await manager.enableBot(id, identity));
  const deactivate = (deleted: boolean): Action => async (_request, identity, id) => {
    await manager.deactivate(id, identity, deleted);
    return new Response(null, { status: 204 });
  };
  const actions: Record<string, Action> = {
    "GET ": (_request, identity, id) => Response.json(publicBot(manager.owned(id, identity))),
    "PATCH ": async (request, identity, id) => Response.json(await manager.updateBot(id, await body(request), identity)),
    "DELETE ": deactivate(true), "POST disable": deactivate(false), "POST enable": enable, "POST retry": enable,
  };
  const roots: Record<string, Action> = {
    "GET /api/bots": (_request, identity) => Response.json(manager.listBots(identity)),
    "POST /api/bots": async (request, identity) => Response.json(await manager.createBot(await body(request), identity), { status: 201 }),
    "GET /api/bots/options": () => Response.json(manager.options.templates.map(({ id, name, harness, model, provider, skills, toolsets }) =>
      ({ id, name, harness, model, provider, skills, toolsets }))),
  };
  return (request: Request, path: string, identity: Identity) => {
    const root = roots[`${request.method} ${path}`];
    if (root) return root(request, identity, "");
    const match = path.match(/^\/api\/bots\/([a-z][a-z0-9_-]{0,63})(?:\/(disable|enable|retry))?$/);
    const action = match ? actions[`${request.method} ${match[2] ?? ""}`] : undefined;
    if (match && action) return action(request, identity, match[1]);
    return Response.json({ error: "Unknown management route" }, { status: 404 });
  };
}
export function createBotApi(manager: BotManager, auth: BotAuthentication) {
  const dispatch = routes(manager);
  return async (request: Request): Promise<Response> => {
    try {
      if (!sameOrigin(request)) throw new BotError(403, "Origin denied");
      const path = new URL(request.url).pathname;
      if (path === "/api/bot-session" && request.method === "POST") {
        const value = await body(request);
        if (typeof value?.token !== "string") throw new BotError(422, "Token required");
        return auth.login(request, value.token);
      }
      if (path === "/api/bot-session" && request.method === "DELETE") return auth.logout(request);
      const identity = auth.authenticate(request);
      if (!identity) throw new BotError(401, "Authentication required");
      return await dispatch(request, path, identity);
    } catch (error) {
      return Response.json({ error: error instanceof BotError ? error.message : "Bot management unavailable" },
        { status: error instanceof BotError ? error.status : 503 });
    }
  };
}
