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
const database=process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
const python=process.env.AGUI_LLM_TEST_HOST_PYTHON;
const execute=promisify(execFile);

test.skipIf(!database||!python)("Host postcommit drives both task handlers to one Graph publication without Scheduler",async()=>{
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
    const response=await handleWorker(new Request(task.url,{method:"POST",headers:task.headers,body:Buffer.from(task.body,"base64")}));
    expect(response.status).toBe(200);return {};
  }} as any);
  const original=queue.enqueue.bind(queue);
  queue.enqueue=async(...args)=>{const id=await original(...args);await tasks.enqueue(id);return id;};
  const complete=createCompletionApi(new SessionIngestor(queue),"runtime-fixture-"+"a".repeat(32));
  const server=createServer(async(req,res)=>{
    try{const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await complete(new Request("http://localhost/internal/graph/completions",{method:"POST",headers:{authorization:req.headers.authorization??""},body:Buffer.concat(chunks)}));
      res.writeHead(response.status).end();
    }catch(error){console.error(error);res.writeHead(503).end();}
  });
  try{
    await store.ready();await queue.ready();
    await execute(python!,["-m","hermes_agui.storage.migrate"],{cwd:resolve("../.."),env:{...process.env,AGUI_HOST_DATABASE_URL:database}});
    server.listen(0,"127.0.0.1");await once(server,"listening");
    const port=(server.address() as any).port;
    const result=await execute(python!,["-m","tests.hermes_agui.completion_event_probe",JSON.stringify(ns),root,`http://127.0.0.1:${port}`],{cwd:resolve("../.."),timeout:30000,env:process.env});
    expect(JSON.parse(result.stdout.trim())).toMatchObject({delivered:true,notifications:1,run:"completed"});
    const jobs=await store.browserJobs(namespaceKey(ns));
    expect(jobs).toHaveLength(1);expect(jobs[0].state).toBe("completed");
    expect((await queue.current(ns,"database"))?.page.id).toBe("database");
  }finally{cloud.mockRestore();delete process.env.EVENT_WORKER_TOKEN;await new Promise<void>(resolve=>server.close(()=>resolve()));await tasks.close();await store.close();await rm(root,{recursive:true,force:true});}
},60000);
