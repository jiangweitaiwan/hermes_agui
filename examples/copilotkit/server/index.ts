export {};

// Set before loading CopilotKit, including modules with import-time telemetry.
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
process.env.DO_NOT_TRACK = "1";

const { createServer } = await import("node:http");
const { createCopilotNodeHandler } = await import("@copilotkit/runtime/v2/node");
const { createApplication } = await import("./application");
const { loadManagement } = await import("./bots/deployment");
const { Hono } = await import("hono");
const { serveStatic } = await import("@hono/node-server/serve-static");
const { getRequestListener } = await import("@hono/node-server");

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const registry = process.env.AGUI_BOTS_CONFIG
  ? JSON.parse(await (await import("node:fs/promises")).readFile(process.env.AGUI_BOTS_CONFIG, "utf8"))
  : undefined;
if (registry && (!Array.isArray(registry.bots) || (!registry.management && registry.bots.length === 0) ||
  new Set(registry.bots.map((bot: { id: string }) => bot.id)).size !== registry.bots.length)) {
  throw new Error("Configure unique Bot IDs");
}
interface DeploymentBot {
  id: string;
  agentUrl: string;
  tokenEnv: string;
  memory?: { keyEnv: string; principal: string; projectId: string };
}
const settings = registry ? Object.fromEntries(registry.bots.map((bot: DeploymentBot) =>
  [bot.id, {
    agentUrl: bot.agentUrl, token: process.env[bot.tokenEnv] ?? "",
    memory: bot.memory ? { key: process.env[bot.memory.keyEnv] ?? "",
      principal: bot.memory.principal, projectId: bot.memory.projectId } : undefined,
  }])) : {
  agentUrl: process.env.AGUI_URL ?? "http://127.0.0.1:8000/agent",
  token: process.env.AGUI_API_KEY ?? "",
};
const { loadWiki } = await import("./graph/provider");
const wiki = loadWiki(registry?.graph);
const application = createApplication(registry ? settings : { hermes: settings }, {
  graph: registry?.graph?.enabled ? { provider: wiki, timeoutMs: registry.graph.timeoutMs, authorize: () => true } : undefined,
  management: loadManagement(registry?.management),
  delegation: registry?.delegation ? { ...registry.delegation,
    token: process.env[registry.delegation.tokenEnv] ?? "" } : undefined,
});
await application.ready;
const runtime = createCopilotNodeHandler(application.runtime);
const management = application.management ? createCopilotNodeHandler(application.management.api) : undefined;
const internal = application.delegation
  ? (await import("./delegation-http")).createDelegationServer(application.delegation) : undefined;
if (internal) {
  const internalPort = registry.delegation.listenPort ?? 3001;
  if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535 || internalPort === port) {
    throw new Error("Invalid delegation listenPort");
  }
  internal.listen(internalPort, registry.delegation.listenHost ?? "127.0.0.1");
}
const production = process.argv.includes("--production");
const vite = production ? undefined : await (await import("vite")).createServer({
  server: { middlewareMode: true },
  appType: "spa",
});
const staticApp = new Hono();
staticApp.use("/*", serveStatic({ root: "./dist" }));
staticApp.get("*", serveStatic({ path: "./dist/index.html" }));
const staticListener = getRequestListener(staticApp.fetch);

const server = createServer((req, res) => {
  const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origin = req.headers.origin;
  if (!expectedHosts.has(req.headers.host ?? "") ||
      (origin && ![...expectedHosts].some(host => origin === `http://${host}`))) {
    res.writeHead(403).end("Local requests only");
    return;
  }
  const path = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (management && (path === "/api/bot-session" || path === "/api/bots" || path.startsWith("/api/bots/"))) {
    void management(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
    return;
  }
  if (path === "/api/bots") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Object.keys(registry ? settings : { hermes: settings })));
    return;
  }
  if (path === "/api/copilotkit" || path.startsWith("/api/copilotkit/")) {
    void runtime(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  } else if (vite) {
    vite.middlewares(req, res);
  } else {
    void staticListener(req, res);
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Hermes chat: http://127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    internal?.close();
    internal?.closeAllConnections();
    server.close(() => { application.close(); wiki?.close(); void Promise.resolve(vite?.close()).then(() => process.exit(0)); });
    server.closeAllConnections();
  });
}
