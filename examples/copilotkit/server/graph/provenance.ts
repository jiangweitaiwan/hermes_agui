import { z } from "zod";
const text = z.string().trim().min(1).max(512).refine(value => Buffer.byteLength(value) <= 512);
export const SessionSourceSchema = z.object({ botId: text, threadId: text, runId: text }).strict();
export const DocumentSourceSchema = z.object({
  kind: z.literal("document"), botId: text, sourceId: z.string().uuid(),
  version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/), title: text,
}).strict();
export const ProvenanceSchema = z.union([SessionSourceSchema, DocumentSourceSchema]);
export type Provenance = z.infer<typeof ProvenanceSchema>;
