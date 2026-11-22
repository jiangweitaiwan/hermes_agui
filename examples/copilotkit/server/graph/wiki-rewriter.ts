import { stringify } from "yaml";
import type { Attribute, Subject } from "./v2-types";
import type { Page, Namespace } from "./types";
import type { RawSource } from "./ingest-queue";
import type { Publication } from "./ingest-store";
import { parsePage } from "./markdown";
export function sourceProvenance(source: RawSource, ns: Namespace): Page["sources"][number] {
  return source.provenance ?? { kind: "document", botId:source.botId ?? ns.botId,sourceId:source.id,version:source.version,hash:source.hash,title:source.title };
}
/** Full attribute evidence is persisted independently; frontmatter is a bounded citation window. */
export function rewriteWiki(subjects: Subject[], attributes: Attribute[], sources: Page["sources"], current?: { page: Page; revision: string }): Publication | undefined {
  const byId = new Map(attributes.map(a => [a.attributeId,a]));
  if (!byId.size) return;
  const sorted = subjects.slice().sort((a,b) => a.sectionKey.localeCompare(b.sectionKey));
  const root = sorted.find(s => !s.parentSubjectId) ?? sorted[0];
  const sections = sorted.map(s => {
    const rows = [...byId.values()].filter(a => a.subjectId === s.subjectId).sort((a,b) => a.attributeId.localeCompare(b.attributeId));
    return `## ${s.canonicalName}\n<!-- ${s.sectionKey} -->\n\n${rows.map(a => `- ${a.text}`).join("\n") || "Profile evidence pending."}`;
  });
  const body = `# ${root.canonicalName}\n\n${sections.join("\n\n")}`;
  if (current?.page.body === body) return;
  const now = new Date().toISOString();
  const unique = [...new Map(sources.map(s => [JSON.stringify(s),s])).values()];
  if (!unique.length) throw new Error("Missing profile provenance");
  const metadata = { id:root.wikiPageId,title:current?.page.title ?? root.canonicalName,type:"entity",sources:unique.slice(0,20),tags:[],related:[],
    created:current?.page.created ?? now,updated:now,verification:"unverified" };
  const markdown = `---\n${stringify(metadata)}---\n${body}\n`;
  parsePage(markdown);
  return {markdown,expectedRevision:current?.revision ?? null};
}
