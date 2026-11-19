"""Delete both application containers and all writable layers; recover only from PG/object storage."""
from urllib.parse import urlsplit

import pytest

from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall


@pytest.mark.integration
@pytest.mark.platforms("posix")
def test_cloud_native_production_images():
    from tests.hermes_agui.cloud_native_smoke import production_image_smoke

    production_image_smoke()


@pytest.mark.integration
@pytest.mark.platforms("posix")
def test_cloud_native_dual_container_restart(tmp_path, native_config):
    from tests.hermes_agui.cloud_native_scenario import KNOWLEDGE, MEMORY, PROCEDURE, SKILL, create_bots, learn_and_lose_ack, recover, scenario

    def reply(record):
        messages = record["body"]["messages"]
        task = next(message["content"] for message in reversed(messages) if message["role"] == "user")
        names = [call["function"]["name"] for message in messages for call in message.get("tool_calls", [])]
        if task == "learn":
            if "memory" not in names:
                return ToolCall("memory", {"target": "memory", "operations": [{"action": "add", "content": MEMORY}]})
            if "skill_manage" not in names:
                return ToolCall("skill_manage", {"action": "create", "name": "notebook", "content": SKILL})
            return Text(KNOWLEDGE)
        if task == "continue":
            assert KNOWLEDGE in str(messages)
            assert any(message["role"] == "tool" for message in messages)
            if messages[-1]["role"] != "tool":
                return ToolCall("skill_view", {"name": "notebook"})
            assert PROCEDURE in messages[-1]["content"]
            return Text("已復原原始對話、記憶與核准技能。")
        if task == "memory-check":
            assert MEMORY in str(messages[0])
            return Text("已在新對話載入持久化的原生記憶。")
        if task == "retrieve":
            assert "資料庫" in str(messages[0])
            return Text("檢索到已授權的共享資料庫知識。")
        raise AssertionError("Unexpected fake-model task")

    with FakeLLMServer(reply, listen_host="0.0.0.0") as model:
        from utils import load_yaml_file_readonly
        cfg = native_config(model)
        templates = tmp_path / "templates"
        templates.mkdir()
        model_url = model.base_url.replace(urlsplit(model.base_url).hostname, "host.docker.internal")
        with scenario(templates, load_yaml_file_readonly(cfg.home / "config.yaml"), model_url) as fixture:
            fixture.start()
            bots = create_bots(fixture)
            evidence = learn_and_lose_ack(fixture, bots[0])
            recover(fixture, bots, evidence)
