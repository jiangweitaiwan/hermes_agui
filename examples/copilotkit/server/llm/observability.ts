import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { taskRegistry, taskFingerprint } from "./config";
import { promptFor, systemPrompt } from "./prompts/registry";
import { validatorVersion, type ValidationResult } from "./validation/pipeline";
export interface ExecutionRecord {
  event:"llm_execution"; executionId:string; jobId?:string; attempt?:number;
  sourceVersion:number|null; taskFingerprint:string; phase:"provider_attempt"|"stage_output"|"publication"; stage:string; taskVersion:string; promptId:string; promptVersion:string; promptHash:string;
  schemaId:string; schemaVersion:number; validatorVersion:string;
  provider:string|null; model:string|null; configHash:string|null; embeddingFingerprint:string|null;
  startedAt:string; finishedAt:string; latencyMs:number;
  validation:ValidationResult; outcome:"succeeded"|"failed";
  promptTokens:number|null; completionTokens:number|null; estimatedCost:number|null;
}
const context=new AsyncLocalStorage<{jobId:string;attempt:number;sourceVersion?:number}>();
export function withExecutionContext<T>(jobId:string,attempt:number,run:()=>T,sourceVersion?:number):T{return context.run({jobId,attempt,sourceVersion},run);}
export type Observer=(record:ExecutionRecord)=>void;
/** The allowlisted envelope never accepts raw source, response, credentials or error.message. */
export const observe:Observer=record=>console.error(JSON.stringify({severity:"INFO",...record}));
export function execution(stage:string,started:number,validation:ValidationResult,fields:Partial<Pick<ExecutionRecord,
  "sourceVersion"|"phase"|"jobId"|"attempt"|"provider"|"model"|"configHash"|"embeddingFingerprint"|"outcome"|"promptTokens"|"completionTokens">>={}):ExecutionRecord {
  const task=taskRegistry[stage],prompt=promptFor(stage);
  return {event:"llm_execution",executionId:randomUUID(),sourceVersion:null,taskFingerprint:taskFingerprint(),phase:"stage_output",stage,taskVersion:"1",promptId:prompt.id,promptVersion:prompt.version,
    promptHash:createHash("sha256").update(systemPrompt(stage)).digest("hex"),schemaId:stage,schemaVersion:task.schemaVersion,validatorVersion,
    provider:null,model:null,configHash:null,embeddingFingerprint:null,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),
    latencyMs:Date.now()-started,validation,outcome:validation.verdict==="accepted"?"succeeded":"failed",promptTokens:null,completionTokens:null,estimatedCost:null,...context.getStore(),...fields};
}
