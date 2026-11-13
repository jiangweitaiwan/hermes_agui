"""HTTP uses SDK SSE frames and real native persistence through a loopback model."""

import json
from concurrent.futures import Future

from ag_ui.core import Event
from fastapi.testclient import TestClient
from pydantic import TypeAdapter
import pytest

from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig
from hermes_agui.server import create_app
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, write_hermes_home
from tests.hermes_agui.test_message_adapter import payload

AUTH = {"Authorization": "Bearer local-secret"}


def events(response):
    output = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    for event in output:
        TypeAdapter(Event).validate_python(event)
    return output


class StubService:
    def __init__(self, _config, **_kwargs):
        self.calls = []
        self.closed = False

    def submit(self, thread, text, *, run_id):
        self.calls.append((thread, text, run_id))
        future = Future()
        future.set_result({"completed": True, "final_response": "answer", "messages": "PRIVATE PROMPT"})
        return future

    def close(self):
        self.closed = True


def test_http_auth_validation_replay_and_safe_health(tmp_path):
    app = create_app(AgentConfig(home=tmp_path, cwd=tmp_path), ServerConfig("local-secret"),
                     service_factory=StubService)
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert client.post("/agent", json=payload()).status_code == 401
        invalid = client.post("/agent", headers=AUTH, json={"api_key": "PRIVATE-SECRET"})
        assert invalid.status_code == 422 and "PRIVATE-SECRET" not in invalid.text
        response = client.post("/agent", headers=AUTH, json=payload())
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        output = events(response)
        assert [e["type"] for e in output] == ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT",
                                               "TEXT_MESSAGE_END", "RUN_FINISHED"]
        assert output[0]["threadId"] == "thread" and output[-1]["runId"] == "run"
        assert len({e["messageId"] for e in output[1:4]}) == 1
        assert "PRIVATE PROMPT" not in response.text
        assert client.post("/agent", headers=AUTH, json=payload()).status_code == 409
        assert client.post("/agent", headers=AUTH, json=payload(runId="new-run")).status_code == 409
        assert len(app.state.adapter.service.calls) == 1
    assert app.state.adapter.service.closed


def test_native_provider_error_uses_sanitized_run_error(tmp_path):
    class Failure(StubService):
        def submit(self, *_args, **_kwargs):
            raise RuntimeError("SECRET-KEY provider prompt")

    app = create_app(AgentConfig(home=tmp_path, cwd=tmp_path), ServerConfig("local-secret"),
                     service_factory=Failure)
    with TestClient(app) as client:
        response = client.post("/agent", headers=AUTH, json=payload())
        assert [e["type"] for e in events(response)] == ["RUN_STARTED", "RUN_ERROR"]
        assert "SECRET-KEY" not in response.text


@pytest.mark.parametrize("flag", ["failed", "partial", "interrupted"])
def test_native_incomplete_results_do_not_publish_private_partial_text(tmp_path, flag):
    class Incomplete(StubService):
        def submit(self, *_args, **_kwargs):
            future = Future()
            future.set_result({"completed": True, flag: True, "final_response": "PRIVATE PARTIAL"})
            return future

    app = create_app(AgentConfig(home=tmp_path, cwd=tmp_path), ServerConfig("local-secret"),
                     service_factory=Incomplete)
    with TestClient(app) as client:
        response = client.post("/agent", headers=AUTH, json=payload())
        assert [e["type"] for e in events(response)] == ["RUN_STARTED", "RUN_ERROR"]
        assert "PRIVATE PARTIAL" not in response.text


def test_http_real_native_history_and_thread_isolation(tmp_path):
    with FakeLLMServer([Text("first"), Text("second"), Text("other")]) as provider:
        home = write_hermes_home(tmp_path / "profile", provider.base_url)
        cfg = AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("todo",),
                          agent_options={"skip_background_review": True, "max_iterations": 3})
        with TestClient(create_app(cfg, ServerConfig("local-secret"))) as client:
            for data, answer in [
                (payload(), "first"),
                (payload(runId="r2", messages=payload()["messages"] + [
                    {"id": "a1", "role": "assistant", "content": "first"},
                    {"id": "u2", "role": "user", "content": "continue"}]), "second"),
                (payload(threadId="other"), "other"),
            ]:
                response = client.post("/agent", json=data, headers=AUTH)
                output = events(response)
                assert output[-1]["type"] == "RUN_FINISHED", response.text
                assert output[2]["delta"] == answer
        transcripts = [[m.get("content") for m in r["messages"]] for r in provider.main_requests()]
        assert transcripts[1].count("hello") == 1
        assert transcripts[1].count("continue") == 1
        assert "continue" not in transcripts[2]
