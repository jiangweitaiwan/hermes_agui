/** Owner-side clean operations; the deployment CLI holds preparation locks. */
import { Pool, type PoolClient } from "pg";
import { ResetIntent, resetPreflight, verifyIsolated, resetOwner, assertCleanGeneration, credentialURL } from "./clean-reset";
export interface CleanConfig {
  oldRoles:string[];newRoles:string[];bindingsHash:string;oldCredentials:{env:string;role:string}[];credentials:{env:string;role:string}[];
}
interface Context {clients:PoolClient[];config:{cleanBootstrap?:CleanConfig}}
interface Prepared {intent:ResetIntent;config:CleanConfig;targets:{database:string;owner:string;oid:string}[]}
export function validateCredentialInventory(credentials:{env:string;role:string}[], encoded:string|undefined,prefix:string,roles:string[],urls:string[]) {
  if(!Array.isArray(credentials) || !credentials.length) throw new Error("Credential inventory missing");
  const actual=JSON.parse(encoded??"null");
  if(!Array.isArray(actual) || JSON.stringify([...actual].sort())!==JSON.stringify(credentials.map(c=>c.env).sort())) throw new Error("Every mounted credential must be validated");
  for(const binding of credentials) {
    if(!new RegExp(`^${prefix}[A-Z_]+_URL$`).test(binding.env) || !roles.includes(binding.role)) throw new Error("Invalid credential inventory binding");
    const url=process.env[binding.env];
    if(!url || decodeURIComponent(credentialURL(url).username)!==binding.role) throw new Error("Application DSN role mismatch; owner/unknown aliases cannot be reset");
    urls.push(url);
  }
}
async function prepare(context:Context):Promise<Prepared> {
  const intent=ResetIntent.parse(JSON.parse(process.env.CLEAN_BOOTSTRAP_INTENT??"null"));
  const config=context.config.cleanBootstrap;
  if(!config) throw new Error("Reviewed clean bootstrap provisioning missing");
  if(config.bindingsHash!==process.env.CLEAN_BINDINGS_HASH) throw new Error("Application Secret binding inventory does not match approved preparation config");
  const urls=[process.env.AGUI_HOST_DATABASE_URL!,process.env.AGUI_RUNTIME_DATABASE_URL!,process.env.AGUI_LLM_ADMIN_DATABASE_URL!];
  const credentials=config.credentials;
  validateCredentialInventory(credentials,process.env.CLEAN_NEW_CREDENTIAL_ENVS,"AGUI_CLEAN_",config.newRoles,urls);
  validateCredentialInventory(config.oldCredentials,process.env.CLEAN_OLD_CREDENTIAL_ENVS,"AGUI_OLD_",config.oldRoles,urls);
  if(!Array.isArray(credentials) || credentials.length!==config.newRoles.length ||
    new Set(credentials.map(c=>c.role)).size!==credentials.length || credentials.some(c=>!config.newRoles.includes(c.role))) throw new Error("New DSN credential inventory incomplete");
  const targets=await resetPreflight(context.clients,intent,urls);
  await assertCleanGeneration(context.clients,intent);
  return {intent,config,targets};
}
async function preflight(context:Context,{intent,config,targets}:Prepared) {
  await verifyIsolated(context.clients[0],config.oldRoles,config.newRoles,false);
  const client=context.clients[0];
  const fn=(await client.query("SELECT to_regprocedure('hermes_deployment.isolate_old_writers(text[])') AS name")).rows[0].name;
  if(!fn || !(await client.query("SELECT has_function_privilege(current_user,'hermes_deployment.isolate_old_writers(text[])','EXECUTE') AS allowed")).rows[0].allowed) throw new Error("One-time isolation provisioning required");
  for(const binding of config.credentials) {
    const pool=new Pool({connectionString:process.env[binding.env],max:1,connectionTimeoutMillis:5000});
    try {
      const row=(await pool.query("SELECT current_user AS role,current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid")).rows[0];
      if(row.role!==binding.role || row.database!==intent.database || row.oid!==targets[0].oid) throw new Error("New application login cannot reach expected database");
    } finally {await pool.end();}
  }
  return {status:"RESET_PREFLIGHT",targets};
}
async function recovery(context:Context,{intent}:Prepared) {
  for(const [index,client] of context.clients.entries()) {
    const schema=index===0?"hermes_agui_host":"hermes_agui_runtime";
    if((await client.query("SELECT to_regclass($1) AS name",[`${schema}.deployment_epoch`])).rows[0].name) {
      const row=(await client.query(`SELECT epoch::text,operation,resumed FROM ${schema}.deployment_epoch WHERE singleton`)).rows[0];
      if(!row || (row.operation===intent.operation && row.resumed)) throw new Error("Admission already resumed; reset recovery prohibited");
    }
  }
  return {status:"RECOVERY_CHECKED"};
}
async function reset(context:Context,{intent,targets}:Prepared) {
  const commits=[];
  for(const [index,client] of context.clients.entries()) {
    const commit=await resetOwner(client,index,intent);
    commits.push(commit);console.log(JSON.stringify({event:"clean_reset_commit",...commit}));
  }
  return {status:"RESET_COMMITTED",commits,targets};
}
async function initializeEpoch(context:Context,{intent}:Prepared) {
  for(const [index,client] of context.clients.entries()) {
    const schema=index===0?"hermes_agui_host_migrations":"hermes_agui_runtime_migrations";
    const marker=(await client.query(`SELECT operation,epoch::text FROM ${schema}.clean_reset WHERE singleton`)).rows[0];
    if(!marker || marker.operation!==intent.operation || marker.epoch!==intent.epoch) throw new Error("Epoch requires matching committed reset markers");
  }
  for(const [index,client] of context.clients.entries()) {
    const schema=index===0?"hermes_agui_host":"hermes_agui_runtime";
    const row=(await client.query(`SELECT epoch::text,operation,resumed FROM ${schema}.deployment_epoch WHERE singleton`)).rows[0];
    if(!row || row.resumed || (row.epoch && (row.epoch!==intent.epoch || row.operation!==intent.operation))) throw new Error("Epoch cannot be overwritten");
    await client.query(`UPDATE ${schema}.deployment_epoch SET epoch=$1,operation=$2 WHERE singleton AND epoch IS NULL`,[intent.epoch,intent.operation]);
  }
  return {status:"EPOCH_INITIALIZED",epoch:intent.epoch};
}
const handlers:Record<string,(context:Context,prepared:Prepared)=>Promise<{status:string;[key:string]:unknown}>>={
  reset,epoch:initializeEpoch,"recovery-check":recovery,
  "reset-host":async(context,{intent})=>resetOwner(context.clients[0],0,intent),
  "reset-runtime":async(context,{intent})=>resetOwner(context.clients[1],1,intent),
  isolate:async(_context,{targets})=>({status:"ISOLATED",targets}),
  "verify-isolation":async(_context,{targets})=>({status:"ISOLATED",targets}),
};
export async function cleanOperation(context:Context,command:string) {
  const prepared=await prepare(context);
  if(command==="reset-preflight") return preflight(context,prepared);
  if(command==="isolate") await context.clients[0].query("SELECT hermes_deployment.isolate_old_writers($1::text[])",[prepared.config.oldRoles]);
  await verifyIsolated(context.clients[0],prepared.config.oldRoles,prepared.config.newRoles);
  if(!Object.hasOwn(handlers,command)) throw new Error("Unknown clean operation");
  return handlers[command](context,prepared);
}
