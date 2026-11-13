"""Executor admission bounds queued work and carries contextvars into workers."""

import contextvars
import threading

import pytest

from hermes_agui.execution_manager import ExecutionManager


def test_capacity_queue_cancellation_and_context_propagation():
    entered, release = threading.Event(), threading.Event()
    marker = contextvars.ContextVar("headless-test-marker", default="missing")
    marker.set("owner")
    execution = ExecutionManager(max_workers=1, max_pending=2)

    def work():
        entered.set()
        assert release.wait(30)
        return marker.get()

    try:
        first = execution.submit(work)
        assert entered.wait(30)
        queued = execution.submit(work)
        with pytest.raises(RuntimeError, match="capacity"):
            execution.submit(work)
        assert queued.cancel()
        release.set()
        assert first.result(timeout=30) == "owner"
    finally:
        release.set()
        execution.close()
