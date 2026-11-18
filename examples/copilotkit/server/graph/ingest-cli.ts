import { PostgresWikiStore } from "./postgres-wiki-store";
import { PostgresDocumentIngestor } from "./postgres-ingest-queue";
import { GcsGraphObjects } from "./objects";
import { GraphBrowser } from "./browser";
import { parseQuery } from "./browser-query";
import { SessionIngestor } from "./session-ingestor";
import { wikiHealth, scopedReindex } from "./health";
import { EmbeddingConfig, OpenAIEncoder, VectorIndex } from "./embedding";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { NamespaceSchema } from "./types";
import { WikiStore, safePath, namespaceKey } from "./wiki-store";
import { DocumentIngestor } from "./ingest-queue";
import { OpenAICompilerLLM, WikiCompiler, WORKER_SHUTDOWN } from "./compiler";

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
async function work(queue: DocumentIngestor | PostgresDocumentIngestor, config: z.infer<typeof Config>, jobId?: string) {
  if (!config.compiler) throw new Error("Compiler configuration required");
  const worker = new WikiCompiler(queue, new OpenAICompilerLLM(config.compiler));
  const controller = new AbortController(), cancel = () => controller.abort(WORKER_SHUTDOWN);
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try { return { processedJobId: await (jobId ? worker.processJob(config.namespace, jobId, controller.signal) : worker.runNext(config.namespace, controller.signal)) ?? null }; }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
async function rebuildVectors(store: WikiStore | PostgresWikiStore, config: z.infer<typeof Config>) {
  if (!config.embedding) throw new Error("Embedding config required");
  const vectors = new VectorIndex(store, new OpenAIEncoder(config.embedding), config.embedding.retries);
  await vectors.rebuild(config.namespace);
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
  const backend = process.env.AGUI_STORAGE_BACKEND ?? "local";
  if (!["local", "gcp"].includes(backend)) throw new Error("Invalid storage backend");
  const store = backend === "gcp" ? new PostgresWikiStore(process.env.AGUI_RUNTIME_DATABASE_URL ?? "",
    new GcsGraphObjects(process.env.AGUI_GCS_BUCKET ?? "")) : new WikiStore(root);
  if (store instanceof PostgresWikiStore && store.objects instanceof GcsGraphObjects) await store.objects.ready();
  const queue = store instanceof PostgresWikiStore ? new PostgresDocumentIngestor(store) : new DocumentIngestor(store), ns = config.namespace;
  if (queue instanceof PostgresDocumentIngestor) { await queue.store.ready(); await queue.ready(); }
  const id = () => { if (!value) throw new Error("Scoped job/source ID required"); return value; };
  const actions: Record<string, () => unknown> = {
    enqueue: async () => ({ jobId: await queue.enqueue(ns, jsonFile(id(), 6291456)), status: "accepted" }),
    jobs: async () => Promise.all((await store.browserJobs(namespaceKey(ns))).map(async row => {
      const job = await queue.status(ns, row.id);
      return { id: job.id, sourceId: job.source, version: job.version, state: job.state, attempt: job.attempt, error: job.error };
    })),
    work: () => work(queue, config), process: () => work(queue, config, id()),
    health: async () => {
      if (queue instanceof DocumentIngestor) return wikiHealth(queue, ns);
      const browser = new GraphBrowser(queue.store, ns, parseQuery(new URL("http://localhost/?scope=" + ns.visibility), "health"), () => true);
      const result = await browser.health(); await browser.revalidate(); return result;
    },
    reindex: async () => { await store.reindex(ns); return { status: "ok" }; },
    vectors: () => rebuildVectors(store, config),
    share: async () => ({ status: "accepted", jobId: await new SessionIngestor(queue).share(ns, id()) }),
    rebuild: async () => { await queue.rebuild(ns); return { status: "queued" }; },
    status: async () => {
      const job = await queue.status(ns, id());
      return { id: job.id, sourceId: job.source, version: job.version, state: job.state, attempt: job.attempt, error: job.error };
    },
    cancel: async () => { await queue.cancel(ns, id()); return { status: "ok" }; },
    retry: async () => { await queue.retry(ns, id()); return { status: "ok" }; },
    delete: async () => { await queue.revoke(ns, id()); return { status: "ok" }; },
    revoke: async () => { await queue.revokeCopies(ns, id()); return { status: "ok" }; },
  };
  try {
    if (!Object.hasOwn(actions, command)) throw new Error("Unknown graph management command");
    return await actions[command]();
  } finally { await store.close(); }
}
// No raw source, endpoint response, or secret is included in error output.
main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(() => {
  console.error("Graph ingest command failed; check server config, scoped IDs and input schema."); process.exitCode = 1;
});
