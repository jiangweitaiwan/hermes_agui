import { ControlSettings, candidate, type ControlPolicy } from "./control-contract";
import { ControlStore } from "./control-store";
import { PostgresDocumentIngestor } from "../graph/postgres-ingest-queue";
import type { createApplication } from "../application";
import { controlApi } from "./control-api";

export function parseControl(registry:any){
  if(!registry?.llmControl)return undefined;
  const policy=ControlSettings.parse(registry.llmControl);
  candidate(registry.llm,policy);
  if(policy.mode==="managed" && (process.env.AGUI_STORAGE_BACKEND!=="gcp" || !registry.management || registry.storage?.botRegistry!=="postgres" || registry.storage?.threadMappings!=="postgres" || registry.graph?.evolution?.compiler))throw new Error("Managed mode requires durable registry Graph and trusted management");
  return policy;
}
export async function openControl(policy?:ControlPolicy, baseline?:unknown, initialize = true){
  const managed=policy?.mode==="managed";
  if(!policy || (!managed && !process.env.AGUI_LLM_DATABASE_URL))return {};
  const releases=new ControlStore(process.env.AGUI_LLM_DATABASE_URL ?? "",policy);
  let adminStore:ControlStore|undefined;
  try{
    await releases.ready(managed && initialize);
    if(initialize && process.env.AGUI_LLM_ADMIN_DATABASE_URL){adminStore=new ControlStore(process.env.AGUI_LLM_ADMIN_DATABASE_URL,policy);await adminStore.ready();}
    if(adminStore && adminStore.target!==releases.target)throw new Error("Control reader/admin database destinations must match");
    if(managed && initialize){
      if(!adminStore)throw new Error("Managed Runtime initialization requires the dedicated admin binding");
      await adminStore.ensureInitialRelease(baseline);
    }
    // Readers fail readiness immediately. Deploy Runtime first; orchestration may retry startup.
    if(managed)await releases.active();
    return {releases,adminStore};
  }catch(error){await releases.close();await adminStore?.close();throw error;}
}
export async function bindManagedQueue(application:ReturnType<typeof createApplication>,releases?:ControlStore){
  if(releases?.policy.mode!=="managed")return;
  const queue=application.evolution?.queue;
  if(!(queue instanceof PostgresDocumentIngestor))throw new Error("Managed mode requires durable job ledger");
  queue.useReleases(releases);
  const unpinned=await queue.store.pool.query("SELECT 1 FROM hermes_agui_runtime.graph_jobs WHERE llm_release_id IS NULL AND state IN ('pending','running') LIMIT 1");
  if(unpinned.rowCount)throw new Error("Drain unpinned jobs before managed activation");
}
export function adminControl(application:ReturnType<typeof createApplication>,adminStore?:ControlStore){
  return adminStore && application.management ? controlApi(adminStore,application.management.auth) : undefined;
}
