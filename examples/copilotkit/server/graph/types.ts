import { z } from "zod";
import { ProvenanceSchema } from "./provenance";
const id = z.string().min(1).max(200).regex(/^[\p{L}\p{N}_-]+$/u);
const text = z.string().trim().min(1).max(512);
export const NamespaceSchema = z.object({
  principal: text, projectId: text, visibility: z.enum(["bot_private", "project_shared"]), botId: text,
}).strict();
export type Namespace = z.infer<typeof NamespaceSchema>;
export const SourceSchema = ProvenanceSchema;
export const PageSchema = z.object({
  id, title: text, type: z.enum(["concept", "entity", "note", "index", "decision", "finding", "procedure", "preference", "task", "source"]),
  sources: z.array(SourceSchema).min(1).max(20),
  tags: z.array(text).max(50), related: z.array(id).max(50),
  created: z.string().datetime(), updated: z.string().datetime(),
  verification: z.enum(["unverified", "verified", "disputed"]).optional(),
}).strict();
export type Page = z.infer<typeof PageSchema> & { body: string; links: string[]; sections: string[] };
export const ManifestSchema = z.object({
  version: z.literal(1), namespace: NamespaceSchema,
  pages: z.array(z.object({ file: z.string().regex(/^[\p{L}\p{N}_-]+\.md$/u), expectedRevision: z.string().nullable() }).strict()).min(1).max(1000),
}).strict();
export interface WikiOptions {
  enabled?: boolean; dataRoot?: string; timeoutMs?: number;
  maxPages?: number; maxPageBytes?: number;
  embedding?: unknown; retrieval?: { rrfK?: number; seedLimit?: number; neighbors?: number };
}
