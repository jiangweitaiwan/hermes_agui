import { SessionIngestor } from "./session-ingestor";
import { wikiHealth, scopedReindex } from "./health";
import { EmbeddingConfig, OpenAIEncoder, VectorIndex } from "./embedding";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { NamespaceSchema } from "./types";
import { WikiStore, safePath, namespaceKey } from "./wiki-store";
import { DocumentIngestor } from "./ingest-queue";
import { OpenAICompilerLLM, WikiCompiler } from "./compiler";

const Config = z.object({ namespace: NamespaceSchema, embedding: EmbeddingConfig.optional(), compiler: z.object({
  baseUrl: z.string().url(), model: z.string().min(1), keyEnv: z.string().min(1),
  timeoutMs: z.number().int().positive().max(120000).optional(), maxTokens: z.number().int().positive().max(8192).optional(),
}).strict().optional() }).strict();
function jsonFile(filename: string, limit: number) {
  const path = safePath(filename);
  if (!statSync(path).isFile() || statSync(path).size > limit) throw new Error("Invalid input file size");
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > limit) throw new Error("Input file size limit");
  return JSON.parse(text);
}
/** Local OS administrator boundary, same as the Part 1 CLI. Never an HTTP/model tool.
 * Deployment config owns scope; the untrusted upload JSON contains no ACL or filesystem path.
 */
async function work(queue: DocumentIngestor, config: z.infer<typeof Config>) {
  if (!config.compiler) throw new Error("Compiler configuration required");
  const worker = new WikiCompiler(queue, new OpenAICompilerLLM(config.compiler));
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try { return { processedJobId: await worker.runNext(config.namespace, controller.signal) ?? null }; }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
async function rebuildVectors(store: WikiStore, config: z.infer<typeof Config>) {
  if (!config.embedding) throw new Error("Embedding config required");
  const vectors = new VectorIndex(store, new OpenAIEncoder(config.embedding), config.embedding.retries);
  vectors.rebuild(config.namespace);
  for (let i = 0; i < 40000; i++) {
    const before = vectors.metrics.indexed;
    await vectors.update(config.namespace, AbortSignal.timeout(30000));
    if (vectors.metrics.indexed === before) break;
  }
  return { status: vectors.metrics.failures ? "partial" : "ok", ...vectors.metrics };
}
export async function main(args: string[]) {
  const [root, configPath, command, value] = args;
  if (!root || !configPath) throw new Error("DATA_ROOT and SERVER_CONFIG required");
  const config = Config.parse(jsonFile(configPath, 16384));
  const store = new WikiStore(root), queue = new DocumentIngestor(store), ns = config.namespace;
  const id = () => { if (!value) throw new Error("Scoped job/source ID required"); return value; };
  const actions: Record<string, () => unknown> = {
    enqueue: () => ({ jobId: queue.enqueue(ns, jsonFile(id(), 6291456)), status: "accepted" }),
    jobs: () => store.db.prepare("SELECT id,source AS sourceId,version,state,attempt,error FROM ingest_jobs WHERE ns=? ORDER BY rowid DESC LIMIT 50").all(namespaceKey(ns)),
    work: () => work(queue, config), health: () => wikiHealth(queue, ns),
    reindex: () => { scopedReindex(store, ns); return { status: "ok" }; },
    vectors: () => rebuildVectors(store, config),
    share: () => ({ status: "accepted", jobId: new SessionIngestor(queue).share(ns, id()) }),
    rebuild: () => { queue.rebuild(ns); return { status: "queued" }; },
    status: () => {
      const job = queue.status(ns, id());
      return { id: job.id, sourceId: job.source, version: job.version, state: job.state, attempt: job.attempt, error: job.error };
    },
    cancel: () => { queue.cancel(ns, id()); return { status: "ok" }; },
    retry: () => { queue.retry(ns, id()); return { status: "ok" }; },
    delete: () => { queue.revoke(ns, id()); return { status: "ok" }; },
    revoke: () => { queue.revokeCopies(ns, id()); return { status: "ok" }; },
  };
  try {
    if (!Object.hasOwn(actions, command)) throw new Error("Unknown graph management command");
    return await actions[command]();
  } finally { store.close(); }
}
// No raw source, endpoint response, or secret is included in error output.
main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(() => {
  console.error("Graph ingest command failed; check server config, scoped IDs and input schema."); process.exitCode = 1;
});
