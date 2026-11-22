import {test,expect} from "vitest";
import {createServer} from "node:http";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadWiki} from "../server/graph/provider";
import {createGraphMemory} from "../server/graph-memory";
import {WikiStore} from "../server/graph/wiki-store";
import {DocumentIngestor} from "../server/graph/ingest-queue";
import {WikiCompiler} from "../server/graph/compiler";
import {fixtureModel,meeting} from "./fixtures/graph-v2/model";
test("registry provider defaults V2; explicit V3 model uses real HTTP adapter and trusted scope gate",async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),"graph-v3-config-"));
 const ns={principal:"config-test",botId:"a",projectId:"test",visibility:"bot_private" as const};
 const key="GRAPH_V3_FIXTURE_KEY";process.env[key]="mock-only-key";let requestedModel="";
 const server=createServer(async(req,res)=>{let body="";for await(const chunk of req)body+=chunk;requestedModel=JSON.parse(body).model;
 res.setHeader("Content-Type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({subjects:[{ref:"bob",name:"Bob"}],narratives:[],temporal:{kind:"history"}})}}]}));});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 let provider:ReturnType<typeof loadWiki>;
 try{
 const store=new WikiStore(root),queue=new DocumentIngestor(store);
 try{const id=queue.enqueue(ns,{title:"incident",content:meeting,mime:"text/plain",idempotencyKey:"incident"},{provenance:{botId:"a",threadId:"m",runId:"m"},classification:"user-stated",referenceTime:{instant:"2026-11-03T08:00:00.000Z",timezone:"Asia/Taipei"},evidence:{user:meeting,confirmed:false,assistants:[]}});await new WikiCompiler(queue,fixtureModel(),120000,"v2").processJob(ns,id);}finally{store.close();}
 provider=loadWiki({enabled:true,dataRoot:root});const v2=createGraphMemory({provider,authorize:()=>true});
 expect(await v2.structuredQuery(v2.scope({...ns,threadId:"q",runId:"q"}),"Bob")).toEqual({status:"disabled"});provider?.close();
 expect(()=>loadWiki({enabled:true,dataRoot:root,retrievalMode:"bad" as any})).toThrow();
 const address=server.address();if(!address||typeof address==="string")throw new Error("Missing fixture port");
 provider=loadWiki({enabled:true,dataRoot:root,retrievalMode:"v3",timeoutMs:10000,queryParser:{baseUrl:`http://127.0.0.1:${address.port}`,model:"deterministic-query-model",keyEnv:key,timeoutMs:2000,maxTokens:2048}});
 const memory=createGraphMemory({provider,authorize:()=>true,timeoutMs:10000});const scope=memory.scope({...ns,threadId:"q",runId:"q"});
 const result=await memory.structuredQuery(scope,"Bob");expect(result).toMatchObject({status:"ok"});if(result.status==="ok")expect(result.net.edges).toHaveLength(5);
 expect(requestedModel).toBe("deterministic-query-model");
 }finally{provider?.close();delete process.env[key];await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));rmSync(root,{recursive:true,force:true});}
});
