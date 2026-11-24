import { ControlStore } from "./control-store";
import { candidate,type ControlPolicy } from "./control-contract";
import { PostgresDocumentIngestor } from "../graph/postgres-ingest-queue";
import type { DocumentIngestor } from "../graph/ingest-queue";
export async function managedIngest(queue:DocumentIngestor|PostgresDocumentIngestor,policy:ControlPolicy|undefined,compiler:unknown,embedding?:unknown){
  if(policy?.mode!=="managed")return undefined;
  if(!(queue instanceof PostgresDocumentIngestor))throw new Error("Managed ingestion requires PostgreSQL");
  const route=compiler as {registry?:unknown;managed?:boolean}|undefined;
  if(!route?.registry || route.managed!==true)throw new Error("Managed ingestion requires a managed registry route");
  candidate(route.registry,policy);
  if(embedding){
    const encoder=embedding as {role?:string;registry?:unknown};
    if(encoder.role!=="graph_embedding" || !encoder.registry)throw new Error("Managed embedding selector is read only");
    candidate(encoder.registry,policy);
  }
  const releases=new ControlStore(process.env.AGUI_LLM_DATABASE_URL??"",policy);
  try{await releases.ready();await releases.active();queue.useReleases(releases);return releases;}
  catch(error){await releases.close();throw error;}
}
