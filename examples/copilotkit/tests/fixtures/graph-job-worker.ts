import { PostgresWikiStore } from "../../server/graph/postgres-wiki-store";
import { PostgresDocumentIngestor } from "../../server/graph/postgres-ingest-queue";
import { FilesystemGraphObjects } from "../../server/graph/objects";
import { WikiCompiler } from "../../server/graph/compiler";
import { NamespaceSchema } from "../../server/graph/types";
import { stringify } from "yaml";

const [mode, encodedNs, id] = process.argv.slice(2);
const ns = NamespaceSchema.parse(JSON.parse(encodedNs));
const store = new PostgresWikiStore(process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL!, new FilesystemGraphObjects(process.env.GRAPH_TEST_OBJECT_ROOT!));
const queue = new PostgresDocumentIngestor(store);
try {
  await store.ready(); await queue.ready();
  if (mode === "hold") {
    const job = await queue.claim(ns, undefined, undefined, id);
    if (!job) throw new Error("No claim");
    const resume = new Promise<void>(resolve => process.once("message", () => resolve()));
    process.send!({ state: "claimed", job });
    await resume;
    const source = await queue.source(job), current = await queue.current(ns, "database");
    const markdown = `---\n${stringify({ id: "database", title: "資料庫", type: "concept", tags: [], related: [],
      sources: [{ kind: "document", botId: ns.botId, sourceId: source.id, version: source.version, hash: source.hash, title: source.title }],
      created: new Date().toISOString(), updated: new Date().toISOString() })}---\nSTALE WORKER`;
    try {
      await queue.publish(ns, job, [{ markdown, expectedRevision: current?.revision ?? null }], () => {});
      process.send!({ state: "published" });
    } catch { process.send!({ state: "fenced" }); }
  } else {
    await new WikiCompiler(queue, { async json(stage, data: any) {
      if (stage === "analysis") return { claims: [{ text: data.text, quote: data.text, certainty: "fact", conflict: false }] };
      if (stage === "generation") return { pages: [{ id: "database", title: "資料庫", type: "concept", tags: [], related: [], claims: [0] }] };
      return { claims: [0], conflict: false };
    } }).processJob(ns, id);
    process.send!({ state: (await queue.status(ns, id)).state });
  }
} finally { await store.close(); process.disconnect?.(); }
