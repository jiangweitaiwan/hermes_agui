import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.AGUI_RUNTIME_DATABASE_URL, max: 1 });
async function main() {
  if (!process.env.AGUI_RUNTIME_DATABASE_URL) throw new Error("Migration database URL required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(92017002)");
    await client.query("CREATE SCHEMA IF NOT EXISTS hermes_agui_runtime_migrations");
    await client.query("CREATE TABLE IF NOT EXISTS hermes_agui_runtime_migrations.runtime (name text PRIMARY KEY)");
    const { rows } = await client.query<{ name: string }>("SELECT name FROM hermes_agui_runtime_migrations.runtime");
    const root = new URL("./migrations/", import.meta.url);
    for (const name of (await readdir(root)).filter(name => name.endsWith(".sql")).sort()) {
      if (rows.some(row => row.name === name)) continue;
      const sql = (await readFile(new URL(name, root), "utf8")).split("\n").filter(line => !["BEGIN;", "COMMIT;"].includes(line.trim().toUpperCase())).join("\n");
      await client.query(sql);
      await client.query("INSERT INTO hermes_agui_runtime_migrations.runtime VALUES ($1)", [name]);
      console.log(name);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
main().catch(() => { console.error("Runtime migration failed; check schema-owner access and migration history"); process.exitCode = 1; }).finally(() => pool.end());
