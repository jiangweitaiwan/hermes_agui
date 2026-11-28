/** Cloud Run Job entrypoint. Credentials/config are mounted secrets, never CLI output. */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { type SchemaContract } from "./schema-contract";
import { databaseTarget } from "../llm/database-target";
import { ControlSettings } from "../llm/control-contract";
import { operations } from "./deployment-operations";

export async function deployment(command:string, configPath:string, contractPath:string) {
  const contract=JSON.parse(await readFile(contractPath,"utf8"));
  if(contract.format!==1 || contract.postgresMajor!==17) throw new Error("Unknown schema contract format");
  const config=JSON.parse(await readFile(configPath,"utf8"));
  if(process.env.CLEAN_BOOTSTRAP_CONFIG) config.cleanBootstrap=JSON.parse(await readFile(process.env.CLEAN_BOOTSTRAP_CONFIG,"utf8"));
  const policy=ControlSettings.parse(config.llmControl);
  if(policy.mode!=="managed") throw new Error("Database-aware deployment requires managed control");
  const hostURL=process.env.AGUI_HOST_DATABASE_URL, runtimeURL=process.env.AGUI_RUNTIME_DATABASE_URL;
  if(!hostURL || !runtimeURL) throw new Error("Migration owner bindings required");
  if(databaseTarget(runtimeURL)!==databaseTarget(process.env.AGUI_LLM_ADMIN_DATABASE_URL??"")) throw new Error("Control admin and Runtime destinations must match");
  const pools=[new Pool({connectionString:hostURL,max:1,connectionTimeoutMillis:5000,statement_timeout:15000}),new Pool({connectionString:runtimeURL,max:1,connectionTimeoutMillis:5000,statement_timeout:15000})];
  const clients:import("pg").PoolClient[]=[];
  try {
    for(const pool of pools) clients.push(await pool.connect());
    // Distributed rollout serialization; same database lock order on every invocation.
    for(const [i,client] of clients.entries()) {
      const lock=(await client.query("SELECT pg_try_advisory_lock($1) AS locked",[92017099+i])).rows[0].locked;
      if(!lock) throw new Error("Concurrent database preparation");
      if(Math.floor(Number((await client.query("SHOW server_version_num")).rows[0].server_version_num)/10000)!==17) throw new Error("PostgreSQL 17 schema contract required");
    }
    const contracts=contract.contracts as SchemaContract[];
    if(contracts.length!==2 || contracts[0].schema!=="hermes_agui_host" || contracts[1].schema!=="hermes_agui_runtime") throw new Error("Invalid schema contract targets");
    const operation=operations[command];
    if(!Object.hasOwn(operations,command)) throw new Error("Unknown database preparation command");
    return await operation({clients,contracts,policy,config,grants:contract.grants});
  } finally {
    for(const client of clients) client.release(true);
    await Promise.all(pools.map(p=>p.end()));
  }
}
if(process.argv[1]?.endsWith("deployment-cli.ts")) {
  deployment(process.argv[2],process.env.RUNTIME_CONFIG??"/etc/hermes/runtime.json",
    process.env.SCHEMA_CONTRACT??"/app/server/storage/schema-contract.json")
    .then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error(error instanceof Error?error.message:"Database preparation failed");process.exitCode=1;});
}
