/** Catalog contracts are generated from SQL in disposable PostgreSQL during image build. */
import { Pool, type PoolClient } from "pg";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const digest = (s:string) => createHash("sha256").update(s).digest("hex");
export const migrationSQL = (s:string) => s.split("\n").filter(s=>!["BEGIN;","COMMIT;"].includes(s.trim().toUpperCase())).join("\n");

export async function catalog(client: PoolClient, schema: string) {
  const queries = {
    relations: `SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname`,
    columns: `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,co.collname AS collation,pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m') ORDER BY c.relname,a.attnum`,
    constraints: `SELECT c.relname,k.conname,k.convalidated,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname,k.conname`,
    indexes: `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname`,
    sequences: `SELECT sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename`,
    indexValidity: `SELECT c.relname,i.indisvalid,i.indisready,i.indislive FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname`,
    functions: `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 ORDER BY p.proname,arguments`,
    triggers: `SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    policies: `SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname=$1 ORDER BY tablename,policyname`,
  };
  const result:Record<string,unknown> = {};
  await client.query("SET search_path=pg_catalog");
  for (const [key,sql] of Object.entries(queries)) result[key]=(await client.query(sql,[schema])).rows;
  return result;
}
export interface SchemaContract { schema:string; ledger:string; files:{name:string;sha256:string}[]; prefixes:unknown[] }
export async function generate(adminURL:string, root:string, output:string) {
  const admin=new Pool({connectionString:adminURL,max:1});
  const database=`schema_${randomUUID().replaceAll("-","")}`;
  for(const role of ["hermes_host","hermes_runtime","hermes_llm_admin","hermes_llm_runtime","hermes_llm_reader","hermes_llm_host_reader"]) {
    if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[role])).rowCount) await admin.query(`CREATE ROLE ${role} NOLOGIN`);
  }
  await admin.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`);
  const url=new URL(adminURL);url.pathname=`/${database}`;
  const pool=new Pool({connectionString:url.href,max:1}), client=await pool.connect();
  try {
    const contracts:SchemaContract[]=[];
    for (const [schema,ledger,dir] of [
      ["hermes_agui_host","hermes_agui_host_migrations.host",`${root}/hermes_agui/storage/migrations`],
      ["hermes_agui_runtime","hermes_agui_runtime_migrations.runtime",`${root}/examples/copilotkit/server/storage/migrations`],
    ]) {
      const files:SchemaContract["files"]=[],prefixes:unknown[]=[await catalog(client,schema)];
      for(const name of (await readdir(dir)).filter(n=>n.endsWith(".sql")).sort()) {
        const sql=await readFile(`${dir}/${name}`,"utf8");
        await client.query(migrationSQL(sql));
        files.push({name,sha256:digest(sql)});prefixes.push(await catalog(client,schema));
      }
      contracts.push({schema,ledger,files,prefixes});
    }
    const grants:string[]=[];
    for(const name of ["database-grants.sql","llm-control-grants.sql","event-driven-grants.sql"]) {
      const source=(await readFile(`${root}/deploy/gcp/${name}`,"utf8")).split("\n").filter(line=>!line.trimStart().startsWith("--")).join("\n");
      grants.push(...source.split(";").map(s=>s.trim()).filter(s=>s.startsWith("GRANT ") && s.includes("hermes_agui_runtime")));
    }
    await writeFile(output,JSON.stringify({format:1,postgresMajor:17,contracts,grants}));
  } finally {
    client.release();await pool.end();await admin.query(`DROP DATABASE ${database}`);await admin.end();
  }
}
export async function checkSchema(client:PoolClient, contract:SchemaContract) {
  const exists=(await client.query("SELECT to_regclass($1) AS name",[contract.ledger])).rows[0].name;
  const rows=exists?(await client.query(`SELECT * FROM ${contract.ledger} ORDER BY name`)).rows:[];
  let count=rows.length;
  if(count>contract.files.length || rows.some((row,i)=>row.name!==contract.files[i].name || (row.sha256 && row.sha256!==contract.files[i].sha256))) throw new Error(`Unknown migration version/checksum: ${contract.schema}`);
  const actual=JSON.stringify(await catalog(client,contract.schema));
  if(!exists && actual!==JSON.stringify(contract.prefixes[0])) {
    count=contract.prefixes.findIndex(p=>JSON.stringify(p)===actual);
    // Let the existing legacy adoption logic prove/adopt exactly known installations.
    if(count<1) throw new Error(`Unledgered schema drift: ${contract.schema}`);
  }
  if(actual!==JSON.stringify(contract.prefixes[count])) throw new Error(`Schema drift: ${contract.schema} at migration ${count}`);
  if(contract.schema==="hermes_agui_host" && count) {
    const versions=(await client.query("SELECT version FROM hermes_agui_host.schema_version ORDER BY version")).rows.map(r=>r.version);
    if(JSON.stringify(versions)!==JSON.stringify(Array.from({length:count},(_,i)=>i+1))) throw new Error("Host schema version drift");
  }
  return {schema:contract.schema,applied:count,pending:contract.files.length-count};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [,,url,root,output]=process.argv;
  generate(url,root,output).catch(()=>{console.error("Schema reference generation failed");process.exitCode=1;});
}
