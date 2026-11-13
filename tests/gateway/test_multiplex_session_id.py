"""Session construction must not publish a multiplexed conversation process-wide."""

import contextvars
import os

import pytest

from agent.secret_scope import reset_multiplex_context, set_multiplex_context
from gateway.session_context import get_session_env, set_current_session_id


@pytest.mark.parametrize("multiplex", [True, False], ids=["multiplex", "legacy-cli"])
def test_session_id_publication_respects_host_mode(monkeypatch, multiplex):
    monkeypatch.setenv("HERMES_SESSION_ID", "launch-session")

    def construct():
        token = set_multiplex_context(multiplex)
        try:
            set_current_session_id("request-session")
            return get_session_env("HERMES_SESSION_ID")
        finally:
            reset_multiplex_context(token)

    assert contextvars.copy_context().run(construct) == "request-session"
    assert os.environ["HERMES_SESSION_ID"] == ("launch-session" if multiplex else "request-session")
