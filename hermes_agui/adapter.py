"""HTTP run admission and cooperative cleanup, outside the native agent loop."""

import asyncio
from dataclasses import dataclass, field
from typing import Any

from hermes_agui.message_adapter import TurnInput


class AdmissionError(Exception):
    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail
        super().__init__(detail)


@dataclass(eq=False)
class Run:
    turn: TurnInput
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None


class AgentAdapter:
    """Owned by one event loop and one principal's service.

    Admission never queues two HTTP runs for one thread. Receipts are bounded and
    retained until process restart; exhaustion fails closed instead of evicting IDs.
    """

    def __init__(self, service, config):
        self.service, self.config = service, config
        self.active: dict[str, Run] = {}
        self.receipts: set[tuple[str, str, str]] = set()
        self.closed = False

    def start(self, turn: TurnInput) -> Run:
        if self.closed:
            raise AdmissionError(503, "Server is shutting down")
        if turn.thread_id in self.active:
            raise AdmissionError(409, "This thread already has an active run")
        keys = {(turn.thread_id, "run", turn.run_id), (turn.thread_id, "message", turn.message_id)}
        if keys & self.receipts:
            raise AdmissionError(409, "Run or user message ID has already been submitted")
        if len(self.active) >= self.config.max_active_runs or len(self.receipts) + 2 > self.config.max_receipts:
            raise AdmissionError(503, "Server admission capacity reached")
        run = Run(turn)
        self.receipts.update(keys)
        self.active[turn.thread_id] = run
        run.task = asyncio.create_task(self._execute(run))
        return run

    async def _execute(self, run: Run) -> dict[str, Any]:
        turn = run.turn
        try:
            if run.stop.is_set():
                return {"interrupted": True}
            future = self.service.submit(turn.thread_id, turn.text, run_id=turn.run_id)
            wrapped = asyncio.wrap_future(future)
            while not wrapped.done():
                if run.stop.is_set():
                    # Repeated checks span queued -> construction -> native active
                    # transitions. A False return is never treated as termination.
                    future.cancel()
                    await asyncio.to_thread(self._interrupt, turn)
                await asyncio.wait({wrapped}, timeout=0.05)
            if wrapped.cancelled():
                return {"interrupted": True}
            return wrapped.result()
        except Exception:  # health: allow BLE001 -- HTTP boundary intentionally suppresses provider exceptions containing credentials/prompts
            # Exception messages may contain provider credentials or prompt data.
            return {"failed": True}
        finally:
            self.active.pop(turn.thread_id, None)

    def _interrupt(self, turn):
        try:
            self.service.cancel(turn.thread_id, turn.run_id)
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
        await asyncio.to_thread(self.service.close)
