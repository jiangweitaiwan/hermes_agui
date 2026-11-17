"""Host PostgreSQL run leases and fenced profile publication."""

from dataclasses import asdict, dataclass
from datetime import datetime
import json
from typing import Literal
from uuid import UUID

from hermes_agui.storage.profile import BotScope, FileRevision, ProfileRevision

TerminalStatus = Literal["completed", "failed", "interrupted"]


@dataclass(frozen=True)
class RunLease:
    scope: BotScope
    run_id: str
    attempt: UUID
    fence: int


@dataclass(frozen=True)
class RunRecord:
    lease: RunLease
    thread_id: str
    status: Literal["running"] | TerminalStatus
    created_at: datetime
    heartbeat_at: datetime
    finished_at: datetime | None
    reason: str | None


class PostgresRunStore:
    """Use a bounded psycopg pool supplied by the Host application."""

    def __init__(self, pool):
        self.pool = pool

    def begin(self, scope: BotScope, thread_id: str, run_id: str, attempt: UUID, seconds: int) -> RunLease | None:
        with self.pool.connection() as conn:
            row = conn.execute("SELECT hermes_agui_host.begin_run(%s,%s,%s,%s,%s,%s,%s)",
                               (scope.project, scope.principal, scope.bot, thread_id, run_id, attempt, seconds)).fetchone()
        return None if row[0] is None else RunLease(scope, run_id, attempt, row[0])

    def get(self, scope: BotScope, run_id: str) -> RunRecord | None:
        with self.pool.connection() as conn:
            row = conn.execute("""SELECT attempt, fence, thread_id, status, created_at,
                heartbeat_at, finished_at, reason FROM hermes_agui_host.runs
                WHERE (project,principal,bot,run_id)=(%s,%s,%s,%s)""",
                (scope.project, scope.principal, scope.bot, run_id)).fetchone()
        if row is None:
            return None
        attempt, fence, thread_id, status, created, heartbeat, finished, reason = row
        return RunRecord(RunLease(scope, run_id, attempt, fence), thread_id, status,
                         created, heartbeat, finished, reason)

    def profile(self, scope: BotScope) -> ProfileRevision | None:
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT profile FROM hermes_agui_host.bot_state WHERE (project,principal,bot)=(%s,%s,%s)",
                (scope.project, scope.principal, scope.bot),
            ).fetchone()
        if row is None:
            raise LookupError("Unknown Bot scope")
        value = row[0]
        return (ProfileRevision(value["revision"], tuple(FileRevision(**item) for item in value["files"]))
                if value is not None else None)

    def renew(self, lease: RunLease, seconds: int) -> bool:
        if not 1 <= seconds <= 300:
            raise ValueError("Invalid lease duration")
        scope = self._scope_args(lease)
        with self.pool.connection() as conn, conn.transaction():
            if not self._lock_lease(conn, lease):
                return False
            conn.execute("""UPDATE hermes_agui_host.bot_state
                SET expires_at=clock_timestamp()+make_interval(secs => %s)
                WHERE (project,principal,bot)=(%s,%s,%s)""", (seconds, *scope))
            conn.execute("""UPDATE hermes_agui_host.runs SET heartbeat_at=clock_timestamp()
                WHERE (project,principal,bot,run_id)=(%s,%s,%s,%s)""", (*scope, lease.run_id))
        return True

    def finish(self, lease: RunLease, *, status: TerminalStatus, reason: str | None = None,
               expected_revision: str | None = None, profile: ProfileRevision | None = None) -> bool:
        """Finish atomically with the optional publication of a staged profile."""
        if status not in {"completed", "failed", "interrupted"}:
            raise ValueError("Invalid terminal status")
        scope = self._scope_args(lease)
        with self.pool.connection() as conn, conn.transaction():
            if not self._lock_lease(conn, lease):
                return False
            if profile is not None:
                saved = conn.execute("""UPDATE hermes_agui_host.bot_state SET profile=%s::jsonb
                    WHERE (project,principal,bot)=(%s,%s,%s)
                      AND profile->>'revision' IS NOT DISTINCT FROM %s""",
                    (json.dumps(asdict(profile)), *scope, expected_revision))
                if saved.rowcount != 1:
                    return False
            conn.execute("""UPDATE hermes_agui_host.runs SET status=%s, reason=%s, finished_at=clock_timestamp()
                WHERE (project,principal,bot,run_id)=(%s,%s,%s,%s)""",
                (status, reason, *scope, lease.run_id))
            conn.execute("""UPDATE hermes_agui_host.bot_state SET active_run=NULL, expires_at=NULL
                WHERE (project,principal,bot)=(%s,%s,%s)""", scope)
        return True

    @staticmethod
    def _scope_args(lease: RunLease) -> tuple[str, str, str]:
        scope = lease.scope
        return scope.project, scope.principal, scope.bot

    def _lock_lease(self, conn, lease: RunLease) -> bool:
        scope = self._scope_args(lease)
        conn.execute("""SELECT 1 FROM hermes_agui_host.bot_state
            WHERE (project,principal,bot)=(%s,%s,%s) FOR UPDATE""", scope)
        return conn.execute("""SELECT 1 FROM hermes_agui_host.bot_state b
            JOIN hermes_agui_host.runs r ON (r.project,r.principal,r.bot,r.run_id) =
                (b.project,b.principal,b.bot,b.active_run)
            WHERE (b.project,b.principal,b.bot)=(%s,%s,%s) AND b.active_run=%s
                AND b.fence=%s AND r.attempt=%s AND r.status='running'
                AND b.expires_at > clock_timestamp()""",
            (*scope, lease.run_id, lease.fence, lease.attempt)).fetchone() is not None
