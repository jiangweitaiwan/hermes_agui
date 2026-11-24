import { test, expect } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiStore } from "../server/graph/wiki-store";
import { DocumentIngestor } from "../server/graph/ingest-queue";
import { WikiCompiler } from "../server/graph/compiler";
import { fixtureModel, meeting } from "./fixtures/graph-v2/model";
// Uses only pre-Part-2 public APIs so this contract can run red on the accepted Part 1 HEAD.
test("a valid quote does not authorize a fabricated assertion or reversed cause",async()=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),"review-contract-")),store=new WikiStore(root),queue=new DocumentIngestor(store);
  const ns={principal:"golden",projectId:"review",botId:"a",visibility:"bot_private" as const};
  try{
    const id=queue.enqueue(ns,{title:"review",content:meeting,mime:"text/plain",idempotencyKey:"review"});
    const model=fixtureModel(),llm={async json(stage:string,data:unknown,signal:AbortSignal){const v:any=await model.json(stage,data,signal);if(stage==="v2-relations"){
      v.edges[0].description="Bob caused the outage";
      const cause=v.edges.find((e:any)=>e.relation==="caused_degradation");[cause.fromRef,cause.toRef]=[cause.toRef,cause.fromRef];
    }return v;}};
    await new WikiCompiler(queue,llm,120000,"v2").processJob(ns,id);
    expect(queue.status(ns,id).state).toBe("pending");
    expect(await queue.graphSubjects(ns)).toEqual([]);
    expect(queue.source(queue.status(ns,id)).content).toBe(meeting);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
