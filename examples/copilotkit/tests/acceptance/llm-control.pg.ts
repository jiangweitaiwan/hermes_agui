import { beforeAll, afterAll, expect, test } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync,spawnSync,spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdtemp, readFile,readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../server/llm/control-store";
import { controlApi } from "../../server/llm/control-api";
import { PostgresWikiStore } from "../../server/graph/postgres-wiki-store";
import { PostgresDocumentIngestor } from "../../server/graph/postgres-ingest-queue";
import { FilesystemGraphObjects } from "../../server/graph/objects";
import { controlFixture } from "../fixtures/llm-control";
import { candidate, hash } from "../../server/llm/control-contract";
import { WikiCompiler } from "../../server/graph/compiler";
import { RegistryLLM } from "../../server/llm/client";
import {fixtureModel,meeting} from "../fixtures/graph-v2/model";
import { managedRunPreparation } from "../../server/llm/run-pinning";
import { executionRelease } from "../../server/llm/execution-release";

// This gate deliberately fails when its disposable real PostgreSQL resource is absent.
const source = process.env.AGUI_LLM_TEST_ADMIN_URL;
if (!source) throw new Error("BLOCKED: AGUI_LLM_TEST_ADMIN_URL must identify disposable PostgreSQL");
const admin = new Pool({ connectionString: source, max: 1 });
const database = `llm_p1_${randomUUID().replaceAll("-", "")}`;
const url = new URL(source); url.pathname = `/${database}`;
const { llm, policy } = controlFixture();
const store = new ControlStore(url.href, policy), replica = new ControlStore(url.href, policy);
let objects: string, wiki: PostgresWikiStore, queue: PostgresDocumentIngestor;
const ns = { principal: "user", projectId: "project", botId: "bot", visibility: "bot_private" as const };
beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0`);
  console.info("real PostgreSQL",(await admin.query("SHOW server_version")).rows[0].server_version);
  const env = { ...process.env, AGUI_RUNTIME_DATABASE_URL: url.href };
  const migrate = () => execFileSync(process.execPath, ["--import", "tsx", "server/storage/migrate-cli.ts"], { env, encoding: "utf8" });
  expect(migrate()).toContain("011_llm_control.sql"); expect(migrate()).toBe("");
  await store.ready(); await replica.ready();
  expect((await store.bootstrap(llm, "operator", false)).applied).toBe(false);
  await expect(store.active()).rejects.toThrow();
  await store.bootstrap(llm, "operator", true);
  expect((await replica.bootstrap(llm, "operator", true)).applied).toBe(false);
  await store.pool.query(`INSERT INTO hermes_agui_runtime.bot_registry(id,principal,record) VALUES ('bot','user',$1)`,
    [{ id: "bot", harness: "hermes", templateId: "native", model: "gemini-2.5-flash", provider: "vertex" }]);
  await expect(store.pinRun("user", "bot", "t", "r")).rejects.toThrow(/migration/);
  await store.optInBot("bot", "operator", true); await store.optInBot("bot", "operator", true);
  objects = await realpath(await mkdtemp(join(tmpdir(), "llm-p1-objects-")));
  wiki = new PostgresWikiStore(url.href, new FilesystemGraphObjects(objects));
  await wiki.ready(); queue = new PostgresDocumentIngestor(wiki); queue.useReleases(store); await queue.ready();
});
afterAll(async () => {
  await wiki?.close(); await store.close(); await replica.close();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  if (objects) await rm(objects, { recursive: true });
});
test("immutable release/audit and exact grants fence reader/worker control writes", async () => {
  const dbRoles=["hermes_llm_admin","hermes_llm_runtime","hermes_llm_reader","hermes_llm_host_reader","hermes_runtime"];
  for(const role of dbRoles)await store.pool.query(`CREATE ROLE ${role} ${role==="hermes_llm_host_reader"?"LOGIN":"NOLOGIN"}`);
  try {
    await store.pool.query(await readFile("../../deploy/gcp/llm-control-grants.sql","utf8"));
    const pinned=await store.pinRun("user","bot","host-thread","host-run");
    const prepared=await managedRunPreparation(store)("bot",{agentUrl:"http://localhost/agent",token:"fixture-token",
      memory:{key:"host-fixture-signing",principal:"user",projectId:"project"}},
    {threadId:"host-thread",runId:"host-run",messages:[],state:{},tools:[],context:[],forwardedProps:{}},async input=>{
      expect(executionRelease()?.release_id).toBe(pinned.release_id);return input;
    });
    const envelope=prepared.forwardedProps!.llmRelease;
    const hostUrl=new URL(url);hostUrl.username="hermes_llm_host_reader";
    const host=spawnSync(process.env.AGUI_LLM_TEST_HOST_PYTHON ?? resolve("../../.venv/bin/python"),["-c",`
import json,sys
from types import SimpleNamespace as NS
from hermes_agui.core.managed_llm import resolve_run,ready_host
v=json.load(sys.stdin)
policy=v['policy']
ready_host(policy)
bot=NS(agent=NS(principal='user',llm_control=policy),server=NS(runtime_memory_key='host-fixture-signing',runtime_memory_project='project'))
value=NS(thread_id='host-thread',run_id='host-run')
registry,release,release_hash=resolve_run(value,'bot',bot,v['envelope'])
assert release=='release-001'
assert release_hash==v['expectedHash']
value.thread_id='foreign-thread'
try:
    resolve_run(value,'bot',bot,v['envelope'])
except ValueError:
    print('verified-and-denied-forgery')
else:
    raise AssertionError('forged binding accepted')
`],{cwd:"../..",encoding:"utf8",env:{...process.env,AGUI_LLM_DATABASE_URL:hostUrl.href},
      input:JSON.stringify({envelope,expectedHash:pinned.release_fingerprint,policy:{approved:policy.approved,taskFingerprint:pinned.task_fingerprint}})});
    expect(host.stderr).toBe("");expect(host.status).toBe(0);expect(host.stdout.trim()).toBe("verified-and-denied-forgery");
    const client = await store.pool.connect();
    try {
      await client.query("SET ROLE hermes_llm_reader");
      expect((await client.query("SELECT release_id FROM hermes_agui_runtime.llm_active_release")).rows).toHaveLength(1);
      await expect(client.query("UPDATE hermes_agui_runtime.llm_active_release SET generation=generation+1")).rejects.toThrow(/permission denied/);
      await expect(client.query("SELECT * FROM hermes_agui_runtime.bot_registry")).rejects.toThrow(/permission denied/);
    } finally { await client.query("RESET ROLE"); client.release(); }
    await expect(store.pool.query("UPDATE hermes_agui_runtime.llm_releases SET reason='overwrite'")).rejects.toThrow(/immutable/);
    await expect(store.pool.query("DELETE FROM hermes_agui_runtime.llm_admin_events")).rejects.toThrow(/immutable/);
  } finally {
    for(const role of dbRoles){await store.pool.query(`DROP OWNED BY ${role}`);await store.pool.query(`DROP ROLE ${role}`);}
  }
});
test("two replicas CAS publication, durable run/job pins survive retry/restart and rollback", async () => {
  const old = await store.pinRun("user", "bot", "same-thread", "run-A");
  const upload = { title: "source", mime: "text/plain", content: "Alice wrote a report.", idempotencyKey: "job-A" };
  const id = await queue.enqueue(ns, upload);
  await expect(store.pool.query(`UPDATE hermes_agui_runtime.graph_jobs SET state='running',token=$1,
    lease=clock_timestamp()+interval '30 seconds',attempt=attempt+1 WHERE id=$2`,[randomUUID(),id])).rejects.toThrow(/compatible reader/);
  const job = await queue.claim(ns, undefined, undefined, id);
  await expect(store.pool.query("UPDATE hermes_agui_runtime.graph_jobs SET state='completed',token=NULL,lease=NULL WHERE id=$1",[id])).rejects.toThrow(/verified release publication/);
  expect((await queue.releaseForJob(job!))!.release_id).toBe(old.release_id);
  const next = structuredClone(llm); next.models[0].model = "gemini-2.5-pro"; next.models[1].model = "gemini-2.5-pro";
  await store.update(next, 1, "deployment-admin");
  const validated = await replica.validate("deployment-admin");
  const results = await Promise.allSettled([store.publish(1, 2, validated.candidateHash, "deployment-admin", "Promote Pro"),
    replica.publish(1, 2, validated.candidateHash, "deployment-admin", "Concurrent promotion")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.status).toBe(409);
  const active = await replica.active(); expect(active.release_id).not.toBe(old.release_id);
  expect((await replica.pinRun("user", "bot", "same-thread", "run-A")).release_id).toBe(old.release_id);
  expect((await replica.pinRun("user", "bot", "same-thread", "run-B")).release_id).toBe(active.release_id);
  expect(await queue.enqueue(ns, upload)).toBe(id);
  await queue.fail(job!); await queue.cancel(ns, id); await queue.retry(ns, id);
  const restarted = new PostgresDocumentIngestor(wiki); restarted.useReleases(replica);
  const retried = await restarted.claim(ns, undefined, undefined, id);
  expect((await restarted.releaseForJob(retried!))!.release_id).toBe(old.release_id);
  const newId = await restarted.enqueue(ns, { ...upload, idempotencyKey: "job-B", content: "Bob wrote a report." });
  expect((await restarted.releaseForJob(await restarted.status(ns, newId)))!.release_id).toBe(active.release_id);
  await store.rollback(old.release_id, 2, "deployment-admin", "Restore Flash");
  expect((await replica.active()).release_id).toBe(old.release_id);
  expect((await replica.pinRun("user", "bot", "same-thread", "run-B")).release_id).toBe(active.release_id);
  await expect(store.pool.query("UPDATE hermes_agui_runtime.graph_jobs SET llm_release_id=$1 WHERE id=$2", [active.release_id, id])).rejects.toThrow(/immutable/);
  await expect(store.rollback(active.release_id, 2, "deployment-admin", "stale CAS")).rejects.toMatchObject({ status: 409 });
  const history = await store.history();
  expect(history.events.map(e => e.action)).toEqual(expect.arrayContaining(["publish", "rollback", "bot_opt_in", "validate"]));
  expect(JSON.stringify(history)).not.toContain("Alice");
});
test("real API requires deployment-admin, rejects cross scope/CSRF/secrets and reports conflicts", async () => {
  const auth = { authenticate: (request: Request) => {
    const token = request.headers.get("authorization");
    return token ? { principal: token, projectId: "project", ownerId: "owner" } : undefined;
  } };
  const handle = controlApi(store, auth);
  const request = (path: string, method = "GET", body?: unknown, actor = "deployment-admin", origin?: string) => new Request(`http://localhost/api/admin/llm/${path}`, {
    method, headers: { ...(actor ? { authorization: actor } : {}), ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect((await handle(request("tasks", "GET", undefined, ""))).status).toBe(401);
  expect((await handle(request("tasks", "GET", undefined, "workspace-owner"))).status).toBe(403);
  expect((await handle(request("tasks?scope=foreign"))).status).toBe(422);
  expect((await handle(request("validate", "POST", {}, "deployment-admin", "https://evil.example"))).status).toBe(403);
  const draft = await store.draft();
  expect((await handle(request("draft", "PATCH", { expectedRevision: draft.revision - 1, config: llm }))).status).toBe(409);
  expect((await handle(request("providers/test", "POST", { url: "http://169.254.169.254", key: "secret" }))).status).toBe(422);
  const tasks = await handle(request("tasks")); expect(tasks.status).toBe(200);
  const body = await tasks.text(); expect(body).not.toContain("synthetic-token");
  const corrupt = { ...candidate(llm, policy), contract: "future" };
  await expect(store.resolve("missing-release")).rejects.toMatchObject({ status: 503 });
  await store.pool.query(`INSERT INTO hermes_agui_runtime.llm_releases(scope,release_id,snapshot,model_fingerprint,
    task_fingerprint,release_fingerprint,validated,created_by,reason) VALUES ('deployment','incompatible',$1,$2,$3,$4,true,'test','contract fault')`,
    [corrupt,corrupt.modelFingerprint,corrupt.taskFingerprint,hash(corrupt)]);
  await expect(store.resolve("incompatible")).rejects.toThrow();
  await store.pool.query("UPDATE hermes_agui_runtime.llm_active_release SET release_id='incompatible'");
  const id=await queue.enqueue(ns,{title:"Fail closed",mime:"text/plain",content:"No candidate may publish.",idempotencyKey:"incompatible-job"});
  let calls=0;
  await new WikiCompiler(queue,{json:async()=>{calls++;throw new Error("must not infer");}},120000,"v2").processJob(ns,id);
  expect(calls).toBe(0);expect((await queue.status(ns,id)).state).toBe("pending");
  expect((await store.pool.query("SELECT count(*)::int AS n FROM hermes_agui_runtime.graph_pages")).rows[0].n).toBe(0);
  await store.pool.query("UPDATE hermes_agui_runtime.llm_active_release SET release_id='release-001'");
  const unavailable=new ControlStore("postgresql://unavailable@127.0.0.1:9/unavailable",policy);
  try{await expect(unavailable.active()).rejects.toThrow();}finally{await unavailable.close();}
});

test("publication between parser and relations cannot change a running job's route",async()=>{
  const old=await store.active();
  const own={...ns,botId:"inflight"};
  let entered!:()=>void,resume!:()=>void;
  const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{resume=r;});
  const routes:string[]=[];const model=fixtureModel();let paused=false;
  const llmClient=new RegistryLLM(llm,"graph_parser",{token:async()=>"local-fixture",transport:async(input,init)=>{
    routes.push(String(input));const wire=JSON.parse(String(init?.body)),data=JSON.parse(wire.contents[0].parts[0].text);
    const stage=data.narratives?"v2-relations":"v2-parser";
    if(stage==="v2-parser" && !paused){paused=true;entered();await gate;}
    const output=await model.json(stage,data,AbortSignal.timeout(2000));
    return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(output)}]}}]});
  }},true);
  const id=await queue.enqueue(own,{title:"inflight",mime:"text/plain",content:meeting,idempotencyKey:"inflight"});
  const compiler=new WikiCompiler(queue,llmClient,120000,"v2");
  const running=compiler.processJob(own,id);
  try{
    await waiting;
    const draft=await store.draft(),next=structuredClone(llm);next.models[1].model="gemini-2.5-pro";next.models[3].model="gemini-2.5-pro";
    await replica.update(next,draft.revision,"deployment-admin");
    const v=await replica.validate("deployment-admin");
    await replica.publish(v.generation,v.revision,v.candidateHash,"deployment-admin","Publish during parser");
  }finally{resume();}
  await running;
  expect((await queue.status(own,id)).state).toBe("completed");
  expect(routes.length).toBeGreaterThanOrEqual(2);expect(routes.every(route=>route.includes("gemini-2.5-flash"))).toBe(true);
  expect((await queue.releaseForJob(await queue.status(own,id)))!.release_id).toBe(old.release_id);
  routes.length=0;
  const newNs={...own,botId:"next-inflight"};
  const nextId=await queue.enqueue(newNs,{title:"next",mime:"text/plain",content:meeting,idempotencyKey:"next"});
  await compiler.processJob(newNs,nextId);
  expect((await queue.status(newNs,nextId)).state).toBe("completed");
  expect(routes.every(route=>route.includes("gemini-2.5-pro"))).toBe(true);
});

test("independent Runtime processes compete on the same active pointer",async()=>{
  const draft=await store.draft();await store.update(llm,draft.revision,"deployment-admin");
  const v=await store.validate("deployment-admin");
  const script=`import {ControlStore} from './server/llm/control-store.ts';
let raw='';for await(const part of process.stdin)raw+=part;
const v=JSON.parse(raw);const store=new ControlStore(v.url,v.policy);
try{await store.publish(v.generation,v.revision,v.candidateHash,'replica','Process CAS');console.log('published');}
catch(error){console.log(error.status===409?'conflict':'failed');}
finally{await store.close();}`;
  const publish=()=>new Promise<string>((resolveResult,reject)=>{
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script],{stdio:["pipe","pipe","pipe"]});
    let result="";child.stdout.on("data",part=>{result+=part;});child.stderr.resume();child.on("error",reject);
    child.on("close",code=>code===0?resolveResult(result.trim()):reject(new Error("replica failed")));
    child.stdin.end(JSON.stringify({url:url.href,policy,...v}));
  });
  expect((await Promise.all([publish(),publish()])).sort()).toEqual(["conflict","published"]);
  expect((await replica.draft()).generation).toBe(v.generation+1);
});

test("pre-control-plane PostgreSQL static workers have no new table dependency",async()=>{
  const legacyDb=`llm_legacy_${randomUUID().replaceAll("-","")}`;
  await admin.query(`CREATE DATABASE ${legacyDb} ENCODING 'UTF8' TEMPLATE template0`);
  const legacyUrl=new URL(url);legacyUrl.pathname=`/${legacyDb}`;
  const root=await realpath(await mkdtemp(join(tmpdir(),"llm-legacy-")));
  const legacy=new PostgresWikiStore(legacyUrl.href,new FilesystemGraphObjects(root));
  try{
    const migrations=new URL("../../server/storage/migrations/",import.meta.url);
    for(const name of (await readdir(migrations)).filter(name=>name.endsWith(".sql")).sort().slice(0,10))
      await legacy.pool.query(await readFile(new URL(name,migrations),"utf8"));
    const queue=new PostgresDocumentIngestor(legacy);await queue.ready();
    const id=await queue.enqueue(ns,{title:"legacy",mime:"text/plain",content:meeting,idempotencyKey:"legacy"});
    await new WikiCompiler(queue,fixtureModel(),120000,"v2").processJob(ns,id);
    expect((await queue.status(ns,id)).state).toBe("completed");
    expect((await legacy.pool.query("SELECT to_regclass('hermes_agui_runtime.llm_releases') AS relation")).rows[0].relation).toBeNull();
  }finally{
    await legacy.close();await rm(root,{recursive:true});await admin.query(`DROP DATABASE ${legacyDb} WITH (FORCE)`);
  }
});

test("release history pagination retains every ID when creation timestamps tie",async()=>{
  await store.pool.query(`INSERT INTO hermes_agui_runtime.llm_releases
    (scope,release_id,snapshot,model_fingerprint,task_fingerprint,release_fingerprint,validated,created_by,reason,created_at)
    SELECT scope,'history-'||lpad(i::text,2,'0'),snapshot,model_fingerprint,task_fingerprint,release_fingerprint,
      true,'history-fixture','Pagination contract','2000-01-01T00:00:00.123456Z'::timestamptz
    FROM hermes_agui_runtime.llm_releases CROSS JOIN generate_series(1,27) i WHERE release_id='release-001'`);
  const ids:string[]=[];let before:string|undefined;
  do{const page=await store.history(before);ids.push(...page.releases.map(row=>row.release_id));before=page.next??undefined;}while(before);
  expect(new Set(ids).size).toBe(ids.length);
  const total=(await store.pool.query("SELECT count(*)::int AS n FROM hermes_agui_runtime.llm_releases")).rows[0].n;
  expect(ids).toHaveLength(total);
  await expect(store.history("invalid-cursor")).rejects.toMatchObject({status:422});
});
