"""Stdlib-only probe executed INSIDE the built image; no test deps in runtime."""

import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def request(value):
    headers = {"Content-Type": "application/json", "Authorization": "Bearer container-test-token"}
    with urlopen(Request("http://127.0.0.1:8000/agent", json.dumps(value).encode(), headers), timeout=40) as response:
        return [json.loads(line[6:]) for line in response.read().decode().splitlines()
                if line.startswith("data: ")]


def start(home, workspace):
    process = subprocess.Popen([
        sys.executable, "-m", "hermes_agui.server", "--home", str(home),
        "--cwd", str(workspace), "--host", "127.0.0.1", "--port", "8000",
    ], stdout=subprocess.DEVNULL, stderr=sys.stderr)
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        assert process.poll() is None, "Container server exited during startup"
        try:
            with urlopen("http://127.0.0.1:8000/health", timeout=1) as response:
                assert json.load(response) == {"status": "ok"}
                return process
        except (URLError, TimeoutError):
            threading.Event().wait(0.1)
    process.kill()
    process.wait(timeout=5)
    raise AssertionError("Container health did not become ready")


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
        raise AssertionError("Container server failed cooperative shutdown") from None
    assert process.returncode in (0, -15)


def main():
    assert os.getuid() == 10000
    for name in ("apps", "web", "ui-tui", "docs", "tests", ".git", "acp_adapter", "examples"):
        assert not (Path("/opt/hermes") / name).exists(), name
    fake = runpy.run_path("/probe/fake_llm_provider.py")
    home, workspace = Path("/srv/hermes/profile"), Path("/srv/workspace")
    os.environ["AGUI_API_KEY"] = "container-test-token"
    with fake["FakeLLMServer"]([
        fake["ToolCall"]("terminal", {"command": "printf container-shell > shell-result.txt"}),
        fake["Text"]("shell completed"), fake["Text"]("history resumed"),
    ]) as provider:
        fake["write_hermes_home"](home, provider.base_url, extra_config=(
            "terminal:\n  backend: local\n  cwd: /srv/workspace\n"
            "platform_toolsets:\n  api_server: [terminal, file, memory, skills, clarify]\n"
            "updates:\n  check: false\nmodels_dev:\n  url: http://127.0.0.1:9/api.json\n"
        ))
        value = {"threadId": "probe", "runId": "first", "state": {}, "tools": [], "context": [],
                 "forwardedProps": {}, "messages": [{"id": "u1", "role": "user", "content": "create marker"}]}
        process = start(home, workspace)
        try:
            try:
                urlopen(Request("http://127.0.0.1:8000/agent", data=b"{}", headers={
                    "Content-Type": "application/json"}), timeout=5)
            except HTTPError as error:
                assert error.code == 401
            else:
                raise AssertionError("Unauthenticated request accepted")
            events = request(value)
            assert events[-1]["type"] == "RUN_FINISHED", events
            assert any(event["type"] == "TOOL_CALL_RESULT" for event in events)
            assert (workspace / "shell-result.txt").read_text(encoding="utf-8") == "container-shell"
        finally:
            stop(process)
        process = start(home, workspace)
        try:
            try:
                request(value)
            except HTTPError as error:
                assert error.code == 409
            else:
                raise AssertionError("Persisted duplicate receipt lost")
            value.update(runId="second", messages=[{"id": "u2", "role": "user", "content": "continue"}])
            assert request(value)[-1]["type"] == "RUN_FINISHED"
            messages = provider.main_requests()[-1]["messages"]
            assert sum(message.get("content") == "create marker" for message in messages) == 1
            assert any(message.get("content") == "shell completed" for message in messages)
            assert any(message.get("role") == "tool" for message in messages)
        finally:
            stop(process)
    print("Container native shell, SSE, authentication, history, receipts and restart: OK")


if __name__ == "__main__":
    main()
