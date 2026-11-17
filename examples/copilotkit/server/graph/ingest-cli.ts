import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { NamespaceSchema } from "./types";
import { WikiStore, safePath } from "./wiki-store";
import { DocumentIngestor } from "./ingest-queue";
import { OpenAICompilerLLM, WikiCompiler } from "./compiler";

const Config = z.object({ namespace: NamespaceSchema, compiler: z.object({
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
export async function main(args: string[]) {
  const [root, configPath, command, value] = args;
  if (!root || !configPath || !["enqueue", "work", "status", "cancel", "retry", "delete", "rebuild"].includes(command)) {
    throw new Error("Usage: ingest-cli.ts DATA_ROOT SERVER_CONFIG enqueue|work|status|cancel|retry|delete|rebuild [UPLOAD_JSON|ID]");
  }
  const config = Config.parse(jsonFile(configPath, 16384));
  const store = new WikiStore(root);
  const queue = new DocumentIngestor(store);
  try {
    const ns = config.namespace;
    if (command === "enqueue") {
      if (!value) throw new Error("Upload JSON required");
      return { jobId: queue.enqueue(ns, jsonFile(value, 6291456)), status: "accepted" };
    }
    if (command === "work") {
      if (!config.compiler) throw new Error("Compiler configuration required");
      const worker = new WikiCompiler(queue, new OpenAICompilerLLM(config.compiler));
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
      try { return { processedJobId: await worker.runNext(ns, controller.signal) ?? null }; }
      finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
    }
    if (command === "rebuild") { queue.rebuild(ns); return { status: "queued" }; }
    if (!value) throw new Error("Scoped job/source ID required");
    if (command === "status") {
      const job = queue.status(ns, value);
      return { id: job.id, sourceId: job.source, version: job.version, state: job.state, attempt: job.attempt, error: job.error };
    }
    if (command === "cancel") queue.cancel(ns, value);
    else if (command === "retry") queue.retry(ns, value);
    else queue.revoke(ns, value);
    return { status: "ok" };
  } finally { store.close(); }
}
// No raw source, endpoint response, or secret is included in error output.
main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(() => {
  console.error("Graph ingest command failed; check server config, scoped IDs and input schema."); process.exitCode = 1;
});
