/** Shared restart scenario: real Runtime/registry/compiler, explicit external object contract double. */
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
process.env.DO_NOT_TRACK = "1";
const { createServer } = await import("node:http");
const { createServer: createTlsServer } = await import("node:https");
const { readFile } = await import("node:fs/promises");
const { createCopilotNodeHandler } = await import("@copilotkit/runtime/v2/node");
const { createApplication } = await import("../../server/application");
const { PostgresWikiStore } = await import("../../server/graph/postgres-wiki-store");
const { FilesystemGraphObjects } = await import("../../server/graph/objects");
const { WikiGraphProvider } = await import("../../server/graph/provider");
const { PostgresThreadMappings } = await import("../../server/storage/thread-mappings");
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const store = new PostgresWikiStore(process.env.AGUI_RUNTIME_DATABASE_URL!, new FilesystemGraphObjects(config.objects));
await store.ready();
const provider = new WikiGraphProvider(store, 10000);
const threads = new PostgresThreadMappings(process.env.AGUI_RUNTIME_DATABASE_URL!);
await threads.ready(false);
const app = createApplication({}, {
  management: { postgres: { url: process.env.AGUI_RUNTIME_DATABASE_URL!, credentialSeed: "93".repeat(32) },
    hostUrl: config.hostUrl, hostToken: "fixture-manager-token",
    users: ["owner", "other"].map(principal => ({ principal, ownerId: principal, projectId: config.project, token: principal + "-token" })),
    templates: [{ id: "native", name: "Native", harness: "hermes", model: "fake-model", provider: "custom", skills: [], toolsets: ["memory", "skills"] }] },
  threadMappings: threads, graphCompletionToken: "c".repeat(32), graph: { provider, timeoutMs: 10000, authorize: () => true },
  evolution: { provider, pollMs: 60000, compiler: { async json(stage, input: any) {
    if (stage === "analysis") return { claims: [{ text: input.text, quote: input.text, certainty: "fact", conflict: false }] };
    if (stage === "generation") return { pages: [{ id: "database", title: "資料庫", type: "finding", tags: [], related: [], claims: [0] }] };
    return { claims: [0], conflict: false };
  } } },
});
await app.ready;
const handler = createCopilotNodeHandler(async request => {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ status: "ok" });
  if (path.startsWith("/__test/")) {
    const identity = app.management!.auth.authenticate(request);
    if (!identity) return new Response(null, { status: 401 });
    if (path === "/__test/tick") { await app.evolution!.tick(); return Response.json(await app.evolution!.queue.metrics()); }
    if (path === "/__test/share") {
      const { botId, source } = await request.json(); app.management!.manager.owned(botId, identity);
      const job = await app.evolution!.sessions.share({ principal: identity.principal, projectId: identity.projectId, botId, visibility: "bot_private" }, source);
      return Response.json({ job });
    }
  }
  if (path === "/internal/graph/completions") return app.graphCompletion!(request);
  if (path.startsWith("/api/bots")) return app.management!.api(request);
  if (path.startsWith("/api/graph")) return app.graphApi(request);
  return app.runtime(request);
});
const server = createServer((req, res) => { void handler(req, res); });
server.listen(config.port, "0.0.0.0");
const tls = createTlsServer({ key: await readFile(config.tlsKey), cert: await readFile(config.tlsCert) }, (req, res) => { void handler(req, res); });
tls.listen(3443, "0.0.0.0");
const stop = () => server.close(() => tls.close(() => { void app.close().then(() => store.close()).then(() => threads.close()).then(() => process.exit(0)); }));
process.once("SIGTERM", stop); process.once("SIGINT", stop);
export {};
