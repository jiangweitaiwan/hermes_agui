"""Trusted run pin keeps native history/tools and freezes in-flight routing."""
from copy import deepcopy
from dataclasses import replace
from threading import Event

import pytest

from hermes_agui.core import AgentConfig, HermesAgentService
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall, write_hermes_home
from tests.hermes_agui.test_llm_registry import compatible_registry


def test_same_thread_new_release_rebuilds_client_preserving_native_history(tmp_path, monkeypatch):
    monkeypatch.setenv("LLM_REGISTRY_TEST_KEY", "fixture-only")
    with FakeLLMServer([Text("first"), Text("second"), Text("third")]) as server:
        home = write_hermes_home(tmp_path / "profile", server.base_url)
        initial = compatible_registry(server.base_url)
        newer = deepcopy(initial)
        newer["models"][0]["model"] = "new-model"
        config = AgentConfig(home, tmp_path, llm_registry=initial,
            llm_credentials={"LLM_REGISTRY_TEST_KEY": "fixture-only"}, enabled_toolsets=("todo",),
            agent_options={"skip_background_review": True, "max_iterations": 2})
        with HermesAgentService(replace(config,llm_control={"mode":"managed"})) as admission:
            with pytest.raises(ValueError, match="verified release"):
                admission.run("thread", "must not infer")
        with HermesAgentService(config) as service:
            one = service.run("thread", "first message", registry=initial, release_id="release-001")
            two = service.run("thread", "continue", registry=newer, release_id="release-002")
            three = service.run("thread", "after rollback", registry=initial, release_id="release-001")
        assert one["completed"] and two["completed"] and three["completed"]
        assert one["native_session_id"] == two["native_session_id"] == three["native_session_id"]
        requests = server.main_requests()
        assert [r["model"] for r in requests] == ["registry-model", "new-model", "registry-model"]
        # Native assembly intentionally refreshes runtime model identity at the new run boundary.
        assert "new-model" in requests[1]["messages"][0]["content"]
        assert requests[0]["messages"][0] == requests[2]["messages"][0]
        assert requests[0]["tools"] == requests[1]["tools"]
        assert any(m.get("content") == "first message" for m in requests[2]["messages"])


def test_publish_while_native_tool_is_running_keeps_original_route(tmp_path, monkeypatch):
    monkeypatch.setenv("LLM_REGISTRY_TEST_KEY", "fixture-only")
    entered, released = Event(), Event()
    completed = []
    with FakeLLMServer([ToolCall("todo_list", {}), Text("A completed"), Text("B completed")]) as server:
        home = write_hermes_home(tmp_path / "profile", server.base_url)
        old = compatible_registry(server.base_url)
        new = deepcopy(old)
        new["models"][0]["model"] = "new-model"
        config = AgentConfig(home, tmp_path, llm_registry=old,
            llm_credentials={"LLM_REGISTRY_TEST_KEY": "fixture-only"}, enabled_toolsets=("todo",),
            agent_options={"skip_background_review": True, "max_iterations": 4})

        def pause(*_args):
            entered.set()
            assert released.wait(15), "test must release native tool"

        with HermesAgentService(config) as service:
            future = service.submit("thread", "inspect native todo list", run_id="A", registry=old, release_id="release-001",
                                    callbacks={"tool_start_callback": pause,"tool_complete_callback":lambda *args: completed.append(args)})
            try:
                assert entered.wait(15), "native loop must reach tool"
                # The publisher's new snapshot is separate from A's trusted input.
                assert new["models"][0]["model"] != old["models"][0]["model"]
            finally:
                released.set()
            assert future.result(timeout=15)["completed"]
            assert service.run("thread", "next turn", registry=new, release_id="release-002")["completed"]
        assert [r["model"] for r in server.main_requests()] == ["registry-model", "registry-model", "new-model"]
        assert completed[0][1] == "todo_list" and "todos" in str(completed[0][3])


def test_managed_native_transport_denies_private_destinations():
    from hermes_agui.core.managed_llm import managed_agent_type
    from tools.url_safety import SSRFConnectionBlocked

    # Exercise the same existing connect-time guard used by the native client seam.
    guarded = managed_agent_type(object)
    with pytest.raises(ValueError,match="TLS verification"):
        guarded._build_keepalive_http_client(verify=False)
    with guarded._build_keepalive_http_client() as client:
        with pytest.raises(SSRFConnectionBlocked,match="private/internal address"):
            client.get("http://127.0.0.1:9/metadata", timeout=2)


def test_shared_golden_snapshot_and_host_contract(tmp_path):
    import json
    from pathlib import Path
    from hermes_agui.core.managed_llm import validate_snapshot, canonical_hash

    fixture = json.loads((Path(__file__).parents[1] / "fixtures" / "llm-control-golden.json").read_text())
    snapshot = fixture["snapshot"]
    assert canonical_hash(snapshot) == fixture["releaseFingerprint"]
    assert validate_snapshot(snapshot, fixture["releaseFingerprint"], fixture["policy"]) == snapshot["llm"]
    changed = deepcopy(snapshot)
    changed["tasks"]["v2-parser"]["prompt"] = "different instruction"
    with pytest.raises(ValueError, match="contract"):
        validate_snapshot(changed, canonical_hash(changed), fixture["policy"])
    with pytest.raises(ValueError,match="agent_primary"):
        AgentConfig(tmp_path/"profile",tmp_path,model_role="graph_story",llm_control={"mode":"managed"})


@pytest.mark.asyncio
async def test_cancelled_http_resolver_keeps_connection_budget_until_thread_finishes(monkeypatch):
    import asyncio
    from hermes_agui.core.managed_llm import ManagedResolver
    from tests.waiting import async_wait_until

    entered, released = Event(), Event()

    def resolve(*_args):
        entered.set()
        assert released.wait(5)
        return "resolved"

    monkeypatch.setattr("hermes_agui.core.managed_llm.resolve_run", resolve)
    resolver = ManagedResolver(1)
    task = asyncio.create_task(resolver.resolve(None, "bot", None, None))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with pytest.raises(ValueError, match="capacity"):
            await resolver.resolve(None, "bot", None, None)
    finally:
        released.set()

    async def retry():
        try:
            return await resolver.resolve(None, "bot", None, None)
        except ValueError:
            return None

    assert await async_wait_until(retry, timeout=5) == "resolved"


def test_graph_only_release_does_not_reinitialize_native_prompt_and_tools(tmp_path, monkeypatch):
    import hermes_agui.core.service as module

    initialized = []
    original = module.create_agent

    def construct(*args):
        initialized.append(True)
        return original(*args)

    monkeypatch.setattr(module, "create_agent", construct)
    monkeypatch.setenv("LLM_REGISTRY_TEST_KEY", "fixture-only")
    with FakeLLMServer([Text("one"), Text("two")]) as server:
        initial = compatible_registry(server.base_url)
        initial["models"].append({**initial["models"][0], "alias": "graph_parser", "model": "parser-old"})
        changed = deepcopy(initial)
        changed["models"][1]["model"] = "parser-new"
        home = write_hermes_home(tmp_path / "profile", server.base_url)
        config = AgentConfig(home, tmp_path, llm_registry=initial,
            llm_credentials={"LLM_REGISTRY_TEST_KEY": "fixture-only"}, enabled_toolsets=("todo",),
            agent_options={"skip_background_review": True, "max_iterations": 2})
        with HermesAgentService(config) as service:
            first = service.run("thread", "first", registry=initial, release_id="release-001")
            second = service.run("thread", "next", registry=changed, release_id="release-002")
        assert first["completed"] and second["completed"]
        assert first["native_session_id"] == second["native_session_id"]
        assert len(initialized) == 1
        requests = server.main_requests()
        assert requests[0]["messages"][0] == requests[1]["messages"][0]
        assert requests[0]["tools"] == requests[1]["tools"]
