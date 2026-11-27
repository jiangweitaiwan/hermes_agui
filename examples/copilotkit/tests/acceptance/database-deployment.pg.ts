import { afterAll, beforeAll, expect, test } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { controlFixture } from "../fixtures/llm-control";
import { candidate, hash, taskManifest, verifySnapshot } from "../../server/llm/control-contract";
import { ControlStore } from "../../server/llm/control-store";
import { upgradeRelease } from "../../server/llm/control-upgrade";
import { deployment } from "../../server/storage/deployment-cli";
import { generate, migrationSQL, checkSchema, type SchemaContract } from "../../server/storage/schema-contract";

const source=process.env.AGUI_LLM_TEST_ADMIN_URL;
if(!source) throw new Error("Disposable PostgreSQL required");
const admin=new Pool({connectionString:source,max:1});
const root=resolve("../.."), databases:string[]=[];
const {llm,policy}=controlFixture();
let scratch:string, contractPath:string, contracts:SchemaContract[];
const python=process.env.AGUI_LLM_TEST_HOST_PYTHON??resolve("../../work/test-env/bin/python");
async function database() {
  const name=`deploy_${randomUUID().replaceAll("-","")}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);databases.push(name);
  const url=new URL(source!);url.pathname=`/${name}`;
  return url.href;
}
function hostMigrate(url:string,grants=false) {
  return execFileSync(python,["-m","hermes_agui.storage.migrate"],{cwd:root,env:{...process.env,AGUI_HOST_DATABASE_URL:url,...(grants?{AGUI_APPLY_DATABASE_GRANTS:"true"}:{})},encoding:"utf8"});
}
function runtimeMigrate(url:string) {
  return execFileSync(process.execPath,["--import","tsx","server/storage/migrate-cli.ts"],{env:{...process.env,AGUI_RUNTIME_DATABASE_URL:url},encoding:"utf8"});
}
async function schemaStatus(url:string,index:number) {
  const pool=new Pool({connectionString:url,max:1}),client=await pool.connect();
  try{return await checkSchema(client,contracts[index]);}finally{client.release();await pool.end();}
}
async function fenced(url:string) {
  const store=new ControlStore(url,policy);
  await store.pool.query("UPDATE hermes_agui_runtime.deployment_fence SET closed=true,jobs_closed=true");
  return store;
}
async function fingerprintState(store:ControlStore) {
  return (await store.pool.query(`SELECT
    (SELECT count(*) FROM hermes_agui_runtime.llm_releases) AS releases,
    (SELECT count(*) FROM hermes_agui_runtime.llm_admin_events) AS events,
    (SELECT row_to_json(d) FROM hermes_agui_runtime.llm_drafts d) AS draft,
    (SELECT row_to_json(a) FROM hermes_agui_runtime.llm_active_release a) AS active`)).rows[0];
}
beforeAll(async()=>{
  for(const role of ["hermes_host","hermes_runtime","hermes_llm_admin","hermes_llm_runtime","hermes_llm_reader","hermes_llm_host_reader"]) {
    if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[role])).rowCount) await admin.query(`CREATE ROLE ${role} NOLOGIN`);
  }
  scratch=await mkdtemp(join(tmpdir(),"database-aware-"));contractPath=join(scratch,"schema.json");
  await generate(source!,root,contractPath);
  contracts=JSON.parse(await readFile(contractPath,"utf8")).contracts;
});
afterAll(async()=>{
  for(const name of databases) await admin.query(`DROP DATABASE ${name}`);
  await admin.end();if(scratch)await rm(scratch,{recursive:true});
});

test("empty database migrates and bootstraps once; latest run performs zero release or migration writes",async()=>{
  const url=await database();
  expect((await schemaStatus(url,0)).pending).toBe(contracts[0].files.length);
  hostMigrate(url);runtimeMigrate(url);
  expect((await schemaStatus(url,0)).pending).toBe(0);expect((await schemaStatus(url,1)).pending).toBe(0);
  const store=await fenced(url);
  try {
    expect((await upgradeRelease(store,llm)).status).toBe("BOOTSTRAPPED");
    expect((await store.active()).snapshot).toMatchObject({contract:"management-part-2",prompts:{}});
    const before=await fingerprintState(store);
    // A database read-only transaction default rejects even an accidental no-op DDL/UPDATE.
    const readOnly=new URL(url);readOnly.searchParams.set("options","-c default_transaction_read_only=on");
    const reader=new ControlStore(readOnly.href,policy);
    try{expect((await upgradeRelease(reader,llm)).status).toBe("CURRENT");}finally{await reader.close();}
    expect(hostMigrate(readOnly.href.replaceAll("+","%20"))).toBe("");expect(runtimeMigrate(readOnly.href)).toBe("");
    expect(await fingerprintState(store)).toEqual(before);
    expect((await Promise.all([upgradeRelease(store,llm),upgradeRelease(store,llm)])).map(r=>r.status)).toEqual(["CURRENT","CURRENT"]);
  } finally{await store.close();}
});

test("management-part-1 upgrades with legal active Model and unpublished Model/Prompt edits preserved",async()=>{
  const url=await database();hostMigrate(url);runtimeMigrate(url);
  const store=await fenced(url);
  try{
    const modern=candidate(llm,policy);
    const legacy:any={version:1,contract:"management-part-1",llm:modern.llm,modelFingerprint:modern.modelFingerprint,taskFingerprint:hash(taskManifest()),tasks:taskManifest()};
    await store.pool.query(`INSERT INTO hermes_agui_runtime.llm_releases(scope,release_id,snapshot,model_fingerprint,task_fingerprint,release_fingerprint,validated,created_by,reason)
      VALUES('deployment','release-001',$1,$2,$3,$4,true,'test','historical release')`,[legacy,legacy.modelFingerprint,legacy.taskFingerprint,hash(legacy)]);
    await store.pool.query("INSERT INTO hermes_agui_runtime.llm_active_release(scope,release_id,generation,updated_by) VALUES('deployment','release-001',1,'test')");
    const draft=structuredClone(llm);draft.models[0].model="gemini-2.5-pro";
    await store.pool.query("INSERT INTO hermes_agui_runtime.llm_drafts(scope,config,prompts,revision,updated_by) VALUES('deployment',$1,$2,4,'test')",[draft,{agent_primary:"Keep the requested tone.","v3-query":"Prefer explicit dates."}]);
    expect(()=>verifySnapshot(legacy,hash(legacy),policy)).toThrow();
    const result=await upgradeRelease(store,llm);expect(result.status).toBe("UPGRADED");
    expect((await store.active()).snapshot.llm).toEqual(modern.llm);
    expect((await store.draft()).config.models[0].model).toBe("gemini-2.5-pro");
    expect((await store.draft()).prompts).toEqual({agent_primary:"Keep the requested tone.","v3-query":"Prefer explicit dates."});
    expect((await store.pool.query("SELECT snapshot FROM hermes_agui_runtime.llm_releases WHERE release_id='release-001'")).rows[0].snapshot).toEqual(legacy);
    expect((await store.history()).events).toMatchObject([{action:"publish",old_release:"release-001",new_release:result.release_id}]);
    const before=await fingerprintState(store);await upgradeRelease(store,llm);expect(await fingerprintState(store)).toEqual(before);
  }finally{await store.close();}
});

test("changed task contracts rebuild a new Release and retain active editable prompts",async()=>{
  const url=await database();hostMigrate(url);runtimeMigrate(url);
  const store=await fenced(url);
  try{
    const old=candidate(llm,policy,{agent_primary:"Use Traditional Chinese.","v3-story":"Use a concise style."});
    // A historical code manifest/fingerprint from the previous source tree.
    old.codeTaskFingerprint=hash({previous:"task-contract"});
    await store.transaction(async client=>{
      await store.insert(client,old,"test","old task contract",null,"release-001");
      await client.query("INSERT INTO hermes_agui_runtime.llm_active_release(scope,release_id,generation,updated_by) VALUES('deployment','release-001',1,'test')");
      await client.query("INSERT INTO hermes_agui_runtime.llm_drafts(scope,config,prompts,revision,updated_by) VALUES('deployment',$1,$2,1,'test')",[llm,old.prompts]);
    });
    expect((await upgradeRelease(store,llm)).status).toBe("UPGRADED");
    const active=await store.active();expect(active.snapshot.prompts).toEqual(old.prompts);expect(active.snapshot.codeTaskFingerprint).toBe(hash(taskManifest()));
    const host=spawnSync(python,["-c",`import json,sys\nfrom hermes_agui.core.managed_llm import validate_snapshot,source_control_policy\nx=json.load(sys.stdin)\npolicy=source_control_policy({**x['policy'],'mode':'managed','taskFingerprint':'0'*64})\nvalidate_snapshot(x['snapshot'],x['fingerprint'],policy)`],{cwd:root,input:JSON.stringify({snapshot:active.snapshot,fingerprint:active.release_fingerprint,policy:{approved:policy.approved,taskFingerprint:hash(taskManifest())}}),encoding:"utf8"});
    expect(host.stderr).toBe("");expect(host.status).toBe(0);
  }finally{await store.close();}
});

test("SQL additions execute only pending migrations; unknown ledger/schema drift is rejected",async()=>{
  const url=await database();hostMigrate(url,true);
  const pool=new Pool({connectionString:url,max:1});
  try{
    await pool.query("CREATE SCHEMA hermes_agui_runtime_migrations; CREATE TABLE hermes_agui_runtime_migrations.runtime(name text PRIMARY KEY)");
    const dir=resolve("server/storage/migrations");
    for(const name of (await readdir(dir)).filter(n=>n.endsWith(".sql")).sort().slice(0,-2)) {
      await pool.query(migrationSQL(await readFile(join(dir,name),"utf8")));
      await pool.query("INSERT INTO hermes_agui_runtime_migrations.runtime VALUES($1)",[name]);
    }
    expect((await schemaStatus(url,1)).pending).toBe(2);
    expect(runtimeMigrate(url)).toContain("014_deployment_fence.sql");expect(runtimeMigrate(url)).toBe("");
    expect((await schemaStatus(url,1)).pending).toBe(0);
    await pool.query("ALTER TABLE hermes_agui_runtime.llm_drafts ADD COLUMN unexpected text");
    await expect(schemaStatus(url,1)).rejects.toThrow("Schema drift");
    await pool.query("ALTER TABLE hermes_agui_runtime.llm_drafts DROP COLUMN unexpected");
    await pool.query("INSERT INTO hermes_agui_runtime_migrations.runtime(name) VALUES('999_unknown.sql')");
    await expect(schemaStatus(url,1)).rejects.toThrow("Unknown migration");
  }finally{await pool.end();}
});

test("invalid policy and damaged release hashes abort upgrade without pointer/draft/history writes",async()=>{
  for(const damage of [false,true]) {
    const url=await database();hostMigrate(url);runtimeMigrate(url);const store=await fenced(url);
    try{
      const snapshot=candidate(llm,policy);snapshot.codeTaskFingerprint=hash({previous:true});
      if(!damage) snapshot.llm.models[0].model="gemini-unapproved";
      // Make an internally valid historical model fingerprint for the policy failure case.
      if(!damage){const {ModelRegistry}=await import("../../server/llm/config");snapshot.modelFingerprint=new ModelRegistry(snapshot.llm).fingerprint;}
      await store.transaction(async client=>{
        await store.insert(client,snapshot,"test","previous",null,"release-001");
        await client.query("INSERT INTO hermes_agui_runtime.llm_active_release(scope,release_id,generation,updated_by) VALUES('deployment','release-001',1,'test')");
        await client.query("INSERT INTO hermes_agui_runtime.llm_drafts(scope,config,revision,updated_by) VALUES('deployment',$1,1,'test')",[llm]);
      });
      if(damage){
        // Test fixture corruption only: production history remains immutable.
        await store.pool.query("ALTER TABLE hermes_agui_runtime.llm_releases DISABLE TRIGGER llm_release_immutable");
        await store.pool.query("UPDATE hermes_agui_runtime.llm_releases SET release_fingerprint=repeat('0',64)");
        await store.pool.query("ALTER TABLE hermes_agui_runtime.llm_releases ENABLE TRIGGER llm_release_immutable");
      }
      const before=await fingerprintState(store);
      await expect(upgradeRelease(store,llm)).rejects.toThrow(damage?"integrity":"approved");
      expect(await fingerprintState(store)).toEqual(before);
    }finally{await store.close();}
  }
});

test("failed SQL migration rolls back schema and ledger; preparation CLI fences, activates and resumes",async()=>{
  const url=await database();hostMigrate(url,true);
  const pool=new Pool({connectionString:url,max:1});
  try{
    const files=contracts[1].files.slice(0,-2);
    await pool.query("CREATE SCHEMA hermes_agui_runtime_migrations; CREATE TABLE hermes_agui_runtime_migrations.runtime(name text PRIMARY KEY)");
    for(const {name} of files){
      await pool.query(migrationSQL(await readFile(resolve("server/storage/migrations",name),"utf8")));
      await pool.query("INSERT INTO hermes_agui_runtime_migrations.runtime VALUES($1)",[name]);
    }
    await pool.query(`CREATE FUNCTION public.reject_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER reject_migration BEFORE INSERT ON hermes_agui_runtime_migrations.runtime FOR EACH ROW EXECUTE FUNCTION public.reject_migration()`);
    const failed=spawnSync(process.execPath,["--import","tsx","server/storage/migrate-cli.ts"],{env:{...process.env,AGUI_RUNTIME_DATABASE_URL:url},encoding:"utf8"});
    expect(failed.status).toBe(1);expect((await schemaStatus(url,1)).pending).toBe(2);
    await pool.query("DROP TRIGGER reject_migration ON hermes_agui_runtime_migrations.runtime; DROP FUNCTION public.reject_migration()");
    const {writeFile}=await import("node:fs/promises");
    const configPath=join(scratch,"runtime.json");await writeFile(configPath,JSON.stringify({llm,llmControl:policy}));
    process.env.AGUI_HOST_DATABASE_URL=url;process.env.AGUI_RUNTIME_DATABASE_URL=url;const adminURL=new URL(url);adminURL.searchParams.set("options","-c role=hermes_llm_admin");
    process.env.AGUI_LLM_ADMIN_DATABASE_URL=adminURL.href;
    expect((await deployment("check",configPath,contractPath)).status).toBe("SCHEMA_CHECKED");
    await deployment("migrate",configPath,contractPath);await deployment("seal",configPath,contractPath);
    expect((await deployment("release",configPath,contractPath)).status).toBe("BOOTSTRAPPED");
    expect((await deployment("release",configPath,contractPath)).status).toBe("CURRENT");
    await expect(pool.query(`INSERT INTO hermes_agui_runtime.llm_run_pins(scope,principal,bot,thread,run,release_id)
      VALUES('deployment','p','b','t','r','release-001')`)).rejects.toThrow("maintenance");
    const readOnly=new URL(url);readOnly.searchParams.set("options","-c default_transaction_read_only=on");
    process.env.AGUI_HOST_DATABASE_URL=readOnly.href;process.env.AGUI_RUNTIME_DATABASE_URL=readOnly.href;
    expect(hostMigrate(readOnly.href.replaceAll("+","%20"),true)).toBe("");
    expect((await deployment("migrate",configPath,contractPath)).status).toBe("RUNTIME_MIGRATED");
    process.env.AGUI_HOST_DATABASE_URL=url;process.env.AGUI_RUNTIME_DATABASE_URL=url;
    await deployment("drain",configPath,contractPath);
    expect((await pool.query("SELECT has_table_privilege('hermes_host','hermes_agui_host.runs','INSERT') AS allowed")).rows[0].allowed).toBe(true);
    expect((await pool.query("SELECT has_schema_privilege('hermes_runtime','hermes_agui_runtime','CREATE') AS allowed")).rows[0].allowed).toBe(false);
    expect((await deployment("resume",configPath,contractPath)).status).toBe("RESUMED");
    expect((await pool.query("SELECT closed FROM hermes_agui_host.deployment_fence")).rows[0].closed).toBe(false);
  }finally{await pool.end();}
});
