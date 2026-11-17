import { parseDocument } from "yaml";
import { PageSchema, type Page } from "./types";

/** No YAML aliases, custom tags, or Markdown-owned authorization fields. */
export function parsePage(markdown: string): Page {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error("Missing frontmatter");
  const doc = parseDocument(match[1], { uniqueKeys: true, schema: "core" });
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML");
  const metadata = PageSchema.parse(doc.toJS({ maxAliasCount: 0 }));
  const body = match[2].trim();
  if (!body) throw new Error("Empty wiki page");
  const links = new Set(metadata.related);
  for (const link of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = link[1].split("#")[0].trim();
    // Namespace-qualified and path-like targets never become edges.
    if (/^[\p{L}\p{N}_-]+$/u.test(target)) links.add(target);
  }
  const sections = body.split(/\r?\n\s*\r?\n/).map(s => s.trim()).filter(Boolean);
  if (sections.length > 128) throw new Error("Too many sections");
  if (sections.some(s => Buffer.byteLength(s) > 16384)) throw new Error("Section exceeds hit budget");
  return { ...metadata, body, links: [...links].sort(), sections };
}

/** FTS5's unicode tokenizer does not segment Traditional Chinese: index overlapping bigrams. */
export function terms(text: string): string[] {
  const result = new Set<string>();
  for (const match of text.normalize("NFKC").toLowerCase().matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu)) {
    const word = match[0];
    if (/^\p{Script=Han}+$/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) result.add(word);
      for (let i = 0; i < chars.length - 1; i++) result.add(chars[i] + chars[i + 1]);
    } else result.add(word);
  }
  return [...result].slice(0, 128);
}
