"""Authenticated references reach real native provider requests without durable pollution."""
import base64
import hashlib
import hmac
import json
import time

from fastapi.testclient import TestClient
import pytest

from hermes_agui.config import ServerConfig
from hermes_agui.server import create_app
from tests.fakes.fake_llm_provider import FakeLLMServer, Text
from tests.hermes_agui.test_message_adapter import payload
from tests.hermes_agui.test_server import AUTH, events


KEY = "runtime-only-key"


def signed(context, *, thread="alpha", run="one", bot="hermes", expires=None):
    data = {"botId": bot, "threadId": thread, "runId": run, "principal": "local-owner",
            "projectId": "alpha", "expires": int(time.time()) + 60 if expires is None else expires, "context": context}
    encoded = base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
    return {"runtimeMemory": {"payload": encoded,
            "signature": hmac.new(KEY.encode(), encoded.encode(), hashlib.sha256).hexdigest()}}


def context(text="Project Alpha 使用 PostgreSQL"):
    return {"version": 1, "records": [{"id": "fact-1", "content": text,
        "sourceBotId": "hermes", "sourceThreadId": "source", "visibility": "project_shared"}]}


def document_context():
    return {"version": 2, "records": [{"id": "fact-1", "content": "Project Alpha 使用 PostgreSQL",
        "sourceBotId": "hermes", "visibility": "bot_private", "sources": [{"kind": "document",
        "botId": "hermes", "sourceId": "12345678-1234-1234-1234-123456789abc", "version": 1,
        "hash": "a" * 64, "title": "Database policy"}]}]}


@pytest.mark.parametrize("factory", [context, document_context])
def test_reference_reaches_native_model_only_for_current_run(native_config, factory):
    with FakeLLMServer([Text("PostgreSQL"), Text("continue")]) as provider:
        cfg = native_config(provider)
        server = ServerConfig("local-secret", runtime_memory_key=KEY, runtime_memory_project="alpha")
        with TestClient(create_app(cfg, server)) as client:
            first = payload(threadId="alpha", runId="one", forwardedProps=signed(factory()))
            response = client.post("/agent", headers=AUTH, json=first)
            assert response.status_code == 200, response.text
            assert events(response)[-1]["type"] == "RUN_FINISHED", response.text
            response = client.post("/agent", headers=AUTH, json=payload(threadId="alpha", runId="two",
                messages=[{"id": "second", "role": "user", "content": "continue"}]))
            assert events(response)[-1]["type"] == "RUN_FINISHED", response.text
        requests = provider.main_requests()
        assert "PostgreSQL" in str(requests[0]["messages"])
        assert "fact-1" not in str(requests[1]["messages"])
        assert requests[0]["messages"][0] == requests[1]["messages"][0]
        import sqlite3
        with sqlite3.connect(cfg.home / "state.db") as db:
            rows = db.execute("SELECT * FROM messages").fetchall()
        assert "fact-1" not in str(rows)


def test_forged_misbound_and_replayed_envelopes_fail_closed(native_config):
    with FakeLLMServer([Text("ok")]) as provider:
        cfg = native_config(provider)
        with TestClient(create_app(cfg, ServerConfig("local-secret", runtime_memory_key=KEY,
                                                       runtime_memory_project="alpha"))) as client:
            for props in ({"runtimeMemory": {"payload": "fake", "signature": "fake"}},
                          signed(context(), bot="other"), signed(context(), thread="other"),
                          signed(context(), run="other"), signed(context(), expires=0),
                          signed({**context(), "version": 2}),
                          signed(context("x" * 20000)),
                          {"runtimeMemory": {"payload": "fake", "signature": "非ASCII"}}):
                response = client.post("/agent", headers=AUTH, json=payload(
                    threadId="alpha", runId="one", forwardedProps=props))
                assert response.status_code == 422
            valid = payload(threadId="alpha", runId="one", forwardedProps=signed(context()))
            assert client.post("/agent", headers=AUTH, json=valid).status_code == 200
            assert client.post("/agent", headers=AUTH, json=valid).status_code == 409


@pytest.mark.parametrize("probe,record_id,expected", [
    ("runtime-memory-probe.ts", "runtime-acceptance-fact", "PostgreSQL"),
    ("wiki-document-probe.ts", "document", "PostgreSQL"),
    ("graph-v3-probe.ts", "story:", "FeatureHub"),
])
def test_copilot_runtime_fake_graph_to_native_provider(native_config, tmp_path, probe, record_id, expected):
    import os
    from pathlib import Path
    import shutil
    import subprocess

    import pytest

    from tests.hermes_agui.test_runtime_entrypoint import runtime

    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for cross-language Runtime acceptance")
    root = Path(__file__).resolve().parents[2]
    example = root / "examples" / "copilotkit"
    if not (example / "node_modules" / "tsx" / "dist" / "cli.mjs").exists():
        pytest.skip("Install example JS dependencies for cross-language acceptance")
    with FakeLLMServer([Text("PostgreSQL")]) as provider:
        cfg = native_config(provider)
        deployment = tmp_path / "bots.yaml"
        deployment.write_text(json.dumps({"default_bot": "hermes", "bots": [{
            "id": "hermes", "token_env": "AGUI_API_KEY",
            "agent": {"home": str(cfg.home), "cwd": str(cfg.cwd), "enabled_toolsets": ["memory", "skills"],
                      "agent_options": {"skip_background_review": True}},
            "server": {"runtime_memory_key_env": "TEST_RUNTIME_MEMORY_KEY", "runtime_memory_project": "alpha"},
        }]}))
        from unittest.mock import patch
        with patch.dict(os.environ, {"TEST_RUNTIME_MEMORY_KEY": KEY}):
            with runtime(cfg.home, cfg.cwd, tmp_path, bots_config=deployment) as url:
                completed = subprocess.run([node, "node_modules/tsx/dist/cli.mjs",
                    f"tests/fixtures/{probe}", url + "/agent"],
                    cwd=example, capture_output=True, text=True, timeout=90, check=False,
                    env={**os.environ, "COPILOTKIT_TELEMETRY_DISABLED": "true", "DO_NOT_TRACK": "1"})
                assert completed.returncode == 0, completed.stderr
        requests = provider.main_requests()
        assert len(requests) == 1
        assert record_id in str(requests[0]["messages"])
        assert expected in str(requests[0]["messages"])
        if probe == "graph-v3-probe.ts":
            assert "untrusted reference" in str(requests[0]["messages"])
            assert "source-thread-a" in str(requests[0]["messages"])
            assert "Bob 把 FeatureHub 回滾" in str(requests[0]["messages"])
        import sqlite3
        with sqlite3.connect(cfg.home / "state.db") as db:
            assert record_id not in str(db.execute("SELECT * FROM messages").fetchall())


def test_v2_private_multi_source_and_unknown_fields_fail_closed():
    from hermes_agui.runtime_memory import _validate_context

    value = document_context()
    assert _validate_context(value, "hermes")["version"] == 2
    value["records"][0]["sources"].append({"botId": "other", "threadId": "private", "runId": "run"})
    with pytest.raises(ValueError):
        _validate_context(value, "hermes")
    value = document_context()
    value["records"][0]["sources"][0]["path"] = "../../secret"
    with pytest.raises(ValueError):
        _validate_context(value, "hermes")
