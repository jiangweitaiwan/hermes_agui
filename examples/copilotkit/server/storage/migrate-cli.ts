import { readdir, readFile } from "node:fs/promises";
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
    await client.query("CREATE SCHEMA IF NOT EXISTS hermes_agui_runtime_migrations");
    await client.query(
      "CREATE TABLE IF NOT EXISTS hermes_agui_runtime_migrations.runtime (name text PRIMARY KEY)",
    );
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM hermes_agui_runtime_migrations.runtime",
    );
    const applied = new Set(rows.map(row => row.name));
    const root = new URL("./migrations/", import.meta.url);
    for (const name of (await readdir(root)).filter(name => name.endsWith(".sql")).sort()) {
      if (applied.has(name)) continue;
      const sql = migrationSql(await readFile(new URL(name, root), "utf8"));
      try {
        await client.query("BEGIN");
        if (!(await legacyMigrationApplied(client, name)) && sql.trim()) await client.query(sql);
        await client.query("INSERT INTO hermes_agui_runtime_migrations.runtime VALUES ($1)", [name]);
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
