"""Host-owned completion notifications, with at-least-once delivery."""

from contextlib import contextmanager
from dataclasses import dataclass
from typing import Protocol

from hermes_agui.storage.profile import BotScope, FileRevision, ProfileRevision


@dataclass(frozen=True)
class RunCompletion:
    id: int
    scope: BotScope
    run_id: str
    profile_revision: str
    attempt: int
    evidence_generation: str | None = None


class RunCompletionDispatcher(Protocol):
    def deliver(self, event: RunCompletion) -> None:
        """Return after accepting the event durably, deduplicating by scope and run ID."""
        ...


class PostgresRunOutbox:
    def __init__(self, pool):
        self.pool = pool

    @contextmanager
    def delivery_guard(self):
        with self.pool.connection() as conn, conn.transaction():
            row = conn.execute("SELECT hermes_agui_host.acquire_completion_delivery()").fetchone()
            if row is None or not row[0]:
                raise RuntimeError("Completion consumers sealed")
            yield

    def claim(self, *, seconds: int = 60, event_id: int | None = None) -> RunCompletion | None:
        if not 1 <= seconds <= 300:
            raise ValueError("Invalid delivery lease")
        with self.pool.connection() as conn:
            row = conn.execute("""WITH selected AS (
                SELECT id FROM hermes_agui_host.run_outbox
                WHERE (%s::bigint IS NULL OR id=%s) AND ((status='pending' AND available_at <= clock_timestamp())
                   OR (status='leased' AND lease_until <= clock_timestamp()))
                ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            UPDATE hermes_agui_host.run_outbox event
            SET status='leased', attempts=attempts+1,
                lease_until=clock_timestamp()+make_interval(secs => %s)
            FROM selected WHERE event.id=selected.id
            RETURNING event.id,project,principal,bot,run_id,profile_revision,attempts,evidence_generation""",
            (event_id, event_id, seconds)).fetchone()
        if row is None:
            return None
        event_id, project, principal, bot, run_id, revision, attempt, generation = row
        return RunCompletion(event_id, BotScope(project, principal, bot), run_id, revision, attempt, generation)

    def state(self, event_id):
        with self.pool.connection() as conn:
            row = conn.execute("SELECT status FROM hermes_agui_host.run_outbox WHERE id=%s",
                               (event_id,)).fetchone()
        return row[0] if row else None

    def acknowledge(self, event: RunCompletion) -> bool:
        with self.pool.connection() as conn:
            updated = conn.execute("""UPDATE hermes_agui_host.run_outbox SET status='delivered',
                lease_until=NULL, delivered_at=clock_timestamp()
                WHERE id=%s AND status='leased' AND attempts=%s AND lease_until > clock_timestamp()""",
                (event.id, event.attempt))
        return updated.rowcount == 1

    def profile(self, event: RunCompletion) -> ProfileRevision:
        scope = event.scope
        with self.pool.connection() as conn:
            row = conn.execute("""SELECT profile FROM hermes_agui_host.run_outbox
                WHERE id=%s AND (project,principal,bot,run_id)=(%s,%s,%s,%s)
                    AND profile_revision=%s""",
                (event.id, scope.project, scope.principal, scope.bot, event.run_id, event.profile_revision),
            ).fetchone()
        if row is None:
            raise LookupError("Unknown run completion")
        profile = row[0]
        return ProfileRevision(profile["revision"], tuple(FileRevision(**item) for item in profile["files"]))

    def retry(self, event: RunCompletion, *, seconds: int, permanent: bool = False) -> bool:
        if not 1 <= seconds <= 86400:
            raise ValueError("Invalid retry delay")
        with self.pool.connection() as conn:
            updated = conn.execute("""UPDATE hermes_agui_host.run_outbox SET status=%s,
                lease_until=NULL, available_at=clock_timestamp()+make_interval(secs => %s)
                WHERE id=%s AND status='leased' AND attempts=%s AND lease_until > clock_timestamp()""",
                ("failed" if permanent else "pending", seconds, event.id, event.attempt))
        return updated.rowcount == 1

    def dispatch_once(self, dispatcher: RunCompletionDispatcher, *, lease_seconds: int = 60) -> RunCompletion | None:
        with self.delivery_guard():
            return self._dispatch_once(dispatcher, lease_seconds=lease_seconds)

    def _dispatch_once(self, dispatcher, *, lease_seconds):
        event = self.claim(seconds=lease_seconds)
        if event is None:
            return None
        try:
            dispatcher.deliver(event)
        except Exception:  # health: allow BLE001 -- a delivery error leaves the event eligible for retry
            self.retry(event, seconds=min(300, 2 ** min(event.attempt, 9)))
            raise
        if not self.acknowledge(event):
            raise RuntimeError("Run completion delivery lease expired before acknowledgement")
        return event
