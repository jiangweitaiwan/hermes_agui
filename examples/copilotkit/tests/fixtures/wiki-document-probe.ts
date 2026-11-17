/** Actual document compiler → wiki provider → Runtime → native Hermes acceptance, with mock LLM. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../../server/application";
import { WikiStore } from "../../server/graph/wiki-store";
import { DocumentIngestor } from "../../server/graph/ingest-queue";
import { WikiCompiler } from "../../server/graph/compiler";
import { WikiGraphProvider } from "../../server/graph/provider";
const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-native-"));
const store = new WikiStore(root);
const queue = new DocumentIngestor(store);
const ns = { principal: "local-owner", projectId: "alpha", botId: "hermes", visibility: "bot_private" as const };
queue.enqueue(ns, { title: "Database policy", mime: "text/plain", content: "Project Alpha 使用 PostgreSQL", idempotencyKey: "acceptance" });
await new WikiCompiler(queue, { async json(stage) {
  if (stage === "analysis") return { claims: [{ text: "Project Alpha 使用 PostgreSQL", quote: "Project Alpha 使用 PostgreSQL", certainty: "fact", conflict: false }] };
  if (stage === "generation") return { pages: [{ id: "database", title: "Database", type: "concept", tags: [], related: [], claims: [0] }] };
  return { claims: [0], conflict: false };
} }).runNext(ns);
const application = createApplication({ hermes: {
  agentUrl: process.argv[2], token: "runtime-test-token",
  memory: { key: "runtime-only-key", principal: "local-owner", projectId: "alpha" },
} }, { graph: { provider: new WikiGraphProvider(store), authorize: () => true } });
try {
  const response = await application.runtime(new Request("http://localhost/api/copilotkit/agent/hermes/run", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      threadId: "acceptance", runId: "acceptance-run", messages: [{ id: "question", role: "user",
        content: "Project Alpha 使用什麼資料庫？" }], tools: [], context: [], state: {}, forwardedProps: {},
    }),
  }));
  const output = await response.text();
  const events = output.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  const answer = events.filter(event => event.type === "TEXT_MESSAGE_CONTENT").map(event => event.delta).join("");
  if (response.status !== 200 || !events.some(event => event.type === "RUN_FINISHED") || !answer.includes("PostgreSQL")) throw new Error("Document bridge acceptance failed");
} finally { application.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
