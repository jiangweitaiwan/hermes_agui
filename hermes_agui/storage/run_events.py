"""Scoped event replay and cancellation, layered on Part 1 run ownership."""

import json


class RunEvents:
    def __init__(self, pool):
        self.pool = pool

    @staticmethod
    def scope(scope):
        return scope.project, scope.principal, scope.bot

    def append(self, lease, event):
        value = event.model_dump(mode="json", by_alias=True, exclude_none=True)
        encoded = json.dumps(value)
        if len(encoded.encode()) > 1048576:
            raise ValueError("Event exceeds replay limit")
        key = (*self.scope(lease.scope), lease.run_id)
        with self.pool.connection() as conn, conn.transaction():
            owner = conn.execute("""SELECT fence,expires_at>clock_timestamp() FROM hermes_agui_host.bot_state
                WHERE (project,principal,bot)=(%s,%s,%s) FOR UPDATE""", self.scope(lease.scope)).fetchone()
            row = conn.execute("""SELECT attempt,status FROM hermes_agui_host.runs
                WHERE (project,principal,bot,run_id)=(%s,%s,%s,%s) FOR UPDATE""", key).fetchone()
            if (row is None or row[0] != lease.attempt or owner is None or owner[0] != lease.fence
                    or (row[1] == "running" and not owner[1])):
                raise RuntimeError("Run ownership lost")
            terminal = conn.execute("""SELECT 1 FROM hermes_agui_host.run_events
                WHERE (project,principal,bot,run_id)=(%s,%s,%s,%s)
                AND event_type IN ('RUN_FINISHED','RUN_ERROR') LIMIT 1""", key).fetchone()
            if terminal:
                raise RuntimeError("Run already has a terminal event")
            size = conn.execute("""SELECT COALESCE(sum(octet_length(payload::text)),0),count(*) FROM hermes_agui_host.run_events
                WHERE (project,principal,bot,run_id)=(%s,%s,%s,%s)""", key).fetchone()
            if size[0] + len(encoded.encode()) > 8 * 1024 * 1024 or size[1] >= 10000:
                raise RuntimeError("Run event retention capacity reached")
            seq = conn.execute("""SELECT COALESCE(max(seq),0)+1 FROM hermes_agui_host.run_events
                WHERE (project,principal,bot,run_id)=(%s,%s,%s,%s)""", key).fetchone()[0]
            conn.execute("""INSERT INTO hermes_agui_host.run_events
                (project,principal,bot,run_id,attempt,seq,event_type,payload)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""", (*key, lease.attempt, seq, value["type"], encoded))
        return seq

    def replay(self, scope, thread, run_id, after):
        with self.pool.connection() as conn:
            rows = conn.execute("""SELECT e.seq,e.payload FROM hermes_agui_host.run_events e
                JOIN hermes_agui_host.runs r USING(project,principal,bot,run_id)
                WHERE (e.project,e.principal,e.bot,e.run_id,r.thread_id)=(%s,%s,%s,%s,%s)
                AND e.seq>%s ORDER BY e.seq LIMIT 1000""", (*self.scope(scope), run_id, thread, after)).fetchall()
        return [{"seq": row[0], "event": row[1]} for row in rows]

    def cancel(self, scope, thread):
        with self.pool.connection() as conn:
            return conn.execute("""UPDATE hermes_agui_host.runs SET cancel_requested=true
                WHERE (project,principal,bot,thread_id)=(%s,%s,%s,%s) AND status='running'""",
                (*self.scope(scope), thread)).rowcount > 0

    def cancelled(self, lease):
        with self.pool.connection() as conn:
            row = conn.execute("""SELECT cancel_requested FROM hermes_agui_host.runs
                WHERE (project,principal,bot,run_id,attempt)=(%s,%s,%s,%s,%s)""",
                (*self.scope(lease.scope), lease.run_id, lease.attempt)).fetchone()
        return row is None or row[0]

    def input(self, lease, turn):
        with self.pool.connection() as conn:
            conn.execute("""UPDATE hermes_agui_host.runs SET input=%s::jsonb
                WHERE (project,principal,bot,run_id,attempt)=(%s,%s,%s,%s,%s)""",
                (json.dumps({"id": turn.message_id, "role": "user", "content": turn.text}),
                 *self.scope(lease.scope), lease.run_id, lease.attempt))

    def history(self, scope, thread):
        with self.pool.connection() as conn:
            rows = conn.execute("""SELECT run_id,input,status FROM hermes_agui_host.runs
                WHERE (project,principal,bot,thread_id)=(%s,%s,%s,%s)
                ORDER BY created_at DESC LIMIT 20""", (*self.scope(scope), thread)).fetchall()
        result = []
        total = 0
        for run_id, message, status in reversed(rows):
            events = []
            after = 0
            while True:
                page = self.replay(scope, thread, run_id, after)
                if not page:
                    break
                total += len(json.dumps(page).encode())
                if total > 2 * 1024 * 1024:
                    raise ValueError("History capacity exceeded; use paged event replay")
                events.extend(page)
                after = page[-1]["seq"]
            result.append({"runId": run_id, "input": message, "status": status, "events": events})
        return result

    def reconcile(self):
        with self.pool.connection() as conn, conn.transaction():
            expired = conn.execute("""SELECT project,principal,bot,active_run FROM hermes_agui_host.bot_state
                WHERE active_run IS NOT NULL AND expires_at<=clock_timestamp()
                FOR UPDATE SKIP LOCKED LIMIT 100""").fetchall()
            for project, principal, bot, run_id in expired:
                key = (project, principal, bot, run_id)
                conn.execute("""UPDATE hermes_agui_host.runs SET status='interrupted',reason='lease_expired',finished_at=clock_timestamp()
                    WHERE (project,principal,bot,run_id)=(%s,%s,%s,%s) AND status='running'""", key)
                conn.execute("""UPDATE hermes_agui_host.bot_state SET active_run=NULL,expires_at=NULL
                    WHERE (project,principal,bot)=(%s,%s,%s)""", key[:3])
            rows = conn.execute("""SELECT project,principal,bot,run_id,attempt,status FROM hermes_agui_host.runs r
                WHERE status<>'running' AND finished_at<clock_timestamp()-interval '30 seconds'
                    AND finished_at>=clock_timestamp()-interval '30 days' AND NOT EXISTS (SELECT 1 FROM hermes_agui_host.run_events e
                    WHERE (e.project,e.principal,e.bot,e.run_id)=(r.project,r.principal,r.bot,r.run_id)
                    AND e.event_type IN ('RUN_FINISHED','RUN_ERROR'))
                FOR UPDATE SKIP LOCKED LIMIT 100""").fetchall()
            for project, principal, bot, run_id, attempt, status in rows:
                key = (project, principal, bot, run_id)
                payload = {"type": "RUN_ERROR", "message": "Stream interrupted; inspect durable run status before retrying", "code": status}
                conn.execute("""INSERT INTO hermes_agui_host.run_events(project,principal,bot,run_id,attempt,seq,event_type,payload)
                    SELECT %s,%s,%s,%s,%s,COALESCE(max(seq),0)+1,'RUN_ERROR',%s::jsonb FROM hermes_agui_host.run_events
                    WHERE (project,principal,bot,run_id)=(%s,%s,%s,%s)""", (*key, attempt, json.dumps(payload), *key))
            conn.execute("""DELETE FROM hermes_agui_host.run_events e USING hermes_agui_host.runs r
                WHERE (e.project,e.principal,e.bot,e.run_id)=(r.project,r.principal,r.bot,r.run_id)
                AND r.finished_at<clock_timestamp()-interval '30 days'""")
        return len(expired)
