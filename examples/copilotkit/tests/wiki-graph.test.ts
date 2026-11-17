import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiStore } from "../server/graph/wiki-store";
import { WikiGraphProvider, loadWiki } from "../server/graph/provider";
import { parsePage } from "../server/graph/markdown";
import { ManifestSchema } from "../server/graph/types";
import { createGraphMemory } from "../server/graph-memory";
import { ContextAssembler } from "../server/memory/assembler";
import { createApplication } from "../server/application";

const roots: string[] = [], stores: WikiStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function setup(options = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-test-")); roots.push(root);
  const store = new WikiStore(root, options); stores.push(store);
  return { root, store, provider: new WikiGraphProvider(store) };
}
const scope = { principal: "owner", projectId: "project", botId: "a", threadId: "current", runId: "current-run" };
const ns = { principal: scope.principal, projectId: scope.projectId, botId: "a", visibility: "bot_private" as const };
export function markdown(id: string, body: string, related: string[] = [], botId = "a") {
  return `---\nid: ${id}\ntitle: ${id}\ntype: note\nsources:\n  - botId: ${botId}\n    threadId: recorded-thread\n    runId: recorded-run\ntags: []\nrelated: ${JSON.stringify(related)}\ncreated: 2026-11-17T00:00:00.000Z\nupdated: 2026-11-17T00:00:00.000Z\n---\n${body}`;
}
const input = (id: string, body: string, related: string[] = [], bot = "a") => ({ markdown: markdown(id, body, related, bot), expectedRevision: null });
const query = async (provider: WikiGraphProvider, text: string, changes = {}, limit = 50) => {
  const result = await provider.query({ ...scope, ...changes }, { text, limit }, new AbortController().signal);
  if (result.status !== "ok") throw new Error(result.status);
  return result.hits;
};
test("English/CJK lexical retrieval, paragraphs, aliases, cycles, broken links and stable ranking", async () => {
  const { store, provider } = setup();
  store.import(ns, [input("database", "PostgreSQL database performance\n\n繁體中文資料庫搜尋 [[neighbor|別名]] [[missing]] [[other:secret]]", ["neighbor"]),
    input("neighbor", "database tuning", ["database"]), input("irrelevant", "flowers and gardens", ["database"])]);
  expect((await query(provider, "資料庫")).map(h => h.content)).toEqual([expect.stringContaining("繁體中文")]);
  const hits = await query(provider, "database performance");
  expect(hits[0].content).toBe("PostgreSQL database performance");
  expect(hits.some(h => h.content === "database tuning")).toBe(true);
  expect(hits.some(h => h.content.includes("flowers"))).toBe(false);
  expect(await query(provider, "no-match-xyz")).toEqual([]);
  expect(await query(provider, "database performance")).toEqual(hits);
  expect(store.diagnostics().edges).toBe(4);
});
test("namespace identity, same slug isolation, private/shared edges never cross boundaries", async () => {
  const { store, provider } = setup();
  store.import(ns, [input("same", "database private A", ["secret"])]);
  store.import({ ...ns, botId: "b" }, [input("secret", "database private B", [], "b")]);
  store.import({ ...ns, visibility: "project_shared" }, [input("same", "database shared")]);
  store.import({ ...ns, principal: "other" }, [input("same", "database other owner")]);
  store.import({ ...ns, projectId: "other" }, [input("same", "database other project")]);
  expect((await query(provider, "database")).map(h => h.content).sort()).toEqual(["database private A", "database shared"]);
  expect((await query(provider, "database", { botId: "b" })).map(h => h.content).sort()).toEqual(["database private B", "database shared"]);
  expect(await query(provider, "database", { principal: "unknown" })).toEqual([]);
  expect(await query(provider, "database", { projectId: "unknown" })).toEqual([]);
});
test("restart/reindex preserve results, CAS prevents lost updates and uncommitted files stay invisible", async () => {
  const { root, store, provider } = setup();
  const [revision] = store.import(ns, [input("page", "database published")]);
  const before = await query(provider, "database");
  expect(() => store.import(ns, [input("page", "database lost update")])).toThrow("Revision conflict");
  expect(() => store.import(ns, [input("duplicate", "x"), input("duplicate", "y")])).toThrow("Duplicate");
  writeFileSync(join(root, "unpublished.md"), markdown("secret", "database unpublished"));
  store.db.exec("DELETE FROM sections; DELETE FROM edges");
  expect(await query(provider, "database")).toEqual([]);
  store.reindex();
  expect(await query(provider, "database")).toEqual(before);
  store.close(); stores.splice(stores.indexOf(store), 1);
  const restarted = new WikiStore(root); stores.push(restarted);
  expect(await query(new WikiGraphProvider(restarted), "database")).toEqual(before);
  restarted.import(ns, [{ markdown: markdown("page", "database updated"), expectedRevision: revision }]);
  expect((await query(new WikiGraphProvider(restarted), "database"))[0].content).toBe("database updated");
});
test("safe frontmatter, paths, source provenance and limits", () => {
  const { root, store } = setup({ maxPages: 1 });
  expect(() => parsePage(markdown("../escape", "x"))).toThrow();
  expect(() => parsePage(markdown("safe", "x").replace("tags: []", "tags: &a [*a]"))).toThrow();
  expect(() => parsePage(markdown("safe", "x").replace("tags: []", "visibility: project_shared\ntags: []"))).toThrow();
  expect(() => store.import(ns, [input("safe", "x", [], "b")])).toThrow("source");
  expect(() => ManifestSchema.parse({ version: 1, namespace: ns, pages: [{ file: "../secret.md", expectedRevision: null }] })).toThrow();
  symlinkSync(root, join(root, "link"));
  expect(() => new WikiStore(join(root, "link", "store"))).toThrow("Symlink");
  store.import(ns, [input("one", "database")]);
  expect(() => store.import(ns, [input("two", "database")])).toThrow("page limit");
});
test("disabled creates nothing, write disabled, unavailable/abort/timeout and result budgets", async () => {
  const { root, store, provider } = setup();
  const absent = join(root, "disabled");
  expect(loadWiki({ enabled: false, dataRoot: absent })).toBeUndefined(); expect(existsSync(absent)).toBe(false);
  expect(await loadWiki({ enabled: true, dataRoot: join(root, "wiki.sqlite", "invalid") })!.query(scope, { text: "database", limit: 1 }, new AbortController().signal)).toEqual({ status: "unavailable" });
  store.import(ns, Array.from({ length: 60 }, (_, i) => input(`page${i}`, `database ${i} ${"x".repeat(500)}`)));
  const hits = await query(provider, "database");
  expect(hits.length).toBeLessThanOrEqual(50);
  const context = new ContextAssembler().assemble(hits);
  expect(context.records.length).toBeLessThanOrEqual(20);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(4096);
  expect(await provider.write(scope, {} as never, new AbortController().signal)).toEqual({ status: "disabled" });
  const abort = new AbortController(); abort.abort();
  expect(await provider.query(scope, { text: "database", limit: 50 }, abort.signal)).toEqual({ status: "unavailable" });
  expect(await new WikiGraphProvider(store, 0).query(scope, { text: "database", limit: 50 }, new AbortController().signal)).toEqual({ status: "unavailable" });
  const graph = createGraphMemory({ provider, authorize: () => true });
  expect(await graph.query(scope, { text: "database", limit: 1 })).toMatchObject({ status: "rejected" });
  expect(await graph.query(graph.scope(scope), { text: "database", limit: 51 })).toMatchObject({ status: "rejected" });
});
test("custom policy cannot bypass base principal/project/bot authorization", async () => {
  const app = createApplication({ a: { agentUrl: "http://localhost/agent", token: "t", memory: { key: "key", principal: "owner", projectId: "project" } } },
    { graph: { authorize: () => true } });
  for (const changes of [{ principal: "forged" }, { projectId: "forged" }, { botId: "illegal" }]) {
    expect(await app.graph.query(app.graph.scope({ ...scope, ...changes }), { text: "database", limit: 1 })).toEqual({ status: "rejected", reason: "unauthorized" });
  }
  app.close();
});
test("one-hop expansion adds lexically relevant neighbors beyond eight seeds; edges alone do not qualify", async () => {
  const { store, provider } = setup();
  store.import(ns, [
    ...Array.from({ length: 8 }, (_, i) => input(`seed${i}`, "database performance tuning", i === 0 ? ["neighbor", "unrelated"] : [])),
    input("neighbor", "database connected detail", ["seed0"]),
    input("unrelated", "gardening connected detail"),
  ]);
  const hits = await query(provider, "database performance tuning");
  expect(hits.filter(h => h.content === "database connected detail")).toHaveLength(1);
  expect(hits.some(h => h.content.includes("gardening"))).toBe(false);
  expect(hits.at(-1)!.content).toBe("database connected detail");
  expect(await query(provider, "unfindable")).toEqual([]);
});
test("failed publication rolls back pointers/indexes and cleanup removes only uncommitted revision files", async () => {
  const { store, root, provider } = setup();
  store.db.exec(`CREATE TRIGGER reject_bad BEFORE INSERT ON pages WHEN NEW.page='bad'
    BEGIN SELECT RAISE(ABORT, 'publication failed'); END`);
  expect(() => store.import(ns, [input("good", "database good"), input("bad", "database bad")])).toThrow("publication failed");
  expect(await query(provider, "database")).toEqual([]);
  expect(store.diagnostics()).toMatchObject({ pages: 0, revisions: 0, sections: 0 });
  const { readdirSync } = await import("node:fs");
  const files = () => readdirSync(root, { recursive: true }).filter(p => String(p).endsWith(".md"));
  expect(files().length).toBeGreaterThan(0);
  store.cleanup();
  expect(files()).toEqual([]);
  store.db.exec("DROP TRIGGER reject_bad");
  store.import(ns, [input("good", "database good")]);
  store.cleanup();
  expect(files()).toHaveLength(1);
  expect((await query(provider, "database"))[0].content).toBe("database good");
});
