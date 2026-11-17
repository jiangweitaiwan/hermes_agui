"""Native snapshot restart and allowlisted immutable object contracts."""

from dataclasses import replace
from shutil import rmtree

import pytest

from hermes_agui.core import HermesAgentService
from hermes_agui.storage.objects import FilesystemObjects
from hermes_agui.storage.profile import BotScope, ProfileObjects
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall


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
