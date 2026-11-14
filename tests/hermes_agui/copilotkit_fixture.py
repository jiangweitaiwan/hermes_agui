"""Loopback-only native Hermes host for the CopilotKit browser acceptance suite.

Run via the example's Playwright webServer. No real credentials or model calls.
"""

import argparse
import os
import socket
from pathlib import Path
import tempfile
import threading
from unittest.mock import patch


def serve(port):
    import uvicorn

    from hermes_agui.config import ServerConfig
    from hermes_agui.core import AgentConfig, HermesAgentService
    from hermes_agui.server import create_app
    from tests.fakes.fake_llm_provider import Error, FakeLLMServer, Text, ToolCall, write_hermes_home

    release = threading.Event()
    workspace = Path(os.environ["HERMES_HOME"]).parent
    target = workspace / "sample.txt"
    target.write_text("Native tool fixture content", encoding="utf-8")

    def respond(record):
        messages = record["body"]["messages"]
        text = next(m["content"] for m in reversed(messages) if m["role"] == "user")
        if text == "ask color":
            if messages[-1]["role"] == "tool":
                return Text("Clarification received: Blue.")
            return ToolCall("clarify", {"questions": [{"question": "Which color?", "choices": ["Red", "Blue"]}]})
        if text == "approve write":
            if messages[-1]["role"] == "tool":
                return Text("Approval handled.")
            return ToolCall("write_file", {"path": str(workspace / "AGENTS.md"), "content": "approved"})
        if text == "fail":
            return Error(400, "PRIVATE scripted provider failure")
        if text == "read sample":
            if messages[-1]["role"] == "tool":
                return Text("Native tool finished.")
            return ToolCall("read_file", {"path": str(target)})
        replies = {"hello alpha": "Alpha private answer.", "hello beta": "Beta private answer.",
                   "continue": "Continued alpha conversation.",
                   "stream": "First streamed words. Remaining final answer."}
        return Text(replies.get(text, "Fixture answer."), chunk_chars=6)

    class StreamingProbeService(HermesAgentService):
        def submit(self, session_id, message, *, run_id, callbacks=None):
            callbacks = dict(callbacks or {})
            if message == "stream":
                original = callbacks["stream_delta_callback"]
                first = True

                def delta(value):
                    nonlocal first
                    original(value)
                    if value and first:
                        first = False
                        if not release.wait(120):
                            raise TimeoutError("Browser did not release streaming probe")

                callbacks["stream_delta_callback"] = delta
            return super().submit(session_id, message, run_id=run_id, callbacks=callbacks)

    with FakeLLMServer(respond) as provider:
        home = write_hermes_home(Path(os.environ["HERMES_HOME"]), provider.base_url, extra_config=(
            "updates:\n  check: false\nmodels_dev:\n  url: http://127.0.0.1:9/api.json\n"
            "skills:\n  creation_nudge_interval: 0\nmemory:\n  nudge_interval: 0\n"
        ))
        cfg = AgentConfig(home=home, cwd=workspace, enabled_toolsets=("file", "clarify"),
                          agent_options={"skip_background_review": True, "max_iterations": 3})
        app = create_app(cfg, ServerConfig("browser-test-only"), service_factory=StreamingProbeService)

        @app.post("/__test/release")
        async def release_stream():
            release.set()
            return {"released": True}

        @app.get("/__test/transcripts")
        async def transcripts():
            return [[m for m in request["messages"] if m["role"] != "system"]
                    for request in provider.main_requests()]

        try:
            uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
        finally:
            release.set()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="hermes-copilotkit-e2e-") as directory:
        os.environ["HERMES_HOME"] = str(Path(directory) / "profile")
        os.environ["HERMES_RUNTIME_DIR"] = str(Path(directory) / "runtime")
        original_resolver = socket.getaddrinfo

        def loopback_only(host, *args, **kwargs):
            if host not in ("localhost", "127.0.0.1", "::1", b"localhost", b"127.0.0.1", b"::1"):
                raise socket.gaierror("Browser fixture only permits loopback network")
            return original_resolver(host, *args, **kwargs)

        with patch.object(socket, "getaddrinfo", loopback_only):
            serve(args.port)


if __name__ == "__main__":
    main()
