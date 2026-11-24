import { z } from "zod";
import { SubjectSchema } from "../../graph/v2-types";
import { parserText as text, parserRef as ref, TimeExpressionSchema } from "../../graph/time-expression";
const quote = z.object({ quote: text, position: z.number().int().nonnegative() });
export const ParsedSchema = z.object({
  subjects: z.array(quote.extend({ ref, name: text, type: SubjectSchema.shape.type, identity: text,
    aliases: z.array(text).max(20), parentRef: ref.optional(), grouping: z.enum(["independent", "component-of"]),
  }).strict()).max(96),
  narratives: z.array(quote.extend({ ref, text, subjectRefs: z.array(ref).min(1).max(12), timeText: z.string().max(100),
    anchorRef: ref.optional(), timeExpression: TimeExpressionSchema.optional(), eventRef: ref,
  }).strict()).max(96),
  stableAttributes: z.array(quote.extend({ subjectRef: ref, kind: z.enum(["background", "role", "expertise", "interest", "design", "component_property"]), text }).strict()).max(96),
}).strict();
