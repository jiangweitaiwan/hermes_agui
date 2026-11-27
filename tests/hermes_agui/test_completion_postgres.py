"""Real PG17 rollback, concurrent targeted claim and stale-attempt fencing."""
import os
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from uuid import uuid4

import pytest

from hermes_agui.storage.profile import BotScope, ProfileRevision
from hermes_agui.storage.run_outbox import PostgresRunOutbox
from hermes_agui.storage.runs import PostgresRunStore
from hermes_agui.storage.completion_http import process


@pytest.fixture
def storage(monkeypatch):
    psycopg = pytest.importorskip('psycopg')
    from psycopg_pool import ConnectionPool
    from hermes_agui.storage.migrate import main
    socket = os.environ.get('HERMES_AGUI_TEST_DB_SOCKET')
    source = 'postgresql://hermes@/postgres?host=' + socket if socket else None
    if not source:
        pytest.skip('Disposable local PG17 required')
    from urllib.parse import urlsplit, urlunsplit
    parsed = urlsplit(source)
    assert socket.startswith('/tmp/') or socket.startswith('/var/run/')
    name = 'event_' + uuid4().hex
    with psycopg.connect(source, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE {name}')
        target = urlunsplit(parsed._replace(path='/' + name))
        try:
            monkeypatch.setenv('AGUI_HOST_DATABASE_URL', target)
            main()
            with ConnectionPool(target, min_size=1, max_size=4) as pool:
                assert int(pool.get_stats()['pool_size']) >= 1
                scope = BotScope('p','u','bot')
                with pool.connection() as conn:
                    conn.execute("INSERT INTO hermes_agui_host.bot_state(project,principal,bot) VALUES('p','u','bot')")
                yield pool, scope
        finally:
            admin.execute(f'DROP DATABASE {name} WITH (FORCE)')


def test_postcommit_notification_and_rollback(storage):
    from psycopg.errors import CheckViolation
    pool, scope = storage
    seen = []
    outbox = PostgresRunOutbox(pool)
    def notify(identifier):
        # A different connection can observe it: notification cannot precede commit.
        assert outbox.state(identifier) == 'pending'
        seen.append(identifier)
    runs = PostgresRunStore(pool, publish_completions=True, completion_tasks=SimpleNamespace(notify=notify))
    lease = runs.begin(scope, 'thread', 'run', uuid4(), 90)
    profile = ProfileRevision('a'*32, ())
    with pool.connection() as conn:
        conn.execute('ALTER TABLE hermes_agui_host.run_outbox ADD CONSTRAINT injected CHECK(false)')
    with pytest.raises(CheckViolation):
        runs.finish(lease, status='completed', profile=profile)
    assert not seen and runs.get(scope, 'run').status == 'running'
    with pool.connection() as conn:
        conn.execute('ALTER TABLE hermes_agui_host.run_outbox DROP CONSTRAINT injected')
    assert runs.finish(lease, status='completed', profile=profile)
    assert len(seen) == 1
    assert not runs.finish(lease, status='completed', profile=profile)
    assert len(seen) == 1


def test_concurrent_targeted_claim_and_expired_fences(storage):
    pool, scope = storage
    runs = PostgresRunStore(pool, publish_completions=True)
    lease = runs.begin(scope, 'thread', 'run', uuid4(), 90)
    assert runs.finish(lease, status='completed', profile=ProfileRevision('a'*32, ()))
    outbox = PostgresRunOutbox(pool)
    with pool.connection() as conn:
        identifier = conn.execute('SELECT id FROM hermes_agui_host.run_outbox').fetchone()[0]
    with ThreadPoolExecutor(max_workers=4) as executor:
        claimed = list(executor.map(lambda _: outbox.claim(event_id=identifier), range(4)))
    assert sum(e is not None for e in claimed) == 1
    old = next(e for e in claimed if e is not None)
    assert process(outbox, None, identifier) == 503
    with pool.connection() as conn:
        conn.execute('UPDATE hermes_agui_host.run_outbox SET lease_until=clock_timestamp() WHERE id=%s',(identifier,))
    current = outbox.claim(event_id=identifier)
    assert current.attempt == old.attempt + 1
    assert not outbox.acknowledge(old) and not outbox.retry(old, seconds=1)
    assert outbox.retry(current, seconds=60)
    assert process(outbox, None, identifier) == 503
    with pool.connection() as conn:
        conn.execute('UPDATE hermes_agui_host.run_outbox SET available_at=clock_timestamp() WHERE id=%s',(identifier,))
    event = outbox.claim(event_id=identifier)
    assert outbox.acknowledge(event)
    assert process(outbox, None, identifier) == 204
    assert outbox.claim(event_id=identifier) is None


def test_seal_waits_for_active_delivery_and_blocks_new_consumers(storage):
    from threading import Event
    from tests.waiting import wait_until
    pool, _ = storage
    entered, release, sealed = Event(), Event(), Event()
    outbox = PostgresRunOutbox(pool)
    def consumer():
        with outbox.delivery_guard():
            entered.set()
            assert release.wait(10)
    def seal():
        with pool.connection() as conn:
            conn.execute('UPDATE hermes_agui_host.deployment_fence SET deliveries_closed=true')
        sealed.set()
    def waiting():
        with pool.connection() as conn:
            return conn.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'").fetchone()[0] > 0
    with ThreadPoolExecutor(max_workers=2) as executor:
        active = executor.submit(consumer)
        assert entered.wait(5)
        sealing = executor.submit(seal)
        try:
            assert wait_until(waiting, timeout=5)
            assert not sealed.is_set()
        finally:
            release.set()
        active.result(timeout=5)
        sealing.result(timeout=5)
    assert sealed.is_set()
    with pytest.raises(RuntimeError, match='sealed'):
        with outbox.delivery_guard():
            pytest.fail('sealed consumer admitted')
    assert process(outbox, None, 999) == 204


def test_enqueue_timeout_retains_completed_run_for_manual_fallback(storage):
    from unittest.mock import Mock
    from hermes_agui.storage.completion_tasks import CompletionTasks
    from hermes_agui.storage.completion_delivery import drain
    pool, scope=storage
    producer=CompletionTasks('project','region','queue','https://host.run.app',
                             'dispatch@project.iam.gserviceaccount.com','x'*32,None)
    producer.enqueue=Mock(side_effect=TimeoutError)
    runs=PostgresRunStore(pool,publish_completions=True,completion_tasks=producer)
    lease=runs.begin(scope,'thread','run',uuid4(),90)
    assert runs.finish(lease,status='completed',profile=ProfileRevision('a'*32,()))
    assert runs.get(scope,'run').status=='completed'
    result=drain(PostgresRunOutbox(pool),SimpleNamespace(deliver=lambda event:None))
    assert result['delivered']==1 and result['retry']==0
