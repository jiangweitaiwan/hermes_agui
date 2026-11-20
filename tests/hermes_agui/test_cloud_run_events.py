"""Real PostgreSQL contracts for scoped replay, cancellation and crash reconciliation."""

from dataclasses import replace
import os
from uuid import uuid4

from ag_ui.core import RunErrorEvent, RunStartedEvent
import pytest

from hermes_agui.storage.profile import BotScope
from hermes_agui.storage.run_events import RunEvents
from hermes_agui.storage.runs import PostgresRunStore


@pytest.fixture
def stores():
    socket = os.environ.get("HERMES_AGUI_TEST_DB_SOCKET")
    if not socket:
        pytest.skip("Requires disposable migrated PostgreSQL")
    from psycopg_pool import ConnectionPool

    url = f"host={socket} dbname=postgres user=hermes"
    with ConnectionPool(url, min_size=1, max_size=2) as first, ConnectionPool(url, min_size=1, max_size=2) as second:
        scope = BotScope(str(uuid4()), "owner", "bot")
        with first.connection() as connection:
            connection.execute("INSERT INTO hermes_agui_host.bot_state(project,principal,bot) VALUES (%s,%s,%s)",
                               (scope.project, scope.principal, scope.bot))
        yield scope, PostgresRunStore(first), RunEvents(first), RunEvents(second)


def test_replay_and_cancel_share_scope_and_terminal_authority(stores):
    scope, runs, owner, remote = stores
    lease = runs.begin(scope, "thread", "run", uuid4(), 90)
    assert owner.append(lease, RunStartedEvent(thread_id="thread", run_id="run")) == 1
    stranger = replace(scope, principal="other")
    assert remote.replay(stranger, "thread", "run", 0) == []
    assert not remote.cancel(stranger, "thread")
    assert remote.replay(scope, "wrong-thread", "run", 0) == []
    assert not owner.cancelled(lease)
    assert remote.cancel(scope, "thread")
    assert owner.cancelled(lease)
    assert runs.finish(lease, status="completed")
    assert runs.get(scope, "run").status == "interrupted"
    assert owner.append(lease, RunErrorEvent(message="cancelled")) == 2
    assert [item["seq"] for item in remote.replay(scope, "thread", "run", 0)] == [1, 2]
    assert [item["seq"] for item in remote.replay(scope, "thread", "run", 1)] == [2]
    with pytest.raises(RuntimeError, match="terminal"):
        owner.append(lease, RunErrorEvent(message="duplicate"))


def test_crash_reconcile_preserves_events_and_rejects_stale_owner(stores):
    scope, runs, owner, remote = stores
    lease = runs.begin(scope, "thread", "run", uuid4(), 90)
    owner.append(lease, RunStartedEvent(thread_id="thread", run_id="run"))
    with runs.pool.connection() as connection:
        connection.execute("UPDATE hermes_agui_host.bot_state SET expires_at=clock_timestamp()-interval '1 second' WHERE project=%s",
                           (scope.project,))
    assert remote.reconcile() >= 1
    assert runs.get(scope, "run").status == "interrupted"
    with runs.pool.connection() as connection:
        connection.execute("UPDATE hermes_agui_host.runs SET finished_at=clock_timestamp()-interval '31 seconds' WHERE project=%s",
                           (scope.project,))
    remote.reconcile()
    remote.reconcile()
    replay = remote.replay(scope, "thread", "run", 0)
    assert [item["event"]["type"] for item in replay] == ["RUN_STARTED", "RUN_ERROR"]
    replacement = runs.begin(scope, "thread", "replacement", uuid4(), 90)
    assert replacement.fence > lease.fence
    with pytest.raises(RuntimeError, match="ownership"):
        owner.append(lease, RunErrorEvent(message="stale"))
    assert runs.finish(replacement, status="failed")
