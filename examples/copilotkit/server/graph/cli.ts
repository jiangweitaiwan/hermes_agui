import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ManifestSchema } from "./types";
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
  if (command !== "import" || !target || localManifest) throw new Error("Usage: tsx server/graph/cli.ts import MANIFEST");
  const { GcsGraphObjects } = await import("./objects");
  const { PostgresWikiStore } = await import("./postgres-wiki-store");
  const { namespace, pages } = readManifest(target);
  const store = new PostgresWikiStore(process.env.AGUI_RUNTIME_DATABASE_URL ?? "", new GcsGraphObjects(process.env.AGUI_GCS_BUCKET ?? ""));
  try {
    await store.ready();
    console.log(JSON.stringify({ revisions: await store.import(namespace, pages) }));
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
