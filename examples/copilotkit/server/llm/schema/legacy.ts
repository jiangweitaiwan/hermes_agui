import { z } from "zod";
export const Claim = z.object({ text: z.string().min(1).max(1000), quote: z.string().min(1).max(1000),
  certainty: z.enum(["fact", "inference"]), conflict: z.boolean() }).strict();
export const Analysis = z.object({ claims: z.array(Claim).max(24) }).strict();
const slug = z.string().min(1).max(100).regex(/^[\p{L}\p{N}_-]+$/u);
export const Proposal = z.object({ id: slug.refine(value => !value.startsWith("source-"), "Reserved source ID"), title: z.string().min(1).max(200),
  type: z.enum(["entity", "concept", "decision", "finding", "procedure", "preference", "task"]),
  tags: z.array(z.string().min(1).max(100)).max(20), related: z.array(slug).max(20),
  claims: z.array(z.number().int().nonnegative()).min(1).max(24),
}).strict();
export const Generation = z.object({ pages: z.array(Proposal).max(8) }).strict();
export const Merge = z.object({ claims: z.array(z.number().int().nonnegative()).max(24), conflict: z.boolean() }).strict();
