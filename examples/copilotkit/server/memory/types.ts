import { z } from "zod";
import { ProvenanceSchema } from "../graph/provenance";
const identifier = z.string().trim().min(1).max(512);
const LegacyContextSchema = z.object({
  version: z.literal(1), records: z.array(z.object({
    id: identifier, content: z.string().min(1).max(16384),
    sourceBotId: identifier, sourceThreadId: identifier,
    visibility: z.enum(["bot_private", "project_shared"]),
  }).strict()).max(20),
}).strict();

export const MemoryContextSchema = z.union([LegacyContextSchema, z.object({
  version: z.literal(2), records: z.array(z.object({
    id: identifier, content: z.string().min(1).max(16384), sourceBotId: identifier,
    visibility: z.enum(["bot_private", "project_shared"]), sources: z.array(ProvenanceSchema).min(1).max(20),
  }).strict()).max(20),
}).strict()]);
export type MemoryContext = z.infer<typeof MemoryContextSchema>;
