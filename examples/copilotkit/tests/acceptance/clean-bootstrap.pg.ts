import { beforeAll, afterAll, expect, test } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { RESET_SCHEMAS, dependencyCheck, resetOwner, verifyIsolated, assertCleanGeneration } from "../../server/storage/clean-reset";
import { generate, checkSchema, type SchemaContract } from "../../server/storage/schema-contract";
import { readFile } from "node:fs/promises";
import { taskGeneration } from "../../server/storage/epoch";
import { provision, LEGACY_ROLES } from "../../server/storage/provision-clean";
const adminURL=process.env.AGUI_LLM_TEST_ADMIN_URL!;
if(!adminURL) throw new Error("Disposable local PostgreSQL required");
const admin=new Pool({connectionString:adminURL,max:1});
const name=`clean_${randomUUID().replaceAll("-","")}`;
let url:string,pool:Pool,scratch:string,contracts:SchemaContract[];
let tearingDown=false;
const python=process.env.AGUI_LLM_TEST_HOST_PYTHON!;
const root=resolve("../..");
const intent={operation:"123",epoch:randomUUID(),source:"a".repeat(40),project:"copilotkit-agui" as const,instance:"copilotkit-agui:asia-east1:fixture",database:"hermes" as const};
function migrate() {
  execFileSync(python,["-m","hermes_agui.storage.migrate"],{cwd:root,env:{...process.env,AGUI_HOST_DATABASE_URL:url,AGUI_APPLY_DATABASE_GRANTS:"true"},stdio:"pipe"});
  execFileSync(process.execPath,["--import","tsx","server/storage/migrate-cli.ts"],{env:{...process.env,AGUI_RUNTIME_DATABASE_URL:url},stdio:"pipe"});
}
beforeAll(async()=>{
  scratch=await mkdtemp(join(tmpdir(),"clean-pg-"));
  await generate(adminURL,root,join(scratch,"contract.json"));
  contracts=JSON.parse(await readFile(join(scratch,"contract.json"),"utf8")).contracts;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
  const parsed=new URL(adminURL);parsed.pathname=`/${name}`;url=parsed.href;
  pool=new Pool({connectionString:url,max:3});
  // PG may deliver the expected FORCE-drop notification while the final idle
  // socket is closing; never suppress errors while a test is using the pool.
  pool.on("error",error=>{if(!tearingDown || (error as {code?:string}).code!=="57P01")throw error;});
});
afterAll(async()=>{tearingDown=true;await pool?.end();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();await rm(scratch,{recursive:true,force:true});});

test("PG17 reset keeps database OID, roles, extensions and unrelated data; replays ledgers; same-operation replay cannot DROP",async()=>{
  migrate();
  const client=await pool.connect();
  try {
    const oid=(await client.query("SELECT oid FROM pg_database WHERE datname=current_database()")).rows;
    await client.query("CREATE SCHEMA sentinel; CREATE TABLE sentinel.keep(value text); INSERT INTO sentinel.keep VALUES('retained'); CREATE EXTENSION IF NOT EXISTS pgcrypto");
    const extensions=(await client.query("SELECT extname,oid FROM pg_extension ORDER BY extname")).rows;
    const roles=(await client.query("SELECT oid,rolname FROM pg_roles ORDER BY oid")).rows;
    // Unknown old migration and drift are discarded without asking the old schema validator.
    await client.query("CREATE TABLE hermes_agui_host.legacy_data(value text); INSERT INTO hermes_agui_host.legacy_data VALUES('old'); INSERT INTO hermes_agui_host_migrations.host VALUES('999_unknown.sql','drift')");
    await dependencyCheck(client);
    expect((await resetOwner(client,0,intent)).status).toBe("RESET_COMMITTED");
    expect((await resetOwner(client,1,intent)).status).toBe("RESET_COMMITTED");
    migrate();
    for(const contract of contracts) expect((await checkSchema(client,contract)).pending).toBe(0);
    expect((await client.query("SELECT oid FROM pg_database WHERE datname=current_database()")).rows).toEqual(oid);
    expect((await client.query("SELECT extname,oid FROM pg_extension ORDER BY extname")).rows).toEqual(extensions);
    expect((await client.query("SELECT oid,rolname FROM pg_roles ORDER BY oid")).rows).toEqual(roles);
    expect((await client.query("SELECT * FROM sentinel.keep")).rows).toEqual([{value:"retained"}]);
    expect((await client.query("SELECT to_regclass('hermes_agui_host.legacy_data') AS name")).rows[0].name).toBeNull();
    await client.query("CREATE TABLE hermes_agui_host.new_generation(value text); INSERT INTO hermes_agui_host.new_generation VALUES('new')");
    expect((await resetOwner(client,0,intent)).status).toBe("ALREADY_RESET");
    expect((await client.query("SELECT * FROM hermes_agui_host.new_generation")).rows).toEqual([{value:"new"}]);
    await expect(resetOwner(client,0,{...intent,epoch:randomUUID()})).rejects.toThrow("epoch mismatch");
    await client.query("DROP TABLE hermes_agui_host.new_generation");
  } finally{client.release();}
},60000);

test("outside dependent views block before any schema DROP",async()=>{
  const client=await pool.connect();
  try {
    await client.query("CREATE VIEW sentinel.foreign_dependency AS SELECT * FROM hermes_agui_host.runs");
    await expect(dependencyCheck(client)).rejects.toThrow("outside fixed schema");
    expect((await client.query("SELECT to_regclass('hermes_agui_host.runs') AS name")).rows[0].name).not.toBeNull();
    await client.query("DROP VIEW sentinel.foreign_dependency");
  }finally{client.release();}
});

test("old real login/session cannot write after isolation, new login inherits grants",async()=>{
  const client=await pool.connect();
  let writer:Pool|undefined;
  try {
    // Disposable cluster only: turn capability roles into old application logins.
    for(const role of LEGACY_ROLES) await client.query(`ALTER ROLE ${role} LOGIN`);
    const owner=(await client.query("SELECT current_user AS name")).rows[0].name;
    await provision(client,owner);
    for(const role of LEGACY_ROLES) await client.query(`ALTER ROLE ${role}_clean LOGIN`);
    const old=new URL(url);old.username="hermes_host";
    writer=new Pool({connectionString:old.href,max:1});writer.on("error",()=>{});
    await writer.query("SELECT 1");
    await expect(verifyIsolated(client,[...LEGACY_ROLES],LEGACY_ROLES.map(r=>r+"_clean"))).rejects.toThrow("not isolated");
    await expect(client.query("SELECT hermes_deployment.isolate_old_writers($1::text[])",[[]])).rejects.toThrow("Fixed legacy role inventory");
    await client.query("SELECT hermes_deployment.isolate_old_writers($1::text[])",[[...LEGACY_ROLES]]);
    await verifyIsolated(client,[...LEGACY_ROLES],LEGACY_ROLES.map(r=>r+"_clean"));
    await expect(writer.query("SELECT * FROM hermes_agui_host.runs")).rejects.toThrow();
    const next=new URL(url);next.username="hermes_host_clean";
    const fresh=new Pool({connectionString:next.href,max:1});
    try{expect((await fresh.query("SELECT count(*) FROM hermes_agui_host.runs")).rows).toHaveLength(1);}finally{await fresh.end();}
    // A restricted old application connection cannot invoke isolation or RESET.
    expect((await client.query("SELECT has_function_privilege('hermes_host_clean','hermes_deployment.isolate_old_writers(text[])','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
  }finally{await writer?.end();client.release();}
});

test("generation collisions never select current work, rolling retains legacy payloads",()=>{
  const id=randomUUID(),epoch=randomUUID();
  expect(taskGeneration({schema:1,jobId:id},null).status).toBe("current");
  expect(taskGeneration({schema:1,jobId:id},epoch).status).toBe("stale");
  expect(taskGeneration({schema:2,jobId:id,epoch:randomUUID()},epoch).status).toBe("stale");
  expect(taskGeneration({schema:2,jobId:id,epoch},epoch).status).toBe("current");
});

test("epoch-authenticated worker and evidence endpoints ignore stale tasks without touching a reused ID",async()=>{
  const { workerHandler }=await import("../../server/worker-http");
  const { CloudTasksDelivery,TasksSchema }=await import("../../server/graph/tasks");
  const { createCompletionApi }=await import("../../server/graph/completion-api");
  const { deploymentEpoch }=await import("../../server/storage/epoch");
  const { GcsGraphObjects }=await import("../../server/graph/objects");
  const { PostgresWikiStore }=await import("../../server/graph/postgres-wiki-store");
  const epoch=randomUUID(),jobId=randomUUID();
  await pool.query("UPDATE hermes_agui_runtime.deployment_epoch SET epoch=$1,operation='123' WHERE singleton",[epoch]);
  process.env.CLEAN_TEST_TOKEN="x".repeat(40);
  const tasks=new CloudTasksDelivery(pool,TasksSchema.parse({project:"fixture-project",location:"asia-east1",queue:"graph",workerUrl:"https://worker.run.app",serviceAccount:"worker@fixture-project.iam.gserviceaccount.com",tokenEnv:"CLEAN_TEST_TOKEN"}));
  let claims=0;
  const evolution={controller:new AbortController(),options:{provider:{}},processJob:async()=>{claims++;return {state:"completed"};}};
  const handle=workerHandler(evolution as any,tasks,process.env.CLEAN_TEST_TOKEN);
  const request=(body:unknown,token=process.env.CLEAN_TEST_TOKEN)=>handle(new Request("https://worker.run.app/internal/jobs/process",{method:"POST",headers:{"x-worker-token":token!},body:JSON.stringify(body)}));
  try {
    expect((await request({schema:1,jobId})).status).toBe(204);
    expect((await request({schema:2,jobId,epoch:randomUUID()})).status).toBe(204);
    expect(claims).toBe(0);
    expect((await request({schema:2,jobId,epoch},"wrong")).status).toBe(401);
    expect((await request({schema:2,jobId,epoch})).status).toBe(200);
    expect(claims).toBe(1);
    let ingests=0;
    const receive=createCompletionApi({authorized:()=>true,enqueue:async()=>{ingests++;}} as any,"e".repeat(40),()=>deploymentEpoch(pool));
    const evidence={namespace:{projectId:"p",principal:"u",botId:"b",visibility:"bot_private"},threadId:"t",runId:"r",messageId:"m",user:"hello",assistants:[{id:"final",text:"answer"}]};
    for(const old of [undefined,randomUUID()]) {
      const headers:Record<string,string>={authorization:"Bearer "+"e".repeat(40)};
      if(old) headers['x-deployment-epoch']=old;
      expect((await receive(new Request("https://runtime/internal/graph/completions",{method:"POST",headers,body:JSON.stringify(evidence)}))).status).toBe(204);
    }
    expect(ingests).toBe(0);
    expect((await receive(new Request("https://runtime/internal/graph/completions",{method:"POST",headers:{authorization:"Bearer "+"e".repeat(40),'x-deployment-epoch':epoch},body:JSON.stringify(evidence)}))).status).toBe(204);
    expect(ingests).toBe(1);
    const objects=new GcsGraphObjects("fixture-bucket");
    const store=new PostgresWikiStore(url,objects);
    try {await store.ready();expect(objects.prefix).toBe(`epochs/${epoch}/graph`);}finally{await store.close();}
  } finally {await tasks.close();delete process.env.CLEAN_TEST_TOKEN;}
});

test("an extension member inside an application schema blocks reset without deleting the extension",async()=>{
  const client=await pool.connect();
  try {
    await client.query("CREATE EXTENSION hstore SCHEMA hermes_agui_host");
    await expect(dependencyCheck(client)).rejects.toThrow();
    expect((await client.query("SELECT 1 FROM pg_extension WHERE extname='hstore'")).rowCount).toBe(1);
  }finally{await client.query("DROP EXTENSION IF EXISTS hstore");client.release();}
});

test("next rolling migrations preserve new Bot, Session and Graph records and generation",async()=>{
  await pool.query("INSERT INTO hermes_agui_host.bot_state(project,principal,bot) VALUES('new-project','new-user','new-bot')");
  await pool.query("INSERT INTO hermes_agui_runtime.bot_registry VALUES('new-bot','new-user','{\"id\":\"new-bot\"}')");
  await pool.query("INSERT INTO hermes_agui_runtime.thread_mappings(project,principal,bot,browser_thread,host_thread) VALUES('new-project','new-user','new-bot','browser-session','host-session')");
  const ns='a'.repeat(64),revision=randomUUID();
  await pool.query("INSERT INTO hermes_agui_runtime.graph_namespaces VALUES($1,$2)",[ns,{projectId:'new-project',principal:'new-user',botId:'new-bot',visibility:'bot_private'}]);
  await pool.query("INSERT INTO hermes_agui_runtime.graph_revisions VALUES($1,'page',$2,'new-epoch-object','123',$3,12)",[ns,revision,'b'.repeat(64)]);
  await pool.query("INSERT INTO hermes_agui_runtime.graph_pages VALUES($1,'page',$2)",[ns,revision]);
  const tables=['hermes_agui_host.bot_state','hermes_agui_runtime.bot_registry','hermes_agui_runtime.thread_mappings','hermes_agui_runtime.graph_pages','hermes_agui_runtime.deployment_epoch'];
  const before=[];
  for(const table of tables) before.push((await pool.query(`SELECT row_to_json(t) AS value FROM ${table} t`)).rows);
  migrate();
  const client=await pool.connect();
  try {for(const contract of contracts)expect((await checkSchema(client,contract)).pending).toBe(0);}finally{client.release();}
  for(const [index,table] of tables.entries())expect((await pool.query(`SELECT row_to_json(t) AS value FROM ${table} t`)).rows).toEqual(before[index]);
});


test("a second clean generation cannot reuse legacy-only credential isolation",async()=>{
  const host=await pool.connect(),runtime=await pool.connect();
  try {
    await expect(assertCleanGeneration([host,runtime],{...intent,operation:"999",epoch:randomUUID()})).rejects.toThrow("new reviewed identity-isolation provisioning");
    expect((await pool.query("SELECT 1 FROM hermes_agui_runtime.bot_registry WHERE id='new-bot'")).rowCount).toBe(1);
  }finally{host.release();runtime.release();}
});
