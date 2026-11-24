import { z } from "zod";
import { parserText, parserRef, TimeExpressionSchema } from "../../graph/time-expression";
import { SubjectSchema } from "../../graph/v2-types";
export const QueryPlanSchema = z.object({
  subjects: z.array(z.object({ref: parserRef, name: parserText, type: SubjectSchema.shape.type.optional(),
    aliases: z.array(z.string().min(1).max(100)).max(4).optional()}).strict()).max(12),
  narratives: z.array(z.object({ref: parserRef, text: parserText, subjectRefs: z.array(parserRef).max(12),
    intent: z.enum(["find_event", "find_state", "explain_cause", "describe_history", "general"]), time: TimeExpressionSchema,
  }).strict()).max(8), temporal: TimeExpressionSchema,
}).strict();
