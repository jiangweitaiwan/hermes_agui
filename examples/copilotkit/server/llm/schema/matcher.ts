import { z } from "zod";
export const MatcherDecisionSchema = z.object({decisions:z.array(z.object({ref:z.string().max(100),action:z.enum(["matched","create","unresolved"]),subjectId:z.string().max(200).optional()}).strict()).max(96)}).strict();
