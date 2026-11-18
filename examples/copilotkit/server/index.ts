export {};

// Set before loading CopilotKit, including modules with import-time telemetry.
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
process.env.DO_NOT_TRACK = "1";

const { createServer } = await import("node:http");
const { createCopilotNodeHandler } = await import("@copilotkit/runtime/v2/node");
const { Hono } = await import("hono");
const { serveStatic } = await import("@hono/node-server/serve-static");
const { getRequestListener } = await import("@hono/node-server");

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const registry = process.env.AGUI_BOTS_CONFIG
  ? JSON.parse(await (await import("node:fs/promises")).readFile(process.env.AGUI_BOTS_CONFIG, "utf8"))
  : undefined;
const { bootstrap } = await import("./bootstrap");
const { application, wiki, threadMappings, settings } = await bootstrap(registry);
// Local operational counters only; no prompts, identifiers, source text or credentials.
const metricsTimer = application.evolution ? setInterval(async () => {
  const evolution = application.evolution!;
  console.log(JSON.stringify({ graphMemory: { query: evolution.options.provider.metrics,
    worker: evolution.metrics, jobs: await evolution.queue.metrics(), sessions: evolution.sessions.metrics,
    compiler: "metrics" in evolution.options.compiler ? evolution.options.compiler.metrics : undefined,
    embeddings: evolution.options.provider.retrieval?.vectors?.metrics } }));
}, 60000) : undefined;
metricsTimer?.unref();
const runtime = createCopilotNodeHandler(application.runtime);
const graphApi = createCopilotNodeHandler(async request => {
  await application.management?.manager.sync();
  return application.graphApi(request);
});
const management = application.management ? createCopilotNodeHandler(application.management.api) : undefined;
const internalRoutes = new Map<string, import("./delegation-http").InternalRoute>();
if (application.delegation) {
  internalRoutes.set("/internal/delegations", { maxBytes: 20_000, handle: request => application.delegation!.handle(request) });
}
if (application.graphCompletion) {
  internalRoutes.set("/internal/graph/completions", { maxBytes: 512 * 1024, handle: application.graphCompletion });
}
const internal = internalRoutes.size
  ? (await import("./delegation-http")).createInternalServer(internalRoutes) : undefined;
if (internal) {
  const internalPort = registry.internal?.listenPort ?? registry.delegation?.listenPort ?? 3001;
  if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535 || internalPort === port) {
    throw new Error("Invalid internal listenPort");
  }
  internal.listen(internalPort, registry.internal?.listenHost ?? registry.delegation?.listenHost ?? "127.0.0.1");
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
  if (path === "/api/graph" || path.startsWith("/api/graph/")) {
    void graphApi(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end();
    });
    return;
  }
  if (management && (path === "/api/bot-session" || path === "/api/bots" || path.startsWith("/api/bots/"))) {
    void management(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
    return;
  }
  if (path === "/api/bots") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Object.keys(settings)));
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
    clearInterval(metricsTimer);
    internal?.close();
    internal?.closeAllConnections();
    server.close(() => { void application.close().then(async () => { await threadMappings?.close(); await wiki?.close(); await vite?.close(); }).then(() => process.exit(0)); });
    server.closeAllConnections();
  });
}
