/** Real Application/API/SQLite, with the explicitly mocked Part 1 fixture models; no Python Host needed for read-only browsing. */
import {createServer} from "node:http";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createCopilotNodeHandler} from "@copilotkit/runtime/v2/node";
import {createServer as createVite} from "vite";
import {createApplication} from "../../server/application";
import {WikiStore} from "../../server/graph/wiki-store";
import {WikiGraphProvider} from "../../server/graph/provider";
import {DocumentIngestor} from "../../server/graph/ingest-queue";
import {WikiCompiler} from "../../server/graph/compiler";
import {meeting,fixtureModel} from "./graph-v2/model";
import {stateText,stateModel} from "./graph-v2/state-model";
const root=mkdtempSync(join(realpathSync(tmpdir()),"graph-v2-ui-")),store=new WikiStore(join(root,"wiki")),provider=new WikiGraphProvider(store,10000);
const ns={principal:"owner",projectId:"project",botId:"a",visibility:"bot_private" as const};
const app=createApplication({a:{agentUrl:"http://127.0.0.1:18765/agent",token:"fixture",memory:{key:"fixture-runtime-signing-key",principal:"owner",projectId:"project"}}},
 {graph:{provider,authorize:()=>true},evolution:{provider,compiler:fixtureModel(),graphCompilerVersion:"v2",pollMs:60000},evolutionTimer:false,management:{registryPath:join(root,"bots.sqlite"),hostUrl:"http://127.0.0.1:18765",hostToken:"fixture",
 users:[{ownerId:"owner",principal:"owner",projectId:"project",token:"owner-secret"}],templates:[{id:"native",name:"Native",harness:"hermes",model:"mock",provider:"mock",skills:[],toolsets:[]}]}});
await app.ready;
const queue=new DocumentIngestor(store);
for(const [key,content,model] of [["meeting",meeting,fixtureModel()],["state",stateText,stateModel]] as const){
 const id=queue.enqueue(ns,{title:key,content,mime:"text/plain",idempotencyKey:key},{provenance:{botId:"a",threadId:key,runId:key},classification:"user-stated",referenceTime:{instant:"2026-11-03T08:00:00.000Z",timezone:"Asia/Taipei"},evidence:{user:content,confirmed:false,assistants:[]}});
 await new WikiCompiler(queue,model,120000,"v2").processJob(ns,id);
}
const vite=await createVite({server:{middlewareMode:true},appType:"spa"});
const handler=createCopilotNodeHandler(async req=>{
 const path=new URL(req.url).pathname;
 if(path.startsWith("/api/graph/"))return app.graphApi(req);
 if(path.startsWith("/api/copilotkit"))return app.runtime(req);
 return app.management!.api(req);
});
const server=createServer((req,res)=>{if(/^\/api\/(graph\/|bots(?:[/?]|$)|bot-session(?:[/?]|$)|copilotkit(?:[/?]|$))/.test(req.url ?? ""))void handler(req,res);else vite.middlewares(req,res);});
server.listen(3039,"127.0.0.1");
process.once("SIGTERM",()=>{server.closeAllConnections();server.close();void app.close().then(()=>{store.close();rmSync(root,{recursive:true,force:true});return vite.close();}).then(()=>process.exit(0));});
