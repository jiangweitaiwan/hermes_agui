"""Real native Agent session for the Graph HTTP integration; external inference is loopback."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from hermes_agui.core import AgentConfig, HermesAgentService
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, write_hermes_home


def main():
    user = json.load(sys.stdin)["user"]
    with tempfile.TemporaryDirectory(prefix="llm-native-session-") as directory:
        root = Path(directory)
        with FakeLLMServer([Text("Research finding: user-stated meeting notes retained as reported evidence; assistant statements remain unverified.")]) as server:
            home = root / "home"
            write_hermes_home(home, server.base_url)
            registry = {"version": 1, "providers": [{"id": "fixture", "driver": "openai-compatible",
                "baseUrl": server.base_url, "keyEnv": "LLM_FIXTURE_KEY", "capabilities": ["chat"]}],
                "models": [{"alias": "agent_primary", "provider": "fixture", "model": "fake-model",
                "timeoutMs": 10000, "maxTokens": 2048, "retries": 0, "fallback": []}]}
            config = AgentConfig(home, root, llm_registry=registry,
                llm_credentials={"LLM_FIXTURE_KEY": "fixture-only"}, enabled_toolsets=("todo",),
                agent_options={"skip_background_review": True, "max_iterations": 2})
            with contextlib.redirect_stdout(io.StringIO()):
                with HermesAgentService(config) as service:
                    result = service.run("source-thread", user)
            if not result.get("completed"):
                raise RuntimeError("Native fixture did not complete")
            print(json.dumps({"user": user, "text": result["final_response"], "nativeSessionId": result["native_session_id"]}))


if __name__ == "__main__":
    main()
