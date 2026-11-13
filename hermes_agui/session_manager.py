"""Bounded in-process admission; durable turn leases remain owned by Hermes."""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator


@dataclass
class Session:
    native_id: str
    lock: Any = field(default_factory=threading.Lock)
    control: Any = field(default_factory=threading.Lock)
    agent: Any = None
    db: Any = None
    active_run: str | None = None
    users: int = 0
    retiring: bool = False


class SessionManager:
    """Never evict an agent while a caller holds or is waiting for its turn lock."""

    def __init__(self, home: str, principal: str, max_sessions: int):
        if max_sessions < 1:
            raise ValueError("max_sessions must be positive")
        self._namespace = (home, principal)
        self._limit = max_sessions
        self._sessions: dict[str, Session] = {}
        self._condition = threading.Condition()
        self._closed = False

    def native_id(self, external_id: str) -> str:
        if not isinstance(external_id, str) or not external_id or len(external_id) > 512:
            raise ValueError("session_id must contain 1–512 characters")
        # Stable across restart, opaque to the caller, and accepted by Hermes ID recovery.
        key = json.dumps((*self._namespace, external_id), ensure_ascii=True).encode()
        return str(uuid.UUID(bytes=hashlib.sha256(key).digest()[:16], version=4))

    @contextmanager
    def borrow(self, external_id: str) -> Iterator[Session]:
        native_id = self.native_id(external_id)
        with self._condition:
            if self._closed:
                raise RuntimeError("Headless service is closed")
            session = self._sessions.get(external_id)
            if session is None:
                if len(self._sessions) >= self._limit:
                    raise RuntimeError("Session capacity reached; evict an idle session first")
                session = self._sessions[external_id] = Session(native_id)
            if session.retiring:
                raise RuntimeError("Session is being evicted")
            session.users += 1
        try:
            with session.lock:
                yield session
        finally:
            with self._condition:
                session.users -= 1
                self._condition.notify_all()

    def find(self, external_id: str) -> Session | None:
        with self._condition:
            return self._sessions.get(external_id)

    def evict(self, external_id: str, close) -> bool:
        with self._condition:
            session = self._sessions.get(external_id)
            if session is None:
                return False
            if session.users:
                raise RuntimeError("Cannot evict a running or queued session")
            session.retiring = True
        try:
            with session.control:
                close(session)
        finally:
            with self._condition:
                del self._sessions[external_id]
                self._condition.notify_all()
        return True

    def close(self, close) -> None:
        with self._condition:
            self._closed = True
            self._condition.wait_for(lambda: all(s.users == 0 and not s.retiring for s in self._sessions.values()))
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            with session.control:
                close(session)

    def stop_admissions(self) -> None:
        with self._condition:
            self._closed = True
