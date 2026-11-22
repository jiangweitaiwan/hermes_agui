import {EdgeRetriever} from "../server/graph/edge-retriever";
import {test,expect} from "vitest";
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WikiStore,namespaceKey,digest} from "../server/graph/wiki-store";
import {DocumentIngestor} from "../server/graph/ingest-queue";
import {WikiCompiler} from "../server/graph/compiler";
import {meeting,profile,fixtureModel} from "./fixtures/graph-v2/model";
import {WikiGraphProvider} from "../server/graph/provider";
import {temporalView,temporalIntent} from "../server/graph/temporal-view";
import {EdgeVectorIndex,backfillEdgeLexical} from "../server/graph/edge-embedding";
import {V2Browser} from "../server/graph/v2-browser";
import {parseQuery} from "../server/graph/browser-query";
import type {FactEdge} from "../server/graph/v2-types";
import {createGraphMemory} from "../server/graph-memory";
const ns={principal:"part2",projectId:"test",botId:"a",visibility:"bot_private" as const};
const scope={principal:ns.principal,projectId:ns.projectId,botId:ns.botId,threadId:"q",runId:"q"};
const signal=()=>new AbortController().signal;
function fixture(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),"graph-v2-read-")),store=new WikiStore(root),queue=new DocumentIngestor(store),provider=new WikiGraphProvider(store,10000);
 const add=(content:string,key:string)=>queue.enqueue(ns,{title:key,content,mime:"text/plain",idempotencyKey:key},
 {provenance:{botId:"a",threadId:key,runId:key},classification:"user-stated",referenceTime:{instant:"2026-11-03T08:00:00.000Z",timezone:"Asia/Taipei"},evidence:{user:content,confirmed:false,assistants:[]}});
 return {root,store,queue,provider,add,close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
test("A: runtime hybrid keyword retrieval expands the incident, respects GraphHit contract, aliases, revocation and Bot scope",async()=>{
 const f=fixture();try{
  const worker=new WikiCompiler(f.queue,fixtureModel(),120000,"v2");
  await worker.processJob(ns,f.add(profile,"profile"));const job=f.add(meeting,"meeting");await worker.processJob(ns,job);
  const memory=createGraphMemory({provider:f.provider,authorize:()=>true,timeoutMs:10000});
  const hits=await memory.query(memory.scope(scope),{text:"Bob 如何處理搜尋推薦服務延遲？",limit:20});
  expect(hits.status).toBe("ok");if(hits.status!=="ok")throw new Error("No hits");
  const edges=hits.hits.filter(h=>h.recordId.startsWith("fact:")).map(h=>JSON.parse(h.content));
  expect(edges).toHaveLength(5);expect(edges.some(e=>e.relation==="rolled_back")).toBe(true);
  expect(edges.every(e=>e.evidence.length && e.evidence[0].quote)).toBe(true);
  expect(new Set(edges.map(e=>e.eventId)).size).toBe(1);
  expect(await f.provider.query({...scope,botId:"b"},{text:"Bob",limit:20},signal())).toEqual({status:"ok",hits:[]});
  const browser=new V2Browser(f.provider.facts,[ns],parseQuery(new URL("http://local/?view=history&limit=2"),"facts"),()=>true);
  const page=await browser.list("test");expect(page.edges).toHaveLength(2);expect(page.nextCursor).toBeTruthy();await browser.revalidate();
  const next=new V2Browser(f.provider.facts,[ns],parseQuery(new URL(`http://local/?view=history&limit=2&cursor=${page.nextCursor}`),"facts"),()=>true);
  const second=await next.list("test");
  expect(second.edges.some(e=>page.edges.some(old=>old.edgeId===e.edgeId))).toBe(false);
  const last=new V2Browser(f.provider.facts,[ns],parseQuery(new URL(`http://local/?view=history&limit=2&cursor=${second.nextCursor}`),"facts"),()=>true);
  const final=await last.list("test");
  expect(new Set([...page.edges,...second.edges,...final.edges].map(e=>e.edgeId)).size).toBe(5);
  expect(final.nextCursor).toBeNull();
  if(process.env.GRAPH_V2_ARTIFACT_DIR){mkdirSync(process.env.GRAPH_V2_ARTIFACT_DIR,{recursive:true});writeFileSync(join(process.env.GRAPH_V2_ARTIFACT_DIR,"retrieval-a.json"),JSON.stringify({mockLLM:true,query:"Bob 如何處理搜尋推薦服務延遲？",runtime:hits,browser:page},null,2));}
  f.queue.revoke(ns,f.queue.status(ns,job).source);
  expect((await f.provider.query(scope,{text:"Bob",limit:20},signal())).status).toBe("ok");
  expect((await f.provider.edgeRetriever.query(scope,{text:"Bob",limit:20},signal()))).toEqual([]);
  await expect(browser.revalidate()).rejects.toThrow();
 }finally{f.close();}
});
function edge(id:string,date?:string,extra:Partial<FactEdge>={}):FactEdge{return {edgeId:id,fromSubjectId:"hub",toSubjectId:id,relation:"deployed_version",description:id,factKind:"state",stateSlotKey:"hub:version",time:{timePrecision:date?"day":"unknown",confidence:date?"certain":"uncertain",...(date?{occurredFrom:`2026-11-${date}T00:00:00.000Z`}:{})},recordedAt:"2026-11-22T00:00:00.000Z",certainty:"reported",status:"active",attribution:"user_stated",semanticHash:digest(id),evidence:[],...extra};}
test("temporal view: effective time, historical independent events, as-of, ties, unknown and disputed claims",()=>{
 const v1=edge("v1","05",{recordedAt:"2026-11-22T00:00:00.000Z"}),v2=edge("v2","12",{recordedAt:"2026-11-13T00:00:00.000Z"});
 expect(temporalView([v2,v1],{mode:"current"})).toMatchObject([{edge:{edgeId:"v2"},view:"latest",changes:[{edgeId:"v1"}]}]);
 expect(temporalView([v2,v1],{mode:"history"}).map(r=>r.edge.edgeId)).toEqual(["v1","v2"]);
 expect(temporalView([v2,v1],temporalIntent("as of 2026-11-06")).map(r=>r.edge.edgeId)).toEqual(["v1"]);
 expect(temporalView([v1,v2],temporalIntent("截至上週")).every(r=>r.view==="uncertain")).toBe(true);
 const rollback1=edge("rollback1","04",{factKind:"event",stateSlotKey:undefined,relation:"rolled_back"}),rollback2=edge("rollback2","15",{factKind:"event",stateSlotKey:undefined,relation:"rolled_back"});
 expect(temporalView([rollback2,rollback1],{mode:"current"})).toHaveLength(2);
 expect(temporalView([v1,v2,edge("unknown")],{mode:"current"}).every(r=>r.view==="uncertain")).toBe(true);
 expect(temporalView([v2,edge("tie","12")],{mode:"current"}).every(r=>r.view==="uncertain")).toBe(true);
 expect(temporalView([v2,edge("disputed","15",{certainty:"disputed"})],{mode:"current"}).every(r=>r.view==="uncertain")).toBe(true);
 expect(temporalView([v2,edge("range","11",{time:{timePrecision:"week",confidence:"certain",occurredFrom:"2026-11-11T00:00:00.000Z",occurredTo:"2026-11-18T00:00:00.000Z"}})],{mode:"current"}).every(r=>r.view==="uncertain")).toBe(true);
});
test("edge indexing: lexical fallback, durable retries, rebuild, model separation, semantic recall, revocation during embedding",async()=>{
 const f=fixture();try{
  const job=f.add(meeting,"m");await new WikiCompiler(f.queue,fixtureModel(),120000,"v2").processJob(ns,job);
  f.store.db.prepare("DELETE FROM graph_fact_tokens").run();expect(await backfillEdgeLexical(f.provider.facts,ns)).toBe(5);
  let fail=true;const encoder={model:"mock",dimension:2,version:"1",async embed(texts:string[]){if(fail)throw new Error("offline");return texts.map(()=>[1,0]);}};
  const index=new EdgeVectorIndex(f.provider.facts,encoder);
  await index.update(ns,signal());expect(index.metrics.failures).toBe(1);
  expect((await f.provider.edgeRetriever.query(scope,{text:"Bob",limit:10},signal())).length).toBe(5);
  const fallback=await new EdgeRetriever(f.provider.facts,index).query(scope,{text:"Bob",limit:10},signal());
  expect(fallback.map(h=>JSON.parse(h.content).relation)).toContain("rolled_back");
  fail=false;await index.update(ns,signal());expect(index.metrics.indexed).toBe(5);expect((await index.search(ns,"semantic only",signal()))).toHaveLength(5);
  expect(await index.search({...ns,botId:"b"},"semantic only",signal())).toEqual([]);
  const other=new EdgeVectorIndex(f.provider.facts,{...encoder,version:"2"});expect(await other.search(ns,"semantic only",signal())).toEqual([]);
  f.store.db.prepare("UPDATE graph_edge_embeddings SET content_hash=?").run("0".repeat(64));expect(await index.search(ns,"semantic only",signal())).toEqual([]);
  await index.rebuild(ns);await index.update(ns,signal());expect((await index.search(ns,"semantic only",signal()))).toHaveLength(5);
  const ranked=new EdgeVectorIndex(f.provider.facts,{...encoder,version:"ranked",async embed(texts:string[]){return texts.map(t=>t.includes('"relation":"rolled_back"') || t==="mitigation" ? [1,0]:[0,1]);}});
  await ranked.update(ns,signal());
  const semantic=await new EdgeRetriever(f.provider.facts,ranked).query(scope,{text:"mitigation",limit:1},signal());
  expect(JSON.parse(semantic[0].content).relation).toBe("rolled_back");
  await index.rebuild(ns);const revoked=new EdgeVectorIndex(f.provider.facts,{...encoder,async embed(texts:string[]){f.queue.revoke(ns,f.queue.status(ns,job).source);return texts.map(()=>[1,0]);}});
  await revoked.update(ns,signal());expect(f.store.db.prepare("SELECT count(*) AS n FROM graph_edge_embeddings").get()?.n).toBe(0);
 }finally{f.close();}
});
test("C: persisted states serve current/history/as-of and source revocation through the real Runtime provider",async()=>{
 const f=fixture();try{
  const {stateText,stateModel}=await import("./fixtures/graph-v2/state-model");
  const job=f.add(stateText,"states");await new WikiCompiler(f.queue,stateModel,120000,"v2").processJob(ns,job);
  const read=async(text:string)=>{const result=await f.provider.query(scope,{text,limit:20},signal());expect(result.status).toBe("ok");if(result.status!=="ok")throw new Error("No state result");return result.hits.filter(h=>h.recordId.startsWith("fact:")).map(h=>JSON.parse(h.content));};
  const current=await read("FeatureHub 目前版本");expect(current).toHaveLength(1);expect(current[0]).toMatchObject({description:"FeatureHub 目前部署 v2",view:"latest",changes:[{description:"FeatureHub 目前部署 v1"}]});
  const history=await read("FeatureHub 歷史版本");expect(history.map(h=>h.description)).toEqual(["FeatureHub 目前部署 v1","FeatureHub 目前部署 v2"]);
  const asOf=await read("FeatureHub as of 2026-11-06");expect(asOf.map(h=>h.description)).toEqual(["FeatureHub 目前部署 v1"]);
  if(process.env.GRAPH_V2_ARTIFACT_DIR)writeFileSync(join(process.env.GRAPH_V2_ARTIFACT_DIR,"retrieval-c.json"),JSON.stringify({mockLLM:true,current,history,asOf,rows:f.store.db.prepare("SELECT * FROM graph_fact_edges").all()},null,2));
  f.queue.revoke(ns,f.queue.status(ns,job).source);expect(await read("FeatureHub 目前版本")).toEqual([]);
 }finally{f.close();}
});
test("independent rollback events remain visible; shared copies and Bot disable cannot bypass evidence authorization",async()=>{
 const f=fixture();try{
  const worker=new WikiCompiler(f.queue,fixtureModel(),120000,"v2");
  const a=f.add(meeting,"first");await worker.processJob(ns,a);
  const b=f.queue.enqueue(ns,{title:"second",content:meeting,mime:"text/plain",idempotencyKey:"second"},
   {provenance:{botId:"a",threadId:"second",runId:"second"},classification:"user-stated",referenceTime:{instant:"2027-11-03T08:00:00.000Z",timezone:"Asia/Taipei"},evidence:{user:meeting,confirmed:false,assistants:[]}});
  await worker.processJob(ns,b);
  const history=await f.provider.edgeRetriever.query(scope,{text:"Bob history",limit:20},signal());
  expect(history.map(h=>JSON.parse(h.content)).filter(h=>h.relation==="rolled_back")).toHaveLength(2);
  const {SessionIngestor}=await import("../server/graph/session-ingestor");const sharedNs={...ns,visibility:"project_shared" as const};
  const share=await new SessionIngestor(f.queue).share(ns,f.queue.status(ns,a).source);await worker.processJob(sharedNs,share);
  expect((await f.provider.edgeRetriever.query({...scope,botId:"b"},{text:"Bob",limit:20},signal())).length).toBe(5);
  f.provider.facts.retained=(_ns,bot)=>bot!=="a";
  expect(await f.provider.edgeRetriever.query({...scope,botId:"b"},{text:"Bob",limit:20},signal())).toEqual([]);
  f.provider.facts.retained=()=>true;f.queue.revokeCopies(ns,f.queue.status(ns,a).source);
  expect(await f.provider.edgeRetriever.query({...scope,botId:"b"},{text:"Bob",limit:20},signal())).toEqual([]);
 }finally{f.close();}
});
test("evidence beyond the 20-source output window is authorized and remains inspectable",async()=>{
 const f=fixture();try{
  const worker=new WikiCompiler(f.queue,fixtureModel(),120000,"v2");let last="";
  for(let i=0;i<22;i++){last=f.add(meeting,`evidence-${i}`);await worker.processJob(ns,last);}
  const hits=await f.provider.edgeRetriever.query(scope,{text:"Bob",limit:10},signal());
  expect(JSON.parse(hits[0].content).relation).toBe("rolled_back");expect(hits.every(h=>(h.sources?.length ?? 0)<=20 && Buffer.byteLength(h.content)<=16384)).toBe(true);
  expect(JSON.parse(hits[0].content).evidenceWindow.total).toBe(22);
  const browser=new V2Browser(f.provider.facts,[ns],parseQuery(new URL(`http://local/?view=history&edgeId=${hits[0].recordId.split(":")[1]}&evidenceStart=20`),"facts"),()=>true);
  const detail=await browser.list("evidence");expect(detail.edges[0].evidence).toHaveLength(2);expect(detail.edges[0].provenance).toHaveLength(2);expect(detail.edges[0].evidenceTotal).toBe(22);
  const forbidden=f.queue.status(ns,last).source,allowed=f.provider.facts.allowed.bind(f.provider.facts);
  f.provider.facts.allowed=async(namespace,source)=>source.id!==forbidden && await allowed(namespace,source);
  expect(await f.provider.edgeRetriever.query(scope,{text:"Bob",limit:10},signal())).toEqual([]);
 }finally{f.close();}
},30000);
