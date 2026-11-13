"""Concurrent native turns preserve scopes, admission order and cancellation identity."""

from __future__ import annotations

import threading
from dataclasses import replace

import pytest

from hermes_agui.core import AgentConfig, HermesAgentService
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, write_hermes_home


def test_background_turns_serialize_per_session_and_cancel_only_matching_run(tmp_path):
    entered, release = threading.Event(), threading.Event()

    def respond(request):
        if request["body"]["messages"][-1].get("content") == "hold first":
            entered.set()
            assert release.wait(120)
        return Text("done")

    with FakeLLMServer(respond) as server:
        home = write_hermes_home(tmp_path / "profile", server.base_url)
        cfg = AgentConfig(home=home, cwd=tmp_path, enabled_toolsets=("todo",),
                          agent_options={"skip_background_review": True, "max_iterations": 3})
        with HermesAgentService(cfg, max_workers=3, max_pending=3) as service:
            first = service.submit("a", "hold first", run_id="first")
            try:
                assert entered.wait(120)
                queued = service.submit("a", "second turn", run_id="second")
                independent = service.submit("b", "unrelated", run_id="other")
                assert independent.result(timeout=120)["final_response"] == "done"
                assert not queued.done()
                assert service.cancel("a", "stale") is False
                with pytest.raises(RuntimeError, match="running or queued"):
                    service.evict("a")
                assert service.cancel("a", "first") is True
            finally:
                release.set()
            stopped = first.result(timeout=120)
            assert stopped.get("interrupted") or not stopped.get("completed")
            assert queued.result(timeout=120)["completed"]
            assert service.cancel("a", "first") is False
        messages = server.main_requests()[-1]["messages"]
        assert messages[-1]["content"] == "second turn"
        assert "unrelated" not in [m.get("content") for m in messages]


def test_profiles_keep_native_memory_skills_and_credentials_separate(tmp_path):
    with FakeLLMServer([Text("alpha reply"), Text("beta reply")], api_key=("key-alpha", "key-beta")) as server:
        home_a = write_hermes_home(tmp_path / "a", server.base_url, api_key="key-alpha")
        home_b = write_hermes_home(tmp_path / "b", server.base_url, api_key="key-beta")
        for home, marker in ((home_a, "alpha"), (home_b, "beta")):
            memory = home / "memories"
            memory.mkdir(exist_ok=True)
            (memory / "MEMORY.md").write_text(f"{marker} private memory", encoding="utf-8")
            skill = home / "skills" / f"{marker}-skill"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                f"---\nname: {marker}-skill\ndescription: {marker} private skill\n---\n{marker} instructions",
                encoding="utf-8",
            )
        cfg = AgentConfig(home=home_a, cwd=tmp_path, enabled_toolsets=("memory", "skills"),
                          agent_options={"skip_background_review": True, "max_iterations": 3})
        with HermesAgentService(cfg) as alpha, HermesAgentService(replace(cfg, home=home_b)) as beta:
            a = alpha.run("same-external-id", "hello alpha")
            b = beta.run("same-external-id", "hello beta")
            assert a["native_session_id"] != b["native_session_id"]
        prompts = [str(r["messages"][0]["content"]) for r in server.main_requests()]
        assert "alpha private memory" in prompts[0] and "beta private memory" not in prompts[0]
        assert "beta private memory" in prompts[1] and "alpha private memory" not in prompts[1]
        assert "alpha-skill" in prompts[0] and "beta-skill" not in prompts[0]
        assert "beta-skill" in prompts[1] and "alpha-skill" not in prompts[1]
