"""Cross-language managed creation, routing, graph isolation and real native delegation."""
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
from unittest.mock import patch
from urllib.parse import urlencode

import pytest

from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall
from tests.hermes_agui.test_runtime_entrypoint import runtime


@pytest.mark.parametrize("backend", ["sqlite", "postgres"])
def test_managed_runtime_native_delegation_and_persistent_lifecycle(native_config, tmp_path, backend):
    database_url = ""
    if backend == "postgres":
        socket_dir = os.environ.get("HERMES_AGUI_TEST_DB_SOCKET")
        if not socket_dir:
            pytest.skip("Requires a disposable PostgreSQL Unix socket with Runtime migrations")
        assert Path(socket_dir).is_absolute() and Path(socket_dir).is_dir()
        database_url = "postgresql://hermes@localhost/postgres?" + urlencode({"host": socket_dir})
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for dynamic Runtime acceptance")
    example = Path(__file__).resolve().parents[2] / "examples" / "copilotkit"
    if not (example / "node_modules" / "tsx" / "dist" / "cli.mjs").exists():
        pytest.skip("Install example dependencies for dynamic Runtime acceptance")

    def respond(record):
        messages = record["body"]["messages"]
        user = next(m["content"] for m in reversed(messages) if m["role"] == "user")
        text = user if isinstance(user, str) else user[0]["text"]
        if text.startswith("delegate "):
            if messages[-1]["role"] == "tool":
                outcome = json.loads(messages[-1]["content"])
                return Text(f"Delegation {outcome['status']}: {outcome.get('text', '')}")
            return ToolCall("message_bot", {"target_bot_id": text.split()[1], "task": "Project Alpha 使用什麼資料庫？"})
        return Text("PostgreSQL")

    registry_path = tmp_path / "runtime-registry.sqlite3"
    with FakeLLMServer(respond) as provider:
        cfg = native_config(provider)
        from utils import load_yaml_file_readonly
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        managed_root = tmp_path / "managed"
        deployment = tmp_path / "managed.json"
        deployment.write_text(json.dumps({"bots": [], "management": {
            "root": str(managed_root), "token_env": "TEST_HOST_MANAGEMENT_KEY",
            "templates": {"native": {"model": "fake-model", "provider": "custom",
                "api_key_env": "TEST_NATIVE_KEY", "base_url": provider.base_url,
                "config": load_yaml_file_readonly(cfg.home / "config.yaml"),
                "agent_options": {"skip_background_review": True, "max_iterations": 5}}}},
            "delegation": {"url": f"http://127.0.0.1:{port}/internal/delegations", "token_env": "TEST_DELEGATION_KEY"}}))
        with patch.dict(os.environ, {"TEST_HOST_MANAGEMENT_KEY": "host-manager-secret",
                                    "AGUI_BOT_CREDENTIAL_SEED": "93" * 32,
                                    "TEST_NATIVE_KEY": "sk-fake-e2e", "TEST_DELEGATION_KEY": "delegation-secret"}):
            with runtime(cfg.home, cfg.cwd, tmp_path, bots_config=deployment) as url:
                completed = subprocess.run([node, "node_modules/tsx/dist/cli.mjs", "tests/fixtures/dynamic-bot-probe.ts",
                    url, str(registry_path), str(port)], cwd=example,
                    capture_output=True, text=True, timeout=150, check=False,
                    env={**os.environ, "COPILOTKIT_TELEMETRY_DISABLED": "true", "DO_NOT_TRACK": "1",
                         "TEST_BOT_REGISTRY_DATABASE_URL": database_url})
                assert completed.returncode == 0, completed.stderr
        assert registry_path.exists() == (backend == "sqlite")
        ids = json.loads(completed.stdout)
        requests = provider.main_requests()
        assert len(requests) >= 6
        child_requests = [r for r in requests if "Reviewer native role" in str(r["messages"][0])]
        assert len(child_requests) >= 2
        for request in child_requests:
            assert "shared-fact" in str(request["messages"])
            assert "private-child" in str(request["messages"])
            assert "private-parent" not in str(request["messages"])
        parent_requests = [r for r in requests if "Researcher native role" in str(r["messages"][0])]
        assert len(parent_requests) >= 2
        assert parent_requests[0]["messages"][0] == parent_requests[1]["messages"][0]
        for bot_id in ids.values():
            with sqlite3.connect(managed_root / bot_id / "home" / "state.db") as db:
                transcript = str(db.execute("SELECT * FROM messages").fetchall())
                assert "shared-fact" not in transcript
                assert "private-child" not in transcript and "private-parent" not in transcript
        assert (managed_root / ids["child"] / "home" / "SOUL.md").exists()
