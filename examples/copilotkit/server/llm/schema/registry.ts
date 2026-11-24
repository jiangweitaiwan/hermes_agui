import { z } from "zod";
import { ParsedSchema } from "./parser";
import { MatcherDecisionSchema } from "./matcher";
import { RelationOutputSchema } from "./relations";
import { QueryPlanSchema } from "./query";
import { StorySchema } from "./story";
import { Analysis, Generation, Merge } from "./legacy";
export const schemas: Record<string,z.ZodTypeAny> = {
  analysis: Analysis, generation: Generation, merge: Merge,
  "v2-parser": ParsedSchema, "v2-subject-disambiguation": MatcherDecisionSchema,
  "v2-relations": RelationOutputSchema, "v3-query": QueryPlanSchema, "v3-story": StorySchema,
};
/** Explicit subset; unsupported types fail at startup. Refinements remain server-side. */
export function outputSchema(schema:z.ZodTypeAny): Record<string,unknown> {
  const d=schema._def;
  if(schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion)return {anyOf:d.options.map((s:z.ZodTypeAny)=>outputSchema(s))};
  if(schema instanceof z.ZodEffects)return outputSchema(d.schema);
  if(schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)return outputSchema(d.innerType);
  if(schema instanceof z.ZodObject){
    const properties:Record<string,unknown>={},required:string[]=[];
    for(const [key,value] of Object.entries(schema.shape) as [string,z.ZodTypeAny][]){
      properties[key]=outputSchema(value);if(!value.isOptional())required.push(key);
    }
    return {type:"object",properties,required,additionalProperties:false};
  }
  if(schema instanceof z.ZodArray)return {type:"array",items:outputSchema(d.type),...(d.minLength?{minItems:d.minLength.value}:{}),...(d.maxLength?{maxItems:d.maxLength.value}:{})};
  if(schema instanceof z.ZodEnum)return {type:"string",enum:d.values};
  if(schema instanceof z.ZodLiteral)return {type:typeof d.value,enum:[d.value]};
  if(schema instanceof z.ZodBoolean)return {type:"boolean"};
  return scalarSchema(schema);
}
function scalarSchema(schema:z.ZodTypeAny):Record<string,unknown>{
  const d=schema._def;
  if(schema instanceof z.ZodString){
    const out:Record<string,unknown>={type:"string"};
    for(const c of d.checks){if(c.kind==="min")out.minLength=c.value;if(c.kind==="max")out.maxLength=c.value;}
    return out;
  }
  if(schema instanceof z.ZodNumber){
    const out:Record<string,unknown>={type:"number"};
    for(const c of d.checks){if(c.kind==="int")out.type="integer";if(c.kind==="min")out.minimum=c.value;if(c.kind==="max")out.maximum=c.value;}
    return out;
  }
  throw new Error("Unsupported output schema type");
}
