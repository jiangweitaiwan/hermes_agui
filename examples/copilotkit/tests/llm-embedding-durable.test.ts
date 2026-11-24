import {test,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {PostgresWikiStore} from "../server/graph/postgres-wiki-store";
import {PostgresDocumentIngestor} from "../server/graph/postgres-ingest-queue";
import {GcsGraphObjects} from "../server/graph/objects";
import {WikiCompiler} from "../server/graph/compiler";
import {VectorIndex} from "../server/graph/embedding";
import {EdgeVectorIndex} from "../server/graph/edge-embedding";
import {V2RetrievalStore} from "../server/graph/v2-retrieval-store";
import {namespaceKey} from "../server/graph/wiki-store";
import {fixtureModel,meeting} from "./fixtures/graph-v2/model";
const url=process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL,bucket=process.env.AGUI_GCS_BUCKET;
test.skipIf(!url||!bucket)("PostgreSQL + REAL GCS: build separate wiki/edge spaces, switch, failure + rollback preserve previous vectors",async()=>{
 const objects=new GcsGraphObjects(bucket!);await objects.ready();
 const store=new PostgresWikiStore(url!,objects),queue=new PostgresDocumentIngestor(store);
 const ns={principal:randomUUID(),projectId:"llm-migration-test",botId:"test",visibility:"bot_private" as const};
 try{
  await queue.ready();const job=await queue.enqueue(ns,{title:"migration test",content:meeting,mime:"text/plain",idempotencyKey:randomUUID()});
  await new WikiCompiler(queue,fixtureModel(),120000,"v2").processJob(ns,job);expect((await queue.status(ns,job)).state).toBe("completed");
  const encoder=(fingerprint:string)=>({model:"same-name",dimension:3,version:"v1",fingerprint,embed:async(texts:string[])=>texts.map(()=>[1,2,3])});
  const old=new VectorIndex(store,encoder("provider-a")),next=new VectorIndex(store,encoder("provider-b")),facts=new V2RetrievalStore(store);
  const oldEdges=new EdgeVectorIndex(facts,old.encoder,"v3"),nextEdges=new EdgeVectorIndex(facts,next.encoder,"v3");
  for(const index of [old,next,oldEdges,nextEdges])await index.update(ns,AbortSignal.timeout(30000));
  expect(await store.indexedEmbeddings(namespaceKey(ns),old.key)).not.toHaveLength(0);expect(await store.indexedEmbeddings(namespaceKey(ns),next.key)).not.toHaveLength(0);
  expect(await oldEdges.search(ns,"Bob",AbortSignal.timeout(30000))).not.toHaveLength(0);expect(await nextEdges.search(ns,"Bob",AbortSignal.timeout(30000))).not.toHaveLength(0);
  const failed=new VectorIndex(store,{...encoder("provider-c"),embed:async()=>{throw Error("outage");}});await failed.update(ns,AbortSignal.timeout(30000));expect(await failed.search([namespaceKey(ns)],"Bob",AbortSignal.timeout(30000))).toEqual([]);
  expect(await old.search([namespaceKey(ns)],"Bob",AbortSignal.timeout(30000))).not.toHaveLength(0);
  expect(await store.indexedEmbeddings(namespaceKey(ns),old.key)).not.toHaveLength(0);
 }finally{await store.close();}
 // Deliberately retain immutable test objects/history; cleanup is a separate scoped admin operation.
},60000);
