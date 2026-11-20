"""Disposable PG17 backup/restore with external object manifest verification."""
from pathlib import Path
import sqlite3
import subprocess
from tempfile import TemporaryDirectory
from uuid import uuid4

import psycopg
from psycopg_pool import ConnectionPool
from hermes_agui.storage.objects import FilesystemObjects
from hermes_agui.storage.profile import BotScope, ProfileObjects
from hermes_agui.storage.runs import PostgresRunStore

url = 'postgresql://postgres:local-acceptance-only@127.0.0.1:55432/postgres'
container = 'hermes-part2-local-pg-20261120'
scope = BotScope(str(uuid4()), 'restore-owner', 'bot')
with TemporaryDirectory(prefix='part2-restore-', dir='/private/tmp') as directory:
    root = Path(directory)
    source = root / 'source'
    source.mkdir()
    (source / 'SOUL.md').write_text('Local durable restore verification')
    # health: allow HX015 -- disposable offline SQLite fixture; no Hermes session owns this scratch database
    with sqlite3.connect(source / 'state.db') as database:
        database.execute('CREATE TABLE evidence(value text)')
        database.execute("INSERT INTO evidence VALUES ('committed native snapshot')")
    objects = ProfileObjects(FilesystemObjects(root / 'external-objects'))
    with ConnectionPool(url, min_size=1, max_size=2) as pool:
        with pool.connection() as connection:
            connection.execute('INSERT INTO hermes_agui_host.bot_state(project,principal,bot) VALUES(%s,%s,%s)',
                               (scope.project, scope.principal, scope.bot))
        runs = PostgresRunStore(pool)
        lease = runs.begin(scope, 'thread', 'run', uuid4(), 90)
        manifest = objects.stage(scope, source)
        assert runs.finish(lease, status='completed', profile=manifest)
    backup = root / 'database.dump'
    with backup.open('wb') as output:
        subprocess.run(['docker', 'exec', container, 'pg_dump', '-U', 'postgres', '-Fc', 'postgres'], stdout=output, check=True, timeout=60)
    with psycopg.connect(url, autocommit=True) as connection:
        connection.execute('CREATE DATABASE restored')
    with backup.open('rb') as data:
        subprocess.run(['docker', 'exec', '-i', container, 'pg_restore', '-U', 'postgres', '--exit-on-error', '-d', 'restored'], stdin=data, check=True, timeout=60)
    with ConnectionPool(url.removesuffix('/postgres') + '/restored', min_size=1, max_size=2) as pool:
        runs = PostgresRunStore(pool)
        assert runs.get(scope, 'run').status == 'completed'
        assert runs.profile(scope) == manifest
        target = root / 'hydrated'
        target.mkdir()
        objects.hydrate(scope, manifest, target)
        assert (target / 'SOUL.md').read_bytes() == (source / 'SOUL.md').read_bytes()
        # health: allow HX015 -- offline restored snapshot; no active Hermes writer or production profile
        with sqlite3.connect(target / 'state.db') as database:
            assert database.execute('SELECT value FROM evidence').fetchone() == ('committed native snapshot',)
        with pool.connection() as connection:
            assert connection.execute('SELECT count(*) FROM hermes_agui_host_migrations.host').fetchone() == (6,)
            assert connection.execute('SELECT count(*) FROM hermes_agui_runtime_migrations.runtime').fetchone() == (8,)
    print('PG17 dump/restore, migration ledgers, profile manifest/generation/checksum and native SQLite recovery: PASS')
    print('External filesystem objects are a contract double; GCS/PITR/image rollback are NOT RUN')
