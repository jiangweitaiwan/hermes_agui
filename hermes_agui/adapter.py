"""HTTP run admission and cooperative cleanup, outside the native agent loop."""

import asyncio
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from hermes_agui.message_adapter import TurnInput
from hermes_agui.event_bridge import EventBridge


class AdmissionError(Exception):
    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail
        super().__init__(detail)


@dataclass(eq=False)
class Run:
    turn: TurnInput
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    bridge: EventBridge | None = None
    delegation_depth: int = 0
    resume_ids: set[str] = field(default_factory=set)
    durable_ready: asyncio.Event = field(default_factory=asyncio.Event)
    durable_lease: Any = None


class AgentAdapter:
    """Owned by one event loop and one principal's service.

    Admission never queues two HTTP runs for one thread. Receipts are bounded and
    durable in the HTTP host; exhaustion fails closed instead of evicting IDs.
    """

    def __init__(self, service, config, *, receipt_store=None, host_has_capacity=None, delegation=None, bot_id=None,
                 durable_runs=None):
        self.service, self.config = service, config
        self.delegation, self.bot_id = delegation, bot_id
        self.active: dict[str, Run] = {}
        self.receipts: set[tuple[str, str, str]] = set()
        self.closed = False
        self.receipt_store = receipt_store
        self.host_has_capacity = host_has_capacity
        self.durable_runs = durable_runs

    def start(self, turn: TurnInput, *, delegation_depth=0) -> Run:
        if self.closed:
            raise AdmissionError(503, "Server is shutting down")
        if turn.thread_id in self.active:
            raise AdmissionError(409, "This thread already has an active run")
        keys = {(turn.thread_id, "run", turn.run_id), (turn.thread_id, "message", turn.message_id)}
        if keys & self.receipts:
            raise AdmissionError(409, "Run or user message ID has already been submitted")
        if len(self.active) >= self.config.max_active_runs or len(self.receipts) + 2 > self.config.max_receipts:
            raise AdmissionError(503, "Server admission capacity reached")
        if self.host_has_capacity is not None and not self.host_has_capacity():
            raise AdmissionError(503, "Host admission capacity reached")
        run = Run(turn, delegation_depth=delegation_depth)
        run.bridge = EventBridge(turn, run.stop, self.config)
        if self.receipt_store is not None:
            try:
                outcome = self.receipt_store.reserve(turn)
            except sqlite3.Error:
                raise AdmissionError(503, "Session admission storage unavailable") from None
            if outcome == "duplicate":
                raise AdmissionError(409, "Run or user message ID has already been submitted")
            if outcome == "full":
                raise AdmissionError(503, "Server admission capacity reached")
        elif self.durable_runs is None:
            self.receipts.update(keys)
        self.active[turn.thread_id] = run
        run.task = asyncio.create_task(self._execute(run))
        return run

    def resume(self, value) -> Run:
        if self.durable_runs is not None:
            raise AdmissionError(409, "Durable checkpoint resume is unsupported")
        run = self.active.get(value.thread_id)
        if self.closed or run is None or not run.bridge.paused or run.task.done():
            raise AdmissionError(409, "No resumable interrupt for this thread")
        if len(value.resume) != 1:
            raise AdmissionError(422, "Submit exactly one interrupt decision")
        if (not value.run_id or len(value.run_id) > 512 or value.run_id == run.turn.run_id
                or value.run_id in run.resume_ids):
            raise AdmissionError(422, "Resume requires a new run ID")
        if len(run.resume_ids) >= self.config.event_capacity:
            raise AdmissionError(503, "Continuation capacity reached; cancel this run")
        try:
            run.bridge.human.resolve(value.resume[0])
        except ValueError as exc:
            raise AdmissionError(409, str(exc)) from None
        from dataclasses import replace

        run.bridge.turn = replace(run.bridge.turn, run_id=value.run_id)
        run.bridge.paused = False
        run.resume_ids.add(value.run_id)
        return run

    async def _execute(self, run: Run) -> dict[str, Any]:
        try:
            if self.durable_runs is not None:
                return await self.durable_runs.execute(run, self._execute_native)
            return await self._execute_native(run, self.service)
        except Exception:  # health: allow BLE001 -- storage errors may contain credential-bearing connection details
            return {"failed": True}
        finally:
            run.durable_ready.set()
            self.active.pop(run.turn.thread_id, None)

    async def _execute_native(self, run: Run, service) -> dict[str, Any]:
        turn = run.turn
        try:
            if run.stop.is_set():
                return {"interrupted": True}
            from hermes_agui.delegation import DelegationInvocation, _execution

            invocation = DelegationInvocation(self.delegation, self.bot_id, turn.thread_id,
                turn.run_id, run.delegation_depth, self.config.bearer_token) if self.delegation else None
            token = _execution.set((invocation, asyncio.get_running_loop(), run.stop) if invocation else None)
            try:
                from agent.runtime_reference import runtime_reference

                reference_token = runtime_reference.set(turn.runtime_memory)
                try:
                    future = service.submit(turn.thread_id, turn.text, run_id=turn.run_id,
                                                 callbacks=run.bridge.callbacks)
                finally:
                    runtime_reference.reset(reference_token)
            finally:
                _execution.reset(token)
            wrapped = asyncio.wrap_future(future)
            while not wrapped.done():
                if run.stop.is_set():
                    # Repeated checks span queued -> construction -> native active
                    # transitions. A False return is never treated as termination.
                    future.cancel()
                    await asyncio.to_thread(self._interrupt, service, turn)
                await asyncio.wait({wrapped}, timeout=0.05)
            if wrapped.cancelled():
                return {"interrupted": True}
            return wrapped.result()
        except Exception:  # health: allow BLE001 -- HTTP boundary intentionally suppresses provider exceptions containing credentials/prompts
            # Exception messages may contain provider credentials or prompt data.
            return {"failed": True}

    def _interrupt(self, service, turn):
        try:
            service.cancel(turn.thread_id, turn.run_id)
        except Exception:  # health: allow BLE001 -- cancellation failure must not abandon the still-owned native future or disclose secrets
            return False
        return True

    async def close(self):
        self.closed = True
        runs = list(self.active.values())
        for run in runs:
            run.stop.set()
        if runs:
            await asyncio.gather(*(run.task for run in runs))
        if self.service is not None:
            await asyncio.to_thread(self.service.close)
