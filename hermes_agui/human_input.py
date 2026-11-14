"""Bounded process-local continuations for native synchronous human callbacks."""

from datetime import UTC, datetime, timedelta
import threading
import time
import uuid

from ag_ui.core import Interrupt


class HumanInput:
    def __init__(self, bridge):
        self.bridge = bridge
        self.serial = threading.Lock()
        self.lock = threading.Lock()
        self.pending = None
        self.answer = None
        self.ready = threading.Event()
        self.deadline = 0.0

    def ask(self, reason, message, schema, metadata):
        # Native parallel tool workers retain their own stacks; expose one card
        # at a time so a decision can never authorize a different pending call.
        with self.serial:
            if self.bridge.stop.is_set():
                return None
            timeout = self.bridge.config.human_input_timeout
            interrupt = Interrupt(id=str(uuid.uuid4()), reason=reason, message=message,
                                  response_schema=schema, metadata=metadata,
                                  expires_at=(datetime.now(UTC) + timedelta(seconds=timeout)).isoformat())
            with self.lock:
                self.answer = None
                self.ready.clear()
                self.pending = interrupt
                self.deadline = time.monotonic() + timeout
            self.bridge._put("human", interrupt.model_dump_json(by_alias=True))
            while not self.ready.wait(0.05):
                if self.bridge.stop.is_set() or time.monotonic() >= self.deadline:
                    self.bridge.loop.call_soon_threadsafe(self.bridge.stop.set)
                    break
            with self.lock:
                answer = self.answer
                self.pending = None
                return answer

    def resolve(self, entry):
        with self.lock:
            if (self.pending is None or self.ready.is_set() or self.bridge.stop.is_set()
                    or time.monotonic() >= self.deadline or entry.interrupt_id != self.pending.id):
                raise ValueError("Interrupt is unknown, expired or already answered")
            payload = entry.payload
            if entry.status == "resolved":
                if self.pending.reason == "tool_approval":
                    if not isinstance(payload, dict) or set(payload) != {"approved"} or type(payload["approved"]) is not bool:
                        raise ValueError("Expected an approved boolean")
                else:
                    ids = {q["qid"] for q in self.pending.metadata["questions"]}
                    if (not isinstance(payload, dict) or set(payload) != {"answers"}
                            or not isinstance(payload["answers"], dict) or set(payload["answers"]) - ids
                            or any(not isinstance(v, (str, type(None))) and not (
                                isinstance(v, list) and all(isinstance(x, str) for x in v))
                                   for v in payload["answers"].values())):
                        raise ValueError("Expected answers keyed by question ID")
            self.answer = payload if entry.status == "resolved" else None
            self.ready.set()

    def clarify(self, questions):
        answer = self.ask("clarification", "Please answer the questions", {"type": "object"},
                          {"questions": questions})
        return {"answers": answer["answers"] if answer else {},
                "outcome": "answered" if answer else "cancelled"}

    def approve(self, command, description, **_options):
        answer = self.ask("tool_approval", description,
                          {"type": "object", "properties": {"approved": {"type": "boolean"}},
                           "required": ["approved"], "additionalProperties": False},
                          {"command": command})
        return "once" if answer and answer["approved"] else "deny"
