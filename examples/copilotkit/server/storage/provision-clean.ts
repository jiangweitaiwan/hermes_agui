/** Operator-only one-time least-privilege DB provisioning, never called by rollout.
 * The provisioning credential belongs only to this disposable Job, never to apps/CI.
 */
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";

export const LEGACY_ROLES=["hermes_host","hermes_runtime","hermes_llm_admin","hermes_llm_runtime","hermes_llm_reader","hermes_llm_host_reader"] as const;
const Settings=z.object({
  project:z.literal("copilotkit-agui"),instance:z.string().regex(/^copilotkit-agui:asia-east1:[a-z][a-z0-9-]+$/),
  hostOwner:z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  secrets:z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/)),
}).strict();
export async function provision(client:import("pg").PoolClient, hostOwner:string) {
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(hostOwner)) throw new Error("Invalid Host owner");
  const owner=(await client.query("SELECT current_user AS name")).rows[0].name;
  if(LEGACY_ROLES.includes(owner)) throw new Error("Provisioning identity must be separate from application roles");
  for(const role of LEGACY_ROLES) {
    const prior=(await client.query("SELECT rolsuper,rolcreaterole FROM pg_roles WHERE rolname=$1",[role])).rows[0];
    if(!prior || prior.rolsuper || prior.rolcreaterole) throw new Error("Missing/untrusted legacy role");
    if((await client.query("SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname=$1)",[role])).rowCount) throw new Error("Application role owns schemas");
    const next=`${role}_clean`;
    if(!(await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[next])).rowCount) await client.query(`CREATE ROLE ${next} NOLOGIN INHERIT`);
    await client.query(`GRANT ${role} TO ${next}`);
  }
  await client.query("CREATE SCHEMA IF NOT EXISTS hermes_deployment");
  await client.query("REVOKE ALL ON SCHEMA hermes_deployment FROM PUBLIC");
  await client.query(`CREATE OR REPLACE FUNCTION hermes_deployment.isolate_old_writers(requested text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
    DECLARE target text;
    BEGIN
      IF requested IS NULL OR (SELECT array_agg(x ORDER BY x) FROM unnest(requested) x) IS DISTINCT FROM
        ARRAY['hermes_host','hermes_llm_admin','hermes_llm_host_reader','hermes_llm_reader','hermes_llm_runtime','hermes_runtime']::text[] THEN
        RAISE EXCEPTION 'Fixed legacy role inventory required';
      END IF;
      FOREACH target IN ARRAY requested LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=target AND (rolsuper OR rolcreaterole)) OR
          EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname=target)) THEN
          RAISE EXCEPTION 'Legacy role must not be an owner or administrator';
        END IF;
        EXECUTE format('ALTER ROLE %I NOLOGIN',target);
      END LOOP;
      PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=ANY(requested) AND pid<>pg_backend_pid();
    END $fn$`);
  await client.query("REVOKE ALL ON FUNCTION hermes_deployment.isolate_old_writers(text[]) FROM PUBLIC");
  await client.query(`GRANT USAGE ON SCHEMA hermes_deployment TO ${hostOwner}`);
  await client.query(`GRANT EXECUTE ON FUNCTION hermes_deployment.isolate_old_writers(text[]) TO ${hostOwner}`);
}
async function main() {
  const config=Settings.parse(JSON.parse(process.env.CLEAN_PROVISION_CONFIG??"null"));
  if(Object.keys(config.secrets).sort().join()!==[...LEGACY_ROLES].sort().join()) throw new Error("All six role Secret names required");
  const connectionString=process.env.AGUI_PROVISION_DATABASE_URL;
  if(!connectionString) throw new Error("Dedicated provisioning credential required");
  const pool=new Pool({connectionString,max:1}),client=await pool.connect();
  try {
    if((await client.query("SELECT current_database() AS name")).rows[0].name!=="hermes") throw new Error("Existing hermes database required");
    await provision(client,config.hostOwner);
    const cloud=await new GoogleAuth({scopes:["https://www.googleapis.com/auth/cloud-platform"]}).getClient();
    for(const role of LEGACY_ROLES) {
      const next=`${role}_clean`;
      let existing:{name:string;payload:{data:string}}|undefined;
      try {
        existing=(await cloud.request<{name:string;payload:{data:string}}>({url:`https://secretmanager.googleapis.com/v1/projects/${config.project}/secrets/${config.secrets[role]}/versions/latest:access`})).data;
      } catch(error) {
        if((error as {response?:{status:number}}).response?.status!==404) throw error;
      }
      if(existing) {
        const stored=new URL(Buffer.from(existing.payload.data,"base64").toString("utf8"));
        if(decodeURIComponent(stored.username)!==next || stored.searchParams.get("host")!==`/cloudsql/${config.instance}` || stored.pathname!=="/hermes") throw new Error("Provisioned credential target mismatch");
        const verify=new Pool({connectionString:stored.href,max:1,connectionTimeoutMillis:5000});
        try {await verify.query("SELECT 1");} finally {await verify.end();}
        console.log(JSON.stringify({role:next,secretVersion:existing.name,status:"EXISTING"}));
        continue;
      }
      if((await client.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1",[next])).rowCount) throw new Error("Cannot rotate an unpublished credential with active sessions");
      const password=randomBytes(32).toString("hex");
      // Password is random hex; role identifiers come only from the fixed inventory.
      await client.query(`ALTER ROLE ${next} LOGIN PASSWORD '${password}'`);
      const url=new URL(`postgresql://${next}:${password}@localhost/hermes`);
      url.searchParams.set("host",`/cloudsql/${config.instance}`);
      const {data}=await cloud.request<{name:string}>({url:`https://secretmanager.googleapis.com/v1/projects/${config.project}/secrets/${config.secrets[role]}:addVersion`,method:"POST",data:{payload:{data:Buffer.from(url.href).toString("base64")}}});
      console.log(JSON.stringify({role:next,secretVersion:data.name}));
    }
  } finally {client.release();await pool.end();}
}
if(process.argv[1]?.endsWith("provision-clean.ts")) main().catch(()=>{console.error("Clean provisioning failed; inspect provisioning permissions; no reset was performed");process.exitCode=1;});
