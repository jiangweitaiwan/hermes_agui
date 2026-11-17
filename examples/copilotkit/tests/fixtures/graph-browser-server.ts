/** Real application/API/WikiStore with a fixture compiler and native fixture Host. No UI route mocks. */
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotNodeHandler } from "@copilotkit/runtime/v2/node";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { getRequestListener } from "@hono/node-server";
import { createServer as createVite } from "vite";
import { createApplication } from "../../server/application";
import { WikiStore } from "../../server/graph/wiki-store";
import { WikiGraphProvider } from "../../server/graph/provider";
const root = mkdtempSync(join(realpathSync(tmpdir()), "graph-ui-"));
const store = new WikiStore(join(root, "wiki"));
mkdirSync('node_modules/.cache', { recursive: true });
const configPath = join(root, 'scope.json');
writeFileSync(configPath, JSON.stringify({ namespace: { principal: 'owner', projectId: 'project', botId: 'a', visibility: 'bot_private' } }));
writeFileSync('node_modules/.cache/graph-fixture.json', JSON.stringify({ root: store.root, configPath }));
const provider = new WikiGraphProvider(store);
const finding = "Research finding: PostgreSQL write ahead logging provides durable database recovery after a crash.";
const app = createApplication(Object.fromEntries(['a', 'b', 'c'].map(id => [id, {
  agentUrl: `http://127.0.0.1:8765/bots/${id}/agent`, token: `browser-test-${id}`,
  memory: { key: "fixture-key", principal: "owner", projectId: "project" },
}])), {
  graph: { provider, authorize: () => true },
  evolution: { provider, pollMs: 1000, compiler: { async json(stage) {
    if (stage === 'analysis') return { claims: [{ text: finding, quote: finding, certainty: 'fact', conflict: false }] };
    if (stage === 'generation') return { pages: [{ id: 'learned', title: 'Learned Alpha', type: 'finding', tags: [], related: ['same'], claims: [0] }] };
    return { claims: [0], conflict: false };
  } } },
  management: { registryPath: join(root, 'bots.sqlite'), hostUrl: 'http://127.0.0.1:8765', hostToken: 'browser-manager-secret',
    users: [{ ownerId: 'owner', principal: 'owner', projectId: 'project', token: 'owner-secret' }, { ownerId: 'other', principal: 'other', projectId: 'other', token: 'other-secret' }],
    templates: [{ id: 'native', name: 'Native', harness: 'hermes', model: 'fake-model', provider: 'custom', skills: [], toolsets: ['memory'] }] },
});
await app.ready;
const registry = app.management!.manager.options.registry;
const c = registry.get('c')!; c.record.ownerId = 'other'; c.record.projectId = 'other';
c.runtime.memory = { key: 'fixture-key', principal: 'other', projectId: 'other' }; registry.put(c);
for (const [botId, visibility, title] of [['a', 'bot_private', 'A private'], ['b', 'bot_private', 'B secret'], ['a', 'project_shared', 'Shared same'], ['c', 'bot_private', 'C secret']] as const) {
  const ns = { botId, visibility, principal: botId === 'c' ? 'other' : 'owner', projectId: botId === 'c' ? 'other' : 'project' };
  store.import(ns, [{ expectedRevision: null, markdown: `---\nid: same\ntitle: ${title}\ntype: note\nsources: [{botId: ${botId}, threadId: fixture, runId: fixture}]\ntags: [fixture]\nrelated: []\ncreated: 2026-11-17T00:00:00.000Z\nupdated: 2026-11-17T00:00:00.000Z\n---\nDatabase 資料庫 [[missing]]\n<script>window.pwned=1</script>\n[bad](javascript:alert(1))\n![tracking](https://example.invalid/track.png)\n[external](https://example.com)` }]);
}
const vite = process.env.COPILOTKIT_TEST_PRODUCTION === '1' ? undefined : await createVite({ server: { middlewareMode: true }, appType: 'spa' });
const assets = new Hono();
assets.use('/*', serveStatic({ root: './dist' }));
assets.get('*', serveStatic({ path: './dist/index.html' }));
const staticListener = getRequestListener(assets.fetch);
const handler = createCopilotNodeHandler(async req => {
  const path = new URL(req.url).pathname;
  if (path.startsWith('/api/graph/')) return app.graphApi(req);
  if (path.startsWith('/api/copilotkit')) return app.runtime(req);
  return app.management!.api(req);
});
const server = createServer((req, res) => {
  if (/^\/api\/(graph\/|bots(?:[/?]|$)|bot-session(?:[/?]|$)|copilotkit(?:[/?]|$))/.test(req.url ?? '')) void handler(req, res);
  else if (vite) vite.middlewares(req, res);
  else void staticListener(req, res);
});
server.listen(3000, '127.0.0.1');
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); void app.close().then(() => { store.close(); rmSync(root, { recursive: true, force: true }); return vite?.close(); }).then(() => process.exit(0)); });
