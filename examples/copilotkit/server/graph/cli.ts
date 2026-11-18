import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ManifestSchema, NamespaceSchema } from "./types";
import { diagnoseWiki } from "./diagnostics";
import { WikiStore, safePath } from "./wiki-store";

/** Trusted administrator only: never exposed as an HTTP route or model tool. */
const backend = process.env.AGUI_STORAGE_BACKEND ?? "local";
const [command, target, localManifest] = process.argv.slice(2);

function readManifest(filename: string | undefined) {
  if (!filename) throw new Error("Manifest with explicit namespace and expected revisions required");
  const path = safePath(filename);
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return { namespace: manifest.namespace, pages: manifest.pages.map(page => ({
    markdown: readFileSync(safePath(join(dirname(path), page.file)), "utf8"), expectedRevision: page.expectedRevision,
  })) };
}

if (backend === "gcp") {
  if (!["import", "reindex", "diagnose"].includes(command) || (command !== "diagnose" && !target) || localManifest) throw new Error("Usage: tsx server/graph/cli.ts import MANIFEST | reindex NAMESPACE_CONFIG | diagnose");
  const { GcsGraphObjects } = await import("./objects");
  const { PostgresWikiStore } = await import("./postgres-wiki-store");
  const store = new PostgresWikiStore(process.env.AGUI_RUNTIME_DATABASE_URL ?? "", new GcsGraphObjects(process.env.AGUI_GCS_BUCKET ?? ""));
  try {
    await (store.objects as InstanceType<typeof GcsGraphObjects>).ready();
    await store.ready();
    if (command === "import") {
      const { namespace, pages } = readManifest(target);
      console.log(JSON.stringify({ revisions: await store.import(namespace, pages) }));
    } else if (command === "reindex") {
      const config = JSON.parse(readFileSync(safePath(target), "utf8"));
      await store.reindex(NamespaceSchema.parse(config.namespace));
      console.log(JSON.stringify({ status: "ok" }));
    } else console.log(JSON.stringify(await store.diagnostics()));
  } finally { await store.close(); }
} else if (backend === "local") {
  if (!target || !["import", "reindex", "diagnose", "cleanup"].includes(command)) {
    throw new Error("Usage: tsx server/graph/cli.ts import|reindex|diagnose|cleanup DATA_ROOT [MANIFEST]");
  }
  if (command === "diagnose") {
    console.log(JSON.stringify(diagnoseWiki(target)));
  } else {
    const store = new WikiStore(target);
    try {
      if (command === "import") {
        const { namespace, pages } = readManifest(localManifest);
        console.log(JSON.stringify({ revisions: store.import(namespace, pages) }));
      } else if (command === "reindex") store.reindex();
      else if (command === "cleanup") store.cleanup();
    } finally { store.close(); }
  }
} else {
  throw new Error("Invalid AGUI_STORAGE_BACKEND");
}
