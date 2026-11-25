"""Native deployment guidance changes only at the trusted new-run boundary."""
from hermes_agui.core import AgentConfig, HermesAgentService
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, write_hermes_home
from tests.hermes_agui.test_llm_registry import compatible_registry


def test_instruction_update_preserves_native_tools_and_history(tmp_path, monkeypatch):
    monkeypatch.setenv("LLM_REGISTRY_TEST_KEY", "fixture-only")
    with FakeLLMServer([Text("first"), Text("second"), Text("third")]) as server:
        home = write_hermes_home(tmp_path / "profile", server.base_url)
        registry = compatible_registry(server.base_url)
        config = AgentConfig(home, tmp_path, llm_registry=registry,
            llm_credentials={"LLM_REGISTRY_TEST_KEY": "fixture-only"}, enabled_toolsets=("todo",),
            agent_options={"skip_background_review": True, "max_iterations": 2})
        with HermesAgentService(config) as service:
            first = service.run("thread", "first message", registry=registry, release_id="old", instruction="OLD_SLOT")
            second = service.run("thread", "next", registry=registry, release_id="new", instruction="NEW_SLOT")
            third = service.run("thread", "rollback", registry=registry, release_id="old", instruction="OLD_SLOT")
        assert first["completed"] and second["completed"] and third["completed"]
        assert first["native_session_id"] == second["native_session_id"] == third["native_session_id"]
        requests = server.main_requests()
        systems = [r["messages"][0]["content"] for r in requests]
        assert "OLD_SLOT" in systems[0] and "NEW_SLOT" not in systems[0]
        assert "NEW_SLOT" in systems[1] and "OLD_SLOT" not in systems[1]
        assert "OLD_SLOT" in systems[2] and "NEW_SLOT" not in systems[2]
        assert requests[0]["tools"] == requests[1]["tools"]
        assert any(m.get("content") == "first message" for m in requests[2]["messages"])


def test_inflight_tool_loop_keeps_instruction_until_next_run(tmp_path, monkeypatch):
    from threading import Event
    from tests.fakes.fake_llm_provider import ToolCall

    monkeypatch.setenv("LLM_REGISTRY_TEST_KEY", "fixture-only")
    entered, released = Event(), Event()
    with FakeLLMServer([ToolCall("todo_list", {}), Text("old complete"), Text("new complete")]) as server:
        home = write_hermes_home(tmp_path / "profile", server.base_url)
        registry = compatible_registry(server.base_url)
        config = AgentConfig(home, tmp_path, llm_registry=registry,
            llm_credentials={"LLM_REGISTRY_TEST_KEY": "fixture-only"}, enabled_toolsets=("todo",),
            agent_options={"skip_background_review": True, "max_iterations": 4})

        def pause(*_args):
            entered.set()
            assert released.wait(15)

        with HermesAgentService(config) as service:
            current = service.submit("thread", "read todo", run_id="old", registry=registry,
                release_id="old", instruction="OLD_SLOT", callbacks={"tool_start_callback": pause})
            try:
                assert entered.wait(15)
                next_run = service.submit("thread", "continue", run_id="new", registry=registry,
                    release_id="new", instruction="NEW_SLOT")
            finally:
                released.set()
            assert current.result(timeout=15)["completed"]
            assert next_run.result(timeout=15)["completed"]
        systems = [r["messages"][0]["content"] for r in server.main_requests()]
        assert all("OLD_SLOT" in value and "NEW_SLOT" not in value for value in systems[:2])
        assert "NEW_SLOT" in systems[2] and "OLD_SLOT" not in systems[2]
