export {};

// Set before loading CopilotKit, including modules with import-time telemetry.
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
process.env.DO_NOT_TRACK = "1";

const { createServer } = await import("node:http");
const { createCopilotNodeHandler } = await import("@copilotkit/runtime/v2/node");
const { createRuntimeHandler } = await import("./runtime");
const { Hono } = await import("hono");
const { serveStatic } = await import("@hono/node-server/serve-static");
const { getRequestListener } = await import("@hono/node-server");

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const runtime = createCopilotNodeHandler(createRuntimeHandler({
  agentUrl: process.env.AGUI_URL ?? "http://127.0.0.1:8000/agent",
  token: process.env.AGUI_API_KEY ?? "",
}));
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
    server.close(() => { void vite?.close().then(() => process.exit(0)); });
    server.closeAllConnections();
  });
}
