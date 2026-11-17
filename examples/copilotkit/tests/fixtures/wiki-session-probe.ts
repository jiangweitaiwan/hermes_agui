/** Real Runtime → Hermes completion → durable session queue → compiler → new Hermes thread. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../../server/application";
import { WikiStore } from "../../server/graph/wiki-store";
import { WikiGraphProvider } from "../../server/graph/provider";
const finding = "Research finding: PostgreSQL write ahead logging provides durable database recovery after a crash.";
const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-native-session-"));
const store = new WikiStore(root), provider = new WikiGraphProvider(store);
const app = createApplication({ hermes: { agentUrl: process.argv[2], token: "runtime-test-token",
  memory: { key: "runtime-only-key", principal: "local-owner", projectId: "alpha" } } }, {
  graph: { provider, authorize: () => true }, evolution: { provider, pollMs: 60000, compiler: { async json(stage) {
    if (stage === "analysis") return { claims: [{ text: finding, quote: finding, certainty: "fact", conflict: false }] };
    if (stage === "generation") return { pages: [{ id: "recovery", title: "Recovery", type: "finding", tags: [], related: [], claims: [0] }] };
    return { claims: [0], conflict: false };
  } } },
});
async function run(thread: string, content: string) {
  const response = await app.runtime(new Request("http://localhost/api/copilotkit/agent/hermes/run", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: thread, runId: thread,
      messages: [{ id: thread, role: "user", content }], tools: [], context: [], state: {}, forwardedProps: {} }),
  }));
  const text = await response.text();
  if (!response.ok || text.includes("RUN_ERROR") || !text.includes("RUN_FINISHED")) throw new Error("Native session run failed");
}
try {
  await app.ready;
  await run("learning", "Research database recovery");
  if (store.db.prepare("SELECT count(*) AS n FROM ingest_jobs WHERE state='pending'").get()?.n !== 1) throw new Error("Native completion not enqueued");
  await app.evolution!.tick();
  if (!store.diagnostics().pages) throw new Error("Native source not compiled");
  const hits = await provider.query({ principal: "local-owner", projectId: "alpha", botId: "hermes", threadId: "next", runId: "next" },
    { text: "database durability", limit: 10 }, new AbortController().signal);
  if (hits.status !== "ok" || !hits.hits.length) throw new Error("Native memory not retrievable");
  await run("next", "database durability");
  console.log(JSON.stringify({ recordIds: hits.hits.map(hit => hit.recordId) }));
} finally { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
