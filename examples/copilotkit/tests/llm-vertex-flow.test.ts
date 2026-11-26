import {parseSource} from "../server/graph/parser";
import {resolveSubjects} from "../server/graph/subject-matcher";
import {spawnSync} from "node:child_process";
import {test,expect} from "vitest";
import {createServer} from "node:http";
import {mkdtempSync,realpathSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {ModelRegistry} from "../server/llm/config";
import {RegistryLLM,embeddingClient} from "../server/llm/client";
import {namespaceKey,WikiStore} from "../server/graph/wiki-store";
import {DocumentIngestor} from "../server/graph/ingest-queue";
import {SessionIngestor} from "../server/graph/session-ingestor";
import {WikiCompiler} from "../server/graph/compiler";
import {QueryParser} from "../server/graph/query-parser";
import {WikiGraphProvider} from "../server/graph/provider";
import {StructuredRetriever} from "../server/graph/structured-retriever";
import {VectorIndex} from "../server/graph/embedding";
import {EdgeVectorIndex} from "../server/graph/edge-embedding";
import {Storyteller} from "../server/memory/storyteller";
import {fixtureModel,meeting} from "./fixtures/graph-v2/model";
const config=()=>({version:1,providers:[{id:"google",driver:"vertex",project:"hermes-test",location:"us-central1",auth:"adc",capabilities:["chat","structured_output","embedding"]}],models:["graph_parser","graph_matcher","graph_relations","graph_query","graph_story","graph_embedding"].map(alias=>({alias,provider:"google",model:alias==="graph_embedding"?"gemini-embedding-001":"gemini-2.5-flash",timeoutMs:2000,retries:0,maxTokens:4096,fallback:[],...(alias==="graph_embedding"?{dimension:3,version:"v1"}:{})}))});
test("Vertex mock HTTP → session ingest → real worker/evidence persistence → isolated embedding → query/story + outage fallbacks",async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),"vertex-flow-")),store=new WikiStore(root),queue=new DocumentIngestor(store);
 const ns={principal:"owner",projectId:"test",botId:"assistant",visibility:"bot_private" as const};
 const calls:string[]=[];let outage=false;const model=fixtureModel();
 const server=createServer(async(req,res)=>{
  try{
   let text="";for await(const part of req)text+=part;
   expect(req.headers.authorization).toBe("Bearer fixture-token");
   if(outage){res.writeHead(503);res.end("unavailable");return;}
   const body=JSON.parse(text);res.setHeader("Content-Type","application/json");
   if(req.url?.endsWith(":predict")){calls.push("embedding");res.end(JSON.stringify({predictions:[{embeddings:{values:[1,2,3],statistics:{truncated:false}}}]}));return;}
   const stage=body.systemInstruction.parts[0].text.split("\n").at(-1),data=JSON.parse(body.contents[0].parts[0].text);calls.push(stage);
   const output=stage==="v2-subject-disambiguation"?{decisions:[{ref:"alice",action:"create"}]}:stage==="v3-query"?{subjects:[{ref:"bob",name:"Bob"}],narratives:[],temporal:{kind:"history"}}:stage==="v3-story"?data.candidate:await model.json(stage,data,AbortSignal.timeout(2000));
   expect(body.generationConfig.responseJsonSchema.type).toBe("object");
   res.end(JSON.stringify({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(output)}]}}]}));
  }catch{res.writeHead(500);res.end();}
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const port=(server.address() as {port:number}).port;
 const deps={token:async()=>"fixture-token",transport:((url:any,init:any)=>fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`,init)) as typeof fetch};
 try{
  const native=spawnSync(process.env.HERMES_PYTHON ?? resolve("../../.venv/bin/python"),["tests/fixtures/llm-native-session.py"],{input:JSON.stringify({user:`研究會議：${meeting}`}),encoding:"utf8",timeout:60000});
  expect(native.status,native.stderr).toBe(0);const completion=JSON.parse(native.stdout);expect(completion.nativeSessionId).toBeTruthy();
  const id=await new SessionIngestor(queue).enqueue({namespace:ns,threadId:"one",runId:"one",messageId:"m",user:completion.user,assistants:[{id:"reply",text:completion.text}],referenceTime:{instant:"2026-11-03T08:00:00.000Z",timezone:"Asia/Taipei"}});
  expect(id).toBeTruthy();await new WikiCompiler(queue,new RegistryLLM(config(),"graph_parser",deps),120000,"v2").processJob(ns,id!);
  expect(queue.status(ns,id!).state).toBe("completed");expect(await queue.graphSubjects(ns)).toHaveLength(7);
  const parsed=await parseSource(model,queue.source(queue.status(ns,id!)),AbortSignal.timeout(5000));
  const alice=(await queue.graphSubjects(ns)).find(s=>s.canonicalName==="Alice")!;
  const ambiguous={...alice,subjectId:"other-alice",identityKey:"person:another alice"};
  const matches=await resolveSubjects(parsed,[ambiguous],new RegistryLLM(config(),"graph_parser",deps),AbortSignal.timeout(5000));
  expect(matches.find(m=>m.ref==="alice")?.subject?.subjectId).not.toBe(ambiguous.subjectId);
  const encoder=embeddingClient({registry:config(),role:"graph_embedding"},deps),wiki=new VectorIndex(store,encoder),provider=new WikiGraphProvider(store,5000,{vectors:wiki});
  const oldEncoder={model:encoder.model,dimension:encoder.dimension,version:encoder.version,embed:encoder.embed.bind(encoder)};
  const old=new VectorIndex(store,oldEncoder);await old.update(ns,AbortSignal.timeout(5000));
  const edge=new EdgeVectorIndex(provider.facts,encoder,"v3");await wiki.update(ns,AbortSignal.timeout(5000));await edge.update(ns,AbortSignal.timeout(5000));expect(wiki.metrics.indexed).toBeGreaterThan(0);expect(edge.metrics.indexed).toBe(5);
  expect(old.key).not.toBe(wiki.key);
  expect(await old.search([namespaceKey(ns)],"Bob",AbortSignal.timeout(5000))).not.toHaveLength(0);
  expect(store.db.prepare("SELECT DISTINCT model FROM embeddings").all()).toHaveLength(2);
  const parser=new QueryParser(new RegistryLLM(config(),"graph_query",deps));const plan=await parser.parse("Bob",AbortSignal.timeout(5000));expect(plan.status).toBe("ok");
  const retriever=new StructuredRetriever(provider.facts,provider.retriever,parser,edge);
  const scope={...ns,threadId:"other",runId:"query"};
  const result=await retriever.query(scope,"Bob",AbortSignal.timeout(5000));expect(result.status).toBe("ok");if(result.status!=="ok")throw Error("Missing net");
  expect(result.net.edges).toHaveLength(5);expect(result.net.provenance.every(p=>!!p.ref)).toBe(true);
  const teller=new Storyteller(new RegistryLLM(config(),"graph_story",deps));expect((await teller.tell(result.net,AbortSignal.timeout(5000))).status).toBe("model");
  outage=true;expect((await parser.parse("Bob",AbortSignal.timeout(5000))).status).toBe("fallback");expect((await teller.tell(result.net,AbortSignal.timeout(5000))).status).toBe("deterministic");expect(await wiki.search([],"Bob",AbortSignal.timeout(5000))).toEqual([]);
  const lexical=await provider.query(scope,{text:"Bob",limit:10},AbortSignal.timeout(5000));expect(lexical.status).toBe("ok");if(lexical.status==="ok")expect(lexical.hits.length).toBeGreaterThan(0);
  expect(calls).toEqual(expect.arrayContaining(["v2-parser","v2-subject-disambiguation","v2-relations","v3-query","v3-story","embedding"]));
 }finally{store.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
},90000);
const live=process.env.AGUI_VERTEX_SMOKE_CONFIG;
test.skipIf(!live)("LIVE Vertex ADC smoke (explicit config file required; incurs model usage)",async()=>{
 const config=JSON.parse(readFileSync(live!,"utf8"));new ModelRegistry(config);
 const client=new RegistryLLM(config,"graph_query");expect(await client.json("v3-query",{message:"Bob",rule:"Extract retrieval subjects; return subjects/narratives/temporal."},AbortSignal.timeout(30000))).toHaveProperty("subjects");
 const encoder=embeddingClient({registry:config,role:"graph_embedding"});expect((await encoder.embed(["快取回滾"],AbortSignal.timeout(30000)))[0]).toHaveLength(encoder.dimension);
},60000);
