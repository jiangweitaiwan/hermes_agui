import { z } from "zod";
import { ModelRegistry } from "./config";
import { embeddingClient } from "./client";
import { ControlError, hash, candidate } from "./control-contract";
import type { ControlStore } from "./control-store";
export const MigrationPlan=z.object({expectedRevision:z.number().int().positive(),
  target:z.object({provider:z.string().min(1).max(100),model:z.string().min(1).max(100),dimension:z.number().int().min(1).max(3072),version:z.string().min(1).max(100)}).strict(),
  retrievalMode:z.enum(["v2","v3"]),reason:z.string().trim().min(1).max(500)}).strict();
/** Planning only: there is no authority here to assert coverage or change the selector. */
export async function planMigration(store:ControlStore,raw:unknown,actor:string){
  const input=MigrationPlan.parse(raw),draft=await store.draft();
  if(input.expectedRevision!==draft.revision)throw new ControlError(409,"Draft changed; reload");
  const config=structuredClone(draft.config),baseline=new ModelRegistry(config);
  const approved=store.policy.approved;
  const approvedCandidate=store.policy.embeddingCandidates?.some(m=>hash(m)===hash(input.target))??false;
  if(!approvedCandidate && !approved.models.some(m=>m.alias==="graph_embedding"&&m.provider===input.target.provider&&m.model===input.target.model&&m.dimension===input.target.dimension&&m.version===input.target.version))throw new ControlError(422,"Encoder requires deployment approval");
  config.models=config.models.map(m=>m.alias==="graph_embedding"?{...m,...input.target}:m);
  const target=new ModelRegistry(config);
  const encoder=embeddingClient({registry:target.config,role:"graph_embedding"});
  const original=embeddingClient({registry:baseline.config,role:"graph_embedding"});
  const candidateHash=hash(candidate(draft.config,store.policy,draft.prompts??undefined));
  const id=hash({candidateHash,scope:store.policy.scope,revision:draft.revision,target:encoder.fingerprint,mode:input.retrievalMode});
  const plan={id,candidateHash,state:"planned",candidateDraftRevision:draft.revision,targetEncoderFingerprint:encoder.fingerprint,
    originalEncoderFingerprint:original.fingerprint,changed:encoder.fingerprint!==original.fingerprint,
    retrievalMode:input.retrievalMode,scope:store.policy.scope,coverage:null,errors:null,lastCheckpoint:null,verifiedAt:null,
    namespaces:"ALL private/shared namespaces; wiki, V2 edge and V3 narrative spaces",
    gate:"BLOCKED: no authoritative all-writer drain, global coverage/revocation/watermark proof installed; selector remains unchanged",
    command:'node --import tsx server/graph/ingest-cli.ts "$DATA_ROOT" "$CANDIDATE_GRAPH_CONFIG" vectors',
    rollback:"Retain old key; verify its current source/revocation coverage before activation or rollback",reason:input.reason};
  await store.pool.query(`INSERT INTO hermes_agui_runtime.llm_embedding_plans(scope,plan_id,plan,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[store.policy.scope,id,plan,actor]);
  await store.audit(store.pool,"embedding_plan",actor,input.reason);
  return plan;
}
export async function migrationStatus(store:ControlStore){
  const result=await store.pool.query(`SELECT plan,created_by,created_at FROM hermes_agui_runtime.llm_embedding_plans WHERE scope=$1 ORDER BY created_at DESC,plan_id DESC LIMIT 25`,[store.policy.scope]);
  return {plans:result.rows,activationEnabled:false,gate:"BLOCKED until authoritative global coverage and write fencing are available",execution:"Existing idempotent vectors CLI; no HTTP background job"};
}
