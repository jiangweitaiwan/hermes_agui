"""Real native callbacks suspend HTTP runs without replaying tools or user input."""

import json

from fastapi.testclient import TestClient
import pytest

from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig
from hermes_agui.server import create_app
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall, write_hermes_home
from tests.hermes_agui.test_message_adapter import payload
from tests.hermes_agui.test_server import AUTH, events


def resume(interrupt, run="resume", **decision):
    return payload(runId=run, messages=[], resume=[{"interruptId": interrupt["id"], **decision}])


def checkpoint(client, data=None):
    response = client.post("/agent", headers=AUTH, json=data or payload())
    output = events(response)
    assert output[-1]["type"] == "RUN_FINISHED", response.text
    assert output[-1]["outcome"]["type"] == "interrupt", response.text
    return output[-1]["outcome"]["interrupts"][0]


def test_native_clarify_resume_and_duplicate_decisions(tmp_path):
    script = [ToolCall("clarify", {"questions": [{"question": "Which color?", "choices": ["Red", "Blue"]}]}),
              Text("Blue selected")]
    with FakeLLMServer(script) as provider:
        home = write_hermes_home(tmp_path / "profile", provider.base_url)
        cfg = AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("clarify",),
                          agent_options={"skip_background_review": True})
        with TestClient(create_app(cfg, ServerConfig("local-secret"))) as client:
            interrupt = checkpoint(client)
            assert interrupt["reason"] == "clarification"
            assert interrupt["metadata"]["questions"][0]["qid"] == "q0"
            assert client.post("/agent", headers=AUTH, json=payload(runId="other")).status_code == 409
            wrong = resume({"id": "wrong"}, status="resolved", payload={"answers": {"q0": "Blue"}})
            assert client.post("/agent", headers=AUTH, json=wrong).status_code == 409
            invalid = resume(interrupt, status="resolved", payload={"answers": {"wrong": "Blue"}})
            assert client.post("/agent", headers=AUTH, json=invalid).status_code == 409
            data = resume(interrupt, status="resolved", payload={"answers": {"q0": "Blue"}})
            assert client.post("/agent", json=data).status_code == 401
            response = client.post("/agent", headers=AUTH, json=data)
            assert events(response)[-1]["type"] == "RUN_FINISHED", response.text
            assert "".join(e["delta"] for e in events(response) if e["type"] == "TEXT_MESSAGE_CONTENT").strip() == "Blue selected"
            assert client.post("/agent", headers=AUTH, json=data).status_code == 409
        requests = provider.main_requests()
        assert len(requests) == 2
        results = [m for m in requests[-1]["messages"] if m["role"] == "tool"]
        assert json.loads(results[0]["content"])["responses"][0]["user_response"] == "Blue"


@pytest.mark.parametrize("approved", [True, False])
def test_native_approval_runs_only_after_matching_decision(tmp_path, approved):
    # Protected instruction-file writes use the native approval gate; no shell
    # command or policy mock is needed to demonstrate the execution boundary.
    target = tmp_path / "AGENTS.md"
    target.write_text("original instructions")
    script = [ToolCall("read_file", {"path": str(target)}),
              ToolCall("write_file", {"path": str(target), "content": "approved instructions"}), Text("done")]
    with FakeLLMServer(script) as provider:
        home = write_hermes_home(tmp_path / "profile", provider.base_url)
        cfg = AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("file",),
                          agent_options={"skip_background_review": True})
        with TestClient(create_app(cfg, ServerConfig("local-secret"))) as client:
            interrupt = checkpoint(client)
            assert interrupt["reason"] == "tool_approval"
            assert target.read_text() == "original instructions"
            data = resume(interrupt, status="resolved", payload={"approved": approved})
            response = client.post("/agent", headers=AUTH, json=data)
            assert events(response)[-1]["type"] == "RUN_FINISHED", response.text
        assert target.read_text() == ("approved instructions" if approved else "original instructions")


def test_cancel_pending_wait_and_reject_cross_thread_resume(tmp_path):
    with FakeLLMServer([ToolCall("clarify", {"questions": [{"question": "Proceed?"}]}), Text("cancelled")]) as provider:
        home = write_hermes_home(tmp_path / "profile", provider.base_url)
        cfg = AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("clarify",),
                          agent_options={"skip_background_review": True})
        with TestClient(create_app(cfg, ServerConfig("local-secret"))) as client:
            interrupt = checkpoint(client)
            data = resume(interrupt, status="cancelled")
            data["threadId"] = "different"
            assert client.post("/agent", headers=AUTH, json=data).status_code == 409
            assert client.post("/threads/thread/cancel", headers=AUTH).status_code == 200
            data["threadId"] = "thread"
            assert client.post("/agent", headers=AUTH, json=data).status_code == 409


def test_pending_wait_expires_and_shutdown_releases_worker(tmp_path):
    from tests.waiting import async_wait_until

    with FakeLLMServer([ToolCall("clarify", {"questions": [{"question": "Proceed?"}]}), Text("done")]) as provider:
        home = write_hermes_home(tmp_path / "profile", provider.base_url)
        cfg = AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("clarify",),
                          agent_options={"skip_background_review": True})
        app = create_app(cfg, ServerConfig("local-secret", human_input_timeout=2))
        with TestClient(app) as client:
            interrupt = checkpoint(client)
            client.portal.call(async_wait_until, lambda: not app.state.adapter.active, 15)
            data = resume(interrupt, status="resolved", payload={"answers": {"q0": "yes"}})
            assert client.post("/agent", headers=AUTH, json=data).status_code == 409


def test_authorization_is_rechecked_on_resume_and_cancel(tmp_path):
    allowed = True

    def authorize(_principal, _thread):
        if not allowed:
            raise PermissionError("private policy")

    with FakeLLMServer([ToolCall("clarify", {"questions": [{"question": "Proceed?"}]}), Text("done")]) as provider:
        home = write_hermes_home(tmp_path / "profile", provider.base_url)
        cfg = AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("clarify",),
                          agent_options={"skip_background_review": True})
        app = create_app(cfg, ServerConfig("local-secret"), authorize=authorize)
        with TestClient(app) as client:
            interrupt = checkpoint(client)
            allowed = False
            data = resume(interrupt, status="cancelled")
            assert client.post("/agent", headers=AUTH, json=data).status_code == 403
            assert client.post("/threads/thread/cancel", headers=AUTH).status_code == 403
            allowed = True
        assert not app.state.adapter.active
