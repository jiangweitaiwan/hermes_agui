"""Explicit Host schema-owner migration command, never run by application startup."""

import os
from pathlib import Path


def main():
    import psycopg

    with psycopg.connect(os.environ["AGUI_HOST_DATABASE_URL"]) as connection, connection.transaction():
        connection.execute("SELECT pg_advisory_xact_lock(92017001)")
        connection.execute("CREATE SCHEMA IF NOT EXISTS hermes_agui_host_migrations")
        connection.execute("CREATE TABLE IF NOT EXISTS hermes_agui_host_migrations.host (name text PRIMARY KEY)")
        applied = {row[0] for row in connection.execute("SELECT name FROM hermes_agui_host_migrations.host")}
        for path in sorted(Path(__file__).with_name("migrations").glob("*.sql")):
            if path.name in applied:
                continue
            sql = "\n".join(line for line in path.read_text().splitlines() if line.strip().upper() not in {"BEGIN;", "COMMIT;"})
            connection.execute(sql)
            connection.execute("INSERT INTO hermes_agui_host_migrations.host VALUES (%s)", (path.name,))
            print(path.name)


if __name__ == "__main__":
    main()
