import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ManifestSchema } from "./types";
import { diagnoseWiki } from "./diagnostics";
import { WikiStore, safePath } from "./wiki-store";

/** Trusted local administrator only: never exposed as an HTTP route or model tool. */
const [command, root, manifestFile] = process.argv.slice(2);
if (!root || !["import", "reindex", "diagnose", "cleanup"].includes(command)) {
  throw new Error("Usage: tsx server/graph/cli.ts import|reindex|diagnose|cleanup DATA_ROOT [MANIFEST]");
}
if (command === "diagnose") {
  console.log(JSON.stringify(diagnoseWiki(root)));
} else {
  const store = new WikiStore(root);
  try {
    if (command === "import") {
      if (!manifestFile) throw new Error("Manifest with explicit namespace and expected revisions required");
      const path = safePath(manifestFile);
      const manifest = ManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      const revisions = store.import(manifest.namespace, manifest.pages.map(page => ({
        markdown: readFileSync(safePath(join(dirname(path), page.file)), "utf8"), expectedRevision: page.expectedRevision,
      })));
      console.log(JSON.stringify({ revisions }));
    } else if (command === "reindex") store.reindex();
    else if (command === "cleanup") store.cleanup();
  } finally { store.close(); }
}
