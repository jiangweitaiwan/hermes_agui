"""Real MemoryManager lifecycle keeps worker and teardown hooks in the owning profile."""

from pathlib import Path

from agent.memory_provider import MemoryProvider
from hermes_agui.core import HermesAgentService
from tests.fakes.fake_llm_provider import FakeLLMServer, Text


class RecordingMemoryProvider(MemoryProvider):
    name = "phase6-recorder"

    def __init__(self):
        self.events = []
        self.options = {}

    def is_available(self):
        return True

    def get_tool_schemas(self):
        return []

    def initialize(self, session_id, **kwargs):
        self.options = kwargs
        self.session_id = session_id
        self.home = Path(kwargs["hermes_home"])
        self._record("initialize", session_id)

    def _record(self, kind, data):
        from agent.secret_scope import get_secret
        from hermes_constants import get_hermes_home

        self.events.append((kind, get_hermes_home(), get_secret("CAPABILITY_TEST_API_KEY"), data))

    def system_prompt_block(self):
        return f"External memory for {self.home.name}."

    def sync_turn(self, user_content, assistant_content, **kwargs):
        self._record("sync", (user_content, assistant_content, kwargs["session_id"]))

    def on_session_end(self, messages):
        self._record("end", [dict(m) for m in messages])
        (self.home / "extracted-memory.txt").write_text(
            "\n".join(str(m.get("content", "")) for m in messages), encoding="utf-8",
        )

    def shutdown(self):
        self._record("shutdown", self.session_id)


def test_provider_sync_extraction_and_shutdown_bind_profile_without_cli(native_config, monkeypatch):
    from hermes_constants import get_hermes_home

    providers = []

    def resolve(name, say=None):
        assert name == RecordingMemoryProvider.name
        provider = RecordingMemoryProvider()
        providers.append(provider)
        return provider

    monkeypatch.setattr("agent.agent_init.resolve_memory_provider", resolve)
    caller_home = get_hermes_home()
    with FakeLLMServer([Text("answer one"), Text("answer two"), Text("beta answer")]) as model:
        configs = [native_config(model, name=name, extra="memory:\n  provider: phase6-recorder\n")
                   for name in ("alpha", "beta")]
        for cfg in configs:
            with (cfg.home / ".env").open("a", encoding="utf-8") as stream:
                stream.write(f"CAPABILITY_TEST_API_KEY=fake-{cfg.home.name}\n")
        alpha, beta = [HermesAgentService(cfg) for cfg in configs]
        try:
            first = alpha.run("thread", "alpha first meaningful message")
            alpha.run("thread", "alpha second meaningful message")
            beta.run("thread", "beta separate meaningful message")
            assert not any(event[0] == "end" for p in providers for event in p.events)
            assert alpha.evict("thread")
            assert (configs[0].home / "extracted-memory.txt").exists()
            assert not (configs[1].home / "extracted-memory.txt").exists()
        finally:
            alpha.close()
            beta.close()
        alpha.close()
        beta.close()
        for provider, cfg, expected_turns in zip(providers, configs, (2, 1)):
            assert provider.options["platform"] == "api_server"
            assert provider.options["agent_context"] == "primary"
            assert all(home == cfg.home and secret == f"fake-{cfg.home.name}"
                       for _, home, secret, _ in provider.events)
            assert sum(kind == "sync" for kind, *_ in provider.events) == expected_turns
            assert sum(kind == "end" for kind, *_ in provider.events) == 1
            assert sum(kind == "shutdown" for kind, *_ in provider.events) == 1
            transcript = (cfg.home / "extracted-memory.txt").read_text(encoding="utf-8")
            assert f"{cfg.home.name} " in transcript
            assert ("beta " if cfg.home.name == "alpha" else "alpha ") not in transcript
        assert providers[0].session_id == first["native_session_id"]
        assert get_hermes_home() == caller_home
