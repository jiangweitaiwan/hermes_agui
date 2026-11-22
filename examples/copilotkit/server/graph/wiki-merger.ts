import type { Page } from "./types";
import type { Subject, Attribute } from "./v2-types";
/** V2 owns only registry-managed pages. Legacy pages require an explicit rebuild. */
export function validateMerge(current: Page | undefined, subjects: Subject[], attributes: Attribute[]) {
  if (!current) return;
  if (!subjects.every(s => current.body.includes(`<!-- ${s.sectionKey} -->`) || attributes.some(a => a.subjectId === s.subjectId))) throw new Error("Missing stable section");
  const markers = [...current.body.matchAll(/<!-- (section_[a-f0-9]+) -->/g)].map(m => m[1]);
  if (!markers.length || markers.some(key => !subjects.some(s => s.sectionKey === key))) throw new Error("Cannot overwrite unmanaged subject sections");
}
