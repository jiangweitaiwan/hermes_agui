import { stringify } from "yaml";
import { test, expect } from "vitest";
import { realpathSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiStore, namespaceKey } from "../server/graph/wiki-store";
import { DocumentIngestor } from "../server/graph/ingest-queue";
import { WikiCompiler } from "../server/graph/compiler";
import { compileV2 } from "../server/graph/compiler-v2";
import { activeEdges, sqliteGraphConnection } from "../server/graph/v2-store";
import { resolveTime } from "../server/graph/temporal-resolver";
import { meeting, profile, fixtureModel } from "./fixtures/graph-v2/model";
import { matchSubjects } from "../server/graph/subject-matcher";
import { parseSource } from "../server/graph/parser";
const ns = {principal:"acceptance",projectId:"test",botId:"a",visibility:"bot_private" as const};
const referenceTime = {instant:"2026-11-03T08:00:00.000Z",timezone:"Asia/Taipei"};
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()),"graph-v2-")); const store = new WikiStore(root); const queue = new DocumentIngestor(store);
  const add = (content:string,key:string) => queue.enqueue(ns,{title:key,content,mime:"text/plain",idempotencyKey:key},
    {provenance:{botId:"a",threadId:key,runId:key},classification:"user-stated",referenceTime,evidence:{user:content,confirmed:false,assistants:[]}});
  return {store,queue,add,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
test("A/B: real queue → parser → grouped subjects/wiki → atomic event/edge evidence; replay and isolation",async()=>{
  const f=fixture();try {
    const model=fixtureModel(); const worker=new WikiCompiler(f.queue,model,120000,"v2");
    const p=f.add(profile,"profile");await worker.processJob(ns,p);
    expect(f.queue.status(ns,p).state).toBe("completed");
    const id=f.add(meeting,"meeting");const job=f.queue.status(ns,id),source=f.queue.source(job);
    const parsed=await parseSource(model,source,new AbortController().signal);
    const publication=await compileV2(f.queue,model,ns,source,new AbortController().signal);
    await worker.processJob(ns,id);expect(f.queue.status(ns,id).state).toBe("completed");
    const subjects=await f.queue.graphSubjects(ns);expect(subjects).toHaveLength(8);
    const hub=subjects.find(s=>s.canonicalName==="FeatureHub")!,cache=subjects.find(s=>s.type==="component" && s.canonicalName.includes("快取"))!;
    expect(cache.parentSubjectId).toBe(hub.subjectId);expect(cache.wikiPageId).toBe(hub.wikiPageId);expect(cache.subjectId).not.toBe(hub.subjectId);
    const wiki=f.queue.current(ns,hub.wikiPageId)!;expect(wiki.page.body).toContain("TTL");expect(wiki.page.body).not.toContain("事故");expect(wiki.page.body).not.toContain("11/3");
    const bob=subjects.find(s=>s.canonicalName==="Bob")!;
    const edges=await activeEdges(sqliteGraphConnection(f.store.db),namespaceKey(ns),bob.subjectId);
    expect(edges).toHaveLength(1);expect(edges[0]).toMatchObject({relation:"rolled_back",time:{occurredFrom:"2026-11-04T00:00:00.000Z"}});
    expect(publication.edges).toHaveLength(5);expect(new Set(publication.edges.map(e=>e.eventId)).size).toBe(1);
    expect(publication.edges.find(e=>e.relation==="caused_degradation")?.time).toMatchObject({occurredFrom:"2026-10-26T00:00:00.000Z",occurredTo:"2026-11-01T00:00:00.000Z"});
    expect(await activeEdges(sqliteGraphConnection(f.store.db),namespaceKey({...ns,botId:"b"}),bob.subjectId)).toEqual([]);
    expect(f.add(meeting,"meeting")).toBe(id);await worker.processJob(ns,id);
    expect(f.store.db.prepare("SELECT count(*) AS n FROM graph_fact_edges").get()?.n).toBe(5);
    expect(f.queue.current(ns,hub.wikiPageId)?.revision).toBe(wiki.revision);
    if(process.env.GRAPH_V2_ARTIFACT_DIR){const dir=process.env.GRAPH_V2_ARTIFACT_DIR;mkdirSync(dir,{recursive:true});
      writeFileSync(join(dir,"fixture-a.json"),JSON.stringify({mockLLM:true,source,parsed,publication,subjects,edgeRows:f.store.db.prepare("SELECT * FROM graph_fact_edges").all(),evidenceRows:f.store.db.prepare("SELECT * FROM graph_edge_evidence").all(),storageLookup:edges},null,2));
      const {body,links,sections,...metadata}=wiki.page;writeFileSync(join(dir,"featurehub.md"),`---\n${stringify(metadata)}---\n${body}\n`);}
  }finally{f.close();}
});
test("time requires metadata; after-meeting remains relative; invalid date is unknown",()=>{
 expect(resolveTime("11/3")).toMatchObject({timePrecision:"unknown"});
 expect(resolveTime("會後",referenceTime)).toMatchObject({timePrecision:"relative",confidence:"uncertain"});
 expect(resolveTime("2/30",referenceTime).occurredFrom).toBeUndefined();
});
test("lease fencing, CAS rollback and invalid JSON never half-publish",async()=>{
 const f=fixture();try{
  const id=f.add(profile,"p"),old=f.queue.claim(ns)!;expect(f.queue.claim(ns)).toBeUndefined();
  const source=f.queue.source(old),pub=await compileV2(f.queue,fixtureModel(),ns,source,new AbortController().signal);
  f.store.db.prepare("UPDATE ingest_jobs SET lease=0 WHERE id=?").run(id);const takeover=f.queue.claim(ns)!;
  expect(()=>f.queue.publish(ns,old,pub,()=>{})).toThrow("lease");expect(await f.queue.graphSubjects(ns)).toEqual([]);
  expect(()=>f.queue.publish(ns,takeover,{...pub,pages:pub.pages.map(p=>({...p,expectedRevision:"bad"}))},()=>{})).toThrow("Revision conflict");
  expect(await f.queue.graphSubjects(ns)).toEqual([]);f.queue.publish(ns,takeover,pub,()=>{});expect(f.queue.status(ns,id).state).toBe("completed");
  const bad=f.add(meeting,"bad");await new WikiCompiler(f.queue,{async json(){return {arbitrary:true};}},120000,"v2").processJob(ns,bad);
  expect(f.queue.status(ns,bad).state).toBe("pending");expect(f.store.db.prepare("SELECT count(*) AS n FROM graph_fact_edges").get()?.n).toBe(0);
 }finally{f.close();}
});
test("revoke source invalidates evidence immediately, retains history, rebuilds other profile evidence",async()=>{
 const f=fixture();try{
  const worker=new WikiCompiler(f.queue,fixtureModel(),120000,"v2");const a=f.add(profile,"a");await worker.processJob(ns,a);
  const b=f.add(profile,"b");await worker.processJob(ns,b);const m=f.add(meeting,"m");await worker.processJob(ns,m);
  const subjects=await f.queue.graphSubjects(ns),bob=subjects.find(s=>s.canonicalName==="Bob")!,hub=subjects.find(s=>s.canonicalName==="FeatureHub")!;
  f.queue.revoke(ns,f.queue.status(ns,m).source);expect(await activeEdges(sqliteGraphConnection(f.store.db),namespaceKey(ns),bob.subjectId)).toEqual([]);
  expect(f.store.db.prepare("SELECT count(*) AS n FROM graph_fact_edges").get()?.n).toBe(5);
  f.queue.revoke(ns,f.queue.status(ns,a).source);expect(f.queue.current(ns,hub.wikiPageId)).toBeUndefined();
  expect(f.queue.status(ns,b).state).toBe("pending");await worker.processJob(ns,b);expect(f.queue.current(ns,hub.wikiPageId)?.page.body).toContain("TTL");
 }finally{f.close();}
});
test("C: state slots retain both effective dates; repeated equivalent source attaches independent evidence",async()=>{
 const f=fixture();try{
  const content="11/05 FeatureHub 目前部署 v1。11/12 FeatureHub 目前部署 v2。";
  const model={async json(stage:string,data:any){
   if(stage==="v2-parser")return {subjects:[{ref:"hub",name:"FeatureHub",type:"system",identity:"FeatureHub",aliases:[],grouping:"independent",quote:"FeatureHub",position:content.indexOf("FeatureHub")},
    ...["v1","v2"].map(ref=>({ref,name:ref,type:"value",identity:ref,aliases:[],grouping:"independent",quote:ref,position:content.indexOf(ref)}))],stableAttributes:[],
    narratives:["v1","v2"].map((ref,i)=>{const quote=content.split("。")[i];return {ref,text:quote,quote,position:content.indexOf(quote),subjectRefs:["hub",ref],timeText:i?"11/12":"11/05",eventRef:ref};})};
   return {edges:["v1","v2"].map(ref=>({narrativeRef:ref,fromRef:"hub",toRef:ref,relation:"deployed_version",description:`FeatureHub 目前部署 ${ref}`,factKind:"state",stateProperty:"deployed_version",certainty:"reported"}))};
  }};
  const worker=new WikiCompiler(f.queue,model,120000,"v2");const a=f.add(content,"state-a");await worker.processJob(ns,a);const b=f.add(content,"state-b");await worker.processJob(ns,b);
  expect(f.queue.status(ns,b).state).toBe("completed");const hub=(await f.queue.graphSubjects(ns)).find(s=>s.canonicalName==="FeatureHub")!;
  const edges=await activeEdges(sqliteGraphConnection(f.store.db),namespaceKey(ns),hub.subjectId);expect(edges).toHaveLength(2);
  expect(new Set(edges.map(e=>e.stateSlotKey)).size).toBe(1);expect(edges.every(e=>e.evidence.length===2)).toBe(true);
  expect(edges.map(e=>e.time.occurredFrom).sort()).toEqual(["2026-11-05T00:00:00.000Z","2026-11-12T00:00:00.000Z"]);
  f.queue.revoke(ns,f.queue.status(ns,a).source);expect((await activeEdges(sqliteGraphConnection(f.store.db),namespaceKey(ns),hub.subjectId)).every(e=>e.evidence.length===1)).toBe(true);
 }finally{f.close();}
});
test("cancellation, revoke during parse and invented quote cannot publish",async()=>{
 const f=fixture();try{
  const revoked=f.add(meeting,"revoked");const base=fixtureModel();
  await new WikiCompiler(f.queue,{async json(stage,data,signal){const output=await base.json(stage,data,signal);f.queue.revoke(ns,f.queue.status(ns,revoked).source);return output;}},120000,"v2").processJob(ns,revoked);
  expect(f.queue.status(ns,revoked).state).toBe("cancelled");expect(await f.queue.graphSubjects(ns)).toEqual([]);
  const cancelled=f.add(profile,"cancelled"),controller=new AbortController();
  await new WikiCompiler(f.queue,{async json(stage,data,signal){controller.abort();return base.json(stage,data,signal);}},120000,"v2").processJob(ns,cancelled,controller.signal);
  expect(f.queue.status(ns,cancelled).state).toBe("cancelled");expect(await f.queue.graphSubjects(ns)).toEqual([]);
  const invalid=f.add(profile,"invalid");
  await new WikiCompiler(f.queue,{async json(stage,data,signal){const value:any=await base.json(stage,data,signal);if(stage==="v2-parser")value.subjects[0].quote="fabricated";return value;}},120000,"v2").processJob(ns,invalid);
  expect(f.queue.status(ns,invalid).state).toBe("pending");expect(await f.queue.graphSubjects(ns)).toEqual([]);
 }finally{f.close();}
});
test("stable identity survives fresh store and homonymous alias remains unresolved",async()=>{
 const f=fixture();try{
  const id=f.add(profile,"profile"),source=f.queue.source(f.queue.status(ns,id));const parsed=await parseSource(fixtureModel(),source,new AbortController().signal);
  await new WikiCompiler(f.queue,fixtureModel(),120000,"v2").processJob(ns,id);
  const subjects=await f.queue.graphSubjects(ns),collision=structuredClone(parsed);collision.subjects[0].identity="FeatureHub of unrelated company";
  expect(matchSubjects(collision,subjects).find(m=>m.ref==="hub")?.status).toBe("unresolved");
  const second=new WikiStore(f.store.root);try{expect(await new DocumentIngestor(second).graphSubjects(ns)).toEqual(subjects);}finally{second.close();}
 }finally{f.close();}
});
test("Fixture A alone creates minimal identity profiles; incident content remains in edges",async()=>{
 const f=fixture();try{
  const id=f.add(meeting,"standalone");
  const source=f.queue.source(f.queue.status(ns,id)),model=fixtureModel(),signal=new AbortController().signal;
  const parsed=await parseSource(model,source,signal),publication=await compileV2(f.queue,model,ns,source,signal);
  await new WikiCompiler(f.queue,fixtureModel(),120000,"v2").processJob(ns,id);
  expect(f.queue.status(ns,id).state).toBe("completed");const subjects=await f.queue.graphSubjects(ns);expect(subjects).toHaveLength(7);
  const hub=subjects.find(s=>s.canonicalName==="FeatureHub")!,cache=subjects.find(s=>s.type==="component")!;
  expect(hub.wikiPageId).toBe(cache.wikiPageId);const wiki=f.queue.current(ns,hub.wikiPageId)!;
  expect(wiki.page.body).toContain(cache.sectionKey);expect(wiki.page.body).not.toContain("回滾");expect(wiki.page.body).not.toContain("失效");
  if(process.env.GRAPH_V2_ARTIFACT_DIR){const dir=process.env.GRAPH_V2_ARTIFACT_DIR;mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,"fixture-a-standalone.json"),JSON.stringify({mockLLM:true,source,parsed,publication,subjects,
    edgeRows:f.store.db.prepare("SELECT * FROM graph_fact_edges").all(),evidenceRows:f.store.db.prepare("SELECT * FROM graph_edge_evidence").all()},null,2));
   for(const page of publication.pages){const parsedPage=(await import("../server/graph/markdown")).parsePage(page.markdown);
    writeFileSync(join(dir,`${parsedPage.id}.md`),page.markdown);}
  }
 }finally{f.close();}
});
test("D: revoke removes only A's distinct attribute; B rebuild and explicitly shared copies remain isolated",async()=>{
 const f=fixture();try{
  const base=fixtureModel();const selective=(index:number)=>({async json(stage:string,data:unknown,signal:AbortSignal){const v:any=await base.json(stage,data,signal);if(stage==="v2-parser")v.stableAttributes=[v.stableAttributes[index]];return v;}});
  const a=f.add(profile,"distinct-a");await new WikiCompiler(f.queue,selective(0),120000,"v2").processJob(ns,a);
  const b=f.add(profile,"distinct-b");await new WikiCompiler(f.queue,selective(1),120000,"v2").processJob(ns,b);
  const hub=(await f.queue.graphSubjects(ns)).find(s=>s.canonicalName==="FeatureHub")!;
  expect(f.queue.current(ns,hub.wikiPageId)?.page.body).toContain("TTL");
  f.queue.revoke(ns,f.queue.status(ns,a).source);await new WikiCompiler(f.queue,selective(1),120000,"v2").processJob(ns,b);
  const body=f.queue.current(ns,hub.wikiPageId)!.page.body;expect(body).toContain("存取層支援版本回滾");expect(body).not.toContain("TTL");
  const { SessionIngestor }=await import("../server/graph/session-ingestor");const sharedNs={...ns,visibility:"project_shared" as const};
  const shared=await new SessionIngestor(f.queue).share(ns,f.queue.status(ns,b).source);
  await new WikiCompiler(f.queue,selective(1),120000,"v2").processJob(sharedNs,shared);
  expect(await f.queue.graphSubjects(sharedNs)).toHaveLength(3);f.queue.revokeCopies(ns,f.queue.status(ns,b).source);
  expect(await f.queue.graphSubjects(sharedNs)).toEqual([]);expect(f.queue.current(sharedNs,hub.wikiPageId)).toBeUndefined();
 }finally{f.close();}
});
test("full attribute evidence survives beyond frontmatter limits; revoking an uncited contribution still invalidates the Wiki",async()=>{
 const f=fixture();try{
  const worker=new WikiCompiler(f.queue,fixtureModel(),120000,"v2");let last="";
  for(let i=0;i<22;i++){last=f.add(profile,`many-${i}`);await worker.processJob(ns,last);expect(f.queue.status(ns,last).state).toBe("completed");}
  const hub=(await f.queue.graphSubjects(ns)).find(s=>s.canonicalName==="FeatureHub")!;
  const wiki=f.queue.current(ns,hub.wikiPageId)!;expect(wiki.page.sources.length).toBeLessThanOrEqual(20);
  expect(f.store.db.prepare("SELECT count(*) AS n FROM graph_subject_attribute_evidence").get()!.n).toBeGreaterThanOrEqual(44);
  f.queue.revoke(ns,f.queue.status(ns,last).source);expect(f.queue.current(ns,hub.wikiPageId)).toBeUndefined();
  expect((await f.queue.graphAttributes(ns,hub.wikiPageId)).length).toBeGreaterThanOrEqual(42);
 }finally{f.close();}
},20000);
test("Session E2E: authenticated completion intake → real OpenAI HTTP adapter → worker → published Wiki/facts",async()=>{
 const f=fixture();const {createServer}=await import("node:http");
 const {OpenAICompilerLLM}=await import("../server/graph/compiler"),{SessionIngestor}=await import("../server/graph/session-ingestor"),{createCompletionApi}=await import("../server/graph/completion-api");
 const model=fixtureModel();const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const request=JSON.parse(Buffer.concat(chunks).toString()),stage=request.messages[0].content.split("\n").at(-1),data=JSON.parse(request.messages[1].content);
  const value=await model.json(stage,data,new AbortController().signal);res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
 });
 const key="GRAPH_V2_TEST_KEY";process.env[key]="mock-only";
 try{
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address() as {port:number};
  const service=new SessionIngestor(f.queue),token="mock-completion-token-01234567890123456789",api=createCompletionApi(service,token);
  const response=await api(new Request("http://local/internal/graph/completions",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({namespace:ns,threadId:"session",runId:"session",messageId:"m",user:`研究會議紀錄：${meeting}`,
   assistants:[{id:"final",text:"Research finding: the user-stated meeting notes are retained as reported evidence; assistant statements are unverified."}],referenceTime})}));
  expect(response.status).toBe(204);
  await new WikiCompiler(f.queue,new OpenAICompilerLLM({baseUrl:`http://127.0.0.1:${address.port}/v1`,model:"fixture",keyEnv:key}),120000,"v2").runNext(ns);
  const job=f.store.db.prepare("SELECT state FROM ingest_jobs").get();expect(job?.state).toBe("completed");
  expect(f.store.db.prepare("SELECT count(*) AS n FROM graph_fact_edges").get()?.n).toBe(5);
  expect(await f.queue.graphSubjects(ns)).toHaveLength(7);
 }finally{delete process.env[key];server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
},20000);
test("same-named components of independently identified systems never share a Subject ID",async()=>{
 const f=fixture();try{
  const id=f.add(profile,"identity"),source=f.queue.source(f.queue.status(ns,id));const parsed=await parseSource(fixtureModel(),source,new AbortController().signal);
  const first=matchSubjects(parsed,[]).map(m=>m.subject!);const second=structuredClone(parsed);second.subjects[0].identity="FeatureHub of another organization";
  const matches=matchSubjects(second,first,new Set(second.subjects.map(s=>s.ref)));
  expect(matches.every(m=>m.status==="create")).toBe(true);
  expect(matches.some(m=>first.some(s=>s.subjectId===m.subject?.subjectId))).toBe(false);
  expect(new Set(matches.map(m=>m.subject?.wikiPageId)).size).toBe(1);
 }finally{f.close();}
});
