import { readFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PostgresWikiStore } from "../../server/graph/postgres-wiki-store";
import { FilesystemGraphObjects } from "../../server/graph/objects";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { stringify } from "yaml";
import { WikiStore } from "../../server/graph/wiki-store";
import { WikiRetriever } from "../../server/graph/retriever";
import { VectorIndex, type Encoder } from "../../server/graph/embedding";
import { DocumentIngestor } from "../../server/graph/ingest-queue";
import { SessionIngestor } from "../../server/graph/session-ingestor";
import { WikiCompiler } from "../../server/graph/compiler";
import { wikiHealth } from "../../server/graph/health";

// This deterministic synonym encoder tests the retrieval harness, not a real model's quality.
const concepts = [/PostgreSQL|write ahead|persist commits|資料庫崩潰/i, /Redis|cached items|快取淘汰/i,
  /Python|coroutine/i, /異地備份|disaster recovery/i, /權限撤銷|withdraw access/i];
const encoder: Encoder = { model: "evaluation-synonym-fixture", dimension: 6, version: "1", async embed(texts) {
  return texts.map(text => { const i = concepts.findIndex(pattern => pattern.test(text)); return Array.from({ length: 6 }, (_, j) => j === (i < 0 ? 5 : i) ? 1 : 0); });
} };
const corpus = JSON.parse(readFileSync(new URL("./wiki-evaluation.json", import.meta.url), "utf8"));
const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-evaluation-"));
const databaseUrl = process.argv.includes("--postgres") ? process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL : undefined;
if (process.argv.includes("--postgres") && !databaseUrl) throw new Error("Set HERMES_AGUI_TEST_RUNTIME_DATABASE_URL");
const store = databaseUrl ? new PostgresWikiStore(databaseUrl, new FilesystemGraphObjects(root)) : new WikiStore(root);
const ns = { principal: databaseUrl ? randomUUID() : "evaluation", projectId: "fixture", visibility: "bot_private" as const, botId: "a" };
const scope = { ...ns, threadId: "evaluation", runId: "evaluation" }, signal = new AbortController().signal;
const byContent = new Map<string, string>(corpus.pages.map((p: any) => [p.body, p.id]));
async function evaluate(retriever: WikiRetriever) {
  let recall = 0, mrr = 0, noise = 0, returned = 0; const latencies: number[] = [];
  for (const query of corpus.queries) {
    const start = performance.now();
    const hits = await retriever.query(scope, { text: query.text, limit: 3 }, signal);
    latencies.push(performance.now() - start);
    const ids = hits.map(h => byContent.get(h.content));
    const found = ids.filter(id => query.relevant.includes(id)).length;
    recall += found / query.relevant.length;
    const rank = ids.findIndex(id => query.relevant.includes(id)); mrr += rank < 0 ? 0 : 1 / (rank + 1);
    noise += ids.length - found; returned += ids.length;
  }
  latencies.sort((a, b) => a - b);
  return { recallAt3: recall / corpus.queries.length, mrr: mrr / corpus.queries.length,
    noiseFraction: returned ? noise / returned : 0, p50Ms: latencies[Math.floor(latencies.length * .5)],
    p95Ms: latencies[Math.ceil(latencies.length * .95) - 1] };
}
try {
  if (store instanceof PostgresWikiStore) await store.ready();
  await store.import(ns, corpus.pages.map((p: any) => ({ expectedRevision: null, markdown: `---\n${stringify({ id: p.id, title: p.id,
    type: "concept", sources: [{ botId: "a", threadId: "fixture", runId: "fixture" }], tags: [], related: p.related,
    created: "2026-11-17T00:00:00.000Z", updated: "2026-11-17T00:00:00.000Z" })}---\n${p.body}` })));
  const vectors = new VectorIndex(store, encoder); await vectors.update(ns, signal);
  const keyword = await evaluate(new WikiRetriever(store, 2000, { neighbors: 0 }));
  const hybrid = await evaluate(new WikiRetriever(store, 2000, { vectors, neighbors: 0 }));
  const hybridGraph = await evaluate(new WikiRetriever(store, 2000, { vectors }));
  if (store instanceof PostgresWikiStore) {
    console.log(JSON.stringify({ backend: "postgres", encoder: encoder.model, keyword, hybrid, hybridGraph }, null, 2));
    if (keyword.recallAt3 < 0.5 || hybrid.recallAt3 < 11 / 12 || hybridGraph.recallAt3 < 1) process.exitCode = 1;
  } else {
    const queue = new DocumentIngestor(store), sessions = new SessionIngestor(queue);
    const answer = "Research finding: database durability depends on write ahead logging and tested recovery procedures.";
    const job = sessions.ingest({ namespace: ns, threadId: "measure", runId: "measure", messageId: "user", user: "Research database recovery", assistants: [{ id: "answer", text: answer }] })!;
    const lag = wikiHealth(queue, ns).lagMs;
    let calls = 0, inputBytes = 0, outputBytes = 0;
    const start = performance.now();
    await new WikiCompiler(queue, { async json(stage, data) {
      calls++; inputBytes += Buffer.byteLength(JSON.stringify(data));
      const value = stage === "analysis" ? { claims: [{ text: answer, quote: answer, certainty: "fact", conflict: false }] }
        : stage === "generation" ? { pages: [{ id: "compiled", title: "Compiled", type: "finding", tags: [], related: [], claims: [0] }] }
        : { claims: [0], conflict: false };
      outputBytes += Buffer.byteLength(JSON.stringify(value)); return value;
    } }).runNext(ns);
    const result = { environment: { node: process.version, corpusPages: corpus.pages.length, queries: corpus.queries.length,
      encoder: encoder.model, note: "in-process deterministic mock; no network, real-model quality or paid API cost claim" }, keyword, hybrid, hybridGraph,
      queue: { lagMs: lag, state: queue.status(ns, job).state }, compiler: { elapsedMs: performance.now() - start, calls, inputBytes, outputBytes, billedCost: null } };
    console.log(JSON.stringify(result, null, 2));
    if (hybrid.recallAt3 <= keyword.recallAt3 || hybridGraph.recallAt3 < hybrid.recallAt3 || hybridGraph.p95Ms >= 2000 || result.queue.state !== "completed") process.exitCode = 1;
  }
} finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
