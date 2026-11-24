import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PostgresWikiStore } from "../server/graph/postgres-wiki-store";
import { PostgresDocumentIngestor } from "../server/graph/postgres-ingest-queue";
import { GcsGraphObjects } from "../server/graph/objects";
import { WikiCompiler } from "../server/graph/compiler";
import { RegistryLLM } from "../server/llm/client";
import { fixtureModel, meeting } from "./fixtures/graph-v2/model";
const url=process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL,bucket=process.env.AGUI_GCS_BUCKET,live=process.env.AGUI_VERTEX_SMOKE_CONFIG;
test.skipIf(!url||!bucket)("REAL PG/GCS: durable review summary, original source retention, retry and revoked-source isolation",async()=>{
  const objects=new GcsGraphObjects(bucket!);await objects.ready();
  const store=new PostgresWikiStore(url!,objects),queue=new PostgresDocumentIngestor(store);
  const ns={principal:randomUUID(),projectId:"llm-part2-review",botId:"test",visibility:"bot_private" as const};
  try{
    await queue.ready();const id=await queue.enqueue(ns,{title:"review",content:meeting,mime:"text/plain",idempotencyKey:randomUUID()});
    const base=fixtureModel(),llm={async json(stage:string,data:unknown,signal:AbortSignal){const output:any=await base.json(stage,data,signal);if(stage==="v2-relations")output.edges[0].description="Bob caused the outage";return output;}};
    await new WikiCompiler(queue,llm,120000,"v2").processJob(ns,id);
    const job=await queue.status(ns,id);expect(job.state).toBe("pending");expect(JSON.parse(job.error!).verdict).toBe("needs_review");
    expect(await queue.graphSubjects(ns)).toEqual([]);expect((await queue.source(job)).content).toBe(meeting);
    await expect(queue.status({...ns,botId:"other"},id)).rejects.toThrow();
    await queue.revoke(ns,job.source);
    await new WikiCompiler(queue,base,120000,"v2").processJob(ns,id);
    expect(await queue.graphSubjects(ns)).toEqual([]);
  }finally{await store.close();}
},60000);
test.skipIf(!url||!bucket||!live)("LIVE Vertex + REAL PG/GCS: positive pipeline publication and namespace isolation",async()=>{
  const objects=new GcsGraphObjects(bucket!);await objects.ready();
  const store=new PostgresWikiStore(url!,objects),queue=new PostgresDocumentIngestor(store);
  const ns={principal:randomUUID(),projectId:"llm-part2-live",botId:"test",visibility:"bot_private" as const};
  try{
    await queue.ready();const id=await queue.enqueue(ns,{title:"live source",content:meeting,mime:"text/plain",idempotencyKey:randomUUID()});
    const llm=new RegistryLLM(JSON.parse(readFileSync(live!,"utf8")),"graph_parser");
    await new WikiCompiler(queue,llm,120000,"v2").processJob(ns,id);
    // A review verdict is safe, but is not counted as a successful positive live acceptance.
    expect((await queue.status(ns,id)).state).toBe("completed");
    expect(await queue.graphSubjects(ns)).not.toHaveLength(0);
    expect(await queue.graphSubjects({...ns,botId:"other"})).toEqual([]);
  }finally{await store.close();}
},120000);
