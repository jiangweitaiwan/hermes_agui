import { z } from "zod";
import { TimeExpressionSchema } from "./time-expression";
import { QueryPlanSchema } from "../llm/schema/query";
export type MemoryQueryPlan = z.infer<typeof QueryPlanSchema>;
export type QueryTime = z.infer<typeof TimeExpressionSchema> & {from?: string; to?: string; timezone?: string; confidence?: "certain" | "uncertain"};
export type QueryParseResult = {status: "ok" | "fallback"; plan: MemoryQueryPlan; warnings: string[]};
