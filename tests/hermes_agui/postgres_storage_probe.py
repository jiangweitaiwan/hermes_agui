"""Run against a disposable, migrated PostgreSQL DB using the real psycopg pool."""

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from psycopg.errors import CheckViolation
from psycopg_pool import ConnectionPool

from hermes_agui.storage.objects import FilesystemObjects
from hermes_agui.storage.profile import BotScope, ProfileObjects
from hermes_agui.storage.runs import PostgresRunStore


def main():
    alpha = BotScope("fixture", "alice", "analyst")
    beta = BotScope("fixture", "bob", "analyst")
    with ConnectionPool(os.environ["HERMES_AGUI_TEST_DATABASE_URL"], min_size=1, max_size=4) as pool:
        pool.wait(timeout=10)
        with pool.connection() as conn:
            for scope in (alpha, beta):
                conn.execute("INSERT INTO hermes_agui_host.bot_state (project,principal,bot) VALUES (%s,%s,%s)",
                             (scope.project, scope.principal, scope.bot))
        store = PostgresRunStore(pool)
        with ThreadPoolExecutor(max_workers=2) as executor:
            contenders = list(executor.map(
                lambda n: store.begin(alpha, "thread", f"run{n}", uuid4(), 120), range(2),
            ))
        assert sum(lease is not None for lease in contenders) == 1
        old = next(lease for lease in contenders if lease is not None)
        other = store.begin(beta, "thread", old.run_id, uuid4(), 120)
        assert other is not None and other.fence == 1
        assert store.renew(old, 120)
        with pool.connection() as conn:
            conn.execute("""UPDATE hermes_agui_host.bot_state SET expires_at=clock_timestamp()
                         WHERE (project,principal,bot)=(%s,%s,%s)""", (alpha.project, alpha.principal, alpha.bot))
        assert store.begin(alpha, "thread", old.run_id, uuid4(), 120) is None
        current = store.begin(alpha, "thread", "replacement", uuid4(), 120)
        assert current is not None and current.fence == old.fence + 1
        with pool.connection() as conn:
            conn.execute("""ALTER TABLE hermes_agui_host.runs
                ADD CONSTRAINT fixture_reject_reason CHECK (reason <> 'injected')""")
        with TemporaryDirectory() as staging:
            check_profile_publication(store, old, current, Path(staging).resolve())
        assert store.profile(beta) is None
        assert store.finish(other, status="failed", reason="fixture")
        interrupted = store.get(alpha, old.run_id)
        assert interrupted is not None and interrupted.status == "interrupted" and interrupted.reason == "lease_expired"
        completed = store.get(alpha, current.run_id)
        assert completed is not None and completed.status == "completed" and completed.lease == current
        assert store.get(beta, current.run_id) is None
    print("PostgreSQL run admission, fencing, profile CAS and scope isolation passed")


def check_profile_publication(store, old, current, root):
    objects = ProfileObjects(FilesystemObjects(root / "objects"))
    source = root / "source"
    source.mkdir()
    (source / "SOUL.md").write_bytes(b"fixture profile")
    scope = current.scope
    manifest = objects.stage(scope, source)
    assert not store.finish(old, status="completed", profile=manifest)
    assert not store.renew(old, 120)
    assert not store.finish(current, status="completed", expected_revision="stale", profile=manifest)
    assert store.profile(scope) is None
    try:
        store.finish(current, status="completed", reason="injected", profile=manifest)
    except CheckViolation:
        assert store.profile(scope) is None
        active = store.get(scope, current.run_id)
        assert active is not None and active.status == "running"
    else:
        raise AssertionError("Injected terminal write failure did not occur")
    assert store.finish(current, status="completed", profile=manifest)
    assert not store.finish(current, status="failed")
    published = store.profile(scope)
    assert published == manifest
    target = root / "target"
    target.mkdir()
    objects.hydrate(scope, published, target)
    assert (target / "SOUL.md").read_bytes() == b"fixture profile"


if __name__ == "__main__":
    main()
