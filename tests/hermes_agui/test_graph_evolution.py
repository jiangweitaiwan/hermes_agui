"""Automatic graph learning traverses real Runtime and Hermes without history pollution."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
from unittest.mock import patch

import pytest

from tests.fakes.fake_llm_provider import FakeLLMServer, Text
from tests.hermes_agui.test_runtime_entrypoint import runtime


def test_native_completion_learns_for_a_new_thread(native_config, tmp_path):
    node = shutil.which("node")
    example = Path(__file__).resolve().parents[2] / "examples" / "copilotkit"
    if not node or not (example / "node_modules" / "tsx").is_dir():
        pytest.skip("Node and installed example dependencies required")
    finding = ("Research finding: PostgreSQL write ahead logging provides durable "
               "database recovery after a crash.")
    with FakeLLMServer([Text(finding), Text("Learned reference received")]) as provider:
        cfg = native_config(provider)
        deployment = tmp_path / "bots.yaml"
        deployment.write_text(json.dumps({"default_bot": "hermes", "bots": [{
            "id": "hermes", "token_env": "AGUI_API_KEY",
            "agent": {"home": str(cfg.home), "cwd": str(cfg.cwd),
                      "enabled_toolsets": ["memory", "skills"],
                      "agent_options": {"skip_background_review": True}},
            "server": {"runtime_memory_key_env": "TEST_RUNTIME_MEMORY_KEY",
                       "runtime_memory_project": "alpha"},
        }]}))
        with patch.dict(os.environ, {"TEST_RUNTIME_MEMORY_KEY": "runtime-only-key"}):
            with runtime(cfg.home, cfg.cwd, tmp_path, bots_config=deployment) as url:
                result = subprocess.run(
                    [node, "--import", "tsx", "tests/fixtures/wiki-session-probe.ts", url + "/agent"],
                    cwd=example, capture_output=True, text=True, timeout=90, check=False,
                    env={**os.environ, "COPILOTKIT_TELEMETRY_DISABLED": "true", "DO_NOT_TRACK": "1"},
                )
                assert result.returncode == 0, result.stderr
        record_ids = json.loads(result.stdout.strip().splitlines()[-1])["recordIds"]
        requests = provider.main_requests()
        assert len(requests) == 2
        assert "assistant-unverified" not in str(requests[0]["messages"])
        assert finding in str(requests[1]["messages"])
        assert "assistant-unverified" in str(requests[1]["messages"])
        assert requests[0]["messages"][0] == requests[1]["messages"][0]
        with sqlite3.connect(cfg.home / "state.db") as db:
            history = str(db.execute("SELECT * FROM messages").fetchall())
        assert all(record_id not in history for record_id in record_ids)
        assert "assistant-unverified" not in history
