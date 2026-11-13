"""Bounded native callback mailbox and official AG-UI event state machine.

Only the ASGI loop mutates protocol state. Native callback threads serialize safe
snapshots into a locked mailbox; overflow cancels the owned run rather than
silently dropping deltas or blocking a provider reader indefinitely.
"""

import asyncio
from collections import deque
import json
import threading
import uuid

from ag_ui.core import (
    RunErrorEvent, RunFinishedEvent, RunStartedEvent,
    TextMessageContentEvent, TextMessageEndEvent, TextMessageStartEvent,
    ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent, ToolCallStartEvent,
)


class EventBridge:
    def __init__(self, turn, stop, config):
        self.turn, self.stop, self.config = turn, stop, config
        self.loop = asyncio.get_running_loop()
        self.wake = asyncio.Event()
        self.lock = threading.Lock()
        self.pending = deque()
        self.pending_bytes = 0
        self.failed = False
        self.closed = False
        self.message_id = None
        self.parts = []
        self.text_bytes = 0
        self.calls = set()
        self.call_bytes = 0
        self.completed_calls = set()

    @property
    def callbacks(self):
        return {"stream_delta_callback": self.delta,
                "interim_assistant_callback": self.interim,
                "tool_start_callback": self.tool_start,
                "tool_complete_callback": self.tool_complete}

    def _signal(self):
        self.wake.set()
        if self.failed:
            self.stop.set()

    def _fail(self):
        with self.lock:
            if self.closed or self.failed:
                return
            self.failed = True
        self.loop.call_soon_threadsafe(self._signal)

    def _put(self, kind, *values):
        # Snapshot before crossing the thread boundary; arbitrary tool objects
        # never enter this mailbox. Limit bytes as well as event count.
        size = sum(len(v.encode("utf-8")) for v in values if isinstance(v, str))
        with self.lock:
            if self.closed or self.failed:
                return
            if len(self.pending) >= self.config.event_capacity or self.pending_bytes + size > self.config.event_bytes:
                self.failed = True
                self.loop.call_soon_threadsafe(self._signal)
                return
            notify = not self.pending
            self.pending.append((kind, values, size))
            self.pending_bytes += size
            if notify:
                self.loop.call_soon_threadsafe(self._signal)

    def delta(self, text):
        if text is None or isinstance(text, str):
            self._put("delta", text)

    def interim(self, text, *, already_streamed=False):
        if isinstance(text, str):
            self._put("interim", text, already_streamed)

    def _project(self, kind, name, value):
        projection = self.config.tool_projection
        safe = projection(kind, name, value) if projection else {"content": "[withheld]"}
        return json.dumps(safe, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

    def tool_start(self, call_id, name, args):
        try:
            self._put("start", str(call_id), str(name), self._project("arguments", name, args))
        except Exception:  # health: allow BLE001 -- trusted projection failures terminate the stream without logging raw tool data
            self._fail()

    def tool_complete(self, call_id, name, args, result):
        try:
            self._put("result", str(call_id), str(name), self._project("result", name, result))
        except Exception:  # health: allow BLE001 -- serialization/projection errors must fail closed without disclosing tool data
            self._fail()

    def _end_text(self):
        if self.message_id is not None:
            yield TextMessageEndEvent(message_id=self.message_id)
            self.message_id = None

    def _text(self, text):
        if not text:
            return
        size = len(text.encode("utf-8"))
        if self.text_bytes + size > self.config.event_bytes:
            self._fail()
            return
        if self.message_id is None:
            self.message_id = str(uuid.uuid4())
            yield TextMessageStartEvent(message_id=self.message_id, role="assistant")
        self.parts.append(text)
        self.text_bytes += size
        yield TextMessageContentEvent(message_id=self.message_id, delta=text)

    def _on_delta(self, text):
        if text is None:
            yield from self._end_text()
        else:
            yield from self._text(text)

    def _on_interim(self, text, already_streamed):
        streamed = "".join(self.parts)
        if not already_streamed:
            if streamed and text.startswith(streamed):
                yield from self._text(text[len(streamed):])
            elif text != streamed:
                yield from self._end_text()
                self.parts.clear()
                self.text_bytes = 0
                yield from self._text(text)
        yield from self._end_text()
        self.parts.clear()
        self.text_bytes = 0

    def _on_start(self, call_id, name, args):
        if call_id in self.calls:
            return
        size = len(call_id.encode("utf-8"))
        if (len(self.calls) >= self.config.event_capacity or
                self.call_bytes + size > self.config.event_bytes):
            self._fail()
            return
        yield from self._end_text()
        self.parts.clear()
        self.text_bytes = 0
        self.calls.add(call_id)
        self.call_bytes += size
        yield ToolCallStartEvent(tool_call_id=call_id, tool_call_name=name)
        yield ToolCallArgsEvent(tool_call_id=call_id, delta=args)
        yield ToolCallEndEvent(tool_call_id=call_id)

    def _on_result(self, call_id, _name, result):
        if call_id not in self.calls or call_id in self.completed_calls:
            return
        self.completed_calls.add(call_id)
        yield ToolCallResultEvent(tool_call_id=call_id, message_id=str(uuid.uuid4()),
                                  content=result, role="tool")

    def _convert(self, kind, values):
        handler = {"delta": self._on_delta, "interim": self._on_interim,
                   "start": self._on_start, "result": self._on_result}[kind]
        yield from handler(*values)

    def _final_text(self, result):
        text = result.get("final_response")
        if not isinstance(text, str):
            return
        streamed = "".join(self.parts)
        if text.startswith(streamed):
            # Native interim/final fallbacks can complete an already shown prefix.
            # Only its missing suffix is eligible; never replay the whole answer.
            yield from self._text(text[len(streamed):])

    async def events(self, task):
        yield RunStartedEvent(thread_id=self.turn.thread_id, run_id=self.turn.run_id)
        task.add_done_callback(lambda _task: self.wake.set())
        try:
            while True:
                with self.lock:
                    items = list(self.pending)
                    self.pending.clear()
                    self.pending_bytes = 0
                    self.wake.clear()
                for kind, values, _size in items:
                    for event in self._convert(kind, values):
                        yield event
                if task.done():
                    with self.lock:
                        if not self.pending:
                            break
                    continue
                await self.wake.wait()
            result = task.result()
            failed = (self.failed or self.stop.is_set() or
                      any(result.get(k) for k in ("failed", "partial", "interrupted")) or
                      not result.get("completed"))
            if not failed:
                for event in self._final_text(result):
                    yield event
            for event in self._end_text():
                yield event
            if failed or self.failed:
                yield RunErrorEvent(message="Agent execution failed or was interrupted", code="AGENT_ERROR")
            else:
                yield RunFinishedEvent(thread_id=self.turn.thread_id, run_id=self.turn.run_id)
        finally:
            with self.lock:
                self.closed = True
                self.pending.clear()
                self.pending_bytes = 0
