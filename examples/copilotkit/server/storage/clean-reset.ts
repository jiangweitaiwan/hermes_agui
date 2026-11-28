/** Fixed schema reset primitives. Called only by the preparation identity. */
import type { PoolClient } from "pg";
import { z } from "zod";
import { databaseTarget } from "../llm/database-target";

export const RESET_SCHEMAS = ["hermes_agui_host", "hermes_agui_host_migrations", "hermes_agui_runtime", "hermes_agui_runtime_migrations"] as const;
export const ResetIntent = z.object({
  operation:z.string().regex(/^[0-9]+$/), epoch:z.string().uuid(),
  project:z.literal("copilotkit-agui"), instance:z.string().regex(/^copilotkit-agui:asia-east1:[a-z][a-z0-9-]+$/),
  database:z.literal("hermes"), source:z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type ResetIntent = z.infer<typeof ResetIntent>;

/** Follow the full pg_depend closure, including columns, rewrites, constraints and types.
 * pg_identify_object resolves catalog-specific namespace membership. Fail on unknown
 * namespaces and on shared/global dependents; never assume a prefix is ours.
 */
export async function dependencyCheck(client:PoolClient) {
  const outside=await client.query(`WITH RECURSIVE doomed(classid,objid,objsubid) AS (
    SELECT 'pg_namespace'::regclass::oid,oid,0 FROM pg_namespace WHERE nspname=ANY($1)
    UNION
    SELECT d.classid,d.objid,d.objsubid FROM pg_depend d JOIN doomed x
      ON d.refclassid=x.classid AND d.refobjid=x.objid AND (x.objsubid=0 OR d.refobjsubid=x.objsubid)
  ) SELECT i.type,i.schema,i.identity FROM doomed x,
    LATERAL pg_identify_object(x.classid,x.objid,x.objsubid) i
    WHERE NOT COALESCE((x.classid='pg_namespace'::regclass AND i.identity=ANY($1)) OR i.schema=ANY($1),false)
      AND NOT ((i.schema IS NULL OR i.schema='pg_toast') AND EXISTS (
        SELECT 1 FROM pg_depend owned JOIN doomed parent
          ON owned.refclassid=parent.classid AND owned.refobjid=parent.objid
          AND (parent.objsubid=0 OR owned.refobjsubid=parent.objsubid)
        WHERE owned.classid=x.classid AND owned.objid=x.objid AND owned.objsubid=x.objsubid
          AND owned.deptype IN ('a','i')))`,[RESET_SCHEMAS]);
  if(outside.rowCount) throw new Error("Reset has dependent objects outside fixed schema allowlist");
  const extension=await client.query(`WITH RECURSIVE doomed(classid,objid,objsubid) AS (
    SELECT 'pg_namespace'::regclass::oid,oid,0 FROM pg_namespace WHERE nspname=ANY($1)
    UNION
    SELECT d.classid,d.objid,d.objsubid FROM pg_depend d JOIN doomed x
      ON d.refclassid=x.classid AND d.refobjid=x.objid AND (x.objsubid=0 OR d.refobjsubid=x.objsubid)
  ) SELECT 1 FROM pg_depend d JOIN doomed x
    ON d.classid=x.classid AND d.objid=x.objid AND d.objsubid=x.objsubid WHERE d.deptype='e'`,[RESET_SCHEMAS]);
  if(extension.rowCount) throw new Error("Reset cannot own extension schemas");
}

/** Reject libpq query overrides and duplicate keys before trusting URI identity. */
export function credentialURL(value:string) {
  const url=new URL(value.replace(/@\//,"@localhost/"));
  const allowed=new Set(["host","port","sslmode","sslrootcert","sslcert","sslkey","connect_timeout","application_name","options","client_encoding"]);
  const keys=[...url.searchParams.keys()];
  if(!["postgres:","postgresql:"].includes(url.protocol) || new Set(keys).size!==keys.length || keys.some(key=>!allowed.has(key))) throw new Error("Ambiguous PostgreSQL credential URI overrides are forbidden");
  return url;
}

export async function resetPreflight(clients:PoolClient[], intent:ResetIntent, urls:string[]) {
  if(urls.some(url=>databaseTarget(url)!==databaseTarget(urls[0]))) throw new Error("Reset DSNs must target the same database");
  for(const url of urls) {
    const parsed=credentialURL(url);
    if(parsed.searchParams.get("host")!==`/cloudsql/${intent.instance}` || decodeURIComponent(parsed.pathname.slice(1))!==intent.database)
      throw new Error("Reset DSN does not match trusted Cloud SQL binding");
  }
  const identities=[];
  for(const [index,client] of clients.entries()) {
    const row=(await client.query(`SELECT current_database() AS database,current_user AS owner,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid`)).rows[0];
    if(row.database!==intent.database) throw new Error("Reset database mismatch");
    const owned=await client.query(`SELECT nspname FROM pg_namespace WHERE nspname=ANY($1) AND nspowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)`,[RESET_SCHEMAS.slice(index*2,index*2+2)]);
    if(owned.rowCount) throw new Error("Schema owner mismatch");
    const create=(await client.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed")).rows[0];
    if(!create.allowed) throw new Error("Schema recreation privilege missing");
    identities.push(row);
  }
  if(identities[0].oid!==identities[1].oid) throw new Error("Database OID mismatch");
  await dependencyCheck(clients[0]);
  return identities;
}

/** Isolation is an enforceable DB state, not a caller-supplied boolean. New runtime
 * logins inherit the existing NOLOGIN capability roles. The provisioning identity
 * must disable the old LOGIN roles and remove all old sessions before this call.
 */
export async function verifyIsolated(client:PoolClient, oldRoles:string[], newRoles:string[], requireStopped=true) {
  const valid=z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)).min(1);
  valid.parse(oldRoles); valid.parse(newRoles);
  if(oldRoles.some(role=>newRoles.includes(role))) throw new Error("Old and new logins overlap");
  const old=(await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolcreaterole FROM pg_roles WHERE rolname=ANY($1)`,[oldRoles])).rows;
  if(old.length!==oldRoles.length || old.some(row=>(requireStopped && row.rolcanlogin) || row.rolsuper || row.rolcreaterole)) throw new Error("Old DB logins are not isolated");
  const active=await client.query("SELECT 1 FROM pg_stat_activity WHERE usename=ANY($1)",[oldRoles]);
  if(requireStopped && active.rowCount) throw new Error("Old DB sessions still exist");
  const unknown=await client.query(`SELECT 1 FROM pg_roles p WHERE p.rolcanlogin AND NOT p.rolsuper AND
    p.rolname<>current_user AND NOT(p.rolname=ANY($1)) AND NOT(p.rolname=ANY($2)) AND
    EXISTS(SELECT 1 FROM pg_roles capability WHERE capability.rolname=ANY($2) AND pg_has_role(p.oid,capability.oid,'MEMBER'))`,[newRoles,oldRoles]);
  if(unknown.rowCount) throw new Error("Unknown application login can inherit Hermes privileges");
  const next=(await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolcreaterole FROM pg_roles WHERE rolname=ANY($1)`,[newRoles])).rows;
  if(next.length!==newRoles.length || next.some(row=>!row.rolcanlogin || row.rolsuper || row.rolcreaterole)) throw new Error("Invalid new application logins");
  // Never let an old login be reached by a new password available to the old identity.
  const privileged=await client.query(`SELECT 1 FROM pg_roles p WHERE p.rolname=ANY($1) AND
    (pg_has_role(p.oid,(SELECT oid FROM pg_roles WHERE rolname=current_user),'MEMBER') OR
    EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=ANY($2) AND pg_has_role(p.oid,n.nspowner,'MEMBER')))`,[newRoles,RESET_SCHEMAS]);
  if(privileged.rowCount) throw new Error("Application login can assume schema owner");
}

/** One committed marker per owner, in the retained migration schema. A crash after
 * COMMIT is reconciled from this marker; re-entry of the same operation never DROP.
 * The orchestrator's create-only journal rejects successful workflow reruns.
 */
export async function resetOwner(client:PoolClient,index:number,intent:ResetIntent) {
  if(index!==0 && index!==1) throw new Error("Invalid reset owner");
  const schema=index===0?"hermes_agui_host_migrations":"hermes_agui_runtime_migrations";
  const marker=`${schema}.clean_reset`;
  const exists=(await client.query("SELECT to_regclass($1) AS name",[marker])).rows[0].name;
  if(exists) {
    const prior=(await client.query(`SELECT operation,epoch::text FROM ${marker} WHERE singleton`)).rows[0];
    if(!prior) throw new Error("Reset commit marker incomplete");
    if(prior.operation===intent.operation) {
      if(prior.epoch!==intent.epoch) throw new Error("Reset operation epoch mismatch");
      return {status:"ALREADY_RESET",schema,operation:intent.operation,epoch:intent.epoch};
    }
    // A different dispatch operation has a new create-only journal and explicit reset confirmation.
  }
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    const lock=92017001+index;
    if(!(await client.query("SELECT pg_try_advisory_xact_lock($1) AS locked",[lock])).rows[0].locked) throw new Error("Concurrent schema migration");
    await dependencyCheck(client);
    // Identifiers below are literal constants. No input can select another schema.
    if(index===0) await client.query("DROP SCHEMA IF EXISTS hermes_agui_host,hermes_agui_host_migrations CASCADE; CREATE SCHEMA hermes_agui_host_migrations");
    else if(index===1) await client.query("DROP SCHEMA IF EXISTS hermes_agui_runtime,hermes_agui_runtime_migrations CASCADE; CREATE SCHEMA hermes_agui_runtime_migrations");
    else throw new Error("Invalid reset owner");
    await client.query(`CREATE TABLE ${marker}(singleton boolean PRIMARY KEY CHECK(singleton),operation text NOT NULL,epoch uuid NOT NULL)`);
    await client.query(`INSERT INTO ${marker} VALUES(true,$1,$2)`,[intent.operation,intent.epoch]);
    await client.query("COMMIT");
    return {status:"RESET_COMMITTED",schema,operation:intent.operation,epoch:intent.epoch};
  } catch(error) {await client.query("ROLLBACK");throw error;}
}

/** The shipped provisioning isolates legacy roles once. A completed clean generation
 * cannot be reset with those legacy-only credentials again: its current LOGINs
 * would still be valid. Require separately reviewed provisioning for another reset.
 */
export async function assertCleanGeneration(clients:PoolClient[],intent:ResetIntent) {
  for(const [index,client] of clients.entries()) {
    const table=index===0?"hermes_agui_host.deployment_epoch":"hermes_agui_runtime.deployment_epoch";
    if(!(await client.query("SELECT to_regclass($1) AS name",[table])).rows[0].name) continue;
    const row=(await client.query(`SELECT epoch::text,operation FROM ${table} WHERE singleton`)).rows[0];
    if(!row || (row.epoch!==null && (row.epoch!==intent.epoch || row.operation!==intent.operation)))
      throw new Error("Existing clean generation requires new reviewed identity-isolation provisioning; legacy provisioning cannot reset it again");
  }
}
