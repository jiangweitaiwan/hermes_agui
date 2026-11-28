import { Pool } from "pg";
import { deploymentEpoch } from "../server/storage/epoch";
import {test,expect,vi} from "vitest";
import {createServer} from "node:http";
import {once} from "node:events";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {GoogleAuth} from "google-auth-library";
import {PostgresWikiStore} from "../server/graph/postgres-wiki-store";
import {PostgresDocumentIngestor} from "../server/graph/postgres-ingest-queue";
import {FilesystemGraphObjects} from "../server/graph/objects";
import {WikiCompiler,type CompilerLLM} from "../server/graph/compiler";
import {SessionIngestor} from "../server/graph/session-ingestor";
import {createCompletionApi} from "../server/graph/completion-api";
import {CloudTasksDelivery,TasksSchema} from "../server/graph/tasks";
import {workerHandler} from "../server/worker-http";
import {namespaceKey} from "../server/graph/wiki-store";
const source=process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
const python=process.env.AGUI_LLM_TEST_HOST_PYTHON;
const execute=promisify(execFile);

test.skipIf(!source||!python).each([false,true])("Host postcommit drives both task handlers without Scheduler; clean epoch=%s",async resetEpoch=>{
  const admin=new Pool({connectionString:source,max:1});
  const name=`chain_${randomUUID().replaceAll("-","")}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
  const target=new URL(source!);target.pathname=`/${name}`;const database=target.href;
  await execute(process.execPath,["--import","tsx","server/storage/migrate-cli.ts"],{env:{...process.env,AGUI_RUNTIME_DATABASE_URL:database}});
  const currentEpoch=resetEpoch?randomUUID():null;
  const root=await mkdtemp(join(tmpdir(),"event-chain-"));
  const store=new PostgresWikiStore(database!,new FilesystemGraphObjects(root));
  const queue=new PostgresDocumentIngestor(store);
  const ns={projectId:"project",principal:randomUUID(),botId:"bot",visibility:"bot_private" as const};
  const model:CompilerLLM={async json(stage,value:any){
    if(stage==="analysis")return {claims:[{text:value.text,quote:value.text,certainty:"fact",conflict:false}]};
    if(stage==="generation")return {pages:[{id:"database",title:"資料庫",type:"concept",tags:[],related:[],claims:[0]}]};
    return {claims:[0],conflict:false};
  }};
  process.env.EVENT_WORKER_TOKEN="worker-fixture-"+"c".repeat(32);
  const tasks=new CloudTasksDelivery(store.pool,TasksSchema.parse({project:"local-project",location:"asia-east1",queue:"graph",workerUrl:"https://worker.run.app",serviceAccount:"dispatch@local-project.iam.gserviceaccount.com",tokenEnv:"EVENT_WORKER_TOKEN"}));
  const compiler=new WikiCompiler(queue,model);
  const handleWorker=workerHandler({controller:new AbortController(),options:{provider:{}},processJob:async(id:string)=>{await compiler.processJob(ns,id);return queue.status(ns,id);}} as any,tasks,process.env.EVENT_WORKER_TOKEN);
  const cloud=vi.spyOn(GoogleAuth.prototype,"getClient").mockResolvedValue({request:async(value:any)=>{
    const task=value.data.task.httpRequest;
    const payload=JSON.parse(Buffer.from(task.body,"base64").toString());
    expect(payload.schema).toBe(resetEpoch?2:1);
    if(resetEpoch)expect(payload.epoch).toBe(currentEpoch);
    const response=await handleWorker(new Request(task.url,{method:"POST",headers:task.headers,body:Buffer.from(task.body,"base64")}));
    expect(response.status).toBe(200);return {};
  }} as any);
  const original=queue.enqueue.bind(queue);
  queue.enqueue=async(...args)=>{const id=await original(...args);await tasks.enqueue(id);return id;};
  const complete=createCompletionApi(new SessionIngestor(queue),"runtime-fixture-"+"a".repeat(32),()=>deploymentEpoch(store.pool));
  const server=createServer(async(req,res)=>{
    try{const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await complete(new Request("http://localhost/internal/graph/completions",{method:"POST",headers:{authorization:req.headers.authorization??"",...(req.headers["x-deployment-epoch"]?{"x-deployment-epoch":String(req.headers["x-deployment-epoch"])}:{})},body:Buffer.concat(chunks)}));
      res.writeHead(response.status).end();
    }catch(error){console.error(error);res.writeHead(503).end();}
  });
  try{
    await execute(python!,["-m","hermes_agui.storage.migrate"],{cwd:resolve("../.."),env:{...process.env,AGUI_HOST_DATABASE_URL:database}});
    if(currentEpoch) {
      await store.pool.query("UPDATE hermes_agui_runtime.deployment_epoch SET epoch=$1 WHERE singleton",[currentEpoch]);
      await store.pool.query("UPDATE hermes_agui_host.deployment_epoch SET epoch=$1 WHERE singleton",[currentEpoch]);
    }
    await store.ready();await queue.ready();
    server.listen(0,"127.0.0.1");await once(server,"listening");
    const port=(server.address() as any).port;
    const result=await execute(python!,["-m","tests.hermes_agui.completion_event_probe",JSON.stringify(ns),root,`http://127.0.0.1:${port}`],{cwd:resolve("../.."),timeout:30000,env:{...process.env,HERMES_AGUI_TEST_RUNTIME_DATABASE_URL:database}});
    expect(JSON.parse(result.stdout.trim())).toMatchObject({delivered:true,notifications:1,run:"completed"});
    const jobs=await store.browserJobs(namespaceKey(ns));
    expect(jobs).toHaveLength(1);expect(jobs[0].state).toBe("completed");
    expect((await queue.current(ns,"database"))?.page.id).toBe("database");
  }finally{cloud.mockRestore();delete process.env.EVENT_WORKER_TOKEN;await new Promise<void>(resolve=>server.close(()=>resolve()));await tasks.close();await store.close();await rm(root,{recursive:true,force:true});await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();}
},60000);
