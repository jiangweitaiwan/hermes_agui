"""Bounded thread execution for hosts that must keep their event loop responsive."""

from __future__ import annotations

import contextvars
import threading
from concurrent.futures import Future, ThreadPoolExecutor


class ExecutionManager:
    def __init__(self, max_workers: int, max_pending: int):
        if max_workers < 1 or max_pending < max_workers:
            raise ValueError("Require 1 <= max_workers <= max_pending")
        self._slots = threading.BoundedSemaphore(max_pending)
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="hermes-headless")

    def submit(self, fn, *args, **kwargs) -> Future:
        if not self._slots.acquire(blocking=False):
            raise RuntimeError("Run capacity reached")
        try:
            future = self._executor.submit(contextvars.copy_context().run, fn, *args, **kwargs)
        except BaseException:
            self._slots.release()
            raise
        future.add_done_callback(lambda _future: self._slots.release())
        return future

    def close(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)
