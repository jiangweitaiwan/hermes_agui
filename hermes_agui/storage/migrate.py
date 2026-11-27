"""Explicit Host schema-owner migration command, never run by application startup.

Safe to run again: each migrations/*.sql file commits together with its name in
hermes_agui_host_migrations.host, and a later run skips that name. Add a new
file for further schema changes; already applied files are left untouched.
Legacy direct SQL installations are adopted using their committed schema_version rows.
"""

import hashlib
import os
from pathlib import Path


def _migration_sql(path: Path) -> str:
    # The runner owns the transaction. A script-level BEGIN/COMMIT would commit
    # the schema change before its ledger row and make a re-run apply it twice.
    return "\n".join(
        line
        for line in path.read_text().splitlines()
        if line.strip().upper() not in {"BEGIN;", "COMMIT;"}
    )


def main():
    import psycopg

    # A SQL_ASCII cluster returns ledger names as bytes, which would miss the
    # string filename check and reapply migrations that are already recorded.
    with psycopg.connect(
        os.environ["AGUI_HOST_DATABASE_URL"],
        autocommit=True,
        client_encoding="UTF8",
    ) as connection:
        connection.execute("SELECT pg_advisory_lock(92017001)")
        try:
            present = connection.execute("SELECT to_regclass('hermes_agui_host_migrations.host')").fetchone()[0]
            if not present:
                connection.execute("CREATE SCHEMA IF NOT EXISTS hermes_agui_host_migrations")
                connection.execute("CREATE TABLE hermes_agui_host_migrations.host (name text PRIMARY KEY,sha256 text)")
            if not connection.execute("SELECT 1 FROM information_schema.columns WHERE table_schema='hermes_agui_host_migrations' AND table_name='host' AND column_name='sha256'").fetchone():
                connection.execute("ALTER TABLE hermes_agui_host_migrations.host ADD COLUMN sha256 text")
            applied = dict(connection.execute("SELECT name,sha256 FROM hermes_agui_host_migrations.host ORDER BY name"))
            paths = sorted(Path(__file__).with_name("migrations").glob("*.sql"))
            if list(applied) != [p.name for p in paths[:len(applied)]]:
                raise RuntimeError("Unknown Host migration or ledger gap")
            # SQL files were historically also applied directly, before the ledger
            # existed. Their version rows commit in the same transaction as DDL.
            versions = set()
            if connection.execute(
                "SELECT to_regclass('hermes_agui_host.schema_version')"
            ).fetchone()[0] is not None:
                versions = {
                    row[0]
                    for row in connection.execute(
                        "SELECT version FROM hermes_agui_host.schema_version"
                    )
                }
            legacy_names = {
                "001_host.sql": 1,
                "002_run_outbox.sql": 2,
                "003_completion_evidence.sql": 3,
                "004_managed_bots.sql": 4,
                "005_management_operations.sql": 5,
                "006_run_events.sql": 6,
            }
            for path in paths:
                checksum = hashlib.sha256(path.read_bytes()).hexdigest()
                if path.name in applied:
                    if applied[path.name] and applied[path.name] != checksum:
                        raise RuntimeError("Host migration checksum mismatch")
                    if not applied[path.name]:
                        connection.execute("UPDATE hermes_agui_host_migrations.host SET sha256=%s WHERE name=%s", (checksum,path.name))
                    continue
                with connection.transaction():
                    sql = _migration_sql(path)
                    if legacy_names.get(path.name) not in versions and sql.strip():
                        # Simple query protocol: migration files are multi-statement scripts.
                        connection.execute(sql, prepare=False)
                    connection.execute(
                        "INSERT INTO hermes_agui_host_migrations.host(name,sha256) VALUES (%s,%s)",
                        (path.name,checksum),
                    )
                print(path.name)
            if os.environ.get("AGUI_APPLY_DATABASE_GRANTS") == "true":
                from hermes_agui.storage.migration_grants import apply_host_grants
                apply_host_grants(connection)
        finally:
            connection.execute("SELECT pg_advisory_unlock(92017001)")


if __name__ == "__main__":
    main()
