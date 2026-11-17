import { afterEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { WikiStore } from "../server/graph/wiki-store";
import { VectorIndex, OpenAIEncoder, type Encoder } from "../server/graph/embedding";
import { WikiRetriever } from "../server/graph/retriever";

const roots: string[] = [], stores: WikiStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
const ns = { principal: "owner", projectId: "project", visibility: "bot_private" as const, botId: "a" };
const scope = { ...ns, threadId: "thread", runId: "run" };
const signal = () => new AbortController().signal;
const encoder: Encoder = { model: "fixture", dimension: 2, version: "1", async embed(texts) { return texts.map(t => /durability|write ahead|復原/.test(t) ? [1, 0] : [0, 1]); } };
function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-hybrid-")); roots.push(root);
  const store = new WikiStore(root); stores.push(store);
  return { store, vectors: new VectorIndex(store, encoder) };
}
function page(id: string, body: string, related: string[] = []) {
  return { expectedRevision: null, markdown: `---\n${stringify({ id, title: id, type: "concept", sources: [{ botId: "a", threadId: "t", runId: "r" }],
    tags: [], related, created: "2026-11-17T00:00:00.000Z", updated: "2026-11-17T00:00:00.000Z" })}---\n${body}` };
}
test("semantic seeds + one-hop graph recover paraphrases, metadata changes fall back, stale revisions and other owners never return", async () => {
  const { store, vectors } = setup();
  store.import(ns, [page("wal", "write ahead logging", ["steps"]), page("steps", "Restore from the most recent checkpoint.")]);
  await vectors.update(ns, signal());
  const keyword = new WikiRetriever(store), hybrid = new WikiRetriever(store, 2000, { vectors });
  expect(await keyword.query(scope, { text: "durability", limit: 10 }, signal())).toEqual([]);
  const result = await hybrid.query(scope, { text: "durability", limit: 10 }, signal());
  expect(result.map(h => h.content)).toEqual(expect.arrayContaining(["write ahead logging", "Restore from the most recent checkpoint."]));
  expect(await hybrid.query({ ...scope, principal: "other" }, { text: "durability", limit: 10 }, signal())).toEqual([]);
  const changed = new VectorIndex(store, { ...encoder, version: "2" });
  expect(await new WikiRetriever(store, 2000, { vectors: changed }).query(scope, { text: "durability", limit: 10 }, signal())).toEqual([]);
  store.import(ns, [{ ...page("wal", "new replacement"), expectedRevision: result[0].recordId.split(":")[0] }]);
  const stale = await hybrid.query(scope, { text: "durability", limit: 10 }, signal());
  expect(stale.some(h => h.content === "write ahead logging")).toBe(false);
  await changed.update(ns, signal()); expect(changed.metrics.indexed).toBeGreaterThan(0);
});
test.each(["offline", "dimension", "invalid"])("%s embedding uses keyword fallback and refuses invalid indexing", async mode => {
  const { store } = setup(); store.import(ns, [page("wal", "write ahead logging")]);
  const broken: Encoder = { ...encoder, async embed() { if (mode === "offline") throw new Error("offline"); return mode === "dimension" ? [[1]] : [[NaN, 1]]; } };
  const vectors = new VectorIndex(store, broken);
  await vectors.update(ns, signal()); expect(vectors.metrics.indexed).toBe(0);
  const result = await new WikiRetriever(store, 2000, { vectors }).query(scope, { text: "logging", limit: 5 }, signal());
  expect(result[0].content).toBe("write ahead logging");
});
test("revocation/publication during async embedding never indexes withdrawn or superseded versions; rebuild handles multiple batches", async () => {
  const { store } = setup(); store.import(ns, [page("wal", "write ahead logging")]);
  const vectors = new VectorIndex(store, { ...encoder, async embed(texts) { store.db.exec("DELETE FROM pages; DELETE FROM sections; DELETE FROM edges"); return texts.map(() => [1, 0]); } });
  await vectors.update(ns, signal()); expect(vectors.metrics.indexed).toBe(0);
  store.import(ns, Array.from({ length: 40 }, (_, i) => page(`p${i}`, `write ahead logging ${i}`)));
  const rebuilt = new VectorIndex(store, encoder); rebuilt.rebuild(ns);
  await rebuilt.update(ns, signal()); await rebuilt.update(ns, signal());
  expect(rebuilt.metrics.indexed).toBe(40);
  expect((await rebuilt.search(["unauthorized"], "durability", signal()))).toEqual([]);
});
test("embedding adapter batches in index order, binds model/dimension/version, retries and rejects wrong models", async () => {
  process.env.EMBEDDING_TEST_KEY = "test";
  try {
    let calls = 0;
    const options = { baseUrl: "http://localhost/v1", model: "fixture", keyEnv: "EMBEDDING_TEST_KEY", dimension: 2, version: "v1" };
    const adapter = new OpenAIEncoder(options, (async () => {
      calls++; return Response.json({ model: "fixture", data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    }) as typeof fetch);
    expect(await adapter.embed(["a", "b"], signal())).toEqual([[1, 0], [0, 1]]); expect(calls).toBe(1);
    const bad = new OpenAIEncoder(options, (async () => Response.json({ model: "other", data: [] })) as typeof fetch);
    await expect(bad.embed(["a"], signal())).rejects.toThrow("model mismatch");
    const { store } = setup(); store.import(ns, [page("wal", "write ahead logging")]); let attempts = 0;
    const vectors = new VectorIndex(store, { ...encoder, async embed(texts) { if (++attempts === 1) throw new Error(); return encoder.embed(texts, signal()); } });
    await vectors.update(ns, signal()); expect(attempts).toBe(2); expect(vectors.metrics.indexed).toBe(1);
  } finally { delete process.env.EMBEDDING_TEST_KEY; }
});

test("an encoder that never responds still permits bounded keyword fallback", async () => {
  const { store } = setup(); store.import(ns, [page("wal", "write ahead logging")]);
  const vectors = new VectorIndex(store, { ...encoder, async embed() { return new Promise(() => {}); } });
  const hits = await new WikiRetriever(store, 2000, { vectors }).query(scope, { text: "logging", limit: 3 }, signal());
  expect(hits[0].content).toBe("write ahead logging");
}, 5000);

test("source ACL revoked while the encoder is pending cannot escape through a shared query", async () => {
  const { DocumentIngestor } = await import("../server/graph/ingest-queue");
  const { SessionIngestor } = await import("../server/graph/session-ingestor");
  const { WikiCompiler } = await import("../server/graph/compiler");
  const { WikiGraphProvider } = await import("../server/graph/provider");
  const { MemoryEvolution } = await import("../server/graph/evolution");
  const { store } = setup(); const queue = new DocumentIngestor(store), sessions = new SessionIngestor(queue);
  const finding = "Research finding: database recovery requires a durable write ahead log.";
  const job = sessions.ingest({ namespace: ns, threadId: "t", runId: "r", messageId: "u", user: "Research database recovery", assistants: [{ id: "a", text: finding }] })!;
  sessions.share(ns, queue.status(ns, job).source);
  const model = { async json(stage: string) {
    if (stage === "analysis") return { claims: [{ text: finding, quote: finding, certainty: "fact", conflict: false }] };
    if (stage === "generation") return { pages: [{ id: "recovery", title: "Recovery", type: "finding", tags: [], related: [], claims: [0] }] };
    return { claims: [0], conflict: false };
  } };
  await new WikiCompiler(queue, model).runNext({ ...ns, visibility: "project_shared" });
  let started!: () => void, release!: () => void, allowed = true;
  const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const vectors = new VectorIndex(store, { ...encoder, async embed(texts) { started(); await gate; return texts.map(() => [1, 0]); } });
  const provider = new WikiGraphProvider(store, 2000, { vectors });
  const evolution = new MemoryEvolution({ provider, compiler: model }, () => true, (_ns, bot) => bot !== "a" || allowed);
  try {
    const result = provider.query({ ...scope, botId: "b" }, { text: "database", limit: 5 }, signal());
    await entered; allowed = false; release();
    expect(await result).toEqual({ status: "ok", hits: [] });
    expect(store.diagnostics().pages).toBe(0);
  } finally { release(); await evolution.close(); }
});
