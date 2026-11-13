"""Automatic native compression survives HTTP turns and service restart."""

import hashlib

from fastapi.testclient import TestClient

from hermes_agui.config import ServerConfig
from hermes_agui.server import create_app
from tests.fakes.fake_llm_provider import FakeLLMServer, Text
from tests.hermes_agui.test_native_capabilities import _send


def test_native_auto_compression_persists_summary_and_retains_full_display_history(native_config):
    summary = "The earlier discussion covered five project decisions and their tradeoffs."
    bulky = "\n".join(f"Decision {i}: {hashlib.sha256(str(i).encode()).hexdigest()}" for i in range(400))
    script = [Text(bulky, chunk_chars=32000) for _ in range(5)] + [
        Text("reported context pressure", prompt_tokens=120000),
        Text("continued after compression"), Text("resumed after restart"),
    ]
    with FakeLLMServer(script, aux=lambda _record: Text(summary, chunk_chars=1000)) as provider:
        cfg = native_config(provider, toolsets=("todo",), extra=(
            "compression:\n  enabled: true\n  protect_first_n: 0\n  protect_last_n: 2\n"
            "skills:\n  creation_nudge_interval: 0\nmemory:\n  nudge_interval: 0\n"
        ))
        with TestClient(create_app(cfg, ServerConfig("local-secret"))) as client:
            for i in range(6):
                _send(client, f"project decision {i}", i)
            _send(client, "continue after the context pressure", 6)
            session = client.app.state.adapter.service._sessions.find("alpha")
            native_id = session.agent.session_id
            assert session.agent.context_compressor.compression_count >= 1
            model_history, display = session.db.get_resume_conversations(native_id)
            assert summary in str(model_history)
            assert sum(m.get("content") == bulky for m in display) == 5
            assert sum(m.get("content") == bulky for m in model_history) < 5
        with TestClient(create_app(cfg, ServerConfig("local-secret"))) as client:
            _send(client, "continue after server restart", 7)
            assert client.app.state.adapter.service._sessions.find("alpha").agent.session_id == native_id
        requests = provider.main_requests()
        compacted = requests[-2]["messages"]
        resumed = requests[-1]["messages"]
        assert summary in str(compacted) and summary in str(resumed)
        assert "continue after server restart" in str(resumed)
        assert len(str(compacted)) < len(str(requests[5]["messages"]))
        assert any(not row["body"].get("tools") for row in provider.requests if row.get("body"))
