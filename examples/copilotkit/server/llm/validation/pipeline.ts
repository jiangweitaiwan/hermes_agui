import { ProviderError } from "../providers/http";
import { schemas } from "../schema/registry";
export type Verdict = "accepted" | "needs_review" | "rejected";
export type Layer = "output" | "evidence" | "domain" | "persistence";
export type IssueCode = "REQUEST_ABORTED" | "PROVIDER_AUTH" | "PROVIDER_QUOTA" | "PROVIDER_UNAVAILABLE" | "OUTPUT_INVALID" | "SPAN_INVALID" | "SOURCE_CHANGED" | "REF_INVALID" | "IDENTITY_UNCERTAIN" | "SEMANTIC_UNCERTAIN" | "ATTRIBUTION_UNCERTAIN" | "TEMPORAL_INVALID" | "STATE_EVENT_CONFLICT" | "PERSISTENCE_CONFLICT";
export interface Issue { stage:string; layer:Layer; code:IssueCode; verdict:Exclude<Verdict,"accepted"> }
export interface ValidationResult { stage:string; validatorVersion:string; checkedLayers:Layer[]; verdict:Verdict; issues:Issue[] }
export const validatorVersion="1";
export function result(stage:string, issues:Issue[]=[],checkedLayers:Layer[]=["output"]):ValidationResult {
  return {stage,validatorVersion,checkedLayers,verdict:issues.some(i=>i.verdict==="rejected")?"rejected":issues.length?"needs_review":"accepted",issues};
}
export function issue(stage:string,layer:Layer,code:IssueCode,verdict:Exclude<Verdict,"accepted">="rejected"):Issue {
  return {stage,layer,code,verdict};
}
/** No source text, model output or provider error is included in an exception. */
export class ValidationError extends Error {
  constructor(readonly validation:ValidationResult){super(`${validation.verdict}:${validation.stage}:${validation.issues.map(i=>i.code==="SPAN_INVALID"?"SPAN_INVALID (Invalid source span)":i.code).join(",")}`);}
}
export function requireAccepted(validation:ValidationResult):void {
  if(validation.verdict!=="accepted")throw new ValidationError(validation);
}
export function validateOutput(stage:string,value:unknown):unknown {
  const schema=schemas[stage];
  if(!schema)throw new Error("Unknown validation task");
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw new ValidationError(result(stage,[issue(stage,"output","OUTPUT_INVALID")]));
  return parsed.data;
}
/** Existing deterministic checks are normalized without exposing arbitrary exception text. */
export async function domainStage<T>(stage:string,code:IssueCode,run:()=>Promise<T>,layer:Layer="domain"):Promise<T>{
  try{return await run();}
  catch(error){if(error instanceof ValidationError)throw error;throw new ValidationError(result(stage,[issue(stage,layer,code)]));}
}

export function failure(stage:string,error:unknown,aborted=false):ValidationResult {
  if(error instanceof ValidationError)return error.validation;
  let code:IssueCode="OUTPUT_INVALID";
  if(aborted)code="REQUEST_ABORTED";
  else if(error instanceof ProviderError){
    code=error.code==="auth"||error.status===401||error.status===403?"PROVIDER_AUTH":error.status===429?"PROVIDER_QUOTA":error.code==="http"?"PROVIDER_UNAVAILABLE":"OUTPUT_INVALID";
  }
  return result(stage,[issue(stage,"output",code)]);
}
