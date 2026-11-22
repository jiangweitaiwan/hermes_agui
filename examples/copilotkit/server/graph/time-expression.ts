import { z } from "zod";
export const parserText = z.string().trim().min(1).max(1000);
export const parserRef = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
/** Text is evidence/intent, never an authoritative LLM-generated UTC timestamp. */
export const TimeExpressionSchema = z.object({
  kind: z.enum(["unspecified", "exact", "range", "as_of", "before_event", "after_event", "previous_event", "current", "history", "unknown"]),
  originalText: z.string().max(200).optional(), anchorRef: parserRef.optional(),
}).strict();
