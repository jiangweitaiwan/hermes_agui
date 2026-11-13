"""Storage-owned callers reload history under the native turn lease, even without contention."""

from agent.turn_facade_lease import admit_durable_turn_lease
from tests.agent.test_cross_process_turn_lease import _DB, _agent_with_db


def test_storage_history_load_follows_uncontended_admission():
    db = _DB()
    agent = _agent_with_db(db)
    admission = admit_durable_turn_lease(
        agent, session_id=agent.session_id, relay_turn_id="headless-turn",
        task_context={"session_id": agent.session_id, "platform": agent.platform},
        conversation_history=None, reload_history=True,
    )
    try:
        assert admission.conversation_history == [{"role": "user", "content": "durable latest"}]
        assert [event[0] for event in db.events] == ["acquire", "resolve", "reload"]
    finally:
        if admission.lease is not None:
            admission.lease.release()


def test_default_admission_preserves_caller_history_without_reload():
    db = _DB()
    agent = _agent_with_db(db)
    history = [{"role": "user", "content": "caller owned"}]
    admission = admit_durable_turn_lease(
        agent, session_id=agent.session_id, relay_turn_id="legacy-turn",
        task_context={"session_id": agent.session_id, "platform": agent.platform},
        conversation_history=history,
    )
    try:
        assert admission.conversation_history is history
        assert [event[0] for event in db.events] == ["acquire"]
    finally:
        if admission.lease is not None:
            admission.lease.release()
