import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, test } from "vitest";

const databaseUrl = process.env.AGUI_MIGRATION_TEST_DATABASE_URL;

test.skipIf(!databaseUrl).each([0, 1, 10])("migrates legacy prefix %i and safely reruns", async prefix => {
  const admin = new Pool({ connectionString: databaseUrl });
  const database = `migration_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href });
  try {
    const root = new URL("../server/storage/migrations/", import.meta.url);
    const names = (await readdir(root)).filter(name => name.endsWith(".sql")).sort();
    for (const name of names.slice(0, prefix)) {
      await pool.query(await readFile(new URL(name, root), "utf8"));
    }
    if (prefix) {
      await pool.query(`INSERT INTO hermes_agui_runtime.thread_mappings
        (project,principal,bot,browser_thread,host_thread) VALUES ('p','u','bot','browser','host')`);
    }
    const run = () => execFileSync(process.execPath,
      ["--import", "tsx", "server/storage/migrate-cli.ts"],
      { env: { ...process.env, AGUI_RUNTIME_DATABASE_URL: url.href }, encoding: "utf8" });
    run();
    expect(run()).toBe("");
    const result = await pool.query("SELECT name FROM hermes_agui_runtime_migrations.runtime ORDER BY name");
    expect(result.rows.map(row => row.name)).toEqual(names);
    if (prefix) {
      expect((await pool.query("SELECT host_thread FROM hermes_agui_runtime.thread_mappings")).rows)
        .toEqual([{ host_thread: "host" }]);
    }
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
}, 30_000);
