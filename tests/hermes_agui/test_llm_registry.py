"""Registry routes through the real native loop; never mutate an existing session."""
from dataclasses import replace
import json

import pytest

from hermes_agui.core import AgentConfig, HermesAgentService
from hermes_agui.core.llm_registry import parse_registry, agent_route, fingerprint, registry_scope
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, write_hermes_home


def compatible_registry(url):
    return {"version": 1, "providers": [{"id": "test", "driver": "openai-compatible", "baseUrl": url,
        "keyEnv": "LLM_REGISTRY_TEST_KEY", "capabilities": ["chat", "structured_output"]}], "models": [{
        "alias": "agent_primary", "provider": "test", "model": "registry-model", "timeoutMs": 3000,
        "retries": 0, "maxTokens": 512, "fallback": []}]}


def test_strict_parse_and_conflict(tmp_path):
    raw = compatible_registry("http://127.0.0.1:9/v1")
    parsed = parse_registry(raw)
    assert fingerprint(parsed) == fingerprint(parse_registry(json.loads(json.dumps(raw))))
    assert agent_route(raw)[0].model == "registry-model"
    raw["providers"][0]["apiKey"] = "must-not-leak"
    with pytest.raises(ValueError, match="^Invalid LLM registry configuration$"):
        parse_registry(raw)
    with pytest.raises(ValueError, match="conflicts"):
        AgentConfig(tmp_path / "profile", tmp_path, model="legacy", llm_registry=compatible_registry("http://localhost/v1"))


def test_vertex_scope_is_explicit_and_restored():
    from agent.vertex_adapter import _resolve_project_override, _resolve_region, vertex_route_scope
    from hermes_cli.timeouts import get_provider_request_timeout
    raw = compatible_registry("http://localhost/v1")
    raw["providers"] = [{"id": "test", "driver": "vertex", "project": "hermes-test", "location": "us-central1", "auth": "adc", "capabilities": ["chat"]}]
    raw["models"][0]["model"] = "gemini-2.5-flash"
    with vertex_route_scope({"project_id": "outer-project", "region": "global"}):
        with registry_scope(raw):
            assert _resolve_project_override() == "hermes-test"
            assert _resolve_region() == "us-central1"
            assert get_provider_request_timeout("vertex", "gemini-2.5-flash") == 3
        assert _resolve_project_override() == "outer-project"
        assert _resolve_region() == "global"


def test_registry_native_conversation_history_and_legacy_unchanged(tmp_path, monkeypatch):
    monkeypatch.setenv("LLM_REGISTRY_TEST_KEY", "fixture-only")
    with FakeLLMServer([Text("registry one"), Text("registry two"), Text("legacy")]) as server:
        home = tmp_path / "profile"
        write_hermes_home(home, server.base_url)
        config = AgentConfig(home, tmp_path, llm_registry=compatible_registry(server.base_url),
            llm_credentials={"LLM_REGISTRY_TEST_KEY": "fixture-only"},
            enabled_toolsets=("todo",), agent_options={"skip_background_review": True, "max_iterations": 2})
        with HermesAgentService(config) as service:
            one = service.run("same", "first message")
            two = service.run("same", "continue")
        assert one["final_response"] == "registry one"
        assert two["final_response"] == "registry two"
        assert one["native_session_id"] == two["native_session_id"]
        requests = server.main_requests()
        assert requests[0]["model"] == "registry-model"
        assert requests[1]["model"] == "registry-model"
        assert requests[0]["messages"][0] == requests[1]["messages"][0]
        assert any(m.get("content") == "first message" for m in requests[1]["messages"])
        with HermesAgentService(replace(config, llm_registry=None)) as service:
            assert service.run("legacy", "hello")["final_response"] == "legacy"


def test_dynamic_template_legacy_positional_api_and_registry_role(tmp_path):
    from hermes_agui.provisioner import ProvisionTemplate, HermesBotProvisioner, BotSpec
    legacy = ProvisionTemplate("old-model", "custom")
    assert legacy.provider == "custom"
    raw = compatible_registry("http://127.0.0.1:9/v1")
    template = ProvisionTemplate(llm_registry=raw, llm_credentials={"LLM_REGISTRY_TEST_KEY": "test-only"})
    spec = BotSpec(id="test", templateId="trusted", principal="owner", projectId="project",
        token="bot-token-for-test-only", memoryKey="memory-key-for-test-only")
    provisioner = HermesBotProvisioner(tmp_path / "managed", {"trusted": template})
    bot = provisioner.prepare(spec)
    assert bot.agent.llm_registry == raw
    assert bot.agent.llm_credentials == {"LLM_REGISTRY_TEST_KEY": "test-only"}
    assert bot.agent.model is None
    restored = provisioner.prepare(spec, restore=True)
    assert restored.agent.model_role == "agent_primary"
    assert restored.agent.home == bot.agent.home
    assert "test-only" not in repr(restored.agent)
