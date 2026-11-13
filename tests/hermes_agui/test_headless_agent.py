"""Real native loop, provider transport, registry and durable history; no live model."""

from __future__ import annotations

from dataclasses import replace

import pytest

from hermes_agui.core import AgentConfig, HermesAgentService
from tests.fakes.fake_llm_provider import Error, FakeLLMServer, Text, ToolCall, write_hermes_home


@pytest.fixture
def service_config(tmp_path):
    def build(server, **changes):
        home = tmp_path / "profile"
        write_hermes_home(home, server.base_url, extra_config=(
            "updates:\n  check: false\nmodels_dev:\n  url: http://127.0.0.1:9/api.json\n"
            "skills:\n  creation_nudge_interval: 0\nmemory:\n  nudge_interval: 0\n"
        ))
        options = {"skip_background_review": True, "max_iterations": 4}
        return AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("todo",), agent_options=options, **changes)
    return build


def test_stream_history_isolation_and_restart(service_config, monkeypatch):
    from gateway.session_context import get_session_env
    from hermes_constants import get_hermes_home

    monkeypatch.setattr("builtins.input", lambda *_args: pytest.fail("Headless runs must not read terminal input"))
    caller_home, caller_session = get_hermes_home(), get_session_env("HERMES_SESSION_ID")
    with FakeLLMServer([Text("first answer"), Text("second answer"), Text("other answer"), Text("resumed")]) as server:
        config = service_config(server)
        deltas = []
        with HermesAgentService(config) as service:
            first = service.run("a", "private alpha", callbacks={"stream_delta_callback": deltas.append})
            second = service.run("a", "continue alpha")
            other = service.run("b", "private beta")
            assert first["completed"] and first["final_response"] == "first answer"
            assert "".join(deltas) == "first answer"
            assert first["native_session_id"] == second["native_session_id"]
            assert other["native_session_id"] != first["native_session_id"]
            assert service.evict("a")
        with HermesAgentService(config) as service:
            resumed = service.run("a", "after restart")
            assert resumed["final_response"] == "resumed"
            assert resumed["native_session_id"] == first["native_session_id"]
        requests = server.main_requests()
        contents = [[m.get("content") for m in r["messages"]] for r in requests]
        assert "private alpha" in contents[1]
        assert "private alpha" not in contents[2]
        assert "private beta" not in contents[3]
        assert contents[3].count("private alpha") == 1
        assert contents[3].count("continue alpha") == 1
        assert requests[0]["messages"][0] == requests[1]["messages"][0]
        assert requests[0].get("tools") == requests[1].get("tools")
        assert get_hermes_home() == caller_home
        assert get_session_env("HERMES_SESSION_ID") == caller_session


@pytest.mark.parametrize("exists", [True, False], ids=["success", "tool-error"])
def test_native_tool_callbacks_and_result_reach_next_model_request(tmp_path, exists):
    target = tmp_path / "sample.txt"
    if exists:
        target.write_text("safe tool content", encoding="utf-8")
    with FakeLLMServer([ToolCall("read_file", {"path": str(target)}), Text("tool finished")]) as server:
        home = write_hermes_home(tmp_path / "profile", server.base_url)
        config = AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("file",),
                             agent_options={"skip_background_review": True, "max_iterations": 4})
        starts, completes = [], []
        with HermesAgentService(config) as service:
            result = service.run("tool-session", "read the supplied file", callbacks={
                "tool_start_callback": lambda *args: starts.append(args),
                "tool_complete_callback": lambda *args: completes.append(args),
            })
        assert result["completed"] and result["final_response"] == "tool finished"
        assert starts and completes
        assert starts[0][0] == completes[0][0]
        assert starts[0][1] == completes[0][1] == "read_file"
        expected = "safe tool content" if exists else "error"
        assert expected in str(completes[0][3])
        rows = server.main_requests()[1]["messages"]
        tool_row = next(m for m in rows if m["role"] == "tool")
        call_row = next(m for m in rows if m.get("tool_calls"))
        assert tool_row["tool_call_id"] == call_row["tool_calls"][0]["id"] == starts[0][0]
        assert expected in str(tool_row["content"])


def test_authorization_and_bounded_lifecycle(service_config):
    with FakeLLMServer([Text("ok"), Text("ok again")]) as server:
        config = service_config(server)

        def authorize(principal, session_id):
            assert principal == "local-owner"
            if session_id == "forbidden":
                raise PermissionError("not owned")

        service = HermesAgentService(config, max_sessions=1, authorize=authorize)
        try:
            with pytest.raises(PermissionError):
                service.run("forbidden", "must not execute")
            service.run("a", "hello")
            with pytest.raises(RuntimeError, match="capacity"):
                service.run("b", "hello")
            assert service.cancel("a", "stale-run") is False
            assert service.evict("a")
            service.run("b", "hello again")
        finally:
            service.close()
        service.close()
        with pytest.raises(RuntimeError, match="closed"):
            service.run("a", "no more")


def test_initialization_failure_can_be_evicted_without_leaking_db(tmp_path):
    config = AgentConfig(home=tmp_path / "profile", cwd=tmp_path, provider="not-a-provider", model="fake")
    with HermesAgentService(config) as service:
        with pytest.raises((ValueError, RuntimeError)):
            service.run("bad", "hello")
        assert service.evict("bad")


def test_explicit_empty_toolsets_and_native_provider_failure(service_config):
    # The shared fake classifies requests without tools as auxiliary, so this
    # fixture explicitly answers that lane for a genuinely tool-free turn.
    with FakeLLMServer(aux=lambda _record: Text("without tools")) as server:
        config = replace(service_config(server), enabled_toolsets=())
        with HermesAgentService(config) as service:
            result = service.run("empty-tools", "hello")
            assert result["completed"] and result["final_response"] == "without tools"
        assert all(not record["body"].get("tools") for record in server.requests if "body" in record)
    with FakeLLMServer([Error(400, "scripted invalid request")] * 8) as server:
        with HermesAgentService(service_config(server)) as service:
            result = service.run("provider-error", "hello")
            assert result.get("failed") and not result.get("completed")


def test_native_memory_write_and_skill_view_remain_available(tmp_path):
    script = [
        ToolCall("memory", {"target": "memory", "operations": [{"action": "add", "content": "remember blue"}]}),
        ToolCall("skill_view", {"name": "host-example"}),
        Text("native capabilities used"),
    ]
    with FakeLLMServer(script) as server:
        home = write_hermes_home(tmp_path / "profile", server.base_url)
        skill = home / "skills" / "host-example"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: host-example\ndescription: Local fixture instructions\n---\nFollow the blue procedure.",
            encoding="utf-8",
        )
        cfg = AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("memory", "skills"),
                          agent_options={"skip_background_review": True, "max_iterations": 5})
        with HermesAgentService(cfg) as service:
            result = service.run("capabilities", "remember blue and read host-example")
            assert result["completed"]
        assert "remember blue" in (home / "memories" / "MEMORY.md").read_text(encoding="utf-8")
        results = [m for m in server.main_requests()[-1]["messages"] if m["role"] == "tool"]
        assert any("Follow the blue procedure" in str(row["content"]) for row in results)
