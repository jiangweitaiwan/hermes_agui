import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiStore, namespaceKey } from "../server/graph/wiki-store";
import { DocumentIngestor } from "../server/graph/ingest-queue";
import { WikiCompiler } from "../server/graph/compiler";
import { compileV2 } from "../server/graph/compiler-v2";
import { validatePersistence } from "../server/llm/validation/persistence";
import { validateIntegrity } from "../server/llm/validation/integrity";
import { fixtureModel, meeting } from "./fixtures/graph-v2/model";
const ns={principal:"owner",projectId:"golden",botId:"a",visibility:"bot_private" as const};
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),"llm-validation-")),store=new WikiStore(root),queue=new DocumentIngestor(store);
  const add=(key:string)=>queue.enqueue(ns,{title:"meeting",content:meeting,mime:"text/plain",idempotencyKey:key});
  return {store,queue,add,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
test("review retains source and normalized issues through retry exhaustion; never publishes active data",async()=>{
  const f=fixture(),logs=vi.spyOn(console,"error").mockImplementation(()=>{});
  try{
    const base=fixtureModel(),id=f.add("review");
    const llm={async json(stage:string,data:unknown,signal:AbortSignal){const value:any=await base.json(stage,data,signal);if(stage==="v2-relations")value.edges[0].description="Bob caused an outage";return value;}};
    const compiler=new WikiCompiler(f.queue,llm,120000,"v2");
    for(let attempt=1;attempt<=3;attempt++){
      f.store.db.prepare("UPDATE ingest_jobs SET available=0 WHERE id=?").run(id);
      await compiler.processJob(ns,id);
      const job=f.queue.status(ns,id),validation=JSON.parse(job.error!);
      expect(validation).toMatchObject({verdict:"needs_review",stage:"v2-relations",validatorVersion:"1"});
      expect(validation.issues.some((i:any)=>i.code==="SEMANTIC_UNCERTAIN")).toBe(true);
      expect(job.state).toBe(attempt===3?"failed":"pending");
      expect(await f.queue.graphSubjects(ns)).toEqual([]);
      expect(f.queue.source(job).content).toBe(meeting);
    }
    const logged=logs.mock.calls.map(args=>JSON.parse(String(args[0])));
    expect(logged.some(r=>r.phase==="publication"&&r.validation.verdict==="needs_review"&&r.jobId===id)).toBe(true);
    expect(JSON.stringify(logged)).not.toContain(meeting);
    // An operator retries the original source after a validated fix; no direct promote API exists.
    f.queue.retry(ns,id);await new WikiCompiler(f.queue,base,120000,"v2").processJob(ns,id);
    expect(f.queue.status(ns,id).state).toBe("completed");
  }finally{logs.mockRestore();f.close();}
});
test("persistence preflight rejects namespace/version mismatch and revoked in-flight source",async()=>{
  const f=fixture();try{
    const id=f.add("scope"),job=f.queue.claim(ns)!,source=f.queue.source(job);
    await expect(validatePersistence(f.queue,{...ns,botId:"b"},job,source)).rejects.toThrow("PERSISTENCE_CONFLICT");
    await expect(validatePersistence(f.queue,ns,job,{...source,version:source.version+1})).rejects.toThrow("PERSISTENCE_CONFLICT");
    const publication=await compileV2(f.queue,fixtureModel(),ns,source,AbortSignal.timeout(5000));
    const bad=structuredClone(publication);bad.edges[0].evidence[0].sourceVersion++;
    expect(validateIntegrity(bad,source).verdict).toBe("rejected");
    const foreign=structuredClone(publication);foreign.edges[0].fromSubjectId="foreign-subject";
    expect(validateIntegrity(foreign,source).verdict).toBe("rejected");
    const time=structuredClone(publication);time.edges[0].time={timePrecision:"day",confidence:"certain",occurredFrom:"2026-11-20T00:00:00.000Z",occurredTo:"2026-11-01T00:00:00.000Z"};
    expect(validateIntegrity(time,source).issues.some(i=>i.code==="TEMPORAL_INVALID")).toBe(true);
    time.edges[0].time.occurredFrom="2026-11-20T00:00:00.500Z";time.edges[0].time.occurredTo="2026-11-20T00:00:00Z";
    expect(validateIntegrity(time,source).issues.some(i=>i.code==="TEMPORAL_INVALID")).toBe(true);
    f.queue.revoke(ns,source.id);
    await expect(validatePersistence(f.queue,ns,job,source)).rejects.toThrow();
    expect(()=>f.queue.publish(ns,job,publication,()=>{})).toThrow();
    expect(await f.queue.graphSubjects(ns)).toEqual([]);
    expect(namespaceKey(ns)).not.toBe(namespaceKey({...ns,botId:"b"}));
  }finally{f.close();}
});
test("reverse cause and assistant-to-human attribution are held for review",async()=>{
  const f=fixture(),logs=vi.spyOn(console,"error").mockImplementation(()=>{});
  try{
    for(const mode of ["cause","actor"]){
      const id=f.add(mode),base=fixtureModel();
      // Each case owns an independent source because completed source deduplication is intentional.
      const model={async json(stage:string,data:unknown,signal:AbortSignal){const v:any=await base.json(stage,data,signal);if(stage==="v2-relations"){
        if(mode==="cause"){const p=v.edges.find((e:any)=>e.relation==="caused_degradation");[p.fromRef,p.toRef]=[p.toRef,p.fromRef];}
        else {const p=v.edges.find((e:any)=>e.relation==="drafted");p.fromRef="alice";}
      }return v;}};
      await new WikiCompiler(f.queue,model,120000,"v2").processJob(ns,id);
      expect(JSON.parse(f.queue.status(ns,id).error!).verdict).toBe("needs_review");
      expect(await f.queue.graphSubjects(ns)).toEqual([]);
      f.queue.cancel(ns,id);
    }
  }finally{logs.mockRestore();f.close();}
});

test("matcher cannot rewrite explicit identity to force a false merge; distinct and exact identities stay separate",async()=>{
  const {matchSubjects,resolveSubjects}=await import("../server/graph/subject-matcher");
  const {ParsedSchema}=await import("../server/llm/schema/parser");
  const input=ParsedSchema.parse({subjects:[{ref:"bob",name:"Bob",type:"person",identity:"Bob engineer",aliases:[],grouping:"independent",quote:"Bob engineer",position:0}],narratives:[],stableAttributes:[]});
  const other=structuredClone(input);other.subjects[0].identity="Bob surgeon";other.subjects[0].quote="Bob surgeon";
  const prior=matchSubjects(other,[])[0].subject!;
  await expect(resolveSubjects(input,[prior],{async json(){return {decisions:[{ref:"bob",action:"matched",subjectId:prior.subjectId}]};}},AbortSignal.timeout(5000))).rejects.toThrow("IDENTITY_UNCERTAIN");
  const separate=await resolveSubjects(input,[prior],{async json(){return {decisions:[{ref:"bob",action:"create"}]};}},AbortSignal.timeout(5000));
  expect(separate[0].subject!.subjectId).not.toBe(prior.subjectId);
  const exact=matchSubjects(input,[separate[0].subject!]);expect(exact[0].status).toBe("matched");expect(exact[0].subject!.subjectId).toBe(separate[0].subject!.subjectId);
});
