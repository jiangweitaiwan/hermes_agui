"""Synchronous host for AIAgent. No model loop or tool dispatch lives here."""

from __future__ import annotations

import contextvars
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Iterator

from hermes_agui.core.factory import AgentConfig, create_agent
from hermes_agui.execution_manager import ExecutionManager
from hermes_agui.session_manager import Session, SessionManager

# These are native callbacks, not AG-UI events. The dedicated reasoning sink is excluded.
CALLBACKS = frozenset({"stream_delta_callback", "interim_assistant_callback", "tool_start_callback",
                      "tool_complete_callback", "tool_progress_callback", "step_callback", "status_callback",
                      "notice_callback", "notice_clear_callback", "event_callback", "tool_gen_callback",
                      "clarify_callback"})


def _unavailable_clarify(questions):
    return {"answers": {q["qid"]: None for q in questions}, "outcome": "unavailable"}


class HermesAgentService:
    """One trusted principal/profile per service. Session IDs are not authentication.

    ``authorize`` is a trusted host hook invoked before every run/cancel/evict.
    Callbacks run on native worker threads and must be thread-safe and nonblocking.
    """

    def __init__(self, config: AgentConfig, *, max_sessions: int = 64,
                 max_workers: int = 4, max_pending: int = 16,
                 authorize: Callable[[str, str], None] | None = None):
        from agent.secret_scope import set_multiplex_active

        # This host may coexist with other profile-bound services in one process.
        set_multiplex_active(True)
        self.config = config
        self._authorize = authorize
        self._sessions = SessionManager(str(config.home), config.principal, max_sessions)
        self._execution = ExecutionManager(max_workers, max_pending)

    def submit(self, session_id: str, message: Any, *, run_id: str,
               callbacks: dict[str, Callable] | None = None):
        """Return a concurrent Future; async hosts can await asyncio.wrap_future.

        Future.cancel cancels queued work only. Use cancel(session_id, run_id)
        for active native execution, then await completion before releasing it.
        """
        self._check_access(session_id)
        return self._execution.submit(self.run, session_id, message, run_id=run_id, callbacks=callbacks)

    @contextmanager
    def _scope(self, native_id: str) -> Iterator[None]:
        from agent.runtime_scope import bind_profile_scope
        from gateway.session_context import set_session_vars

        # Native session helpers include legacy clear semantics. A private Context
        # keeps every mutation (including AIAgent construction) out of the caller.
        with bind_profile_scope(self.config.home):
            set_session_vars(platform="api_server", source="api_server", session_id=native_id,
                             session_key=native_id, user_id=self.config.principal,
                             cwd=str(self.config.cwd), async_delivery=False, cron_session="")
            yield

    def _check_access(self, session_id: str) -> None:
        self._sessions.native_id(session_id)
        if self._authorize is not None:
            self._authorize(self.config.principal, session_id)

    def run(self, session_id: str, message: Any, *, run_id: str | None = None,
            callbacks: dict[str, Callable] | None = None) -> dict[str, Any]:
        """Execute one native turn; history is exclusively owned by Hermes storage.

        Returns the native result plus external_session_id, native_session_id and
        run_id. Exceptions propagate; native failed/partial results remain intact.
        """
        self._check_access(session_id)
        callbacks = dict(callbacks or {})
        if callbacks.keys() - (CALLBACKS | {"approval_callback"}) or any(not callable(cb) for cb in callbacks.values()):
            raise ValueError("callbacks must contain callable native display callbacks")
        if run_id is not None and (not isinstance(run_id, str) or not run_id):
            raise ValueError("run_id must be a nonempty string")
        with self._sessions.borrow(session_id) as session:
            return contextvars.copy_context().run(
                self._run, session, session_id, message, run_id or str(uuid.uuid4()), callbacks,
            )

    def _run(self, session: Session, external_id: str, message: Any,
             run_id: str, callbacks: dict[str, Callable]) -> dict[str, Any]:
        from hermes_state_registry import acquire
        from gateway.session_context import scoped_current_session_id

        with self._scope(session.native_id):
            if session.db is None:
                session.db = acquire(self.config.home / "state.db")
            db = session.db
            if session.agent is None:
                session.agent = create_agent(self.config, session.native_id, db)
            agent = session.agent
            # The canonical transcript is loaded by the native admission while
            # holding its durable lease, never from an unlocked host snapshot.
            tip = db.resolve_resume_session_id(session.native_id) or session.native_id
            agent.session_id = tip
            with scoped_current_session_id(tip):
                return self._invoke(session, agent, external_id, message, run_id, callbacks)

    def _invoke(self, session, agent, external_id, message, run_id, callbacks):
        previous = {key: getattr(agent, key) for key in CALLBACKS}
        for key in CALLBACKS:
            setattr(agent, key, callbacks.get(key))
        agent.clarify_callback = callbacks.get("clarify_callback", _unavailable_clarify)
        with session.control:
            agent.clear_interrupt(hard_cancel=True)
            session.active_run = run_id
        try:
            from tools.approval_context import bind_host_approval

            with bind_host_approval(callbacks.get("approval_callback")):
                result = agent.run_conversation(message, task_id=agent.session_id, reload_history=True)
            return {**result, "run_id": run_id, "external_session_id": external_id,
                    "native_session_id": agent.session_id}
        finally:
            with session.control:
                session.active_run = None
            for key, value in previous.items():
                setattr(agent, key, value)

    def cancel(self, session_id: str, run_id: str) -> bool:
        """Cancel only the matching active run. False means it is no longer active."""
        self._check_access(session_id)
        session = self._sessions.find(session_id)
        if session is None:
            return False
        with session.control:
            if session.active_run != run_id or session.agent is None:
                return False
            return contextvars.copy_context().run(self._interrupt, session)

    def _interrupt(self, session: Session) -> bool:
        with self._scope(session.agent.session_id):
            return session.agent.interrupt(hard_cancel=True, tool_reason="headless cancellation")

    def _close_session(self, session: Session) -> None:
        from hermes_state_registry import release

        if session.db is None:
            return
        native_id = session.agent.session_id if session.agent is not None else session.native_id
        with self._scope(native_id):
            try:
                if session.agent is not None:
                    session.agent.close()
            finally:
                release(session.db)
                session.agent = None
                session.db = None

    def evict(self, session_id: str) -> bool:
        self._check_access(session_id)
        return contextvars.copy_context().run(self._sessions.evict, session_id, self._close_session)

    def close(self) -> None:
        """Stop admissions, wait for callers, then end session resources.

        Cancel active runs first when needed. Do not call close from a run callback.
        Non-cooperative tools may delay shutdown; threads are never reported killed.
        """
        self._sessions.stop_admissions()
        self._execution.close()
        contextvars.copy_context().run(self._sessions.close, self._close_session)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
