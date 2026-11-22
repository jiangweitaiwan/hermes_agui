import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createCopilotNodeHandler } from "@copilotkit/runtime/v2/node";
import { createApplication } from "../server/application";
import { WikiStore, namespaceKey } from "../server/graph/wiki-store";
import { WikiGraphProvider } from "../server/graph/provider";
import { DocumentIngestor } from "../server/graph/ingest-queue";
import type { Namespace } from "../server/graph/types";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });
const ns: Namespace = { principal: "owner", projectId: "project", botId: "a", visibility: "bot_private" };
function md(id: string, body = "資料庫 database", bot = "a", links: string[] = [], sources?: unknown[]) {
  return `---\nid: ${id}\ntitle: ${id}\ntype: note\nsources: ${JSON.stringify(sources ?? [{ botId: bot, threadId: "thread", runId: "run" }])}\ntags: []\nrelated: ${JSON.stringify(links)}\ncreated: 2026-11-17T00:00:00.000Z\nupdated: 2026-11-17T00:00:00.000Z\n---\n${body}`;
}
async function fixture(evolution = true, enabled = true) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "browser-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new WikiStore(join(root, "wiki")); cleanups.push(() => store.close());
  const provider = new WikiGraphProvider(store), queue = new DocumentIngestor(store);
  let allowed = true;
  const bots = Object.fromEntries(["a", "b", "c"].map(id => [id, { agentUrl: "http://localhost/agent", token: "secret",
    memory: { key: "key", principal: "owner", projectId: "project" } }]));
  const app = createApplication(bots, {
    graph: enabled ? { provider, authorize: () => allowed } : undefined,
    evolution: evolution ? { provider, compiler: { json: async () => { throw new Error("No model calls"); } }, pollMs: 60000 } : undefined,
    management: { registryPath: join(root, "bots.sqlite"), hostUrl: "http://localhost", hostToken: "host-secret",
      users: [{ ownerId: "owner", principal: "owner", projectId: "project", token: "token" },
        { ownerId: "other", principal: "other", projectId: "other", token: "other" }],
      templates: [{ id: "native", name: "native", harness: "hermes", model: "mock", provider: "mock", skills: [], toolsets: [] }] },
  });
  await app.ready; cleanups.push(() => app.close());
  const registry = app.management!.manager.options.registry;
  const c = registry.get("c")!; c.record.ownerId = "other"; c.record.projectId = "other";
  c.runtime.memory = { key: "key", principal: "other", projectId: "other" }; registry.put(c);
  const put = (namespace: Namespace, id: string, body?: string, bot = namespace.botId, links: string[] = [], sources?: unknown[]) =>
    store.import(namespace, [{ markdown: md(id, body, bot, links, sources), expectedRevision: null }]);
  put(ns, "same", "A private 資料庫 [[next]] [[missing]]", "a", ["next"]);
  put(ns, "next", "A next database", "a", ["same"]);
  put({ ...ns, botId: "b" }, "same", "B PRIVATE SECRET", "b");
  put({ ...ns, visibility: "project_shared" }, "same", "shared 資料庫", "b");
  put({ ...ns, principal: "other", projectId: "other", botId: "c" }, "same", "C PRIVATE SECRET", "c");
  writeFileSync(join(store.root, "unpublished.md"), md("unpublished", "UNPUBLISHED SECRET"));
  const request = (path: string, token = "token", init: RequestInit = {}) => app.graphApi(new Request(`http://localhost/api/graph/${path}`, {
    headers: { Authorization: `Bearer ${token}` }, ...init,
  }));
  return { root, app, store, provider, queue, registry, request, put, deny: () => { allowed = false; } };
}
test("every endpoint enforces identity, ownership, namespaces and no-store", async () => {
  const f = await fixture();
  for (const path of ["stats", "network", "pages", "search?q=資料庫", "pages/bot_private/same", "health", "jobs"]) {
    expect((await f.request(`a/${path}`, "")).status).toBe(401);
    expect((await f.request(`a/${path}`, "other")).status).toBe(404);
    expect((await f.request(`c/${path}`)).status).toBe(404);
    const response = (await f.request(`a/${path}`));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toMatch(/B PRIVATE|C PRIVATE|UNPUBLISHED|host-secret|lease|wiki.sqlite/);
  }
  expect(await (await f.request("a/stats")).json()).toMatchObject({ pages: 3, private: 2, shared: 1, edges: 2 });
  expect(await (await f.request("b/stats")).json()).toMatchObject({ pages: 2, private: 1, shared: 1 });
  expect((await (await f.request("a/pages/project_shared/same")).json()).provenance[0].botId).toBe("b");
  expect((await f.request("a/pages/project_shared/same?scope=bot_private")).status).toBe(404);
});
test("bound keyset pagination, Chinese FTS, filters and closed network", async () => {
  const f = await fixture();
  const first = await (await f.request("a/pages?limit=1")).json();
  const second = await (await f.request(`a/pages?limit=1&cursor=${first.nextCursor}`)).json();
  expect(second.pages[0].id).not.toBe(first.pages[0].id);
  for (const path of ["a/pages?scope=project_shared&limit=1", "b/pages?limit=1", "a/network?limit=1", "a/pages?limit=1&type=entity"]) {
    expect((await f.request(`${path}&cursor=${first.nextCursor}`)).status).toBe(400);
  }
  const all = await (await f.request("a/pages")).json();
  expect(all.pages.filter((p: any) => p.pageId === "same").map((p: any) => p.id)).toEqual(["bot_private:same", "project_shared:same"]);
  expect((await (await f.request("a/pages?type=entity")).json()).pages).toEqual([]);
  expect((await (await f.request("a/search?q=資料庫")).json()).pages).toHaveLength(2);
  expect((await (await f.request("a/search?q=%22%20OR%201%3D1--")).json()).pages).toEqual([]);
  for (const query of ["", "?limit=1", "?pageId=same&visibility=bot_private&depth=2", "?scope=project_shared"]) {
    const network = await (await f.request(`a/network${query}`)).json();
    const ids = new Set(network.nodes.map((n: any) => n.id));
    for (const edge of network.edges) { expect(ids.has(edge.source)).toBe(true); expect(ids.has(edge.target)).toBe(true); }
    expect(network.edges.some((e: any) => e.target.endsWith(":missing"))).toBe(false);
  }
  expect((await (await f.request("a/pages/bot_private/same")).json()).related.map((p: any) => p.pageId)).toEqual(["next"]);
});
test("strict input, methods, origin, disabled/unavailable/static and evolution off", async () => {
  const f = await fixture(false);
  for (const path of ["pages?limit=0", "pages?limit=301", "pages?limit=1.5", "pages?scope=bad", "pages?q=", "pages?q=" + "x".repeat(513),
    "pages?cursor=xxx", "pages?principal=other", "pages?limit=1&limit=2", "network?depth=3", "network?pageId=same", "search", "pages/bot_private/%2e%2e%2fsecret"]) {
    expect((await f.request(`a/${path}`)).status, path).toBe(400);
  }
  expect((await f.request("a/pages", "token", { method: "POST" })).status).toBe(405);
  expect((await f.request("a/pages", "token", { headers: { Authorization: "Bearer token", Origin: "http://evil" } })).status).toBe(403);
  expect((await f.request("a/health")).status).toBe(503); expect((await f.request("a/jobs")).status).toBe(503);
  expect((await f.request("a/pages")).status).toBe(200);
  const disabled = await fixture(false, false); expect((await disabled.request("a/pages")).status).toBe(503);
  const staticApp = createApplication({}); await staticApp.ready; cleanups.push(() => staticApp.close());
  expect((await staticApp.graphApi(new Request("http://localhost/api/graph/a/pages"))).status).toBe(503);
  vi.spyOn(f.store, "read").mockImplementation(() => { throw new Error("path secret"); });
  expect(await (await f.request("a/pages")).text()).not.toContain("path secret");
  expect((await f.request("a/pages")).status).toBe(503);
});
test("disabled owner reads; deleted sources, mixed pages and policy changes revoke", async () => {
  const f = await fixture();
  const a = f.registry.get("a")!; a.record.status = "disabled"; f.registry.put(a);
  expect((await f.request("a/pages/bot_private/same")).status).toBe(200);
  f.put({ ...ns, visibility: "project_shared" }, "mixed", "mixed secret", "a", [], [
    { botId: "a", threadId: "t1", runId: "r1" }, { botId: "b", threadId: "t2", runId: "r2" }]);
  const b = f.registry.get("b")!; b.record.deletedAt = new Date().toISOString(); f.registry.put(b);
  expect((await f.request("b/pages")).status).toBe(404);
  expect((await f.request("a/pages/project_shared/mixed")).status).toBe(404);
  expect((await f.request("a/pages/project_shared/same")).status).toBe(404);
  expect((await (await f.request("a/stats")).json()).shared).toBe(0);
  f.deny(); expect((await f.request("a/pages")).status).toBe(404);
});
test("without evolution revoked documents cannot reappear; no retrieval or writes", async () => {
  const f = await fixture(false);
  f.queue.enqueue(ns, { title: "doc", content: "source evidence", mime: "text/plain", idempotencyKey: "request" });
  const raw = f.store.db.prepare("SELECT * FROM document_sources WHERE ns=?").get(namespaceKey(ns))!;
  const source = { kind: "document", botId: "a", sourceId: String(raw.id), version: 1, hash: String(raw.hash), title: "doc" };
  f.put(ns, "document", "document body", "a", [], [source]);
  expect((await f.request("a/pages/bot_private/document")).status).toBe(200);
  f.queue.revoke(ns, String(raw.id)); f.put(ns, "resurrected", "old evidence", "a", [], [source]);
  expect((await f.request("a/pages/bot_private/resurrected")).status).toBe(404);
  const before = f.store.db.prepare("SELECT * FROM pages ORDER BY ns,page").all();
  const spy = vi.spyOn(f.provider.retriever, "query").mockRejectedValue(new Error("No retrieval"));
  (await f.request("a/search?q=資料庫")); expect(spy).not.toHaveBeenCalled();
  expect(f.store.db.prepare("SELECT * FROM pages ORDER BY ns,page").all()).toEqual(before);
  const a = f.registry.get("a")!; a.runtime.memory!.principal = "changed"; f.registry.put(a);
  expect((await f.request("a/pages")).status).toBe(404);
});
test("actual HTTP returns active revision and safe job summaries", async () => {
  const f = await fixture(), handler = createCopilotNodeHandler(async request => f.app.graphApi(request));
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const port = (server.address() as { port: number }).port;
  const get = (path: string, token = "token") => fetch(`http://127.0.0.1:${port}/api/graph/a/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  expect((await get("pages", "")).status).toBe(401);
  const previous = f.store.active(namespaceKey(ns), "same")!.revision;
  f.store.import(ns, [{ markdown: md("same", "new active revision"), expectedRevision: previous }]);
  const detail = await (await get("pages/bot_private/same")).json();
  expect(detail.body).toBe("new active revision"); expect(detail.revisionId).not.toBe(previous);
  const job = f.queue.enqueue(ns, { title: "doc", content: "raw secret", mime: "text/plain", idempotencyKey: "job" });
  f.store.db.prepare("UPDATE ingest_jobs SET error=?,token=? WHERE id=?").run("error secret", "lease secret", job);
  const jobs = await (await get("jobs")).json(); expect(jobs.jobs[0].id).toBe(job);
  expect(Object.keys(jobs.jobs[0]).sort()).toEqual(["createdAt", "id", "state"]);
});
test("work bounds, complete keyset traversal and bounded edges", async () => {
  const f = await fixture(false);
  const inputs = Array.from({ length: 305 }, (_, i) => ({ markdown: md(`extra${String(i).padStart(3, "0")}`, "database"), expectedRevision: null }));
  f.store.import(ns, inputs);
  const stats = await (await f.request("a/stats")).json(); expect(stats.partial).toBe(true); expect(stats.pages).toBe(300);
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await (await f.request(`a/pages?limit=100${cursor ? `&cursor=${cursor}` : ""}`)).json();
    for (const page of result.pages) { expect(seen.has(page.id)).toBe(false); seen.add(page.id); }
    cursor = result.nextCursor;
  } while (cursor);
  expect(seen.size).toBe(308);
  expect((await f.request("a/network?limit=300")).status).toBe(200);
  const revision = f.store.active(namespaceKey(ns), "same")!.revision;
  f.store.import(ns, [{ markdown: md("same", inputs.map((_, i) => `[[extra${String(i).padStart(3, "0")}]]`).join(" ")),
    expectedRevision: revision }]);
  const focusQuery = "a/network?limit=300&pageId=same&visibility=bot_private";
  const first = await (await f.request(focusQuery)).json();
  expect(first.nodes).toHaveLength(300); expect(first.truncated).toBe(true);
  const last = await (await f.request(`${focusQuery}&cursor=${first.nextCursor}`)).json();
  expect(last.nodes).toHaveLength(1); expect(last.nextCursor).toBeNull(); expect(last.truncated).toBe(true);
}, 30000);
test("Browser rejects a revision changed during immutable object reading", async () => {
  const f = await fixture(false);
  const other = new WikiStore(f.store.root); cleanups.push(() => other.close());
  other.db.exec("PRAGMA busy_timeout=1");
  const original = f.store.read.bind(f.store); let checked = false;
  vi.spyOn(f.store, "read").mockImplementation(row => {
    if (!checked) {
      checked = true;
      other.import(ns, [{ markdown: md("same", "concurrent secret"), expectedRevision: row.revision }]);
    }
    return original(row);
  });
  expect((await f.request("a/pages/bot_private/same")).status).toBe(503); expect(checked).toBe(true);
  const revision = other.active(namespaceKey(ns), "same")!.revision;
  vi.restoreAllMocks();
  other.import(ns, [{ markdown: md("same", "published after snapshot"), expectedRevision: revision }]);
  expect((await (await f.request("a/pages/bot_private/same")).json()).body).toBe("published after snapshot");
});
test("Unicode cursors match SQLite byte ordering and tracked sessions stay revoked with evolution off", async () => {
  const f = await fixture(false);
  f.put(ns, "𠀀", "astral page"); f.put(ns, "鴨", "BMP page");
  const seen = new Set<string>(); let cursor: string | null = null;
  do {
    const result = await (await f.request(`a/pages?limit=1${cursor ? `&cursor=${cursor}` : ""}`)).json();
    for (const page of result.pages) { expect(seen.has(page.id)).toBe(false); seen.add(page.id); }
    cursor = result.nextCursor;
  } while (cursor);
  expect(seen.size).toBe(5);
  const provenance = { botId: "a", threadId: "tracked-thread", runId: "tracked-run" };
  f.queue.enqueue(ns, { title: "session", content: "session evidence", mime: "text/plain", idempotencyKey: "session" },
    { provenance, classification: "finding" });
  const raw = f.store.db.prepare("SELECT id FROM document_sources WHERE ns=?").get(namespaceKey(ns))!;
  f.put(ns, "session", "session body", "a", [], [provenance]);
  expect((await f.request("a/pages/bot_private/session")).status).toBe(200);
  f.queue.revoke(ns, String(raw.id));
  f.put(ns, "session-old", "revoked session", "a", [], [provenance]);
  expect((await f.request("a/pages/bot_private/session-old")).status).toBe(404);
});
test("network caps dense edges and rechecks every source owner before returning", async () => {
  const f = await fixture(false);
  const ids = Array.from({ length: 40 }, (_, i) => `dense${i}`);
  f.store.import(ns, ids.map(id => ({ markdown: md(id, "dense database", "a", ids), expectedRevision: null })));
  const network = await (await f.request("a/network")).json();
  expect(network.edges).toHaveLength(1500); expect(network.truncated).toBe(true);
  const nodes = new Set(network.nodes.map((n: any) => n.id));
  expect(network.edges.every((e: any) => nodes.has(e.source) && nodes.has(e.target))).toBe(true);
  expect((await (await f.request("a/stats")).json()).edges).toBe(1602);
  const get = f.registry.get.bind(f.registry); let reads = 0;
  vi.spyOn(f.registry, "get").mockImplementation(id => {
    const bot = get(id);
    if (id === "b" && bot && ++reads > 1) bot.record.deletedAt = new Date().toISOString();
    return bot;
  });
  expect((await f.request("a/pages/project_shared/same")).status).toBe(404);
}, 30000);
test("jobs cap at 50 and health marks full candidate windows partial", async () => {
  const f = await fixture();
  for (let i = 0; i < 51; i++) f.queue.enqueue(ns, {
    title: `job ${i}`, content: `evidence ${i}`, mime: "text/plain", idempotencyKey: `job-${i}`,
  });
  const jobs = await (await f.request("a/jobs?limit=300")).json(); expect(jobs.jobs).toHaveLength(50);
  const health = await (await f.request("a/health")).json();
  expect(health).toMatchObject({ status: "ok", pending: 50, partial: true, brokenLinks: null, isolated: null });
  expect(JSON.stringify(jobs)).not.toMatch(/evidence|lease|token|content|error/);
}, 30000);
test("V2 facts API: grouped subject detail, evidence windows, current/history, cursors and revoke/disable",async()=>{
 const f=await fixture();const {WikiCompiler}=await import("../server/graph/compiler"),{meeting,fixtureModel}=await import("./fixtures/graph-v2/model");
 const id=f.queue.enqueue(ns,{title:"meeting",content:meeting,mime:"text/plain",idempotencyKey:"meeting"},{provenance:{botId:"a",threadId:"meeting",runId:"meeting"},classification:"user-stated",referenceTime:{instant:"2026-11-03T08:00:00.000Z",timezone:"Asia/Taipei"},evidence:{user:meeting,confirmed:false,assistants:[]}});
 await new WikiCompiler(f.queue,fixtureModel(),120000,"v2").processJob(ns,id);
 for(const token of ["","other"])expect((await f.request("a/facts",token)).status).toBe(token?404:401);
 const response=await f.request("a/facts?view=history&limit=2");expect(response.status).toBe(200);const first=await response.json();expect(first.edges).toHaveLength(2);
 expect((await f.request(`b/facts?view=history&limit=2&cursor=${first.nextCursor}`)).status).toBe(400);
 const subjects=await f.queue.graphSubjects(ns),hub=subjects.find(s=>s.canonicalName==="FeatureHub")!;
 const grouped=await (await f.request(`a/facts?pageId=${hub.wikiPageId}&view=history`)).json();expect(grouped.subjects.filter((s:any)=>s.wikiPageId===hub.wikiPageId)).toHaveLength(2);
 const edge=first.edges[0];expect((await (await f.request(`a/facts?edgeId=${edge.edgeId}&view=history`)).json()).edges).toHaveLength(1);
 f.queue.revoke(ns,f.queue.status(ns,id).source);expect((await (await f.request("a/facts?view=history")).json()).edges).toEqual([]);
 const bot=f.registry.get("a")!;bot.record.status="disabled";f.registry.put(bot);
 expect((await (await f.request("a/facts")).json()).edges).toEqual([]);
});
