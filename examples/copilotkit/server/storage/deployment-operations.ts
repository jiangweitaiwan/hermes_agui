/** Database Job operations; the CLI owns connection lifetime and preparation locks. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { PoolClient } from "pg";
import { checkSchema, type SchemaContract } from "./schema-contract";
import { ControlStore } from "../llm/control-store";
import type { ControlPolicy } from "../llm/control-contract";
import { upgradeRelease } from "../llm/control-upgrade";
interface Context { clients:PoolClient[]; contracts:SchemaContract[]; policy:ControlPolicy; config:{llm:unknown}; grants:unknown }
export interface DeploymentResult {status:string;[key:string]:unknown}

async function check(context:Context) {
  const {clients,contracts}=context;
  const status=[];
  for(let i=0;i<clients.length;i++) status.push(await checkSchema(clients[i],contracts[i]));
  return {status:"SCHEMA_CHECKED",schemas:status};
}

async function fence(context:Context,command:string) {
  const {clients,contracts,policy}=context;
  if(command==="resume") {
    for(let i=0;i<clients.length;i++) {
      const status=await checkSchema(clients[i],contracts[i]);
      if(status.pending) throw new Error("Cannot resume before migrations complete");
    }
    const store=new ControlStore(process.env.AGUI_LLM_ADMIN_DATABASE_URL??"",policy);
    try{await store.active();}finally{await store.close();}
  }
  for(let i=0;i<clients.length;i++) {
    const table=`${contracts[i].schema}.deployment_fence`;
    if((await clients[i].query("SELECT to_regclass($1) AS name",[table])).rows[0].name) {
      // No duplicate writes when the desired fence state is already installed.
      const closed=command!=="resume";
      if(i===1 && command!=="fence") await clients[i].query(`UPDATE ${table} SET closed=$1,jobs_closed=$1 WHERE singleton AND (closed IS DISTINCT FROM $1 OR jobs_closed IS DISTINCT FROM $1)`,[closed]);
      else await clients[i].query(`UPDATE ${table} SET closed=$1 WHERE singleton AND closed IS DISTINCT FROM $1`,[closed]);
      if(!(await clients[i].query(`SELECT 1 FROM ${table} WHERE singleton`)).rowCount) throw new Error("Deployment fence state missing");
    } else if(command==="resume") throw new Error("Deployment fence missing");
  }
  return {status:command==="resume"?"RESUMED":"FENCED"};
}

async function drain(context:Context) {
  const {clients}=context;
  const checks=[
    [0,"hermes_agui_host.runs","status='running'"],
    [0,"hermes_agui_host.run_outbox","status IN ('pending','leased')"],
    [1,"hermes_agui_runtime.graph_jobs","state IN ('pending','running')"],
  ] as const;
  const deadline=Date.now()+300_000;
  let pending:string[]=[];
  do {
    pending=[];
    for(const [i,table,predicate] of checks) {
      if(!(await clients[i].query("SELECT to_regclass($1) AS name",[table])).rows[0].name) continue;
      if((await clients[i].query(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`)).rowCount) pending.push(table);
    }
    if(!pending.length) break;
    await clients[0].query("SELECT pg_sleep(2)");
  } while(Date.now()<deadline);
  if(pending.length) throw new Error(`Drain incomplete: ${pending.join(", ")}`);
  return {status:"DRAINED"};
}

async function migrate(context:Context) {
  const {clients,contracts}=context;
  // The actual DDL is still owned by the existing migrator, with its ledger/lock.
  const status=await checkSchema(clients[1],contracts[1]);
  if(status.pending) execFileSync(process.execPath,["--import","tsx","server/storage/migrate-cli.ts"],{stdio:"inherit",env:process.env});
  const after=await checkSchema(clients[1],contracts[1]);
  if(after.pending) throw new Error("Runtime migration incomplete");
  const grants=context.grants;
  if(!Array.isArray(grants) || !grants.length) throw new Error("Runtime grants contract missing");
  const checksum=createHash("sha256").update(grants.join("\n")).digest("hex");
  const table="hermes_agui_runtime_migrations.grants";
  const exists=(await clients[1].query("SELECT to_regclass($1) AS name",[table])).rows[0].name;
  const prior=exists?(await clients[1].query(`SELECT sha256 FROM ${table} WHERE name='runtime'`)).rows[0]:undefined;
  if(prior?.sha256!==checksum) {
    await clients[1].query("BEGIN");
    try {
      if(!exists) await clients[1].query(`CREATE TABLE ${table}(name text PRIMARY KEY,sha256 text NOT NULL)`);
      for(const sql of grants) await clients[1].query(sql);
      await clients[1].query(`INSERT INTO ${table}(name,sha256) VALUES('runtime',$1) ON CONFLICT(name) DO UPDATE SET sha256=EXCLUDED.sha256`,[checksum]);
      await clients[1].query("COMMIT");
    } catch(error) {await clients[1].query("ROLLBACK");throw error;}
  }
  return {status:"RUNTIME_MIGRATED"};
}

async function release(context:Context) {
  const {clients,contracts,policy,config}=context;
  for(let i=0;i<clients.length;i++) {
    if((await checkSchema(clients[i],contracts[i])).pending) throw new Error("Release preparation requires latest schemas");
    const row=(await clients[i].query(`SELECT closed FROM ${contracts[i].schema}.deployment_fence WHERE singleton`)).rows[0];
    if(!row?.closed) throw new Error("Release activation requires closed admission fences");
  }
  const store=new ControlStore(process.env.AGUI_LLM_ADMIN_DATABASE_URL??"",policy);
  try{return await upgradeRelease(store,config.llm);}finally{await store.close();}
}

export const operations:Record<string,(context:Context)=>Promise<DeploymentResult>>={
  check,drain,migrate,release,
  fence:context=>fence(context,"fence"),seal:context=>fence(context,"seal"),resume:context=>fence(context,"resume"),
};
