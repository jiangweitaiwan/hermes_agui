"""Configured context engines retain native request, usage and session lifecycle hooks."""

from agent.context_engine import ContextEngine
from hermes_agui.core import HermesAgentService
from tests.fakes.fake_llm_provider import FakeLLMServer, Text


class ObservingContextEngine(ContextEngine):
    name = "phase6-observer"

    def __init__(self):
        self.requests = []
        self.usage = []
        self.turns = []
        self.ends = []

    def should_compress(self, prompt_tokens=None):
        return False

    def compress(self, messages, current_tokens=None, **kwargs):
        raise AssertionError("This short conversation must not need compaction")

    def update_from_response(self, usage):
        self.usage.append(dict(usage))
        self.last_prompt_tokens = usage["prompt_tokens"]
        self.last_completion_tokens = usage["completion_tokens"]

    def on_session_start(self, session_id, **kwargs):
        self.session_id = session_id
        self.home = kwargs["hermes_home"]

    def select_context(self, request_messages, **kwargs):
        self.requests.append([dict(m) for m in request_messages])

    def on_turn_complete(self, messages, usage=None, **kwargs):
        self.turns.append([dict(m) for m in messages])

    def on_session_end(self, session_id, messages):
        from hermes_constants import get_hermes_home

        self.ends.append((session_id, str(get_hermes_home()), [dict(m) for m in messages]))


def test_configured_engine_gets_per_thread_state_and_real_teardown_hooks(native_config, monkeypatch):
    engines = []

    def load(name):
        assert name == ObservingContextEngine.name
        engine = ObservingContextEngine()
        engines.append(engine)
        return engine

    monkeypatch.setattr("plugins.context_engine.load_context_engine", load)
    with FakeLLMServer([Text("alpha one"), Text("beta one"), Text("alpha two")]) as model:
        cfg = native_config(model, extra="context:\n  engine: phase6-observer\n", toolsets=("todo",))
        with HermesAgentService(cfg) as service:
            first = service.run("alpha", "alpha first message")
            second = service.run("beta", "beta first message")
            service.run("alpha", "alpha next message")
            assert len(engines) == 2
            assert not any(engine.ends for engine in engines)
            assert service.evict("alpha")
            assert len(engines[0].ends) == 1 and not engines[1].ends
        for engine, result, expected in zip(engines, (first, second), (2, 1)):
            assert engine.session_id == result["native_session_id"]
            assert engine.home == str(cfg.home)
            assert len(engine.usage) == len(engine.turns) == len(engine.requests) == expected
            assert all(usage["prompt_tokens"] > 0 for usage in engine.usage)
            assert len(engine.ends) == 1
            assert engine.ends[0][:2] == (engine.session_id, str(cfg.home))
        assert "beta first message" not in str(engines[0].requests)
        assert "alpha first message" not in str(engines[1].requests)
        assert "alpha first message" in str(engines[0].requests[-1])
