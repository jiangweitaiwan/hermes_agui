import { createServer } from "node:http";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { getRequestListener } from "@hono/node-server";
import { ControlStore } from "../../server/llm/control-store";
import { controlApi } from "../../server/llm/control-api";
import { BotAuthentication } from "../../server/bots/auth";
import { controlFixture } from "./llm-control";
import { mkdtemp,realpath,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresWikiStore } from "../../server/graph/postgres-wiki-store";
import { PostgresDocumentIngestor } from "../../server/graph/postgres-ingest-queue";
import { FilesystemGraphObjects } from "../../server/graph/objects";
import { RegistryLLM } from "../../server/llm/client";
import { WikiCompiler } from "../../server/graph/compiler";
import { fixtureModel,meeting } from "./graph-v2/model";

const source=process.env.AGUI_LLM_TEST_ADMIN_URL;
if(!source)throw new Error("BLOCKED: disposable PostgreSQL required for browser acceptance");
const admin=new Pool({connectionString:source,max:1});
const database=`llm_ui_${randomUUID().replaceAll("-","")}`;
await admin.query(`CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0`);
const url=new URL(source);url.pathname=`/${database}`;
execFileSync(process.execPath,["--import","tsx","server/storage/migrate-cli.ts"],{env:{...process.env,AGUI_RUNTIME_DATABASE_URL:url.href}});
const {llm,policy}=controlFixture();
policy.admins.push("prompt-browser-admin");
const store=new ControlStore(url.href,policy);
await store.bootstrap(llm,"browser-fixture",true);
const auth=new BotAuthentication([{ownerId:"prompt-owner",principal:"prompt-browser-admin",projectId:"project",token:"local-browser-prompt-only"},{ownerId:"owner",principal:"deployment-admin",projectId:"project",token:"local-browser-admin-only"},
  {ownerId:"member",principal:"ordinary-owner",projectId:"project",token:"local-browser-member-only"}]);
const handle=controlApi(store,auth,{token:async()=>"local-playground-fixture",transport:async()=>Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({subjects:[],narratives:[],stableAttributes:[]})}]}}]})});
const root=await realpath(await mkdtemp(join(tmpdir(),"llm-ui-objects-")));
const wiki=new PostgresWikiStore(url.href,new FilesystemGraphObjects(root));
const queue=new PostgresDocumentIngestor(wiki);queue.useReleases(store);await queue.ready();
async function syntheticJob(){
  const ns={principal:"browser-test",projectId:"test",botId:`bot-${randomUUID()}`,visibility:"bot_private" as const};
  const routes:string[]=[],prompts:string[]=[];
  const model=fixtureModel();
  const client=new RegistryLLM(llm,"graph_parser",{token:async()=>"scripted-local-only",transport:async(input,init)=>{
    routes.push(String(input));
    const body=JSON.parse(String(init?.body));prompts.push(body.systemInstruction.parts[0].text);const data=JSON.parse(body.contents[0].parts[0].text);
    const stage=data.candidates ? "v2-subject-disambiguation" : data.narratives?"v2-relations":"v2-parser";
    const output=stage==="v2-subject-disambiguation"?{decisions:data.subjects.map((s:{ref:string})=>({ref:s.ref,action:"create"}))}:await model.json(stage,data,AbortSignal.timeout(2000));
    return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(output)}]}}]});
  }},true);
  const id=await queue.enqueue(ns,{title:"Synthetic acceptance",mime:"text/plain",content:meeting,idempotencyKey:randomUUID()});
  await new WikiCompiler(queue,client,120000,"v2").processJob(ns,id);
  return {job:await queue.status(ns,id),release:(await queue.releaseForJob(await queue.status(ns,id)))!.release_id,routes,prompts};
}
const listener=getRequestListener(async request=>{
  if(new URL(request.url).pathname==="/api/bot-session")return auth.login(request,(await request.json()).token);
  if(new URL(request.url).pathname==="/api/testing/jobs"){
    if(!policy.admins.includes(auth.authenticate(request)?.principal??""))return new Response(null,{status:403});
    return Response.json(await syntheticJob());
  }
  return handle(request);
});
const vite=await createViteServer({configFile:false,root:process.cwd(),plugins:[react()],server:{middlewareMode:true},appType:"mpa"});
const server=createServer((req,res)=>{
  if(req.url?.startsWith("/api/")){void listener(req,res);return;}
  if(req.url==="/health"){res.writeHead(200).end("ok");return;}
  vite.middlewares(req,res);
});
server.listen(3041,"127.0.0.1");
async function close(){
  server.closeAllConnections();server.close();await vite.close();await wiki.close();await store.close();await rm(root,{recursive:true});
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);await admin.end();process.exit(0);
}
process.once("SIGTERM",()=>void close());process.once("SIGINT",()=>void close());
