"""Apply the existing Host grants atomically, once per grant-file checksum."""
import hashlib
from pathlib import Path


def apply_host_grants(connection):
    path = Path(__file__).resolve().parents[2] / 'deploy/gcp/database-grants.sql'
    source = '\n'.join(line for line in path.read_text().splitlines() if not line.lstrip().startswith('--'))
    statements = [part.strip() for part in source.split(';')
                  if part.strip().upper().startswith('GRANT ') and 'hermes_agui_host' in part]
    checksum = hashlib.sha256('\n'.join(statements).encode()).hexdigest()
    table = 'hermes_agui_host_migrations.grants'
    exists = connection.execute('SELECT to_regclass(%s)', (table,)).fetchone()[0]
    if exists:
        row = connection.execute(f'SELECT sha256 FROM {table} WHERE name=%s', ('host',)).fetchone()
        if row and row[0] == checksum:
            return
    with connection.transaction():
        if not exists:
            connection.execute(f'CREATE TABLE {table} (name text PRIMARY KEY, sha256 text NOT NULL)')
        for statement in statements:
            connection.execute(statement)
        connection.execute(f'INSERT INTO {table}(name,sha256) VALUES (%s,%s) '
                           'ON CONFLICT(name) DO UPDATE SET sha256=EXCLUDED.sha256', ('host',checksum))
