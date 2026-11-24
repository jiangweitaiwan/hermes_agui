import { z } from "zod";
import { EdgeSchema } from "../../graph/v2-types";
export const RelationOutputSchema = z.object({ edges: z.array(z.object({ narrativeRef:z.string().max(100),fromRef:z.string().max(100),toRef:z.string().max(100),
  relation:EdgeSchema.innerType().shape.relation,relationType:EdgeSchema.innerType().shape.relationType,relationLabel:EdgeSchema.innerType().shape.relationLabel,description:z.string().min(1).max(1000),factKind:z.enum(["event","state"]),
  stateProperty:z.string().regex(/^[a-z_]{1,80}$/).optional(),certainty:z.enum(["reported","inferred","disputed"]),
}).strict()).max(96) }).strict();
