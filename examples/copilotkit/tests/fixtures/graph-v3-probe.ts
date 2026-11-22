/** Actual session ingest → new thread → signed AG-UI → native Hermes provider request. */
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApplication} from "../../server/application";
import {WikiStore} from "../../server/graph/wiki-store";
import {DocumentIngestor} from "../../server/graph/ingest-queue";
import {WikiCompiler} from "../../server/graph/compiler";
import {WikiGraphProvider} from "../../server/graph/provider";
import {QueryParser} from "../../server/graph/query-parser";
import {StructuredRetriever} from "../../server/graph/structured-retriever";
import {Storyteller} from "../../server/memory/storyteller";
import {meeting,profile,fixtureModel} from "./graph-v2/model";
const root=mkdtempSync(join(realpathSync(tmpdir()),"v3-native-")),store=new WikiStore(root),queue=new DocumentIngestor(store);
const ns={principal:"local-owner",projectId:"alpha",botId:"hermes",visibility:"bot_private" as const};
const worker=new WikiCompiler(queue,fixtureModel(),120000,"v2");
for(const [key,content] of [["profile",profile],["incident",meeting]]){
 const job=queue.enqueue(ns,{title:key,mime:"text/plain",content,idempotencyKey:key},{provenance:{botId:"hermes",threadId:"source-thread-a",runId:key},classification:"user-stated",referenceTime:{instant:"2026-11-03T08:00:00.000Z",timezone:"Asia/Taipei"},evidence:{user:content,confirmed:false,assistants:[]}});
 await worker.processJob(ns,job);
}
const provider=new WikiGraphProvider(store,10000);
provider.structured=new StructuredRetriever(provider.facts,provider.retriever,new QueryParser({json:async()=>({subjects:[{ref:"bob",name:"Bob"}],narratives:[{ref:"incident",text:"搜尋推薦服務延遲",subjectRefs:["bob"],intent:"explain_cause",time:{kind:"unspecified"}}],temporal:{kind:"history"}})}));
let calls=0;
provider.storyteller=new Storyteller({json:async(_stage,input:any)=>{calls++;return input.candidate;}});
const application=createApplication({hermes:{agentUrl:process.argv[2],token:"runtime-test-token",memory:{key:"runtime-only-key",principal:ns.principal,projectId:ns.projectId}}},{graph:{provider,authorize:()=>true}});
try{
 const response=await application.runtime(new Request("http://localhost/api/copilotkit/agent/hermes/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({threadId:"new-thread-b",runId:"story-run",messages:[{id:"question",role:"user",content:"Bob 如何處理搜尋推薦服務延遲？"}],tools:[],context:[],state:{},forwardedProps:{}})}));
 const output=await response.text();
 if(response.status!==200||!output.includes("RUN_FINISHED")||calls!==1)throw new Error("V3 native bridge acceptance failed");
 console.log(JSON.stringify({mockLLM:true,sourceThread:"source-thread-a",queryThread:"new-thread-b",storyCalls:calls,runFinished:true}));
}finally{await application.close();store.close();rmSync(root,{recursive:true,force:true});}
