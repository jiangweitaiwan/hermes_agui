import { createServer } from "node:http";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { getRequestListener } from "@hono/node-server";
import { ControlStore } from "../../server/llm/control-store";
import { controlApi } from "../../server/llm/control-api";
import { BotAuthentication } from "../../server/bots/auth";
import { controlFixture } from "./llm-control";
import { mkdtemp,realpath,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresWikiStore } from "../../server/graph/postgres-wiki-store";
import { PostgresDocumentIngestor } from "../../server/graph/postgres-ingest-queue";
import { FilesystemGraphObjects } from "../../server/graph/objects";
import { RegistryLLM } from "../../server/llm/client";
import { WikiCompiler } from "../../server/graph/compiler";
import { fixtureModel,meeting } from "./graph-v2/model";

process.env.COPILOTKIT_TELEMETRY_DISABLED="true";
process.env.DO_NOT_TRACK="1";
const source=process.env.AGUI_LLM_TEST_ADMIN_URL;
if(!source)throw new Error("BLOCKED: disposable PostgreSQL required for browser acceptance");
const admin=new Pool({connectionString:source,max:1});
const database=`llm_ui_${randomUUID().replaceAll("-","")}`;
await admin.query(`CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0`);
const url=new URL(source);url.pathname=`/${database}`;
execFileSync(process.execPath,["--import","tsx","server/storage/migrate-cli.ts"],{env:{...process.env,AGUI_RUNTIME_DATABASE_URL:url.href}});
const {llm,policy}=controlFixture();
policy.admins.push("prompt-browser-admin","native-browser-admin");
const store=new ControlStore(url.href,policy);
// A native Bot predating managed activation; no role migration rows are created.
await store.pool.query(`INSERT INTO hermes_agui_runtime.bot_registry(id,principal,record) VALUES('existing-native','native-browser-admin',$1)`,
  [{id:"existing-native",name:"Existing Native",description:"Static-era native persona",harness:"hermes",templateId:"native",
    model:"legacy-unapproved-model",provider:"legacy-provider",ownerId:"native-owner",projectId:"project",status:"active",
    skills:[],toolsets:["todo"],delegationTargets:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]);
process.env.AGUI_LLM_DATABASE_URL=url.href;
process.env.AGUI_LLM_ADMIN_DATABASE_URL=url.href;
const {openControl}=await import("../../server/llm/control-bootstrap");
const runtimeControl=await openControl(policy,llm);
await runtimeControl.releases!.close();await runtimeControl.adminStore!.close();
let auth=new BotAuthentication([{ownerId:"prompt-owner",principal:"prompt-browser-admin",projectId:"project",token:"local-browser-prompt-only"},{ownerId:"owner",principal:"deployment-admin",projectId:"project",token:"local-browser-admin-only"},
  {ownerId:"member",principal:"ordinary-owner",projectId:"project",token:"local-browser-member-only"}]);
const root=await realpath(await mkdtemp(join(tmpdir(),"llm-ui-objects-")));
const {createApplication}=await import("../../server/application");
const {managedRunPreparation}=await import("../../server/llm/run-pinning");
const {PostgresThreadMappings}=await import("../../server/storage/thread-mappings");
const {taskFingerprint}=await import("../../server/llm/config");
const hostConfig=join(root,"host.json");
await writeFile(hostConfig,JSON.stringify({root,llm,hostPolicy:{mode:"managed",approved:policy.approved,taskFingerprint:taskFingerprint()}}));
const host=spawn(process.env.AGUI_LLM_TEST_HOST_PYTHON ?? "../../.venv/bin/python",["tests/fixtures/llm-managed-host.py",hostConfig],
  {env:{...process.env,AGUI_BOT_CREDENTIAL_SEED:"93".repeat(32),HERMES_HOME:join(root,"isolated-home")},stdio:["ignore","ignore","inherit"]});
process.once("exit",()=>{host.kill("SIGTERM");});
let hostReady=false;
for(let attempt=0;attempt<100;attempt++){
  if(host.exitCode!==null)throw new Error("Managed native Host fixture exited");
  try{hostReady=(await fetch("http://127.0.0.1:3042/health")).ok;}catch{}
  if(hostReady)break;
  await new Promise(resolve=>setTimeout(resolve,100));
}
if(!hostReady)throw new Error("Managed native Host readiness timed out (10 seconds)");
const threads=new PostgresThreadMappings(url.href);await threads.ready(false);
const application=createApplication({}, {managedRun:managedRunPreparation(store),evolutionTimer:false,threadMappings:threads,
  management:{postgres:{url:url.href,credentialSeed:"93".repeat(32)},hostUrl:"http://127.0.0.1:3042",hostToken:"fixture-manager",
    users:[{ownerId:"native-owner",principal:"native-browser-admin",projectId:"project",token:"local-browser-native-only"},{ownerId:"owner",principal:"deployment-admin",projectId:"project",token:"local-browser-admin-only"},{ownerId:"prompt-owner",principal:"prompt-browser-admin",projectId:"project",token:"local-browser-prompt-only"},{ownerId:"member",principal:"ordinary-owner",projectId:"project",token:"local-browser-member-only"}],
    templates:[{id:"native",name:"Native",harness:"hermes",model:"legacy-ignored",provider:"legacy",llmManaged:true,skills:[],toolsets:["todo"]}]}});
await application.ready;
auth=application.management!.auth;
const handle=controlApi(store,auth,{token:async()=>"local-playground-fixture",transport:async()=>Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({subjects:[],narratives:[],stableAttributes:[]})}]}}]})});
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
  const path=new URL(request.url).pathname;
  if(path.startsWith("/api/copilotkit"))return application.runtime(request);
  if(path==="/api/bots" || path.startsWith("/api/bots/"))return application.management!.api(request);
  if(path==="/api/testing/native-requests")return Response.json(await (await fetch("http://127.0.0.1:3042/__test/requests")).json());
  if(path==="/api/testing/opt-in-count")return Response.json((await store.pool.query("SELECT count(*)::int n FROM hermes_agui_runtime.llm_bot_roles")).rows[0]);
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
  server.closeAllConnections();server.close();await application.close();await threads.close();host.kill("SIGTERM");await new Promise(resolve=>host.once("close",resolve));await vite.close();await wiki.close();await store.close();await rm(root,{recursive:true});
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);await admin.end();process.exit(0);
}
process.once("SIGTERM",()=>void close());process.once("SIGINT",()=>void close());
