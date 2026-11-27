import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { legacyMigrationApplied } from "./migration-history.js";

const pool = new Pool({ connectionString: process.env.AGUI_RUNTIME_DATABASE_URL, max: 1 });

function migrationSql(source: string): string {
  // The runner owns the transaction. A script-level BEGIN/COMMIT would commit
  // the schema change before its ledger row and make a re-run apply it twice.
  return source
    .split("\n")
    .filter(line => !["BEGIN;", "COMMIT;"].includes(line.trim().toUpperCase()))
    .join("\n");
}

async function main() {
  if (!process.env.AGUI_RUNTIME_DATABASE_URL) throw new Error("Migration database URL required");
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(92017002)");
    const present=(await client.query("SELECT to_regclass('hermes_agui_runtime_migrations.runtime') AS name")).rows[0].name;
    if(!present) await client.query("CREATE SCHEMA IF NOT EXISTS hermes_agui_runtime_migrations");
    if(!present) await client.query("CREATE TABLE hermes_agui_runtime_migrations.runtime (name text PRIMARY KEY,sha256 text)");
    const hasHash=(await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='hermes_agui_runtime_migrations' AND table_name='runtime' AND column_name='sha256'")).rowCount;
    if(!hasHash) await client.query("ALTER TABLE hermes_agui_runtime_migrations.runtime ADD COLUMN sha256 text");
    const { rows } = await client.query<{ name: string; sha256:string }>(
      "SELECT name,sha256 FROM hermes_agui_runtime_migrations.runtime ORDER BY name",
    );
    const applied = new Set(rows.map(row => row.name));
    const root = new URL("./migrations/", import.meta.url);
    const names=(await readdir(root)).filter(name=>name.endsWith(".sql")).sort();
    if(rows.some((r,i)=>r.name!==names[i])) throw new Error("Unknown migration or ledger gap");
    for (const name of names) {
      const source=await readFile(new URL(name,root),"utf8"), checksum=createHash("sha256").update(source).digest("hex");
      const prior=rows.find(r=>r.name===name);
      if(prior?.sha256 && prior.sha256!==checksum) throw new Error("Migration checksum mismatch");
      if(applied.has(name)) {
        if(!prior?.sha256) await client.query("UPDATE hermes_agui_runtime_migrations.runtime SET sha256=$1 WHERE name=$2",[checksum,name]);
        continue;
      }
      const sql = migrationSql(source);
      try {
        await client.query("BEGIN");
        if (!(await legacyMigrationApplied(client, name)) && sql.trim()) await client.query(sql);
        await client.query("INSERT INTO hermes_agui_runtime_migrations.runtime(name,sha256) VALUES ($1,$2)", [name,checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      console.log(name);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(92017002)").catch(() => undefined);
    client.release();
  }
}

main()
  .catch(() => {
    console.error("Runtime migration failed; check schema-owner access and migration history");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
