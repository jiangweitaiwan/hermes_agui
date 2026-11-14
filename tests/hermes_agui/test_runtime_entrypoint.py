"""Exercise the deployment entrypoint, native shell tool and persistent HTTP history."""

from contextlib import contextmanager
import json
import os
import socket
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pytest

from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall, write_hermes_home
from tests.hermes_agui.test_message_adapter import payload
from tests.waiting import wait_until


@contextmanager
def runtime(home, workspace, tmp_path, *, bots_config=None):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = {**os.environ, "AGUI_API_KEY": "runtime-test-token", "HERMES_HOME": str(home)}
    with (tmp_path / "server.log").open("a", encoding="utf-8") as log:
        command = [
            sys.executable, "-m", "hermes_agui.server", "--home", str(home),
            "--cwd", str(workspace), "--port", str(port),
        ]
        if bots_config is not None:
            command += ["--bots-config", str(bots_config)]
        process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
        url = f"http://127.0.0.1:{port}"

        def ready():
            assert process.poll() is None, "Runtime exited before becoming ready"
            try:
                with urlopen(url + "/health", timeout=1) as response:
                    return json.load(response) == {"status": "ok"}
            except (URLError, TimeoutError):
                return False

        try:
            wait_until(ready, timeout=40, what="AG-UI deployment entrypoint ready")
            yield url
        finally:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                pytest.fail("Runtime did not shut down cooperatively")
        assert process.returncode in (0, -15)


def post(url, value, *, authenticated=True):
    headers = {"Content-Type": "application/json"}
    if authenticated:
        headers["Authorization"] = "Bearer runtime-test-token"
    request = Request(url + "/agent", data=json.dumps(value).encode(), headers=headers)
    with urlopen(request, timeout=40) as response:
        return [json.loads(line[6:]) for line in response.read().decode().splitlines()
                if line.startswith("data: ")]


@pytest.mark.platforms("posix")
def test_runtime_shell_and_history_survive_server_restart(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    marker = workspace / "shell-result.txt"
    with FakeLLMServer([
        ToolCall("terminal", {"command": "printf runtime-shell > shell-result.txt"}),
        Text("shell completed"), Text("history resumed"),
    ]) as provider:
        home = write_hermes_home(tmp_path / "profile", provider.base_url, extra_config=(
            f"terminal:\n  backend: local\n  cwd: {workspace}\n"
            "platform_toolsets:\n  api_server: [terminal, file, memory, skills, clarify]\n"
            "updates:\n  check: false\nmodels_dev:\n  url: http://127.0.0.1:9/api.json\n"
        ))
        first = payload(messages=[{"id": "first", "role": "user", "content": "create shell marker"}])
        with runtime(home, workspace, tmp_path) as url:
            with pytest.raises(HTTPError) as error:
                post(url, first, authenticated=False)
            assert error.value.code == 401
            events = post(url, first)
            assert events[-1]["type"] == "RUN_FINISHED"
            assert any(event["type"] == "TOOL_CALL_RESULT" for event in events)
            assert marker.exists(), [m for r in provider.main_requests() for m in r["messages"] if m.get("role") == "tool"]
            assert marker.read_text(encoding="utf-8") == "runtime-shell"
        with runtime(home, workspace, tmp_path) as url:
            with pytest.raises(HTTPError) as error:
                post(url, first)
            assert error.value.code == 409
            events = post(url, payload(runId="second-run", messages=[
                {"id": "second", "role": "user", "content": "continue after restart"},
            ]))
            assert events[-1]["type"] == "RUN_FINISHED"
        messages = provider.main_requests()[-1]["messages"]
        assert sum(message.get("content") == "create shell marker" for message in messages) == 1
        assert any(message.get("content") == "shell completed" for message in messages)
        assert any(message.get("role") == "tool" for message in messages)


def test_runtime_requires_auth_secret(tmp_path):
    env = {key: value for key, value in os.environ.items() if key != "AGUI_API_KEY"}
    result = subprocess.run([
        sys.executable, "-m", "hermes_agui.server", "--home", str(tmp_path),
        "--cwd", str(tmp_path),
    ], env=env, capture_output=True, text=True, timeout=20, check=False)
    assert result.returncode == 2
    assert "Set the AGUI_API_KEY secret" in result.stderr


@pytest.mark.platforms("posix")
def test_multi_bot_cli_restart_preserves_separate_native_histories(tmp_path, monkeypatch):
    with FakeLLMServer(lambda record: Text("reply: " + "|".join(
        m["content"] for m in record["body"]["messages"] if m["role"] == "user"))) as provider:
        bots = []
        for name in ("researcher", "reviewer"):
            workspace = tmp_path / f"{name}-workspace"
            workspace.mkdir()
            home = write_hermes_home(tmp_path / name, provider.base_url, extra_config=(
                "platform_toolsets:\n  api_server: [todo]\nupdates:\n  check: false\n"
                "models_dev:\n  url: http://127.0.0.1:9/api.json\n"))
            monkeypatch.setenv(f"{name.upper()}_TOKEN", name)
            bots.append({"id": name, "token_env": f"{name.upper()}_TOKEN",
                         "agent": {"home": str(home), "cwd": str(workspace), "principal": name,
                                   "agent_options": {"skip_background_review": True}}})
        config = tmp_path / "bots.yaml"
        config.write_text(json.dumps({"bots": bots}))
        for restarted in (False, True):
            with runtime(tmp_path / "launch-profile", tmp_path, tmp_path, bots_config=config) as url:
                for name in ("researcher", "reviewer"):
                    data = payload(runId="second" if restarted else "run", messages=[{
                        "id": "second" if restarted else "u1", "role": "user",
                        "content": "continue" if restarted else name}])
                    request = Request(url + f"/bots/{name}/agent", data=json.dumps(data).encode(),
                        headers={"Content-Type": "application/json", "Authorization": f"Bearer {name}"})
                    with urlopen(request, timeout=40) as response:
                        text = response.read().decode()
                    assert '"type":"RUN_FINISHED"' in text.replace(" ", "")
                    if restarted:
                        messages = provider.main_requests()[-1]["messages"]
                        assert any(m.get("content") == name for m in messages)
                        assert not any(m.get("content") == ("reviewer" if name == "researcher" else "researcher") for m in messages)
