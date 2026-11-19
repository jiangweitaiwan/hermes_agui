import type { createApplication } from "./application";
import type { PostgresThreadMappings } from "./storage/thread-mappings";
import { hostFetch } from "./cloud";
/** All Host credentials and scope come from the authenticated registry. */
export function threadApi(application: ReturnType<typeof createApplication>, mappings?: PostgresThreadMappings) {
  return async (request: Request) => {
    const management = application.management;
    const identity = management?.auth.authenticate(request);
    if (!management || !identity || !mappings) return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    const match = path.match(/^\/api\/threads\/([a-z][a-z0-9_-]{0,63})(?:\/([^/]+)\/(history|cancel|runs\/([^/]+)\/events))?$/);
    if (!match) return new Response(null, { status: 404 });
    await management.manager.sync();
    const bot = management.manager.owned(match[1], identity);
    const scope = { botId: match[1], principal: identity.principal, projectId: identity.projectId };
    if (!match[2]) return request.method === "GET" ? Response.json(await mappings.list(scope)) : new Response(null, { status: 405 });
    const thread = decodeURIComponent(match[2]);
    const existing = await mappings.list(scope);
    if (!existing.some(value => value.threadId === thread)) return new Response(null, { status: 404 });
    const hostThread = await mappings.resolve(scope, thread, thread);
    const action = match[3];
    if ((action === "cancel" ? "POST" : "GET") !== request.method) return new Response(null, { status: 405 });
    const suffix = action.startsWith("runs/") ? `runs/${encodeURIComponent(decodeURIComponent(match[4]))}/events${new URL(request.url).search}` : action;
    const base = bot.runtime.agentUrl.replace(/\/agent$/, "");
    const response = await hostFetch(`${base}/threads/${encodeURIComponent(hostThread)}/${suffix}`, {
      method: request.method, headers: { Authorization: `Bearer ${bot.runtime.token}` }, signal: AbortSignal.timeout(15000),
    });
    return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  };
}
