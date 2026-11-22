import {test,expect} from "vitest";
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WikiStore} from "../server/graph/wiki-store";
import {DocumentIngestor} from "../server/graph/ingest-queue";
import {WikiCompiler} from "../server/graph/compiler";
import {fixtureModel,meeting,profile} from "./fixtures/graph-v2/model";
import {stateText,stateModel} from "./fixtures/graph-v2/state-model";
import {WikiGraphProvider} from "../server/graph/provider";
import {QueryParser} from "../server/graph/query-parser";
import {StructuredRetriever} from "../server/graph/structured-retriever";
import {createGraphMemory} from "../server/graph-memory";
import {EdgeVectorIndex,edgeEmbeddingTextV3} from "../server/graph/edge-embedding";
import {resolveQueryTime,queryTemporalView} from "../server/graph/query-temporal-resolver";
import {pruneNet} from "../server/graph/net-builder";
import {parseSource} from "../server/graph/parser";
const ns={principal:"v3-test",projectId:"test",botId:"a",visibility:"bot_private" as const};
const identity={...ns,threadId:"query",runId:"query"};
const signal=()=>new AbortController().signal;
const artifact=(name:string,value:unknown)=>{const dir=process.env.GRAPH_V3_ARTIFACT_DIR;if(dir){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,name),JSON.stringify({mockLLM:true,result:value},null,2));}};
const defaultPlan={subjects:[{ref:"bob",name:"Bob"}],narratives:[{ref:"incident",text:"搜尋推薦服務延遲",subjectRefs:["bob"],intent:"explain_cause",time:{kind:"unspecified"}}],temporal:{kind:"history"}};
function fixture(plan:unknown=defaultPlan){
 const root=mkdtempSync(join(realpathSync(tmpdir()),"graph-v3-")),store=new WikiStore(root),queue=new DocumentIngestor(store),provider=new WikiGraphProvider(store,10000);
 const parser=new QueryParser({json:async()=>plan});provider.structured=new StructuredRetriever(provider.facts,provider.retriever,parser);
 let active=true;const memory=createGraphMemory({provider,authorize:()=>active,timeoutMs:10000}),scope=memory.scope(identity);
 const add=(content:string,key:string,instant="2026-11-03T08:00:00.000Z")=>queue.enqueue(ns,{title:key,content,mime:"text/plain",idempotencyKey:key},{provenance:{botId:"a",threadId:key,runId:key},classification:"user-stated",referenceTime:{instant,timezone:"Asia/Taipei"},evidence:{user:content,confirmed:false,assistants:[]}});
 return {store,queue,provider,parser,memory,scope,add,disable(){active=false;},close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
async function net(f:ReturnType<typeof fixture>,message="Bob 如何處理搜尋推薦服務延遲？"){
 const result=await f.memory.structuredQuery(f.scope,message);expect(result.status).toBe("ok");if(result.status!=="ok")throw new Error("Missing Net");return result.net;
}
test("A/B: real parser → compiler/publisher → split recall → authorized Net; no fabricated actor, key Wiki section, revoke and scope gate",async()=>{
 const f=fixture();try{
 const worker=new WikiCompiler(f.queue,fixtureModel(),120000,"v2");await worker.processJob(ns,f.add(profile,"profile"));const id=f.add(meeting,"incident");await worker.processJob(ns,id);
 const subjects=await f.queue.graphSubjects(ns);expect(subjects).toHaveLength(8);expect(new Set(subjects.map(s=>s.wikiPageId)).size).toBe(6);
 const result=await net(f);expect(result.edges).toHaveLength(5);expect(result.events).toHaveLength(1);
 expect(result.wikiSections.some(s=>s.text.includes("支援版本回滾"))).toBe(true);
 expect(result.wikiSections.some(s=>s.text.includes("TTL") || s.text.trim()==="- Bob")).toBe(false);
 expect(result.edges.every(e=>e.evidenceRefs.every(ref=>result.provenance.some(p=>p.ref===ref&&p.evidence?.quote)))).toBe(true);
 expect(result.edges.find(e=>e.relation==="drafted")?.fromSubjectId).not.toBe(result.subjects.find(s=>s.canonicalName==="Bob")?.subjectId);
 expect(new Set(result.wikiSections.map(s=>s.revision+":"+s.sectionKey)).size).toBe(result.wikiSections.length);
 const v2=await f.provider.query(f.scope,{text:"Bob 如何處理搜尋推薦服務延遲？",limit:20},signal());
 artifact("retrieval-comparison.json",{v2,netEdgeIds:result.edges.map(e=>e.edgeId),seedCount:result.edges.filter(e=>e.role==="seed").length,supportingCount:result.edges.filter(e=>e.role==="supporting").length,edgeRecall:result.edges.length/5,incidentPrecision:result.edges.filter(e=>e.eventId===result.events[0].eventId).length/result.edges.length,evidenceRecall:result.edges.filter(e=>e.evidenceRefs.length>0).length/5,netBytes:Buffer.byteLength(JSON.stringify(result))});
 const bounded=pruneNet(structuredClone(result),4096);expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(4096);expect(bounded.partial).toBe(true);expect([...bounded.edges,...bounded.wikiSections].every(e=>e.evidenceRefs.every(ref=>bounded.provenance.some(p=>p.ref===ref)))).toBe(true);
 artifact("query-a.json",await f.parser.parse("Bob 如何處理搜尋推薦服務延遲？",signal()));artifact("net-a.json",result);
 expect((await f.memory.structuredQuery({...f.scope},"Bob")).status).toBe("rejected");
 const other=f.memory.scope({...identity,botId:"b"});expect(await f.memory.structuredQuery(other,"Bob 搜尋推薦服務延遲 回滾")).toMatchObject({status:"ok",net:{edges:[],wikiSections:[]}});
 expect((await f.memory.validateNet(other,result)).status).toBe("rejected");
 f.queue.revoke(ns,f.queue.status(ns,id).source);
 const refreshed=await f.memory.validateNet(f.scope,result);expect(refreshed).toMatchObject({status:"ok",net:{edges:[]}});
 f.disable();expect((await f.memory.validateNet(f.scope,result)).status).toBe("rejected");
 }finally{f.close();}
});
test("D: subject only / narrative only / empty; F: independent events stay grouped",async()=>{
 for(const plan of [{...defaultPlan,narratives:[]},{...defaultPlan,subjects:[],narratives:[{...defaultPlan.narratives[0],subjectRefs:[]}]},{subjects:[],narratives:[],temporal:{kind:"unspecified"}}]){
 const f=fixture(plan);try{const worker=new WikiCompiler(f.queue,fixtureModel(),120000,"v2");await worker.processJob(ns,f.add(meeting,"one"));await worker.processJob(ns,f.add(meeting,"two","2026-11-13T08:00:00.000Z"));const result=await net(f);
 if(plan.subjects.length||plan.narratives.length){expect(result.edges).toHaveLength(10);expect(result.events).toHaveLength(2);expect(result.events.every(e=>e.edgeIds.length===5)).toBe(true);}else expect(result.edges).toEqual([]);
 }finally{f.close();}}
});
test("C/E: persisted states current/history/as-of; unresolved anchor stays uncertain, known anchor resolves in two passes",async()=>{
 const results:unknown[]=[];
 for(const temporal of [{kind:"current"},{kind:"history"},{kind:"as_of",originalText:"2026-11-06"},{kind:"before_event",anchorRef:"missing-event"}]){
 const plan={subjects:[{ref:"hub",name:"FeatureHub"}],narratives:[],temporal:temporal.kind==="before_event"?{kind:"unknown"}:temporal};
 const f=fixture(plan);try{await new WikiCompiler(f.queue,stateModel,120000,"v2").processJob(ns,f.add(stateText,"state"));const result=await net(f,"FeatureHub 2026-11-06");results.push(result);
 if(temporal.kind==="current")expect(result.edges.map(e=>e.description)).toEqual(["FeatureHub 目前部署 v2"]);
 if(temporal.kind==="history")expect(result.edges).toHaveLength(2);
 if(temporal.kind==="as_of")expect(result.edges.map(e=>e.description)).toEqual(["FeatureHub 目前部署 v1"]);
 if(temporal.kind==="before_event")expect(result.edges.every(e=>e.view==="uncertain")).toBe(true);
 }finally{f.close();}}
 artifact("temporal-c.json",results);
});
test("I: V3 vectors coexist, resume, mismatch/failure lexical fallback and revoke",async()=>{
 const f=fixture();try{const id=f.add(meeting,"one");await new WikiCompiler(f.queue,fixtureModel(),120000,"v2").processJob(ns,id);
 let fail=false;const encoder={model:"mock",version:"1",dimension:2,async embed(texts:string[]){if(fail)throw new Error("offline");return texts.map(()=>[1,0]);}};
 const v2=new EdgeVectorIndex(f.provider.facts,encoder),v3=new EdgeVectorIndex(f.provider.facts,encoder,"v3");
 await v2.update(ns,signal());expect(await v3.search(ns,"anything",signal())).toEqual([]);
 fail=true;await v3.update(ns,signal());f.provider.structured=new StructuredRetriever(f.provider.facts,f.provider.retriever,f.parser,v3);expect((await net(f)).edges).toHaveLength(5);
 fail=false;await v3.update(ns,signal());await v3.update(ns,signal());expect(v3.metrics.indexed).toBe(5);
 expect(await new EdgeVectorIndex(f.provider.facts,{...encoder,version:"2"},"v3").search(ns,"anything",signal())).toEqual([]);
 expect(await v3.search(ns,"anything",signal())).toHaveLength(5);
 const row=await f.provider.facts.read(ns,(await net(f)).edges[0].edgeId);expect(edgeEmbeddingTextV3(row!.edge,["Bob","FeatureHub"])).not.toContain(row!.edge.fromSubjectId);
 await v3.rebuild(ns);expect(await v2.search(ns,"anything",signal())).toHaveLength(5);
 artifact("vector-index-compat.json",{v2Key:v2.key,v3Key:v3.key,v3Metrics:v3.metrics});
 f.queue.revoke(ns,f.queue.status(ns,id).source);expect(await v2.search(ns,"anything",signal())).toEqual([]);
 }finally{f.close();}
});
test("G/J: custom relation labels publish evidence-backed JSON, invalid quote never publishes",async()=>{
 const f=fixture();try{
 const model=fixtureModel();const custom={async json(stage:string,data:any,abort:AbortSignal){const output:any=await model.json(stage,data,abort);if(stage==="v2-relations")output.edges=output.edges.map((e:any)=>({...e,relation:"related_to",relationType:"association",relationLabel:e.relation==="rolled_back"?"maintains":"responsible_for"}));return output;}};
 await new WikiCompiler(f.queue,custom,120000,"v2").processJob(ns,f.add(meeting,"custom"));const result=await net(f);expect(result.edges).toHaveLength(5);expect(result.edges.some(e=>e.relationLabel==="maintains")).toBe(true);expect(result.edges.every(e=>e.relation==="related_to"&&e.evidenceRefs.length)).toBe(true);artifact("relation-new.json",result.edges);
 const source={id:"00000000-0000-4000-8000-000000000001",version:1,content:meeting,hash:"a".repeat(64),title:"test"};
 await expect(parseSource({json:async(stage,data,abort)=>{const parsed:any=await model.json(stage,data,abort);parsed.subjects[0].quote="invented";return parsed;}},source as any,signal())).rejects.toThrow("Invalid source span");
 }finally{f.close();}
});

test("E: two-pass rollback anchor retrieves the prior state, unknown/tied events remain uncertain",async()=>{
 const plan={subjects:[{ref:"hub",name:"FeatureHub"},{ref:"bob",name:"Bob"}],narratives:[{ref:"anchor",text:"Bob 回滾",subjectRefs:["bob"],intent:"find_event",time:{kind:"unspecified"}},{ref:"state",text:"FeatureHub 版本",subjectRefs:["hub"],intent:"find_state",time:{kind:"before_event",anchorRef:"anchor"}}],temporal:{kind:"before_event",anchorRef:"anchor"}};
 const f=fixture(plan);try{
 const earlyStateModel={async json(stage:string,data:unknown,abort:AbortSignal){const output:any=await stateModel.json(stage,data,abort);if(stage==="v2-parser")output.narratives[0].timeText="11/01";return output;}};
 await new WikiCompiler(f.queue,earlyStateModel,120000,"v2").processJob(ns,f.add(stateText.replace("11/05","11/01"),"state"));
 await new WikiCompiler(f.queue,fixtureModel(),120000,"v2").processJob(ns,f.add(meeting,"rollback","2026-11-06T08:00:00.000Z"));
 const result=await net(f,"Bob 回滾之前 FeatureHub 版本");
 expect(result.temporal.confidence).toBe("certain");expect(result.edges.filter(e=>e.factKind==="state").map(e=>e.description)).toEqual(["FeatureHub 目前部署 v1"]);
 const anchor=result.query.narratives[0];expect(anchor.ref).toBe("anchor");
 const rows=await f.provider.facts.candidates(ns,[],[],"",65,true);const edges=[];for(const id of rows){const row=await f.provider.facts.read(ns,id);if(row)edges.push(row.edge);}
 expect(queryTemporalView(edges,{kind:"previous_event"}).every(r=>r.view==="uncertain")).toBe(true);
 const rollback=edges.find(e=>e.relation==="rolled_back")!;
 expect(resolveQueryTime({kind:"before_event"},undefined,[rollback]).confidence).toBe("certain");
 expect(resolveQueryTime({kind:"before_event"},undefined,[rollback,{...rollback,time:{timePrecision:"unknown",confidence:"uncertain"}}]).confidence).toBe("uncertain");
 }finally{f.close();}
});
test("H: revocation during shared namespace embedding removes previously assembled private claims",async()=>{
 const f=fixture();try{
 const worker=new WikiCompiler(f.queue,fixtureModel(),120000,"v2"),job=f.add(meeting,"incident");await worker.processJob(ns,job);
 const {SessionIngestor}=await import("../server/graph/session-ingestor");const shared={...ns,visibility:"project_shared" as const};
 await worker.processJob(shared,await new SessionIngestor(f.queue).share(ns,f.queue.status(ns,job).source));
 let calls=0;const vectors=new EdgeVectorIndex(f.provider.facts,{model:"mock",dimension:2,version:"1",async embed(texts:string[]){calls++;if(calls===2)f.queue.revokeCopies(ns,f.queue.status(ns,job).source);return texts.map(()=>[1,0]);}},"v3");
 f.provider.structured=new StructuredRetriever(f.provider.facts,f.provider.retriever,f.parser,vectors);
 const result=await net(f);expect(calls).toBe(2);expect(result.edges).toEqual([]);expect(result.provenance).toEqual([]);
 }finally{f.close();}
});
test("pure Wiki Net uses real section provenance; forged Net cannot pass revalidation",async()=>{
 const f=fixture({subjects:[{ref:"hub",name:"FeatureHub"}],narratives:[],temporal:{kind:"unspecified"}});try{
 await new WikiCompiler(f.queue,fixtureModel(),120000,"v2").processJob(ns,f.add(profile,"profile"));
 const result=await net(f,"FeatureHub");expect(result.edges).toEqual([]);expect(result.wikiSections.length).toBeGreaterThan(0);expect(result.wikiSections.every(s=>s.evidenceRefs.length>0)).toBe(true);
 expect((await f.memory.validateNet(f.scope,structuredClone(result))).status).toBe("rejected");
 f.provider.facts.retained=()=>false;expect(await f.memory.validateNet(f.scope,result)).toMatchObject({status:"ok",net:{subjects:[],wikiSections:[],provenance:[]}});
 }finally{f.close();}
});

test("F: two source-supported incidents ten calendar days apart retain distinct event/evidence boundaries",async()=>{
 const f=fixture();try{
 const model=fixtureModel();
 const datedModel={async json(stage:string,data:any,abort:AbortSignal){
   if(stage!=="v2-parser")return model.json(stage,data,abort);
   const actual:string=data.content,canonical=actual.replace("11/13","11/3");
   const output:any=await model.json(stage,{...data,content:canonical},abort);
   for(const item of [...output.subjects,...output.narratives,...output.stableAttributes]){
     item.quote=item.quote.replace("11/3","11/13");item.position=actual.indexOf(item.quote);
     if(item.text)item.text=item.text.replace("11/3","11/13");
     if(item.timeText==="11/3")item.timeText="11/13";
   }
   return output;
 }};
 await new WikiCompiler(f.queue,model,120000,"v2").processJob(ns,f.add(meeting,"first"));
 await new WikiCompiler(f.queue,datedModel,120000,"v2").processJob(ns,f.add(meeting.replace("11/3","11/13"),"second","2026-11-13T08:00:00.000Z"));
 const result=await net(f);expect(result.events).toHaveLength(2);expect(result.edges).toHaveLength(10);
 const rollbacks=result.edges.filter(e=>e.relation==="rolled_back");expect(rollbacks).toHaveLength(2);
 expect(Math.abs(Date.parse(rollbacks[0].time.occurredFrom!)-Date.parse(rollbacks[1].time.occurredFrom!))).toBe(10*86400000);
 expect(new Set(rollbacks.map(e=>e.eventId)).size).toBe(2);
 }finally{f.close();}
});
