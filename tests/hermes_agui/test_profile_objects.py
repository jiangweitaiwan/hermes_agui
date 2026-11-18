"""Native snapshot restart and allowlisted immutable object contracts."""

import asyncio
from dataclasses import replace
from shutil import rmtree
from types import SimpleNamespace

import pytest

from hermes_agui.core import HermesAgentService
from hermes_agui.storage.host_runs import DurableHostRuns
from hermes_agui.storage.objects import FilesystemObjects
from hermes_agui.storage.profile import BotScope, ProfileObjects
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall


@pytest.mark.asyncio
async def test_durable_host_run_rehydrates_native_history(tmp_path, native_config):
    class RunStore:
        manifest = None

        def begin(self, scope, thread_id, run_id, attempt, seconds):
            return run_id

        def profile(self, scope):
            return self.manifest

        def renew(self, lease, seconds):
            return True

        def finish(self, lease, *, status, profile=None, expected_revision=None, reason=None,
                   evidence_generation=None):
            assert evidence_generation is None
            assert reason is None, reason
            assert status == "completed"
            assert expected_revision == (self.manifest.revision if self.manifest else None)
            self.manifest = profile
            return True

    async def execute_native(run, service):
        homes.append(service.config.home)
        return await asyncio.wrap_future(service.submit(
            run.turn.thread_id, run.turn.text, run_id=run.turn.run_id,
        ))

    store = RunStore()
    scope = BotScope("project", "local-owner", "analyst")
    objects = ProfileObjects(FilesystemObjects(tmp_path / "objects"))
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    homes = []
    with FakeLLMServer([Text("before restart"), Text("after restart")]) as model:
        for index, prompt in enumerate(("keep this history", "continue the thread")):
            config = replace(native_config(model, name=f"deployment-{index}"),
                             api_key="fixture-key")
            bot = SimpleNamespace(agent=config, authorize=None)
            lifecycle = DurableHostRuns(store, objects, scope, bot,
                                        scratch=scratch, approved=frozenset())
            run = SimpleNamespace(
                turn=SimpleNamespace(thread_id="thread", run_id=str(index), text=prompt),
                stop=asyncio.Event(), bridge=SimpleNamespace(failed=False),
            )
            result = await lifecycle.execute(run, execute_native)
            assert result.get("completed")
            assert store.manifest is not None
            assert not list(scratch.iterdir())

        assert homes[0] != homes[1]
        contents = [message.get("content") for message in model.main_requests()[-1]["messages"]]
        assert "keep this history" in contents
        assert "before restart" in contents
        requests = model.main_requests()
        prompts = [[message["content"] for message in request["messages"] if message["role"] == "system"]
                   for request in requests]
        assert len(prompts) == 2 and prompts[0] and prompts[0] == prompts[1]


class ImmutableObjects:
    def __init__(self):
        self.objects = {}

    def create(self, key, data):
        assert key not in self.objects
        self.objects[key] = data
        return "1"

    def read(self, key, generation, *, limit):
        assert generation == "1"
        data = self.objects[key]
        assert len(data) <= limit
        return data


def test_snapshot_restores_native_history_at_new_path(tmp_path, native_config):
    scope = BotScope("project", "local-owner", "analyst")
    root = tmp_path / "objects"
    objects = ProfileObjects(FilesystemObjects(root))
    approved = frozenset({"skills/analyst/SKILL.md"})
    fact = "remember the blue notebook"
    procedure = "Read the notebook index before summarizing."
    with FakeLLMServer([
        ToolCall("memory", {"target": "memory", "operations": [{"action": "add", "content": fact}]}),
        Text("before restart"),
        ToolCall("skill_view", {"name": "analyst"}),
        Text("after restart"),
    ]) as model:
        source = native_config(model, name="original")
        skill = source.home / "skills" / "analyst" / "SKILL.md"
        skill.parent.mkdir(parents=True, exist_ok=True)
        skill.write_text(f"---\nname: analyst\ndescription: Notebook analysis\n---\n{procedure}\n",
                         encoding="utf-8")
        with HermesAgentService(source) as service:
            first = service.run("thread", "keep this history")
            assert first["final_response"] == "before restart"
        memory = source.home / "memories" / "MEMORY.md"
        assert fact in memory.read_text(encoding="utf-8")
        template = {name: (source.home / name).read_bytes() for name in ("config.yaml", ".env")}
        revision = objects.stage(scope, source.home, approved=approved)
        assert {item.path for item in revision.files} >= {str(memory.relative_to(source.home)),
                                                         "skills/analyst/SKILL.md", "state.db"}
        assert not {item.path for item in revision.files} & template.keys()

        rmtree(source.home)
        new_home = tmp_path / "replacement"
        new_home.mkdir(mode=0o700)
        ProfileObjects(FilesystemObjects(root)).hydrate(scope, revision, new_home, approved=approved)
        for name, data in template.items():
            (new_home / name).write_bytes(data)
        restored = replace(source, home=new_home, session_home_identity=str(source.home))
        assert fact in (new_home / "memories/MEMORY.md").read_text(encoding="utf-8")

        with HermesAgentService(restored) as service:
            second = service.run("thread", "continue the thread")
        assert second["native_session_id"] == first["native_session_id"]
        assert second["final_response"] == "after restart"
        messages = model.main_requests()[-1]["messages"]
        contents = [message.get("content") for message in messages]
        assert "keep this history" in contents and "before restart" in contents
        assert any(procedure in str(message.get("content")) for message in messages if message["role"] == "tool")


def test_profile_rejects_wrong_scope_tampering_and_unsafe_paths(tmp_path):
    scope = BotScope("project", "alice", "bot")
    remote = ImmutableObjects()
    objects = ProfileObjects(remote)
    source = tmp_path / "source"
    source.mkdir()
    (source / "SOUL.md").write_bytes(b"owner profile")
    target = tmp_path / "target"
    target.mkdir()
    with pytest.raises(ValueError, match="Invalid profile path"):
        objects.stage(scope, source, approved=frozenset({"workspace/../.env"}))
    revision = objects.stage(scope, source)
    with pytest.raises(KeyError):
        objects.hydrate(BotScope("project", "bob", "bot"), revision, target)
    key = next(iter(remote.objects))
    remote.objects[key] = b"forged content"[:len(b"owner profile")]
    with pytest.raises(ValueError, match="checksum"):
        objects.hydrate(scope, revision, target)
    assert not list(target.iterdir())

    secret = tmp_path / "outside"
    secret.write_text("outside")
    (source / "SOUL.md").unlink()
    (source / "SOUL.md").symlink_to(secret)
    with pytest.raises(ValueError, match="Unsafe profile file"):
        objects.stage(scope, source)


def test_filesystem_object_generation_is_immutable(tmp_path):
    objects = FilesystemObjects(tmp_path)
    generation = objects.create("profile/revision/file", b"first")
    with pytest.raises(FileExistsError):
        objects.create("profile/revision/file", b"replacement")
    assert objects.read("profile/revision/file", generation, limit=5) == b"first"
    with pytest.raises(ValueError, match="generation or size"):
        objects.read("profile/revision/file", generation, limit=4)
