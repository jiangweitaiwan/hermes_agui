import type { IngestStore } from "../../graph/ingest-store";
import type { Job, RawSource } from "../../graph/ingest-queue";
import type { Namespace } from "../../graph/types";
import { namespaceKey } from "../../graph/wiki-store";
import { issue, result, requireAccepted, domainStage } from "./pipeline";
/** Preflight only. Store transactions remain authoritative for ACL/CAS/lease/revocation. */
export async function validatePersistence(queue:IngestStore,ns:Namespace,job:Job,source:RawSource){
  const stage="v2-parser";
  if(job.ns!==namespaceKey(ns)||source.ns!==job.ns||source.id!==job.source||source.version!==job.version){
    requireAccepted(result(stage,[issue(stage,"persistence","PERSISTENCE_CONFLICT")]));
  }
  const current=await domainStage(stage,"PERSISTENCE_CONFLICT",()=>Promise.resolve(queue.source(job)),"persistence");
  requireAccepted(result(stage,current.deleted||current.hash!==source.hash||current.version!==source.version?
    [issue(stage,"persistence","SOURCE_CHANGED")]:[]));
}
