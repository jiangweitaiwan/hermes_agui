"""Native memory/skills/context reach HTTP turns without rebuilding cached prompts."""

from fastapi.testclient import TestClient

from hermes_agui.config import ServerConfig
from hermes_agui.server import create_app
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall
from tests.hermes_agui.test_message_adapter import payload
from tests.hermes_agui.test_server import AUTH, events


def _skill(home, name, body):
    path = home / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\ndescription: Local {name} procedure\n---\n{body}\n", encoding="utf-8")
    return path


def _send(client, text, number, thread="alpha"):
    response = client.post("/agent", headers=AUTH, json=payload(
        threadId=thread, runId=f"run-{number}", messages=[
            {"id": f"user-{number}", "role": "user", "content": text}],
    ))
    assert response.status_code == 200, response.text
    assert events(response)[-1]["type"] == "RUN_FINISHED", response.text
    return response


def test_http_memory_writes_and_skill_loading_preserve_conversation_prefix(native_config):
    fact = "The preferred project color is teal."
    with FakeLLMServer([
        ToolCall("memory", {"target": "memory", "operations": [{"action": "add", "content": fact}]}),
        ToolCall("skill_view", {"name": "on-demand"}), Text("written"),
        Text("same session"), Text("new session"), Text("original session"),
    ]) as provider:
        cfg = native_config(provider, extra=(
            "skills:\n  auto_load: [pinned]\n  creation_nudge_interval: 0\n"
            "memory:\n  nudge_interval: 0\n"
        ))
        memories = cfg.home / "memories"
        memories.mkdir()
        (memories / "MEMORY.md").write_text("Initial project memory.", encoding="utf-8")
        (memories / "USER.md").write_text("The owner prefers concise answers.", encoding="utf-8")
        pinned = _skill(cfg.home, "pinned", "PINNED INITIAL PROCEDURE")
        _skill(cfg.home, "on-demand", "ON DEMAND NATIVE PROCEDURE")
        context = cfg.cwd / "AGENTS.md"
        context.write_text("INITIAL WORKSPACE GUIDANCE", encoding="utf-8")
        with TestClient(create_app(cfg, ServerConfig("local-secret"))) as client:
            response = _send(client, "save the project preference and read the local procedure", 1)
            assert "ON DEMAND NATIVE PROCEDURE" not in response.text
            assert fact in (memories / "MEMORY.md").read_text(encoding="utf-8")
            pinned.write_text(pinned.read_text().replace("INITIAL", "UPDATED"), encoding="utf-8")
            context.write_text("UPDATED WORKSPACE GUIDANCE", encoding="utf-8")
            _send(client, "continue the existing discussion", 2)
            _send(client, "start another project discussion", 3, thread="beta")
            _send(client, "return to the original discussion", 4)
        requests = provider.main_requests()
        initial = requests[0]["messages"][0]
        assert all(marker in str(initial["content"]) for marker in (
            "Initial project memory.", "The owner prefers concise answers.",
            "PINNED INITIAL PROCEDURE", "INITIAL WORKSPACE GUIDANCE",
        ))
        for index in (1, 2, 3, 5):
            assert requests[index]["messages"][0] == initial
            assert requests[index]["tools"] == requests[0]["tools"]
        fresh = str(requests[4]["messages"][0]["content"])
        assert fact in fresh and fact not in str(initial["content"])
        assert "PINNED UPDATED PROCEDURE" in fresh and "UPDATED WORKSPACE GUIDANCE" in fresh
        tool_rows = [m for m in requests[2]["messages"] if m["role"] == "tool"]
        assert any("ON DEMAND NATIVE PROCEDURE" in str(m["content"]) for m in tool_rows)
        assert "start another project discussion" not in str(requests[5]["messages"])


def test_same_named_skills_and_memory_stay_in_the_owning_profile(native_config):
    with FakeLLMServer([
        ToolCall("skill_view", {"name": "shared-name"}), Text("alpha completed"),
        ToolCall("skill_view", {"name": "shared-name"}), Text("beta completed"),
    ]) as provider:
        configs = [native_config(provider, name=name) for name in ("alpha", "beta")]
        for cfg, marker in zip(configs, ("ALPHA PROFILE", "BETA PROFILE")):
            memories = cfg.home / "memories"
            memories.mkdir()
            (memories / "MEMORY.md").write_text(marker, encoding="utf-8")
            _skill(cfg.home, "shared-name", f"{marker} PROCEDURE")
            with TestClient(create_app(cfg, ServerConfig("local-secret"))) as client:
                _send(client, "load our local procedure", 1, thread="same-external-thread")
        requests = provider.main_requests()
        for index, own, other in ((1, "ALPHA PROFILE", "BETA PROFILE"),
                                  (3, "BETA PROFILE", "ALPHA PROFILE")):
            rows = requests[index]["messages"]
            assert own in str(rows[0]["content"]) and other not in str(rows)
            assert any(own + " PROCEDURE" in str(m.get("content")) for m in rows if m["role"] == "tool")
