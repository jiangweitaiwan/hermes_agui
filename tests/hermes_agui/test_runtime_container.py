"""Opt-in acceptance against a built Docker image; no live provider credentials."""

import os
from pathlib import Path
import subprocess

import pytest


@pytest.mark.integration
@pytest.mark.platforms("posix")
def test_built_container_native_runtime():
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run([
        "docker", "run", "--rm", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
        "--mount", f"type=bind,src={root / 'tests/hermes_agui/container_probe.py'},dst=/probe/container_probe.py,readonly",
        "--mount", f"type=bind,src={root / 'tests/fakes/fake_llm_provider.py'},dst=/probe/fake_llm_provider.py,readonly",
        "--entrypoint", "python", os.environ.get("AGUI_TEST_IMAGE", "hermes-agui:phase8"),
        "/probe/container_probe.py",
    ], check=False, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Container native shell, SSE, authentication, history, receipts and restart: OK" in result.stdout
