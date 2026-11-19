"""Managed Bots use real native profiles, durable lifecycle state and isolated sessions."""
from concurrent.futures import Future

from fastapi.testclient import TestClient

from hermes_agui.management import ManagementConfig
from hermes_agui.provisioner import ProvisionTemplate
from hermes_agui.server import create_host
from tests.fakes.fake_llm_provider import FakeLLMServer, Text
from tests.hermes_agui.test_message_adapter import payload
from tests.hermes_agui.test_server import events

ADMIN = {"Authorization": "Bearer host-manager-secret"}


def spec(bot_id="bot-alpha", **changes):
    return {"id": bot_id, "name": bot_id, "description": f"Role of {bot_id}", "templateId": "native",
            "principal": "owner", "projectId": "project", "token": f"{bot_id}-bearer-credential",
            "memoryKey": f"{bot_id}-memory-signing-credential", "skills": [],
            "toolsets": ["memory", "skills"], **changes}


def settings(tmp_path, native_config, provider):
    from utils import load_yaml_file_readonly

    cfg = native_config(provider)
    return ManagementConfig(tmp_path / "managed", "host-manager-secret", {"native": ProvisionTemplate(
        model="fake-model", provider="custom", api_key="sk-fake-e2e", base_url=provider.base_url, config=load_yaml_file_readonly(cfg.home / "config.yaml"),
        agent_options={"skip_background_review": True, "max_iterations": 3})})


def test_dynamic_services_isolate_history_restore_and_soft_delete(tmp_path, native_config):
    with FakeLLMServer([Text("alpha"), Text("beta"), Text("alpha resumed")]) as provider:
        config = settings(tmp_path, native_config, provider)
        for cycle in range(2):
            app = create_host([], management=config)
            with TestClient(app) as client:
                if cycle == 0:
                    assert client.put("/internal/bots/bot-alpha", headers=ADMIN, json=spec()).status_code == 200
                    assert client.put("/internal/bots/bot-beta", headers=ADMIN, json=spec("bot-beta")).status_code == 200
                    for bot_id in ("bot-alpha", "bot-beta"):
                        response = client.post(f"/bots/{bot_id}/agent", headers={"Authorization": f"Bearer {spec(bot_id)['token']}"},
                            json=payload(threadId="same-thread", messages=[{"id": "same-message", "role": "user", "content": bot_id}]))
                        assert events(response)[-1]["type"] == "RUN_FINISHED", response.text
                    assert "bot-alpha" in str(provider.main_requests()[0]["messages"][-1])
                    assert "bot-alpha" not in str(provider.main_requests()[1]["messages"][-1])
                else:
                    home = config.root / "bot-alpha" / "home"
                    assert "EVOLVED SOUL" in (home / "SOUL.md").read_text()
                    assert (home / "memories" / "MEMORY.md").read_text() == "NATIVE PERSISTENT MEMORY"
                    assert (home / "skills" / "native-learned" / "SKILL.md").exists()
                    response = client.post("/bots/bot-alpha/agent", headers={"Authorization": f"Bearer {spec()['token']}"},
                        json=payload(threadId="same-thread", runId="second", messages=[{"id": "second", "role": "user", "content": "continue"}]))
                    assert events(response)[-1]["type"] == "RUN_FINISHED", response.text
                    assert "bot-alpha" in str(provider.main_requests()[-1]["messages"])
                if cycle == 0:
                    home = config.root / "bot-alpha" / "home"
                    with (home / "SOUL.md").open("a") as soul:
                        soul.write("EVOLVED SOUL")
                    (home / "memories" / "MEMORY.md").write_text("NATIVE PERSISTENT MEMORY")
                    skill = home / "skills" / "native-learned"
                    skill.mkdir()
                    (skill / "SKILL.md").write_text("---\nname: native-learned\ndescription: learned skill\n---\nNative procedure")
                    assert client.post("/internal/bots/bot-beta/disable", headers=ADMIN).status_code == 200
                    assert client.post("/bots/bot-beta/agent", json=payload()).status_code == 404
                    assert client.put("/internal/bots/bot-beta", headers=ADMIN, json=spec("bot-beta")).status_code == 200
                else:
                    assert client.delete("/internal/bots/bot-alpha", headers=ADMIN).status_code == 200
                    assert client.put("/internal/bots/bot-alpha", headers=ADMIN, json=spec()).status_code == 409
                    assert (config.root / "bot-alpha" / "home" / "state.db").exists()
        with TestClient(create_host([], management=config)) as client:
            assert client.post("/bots/bot-alpha/agent", json=payload()).status_code == 404
            assert client.get("/internal/bots/bot-alpha", headers=ADMIN).json()["status"] == "deleted"


def test_management_auth_paths_capabilities_and_symlinks_fail_closed(tmp_path, native_config):
    with FakeLLMServer([]) as provider:
        config = settings(tmp_path, native_config, provider)
        outside = tmp_path / "outside"
        outside.mkdir()
        config.root.mkdir()
        (config.root / "bot-link").symlink_to(outside, target_is_directory=True)
        with TestClient(create_host([], management=config)) as client:
            assert client.put("/internal/bots/bot-alpha", json=spec()).status_code == 401
            assert client.put("/internal/bots/bot-alpha", headers={**ADMIN, "Origin": "http://browser"}, json=spec()).status_code == 401
            for changes in ({"id": "../escape"}, {"toolsets": ["terminal"]}, {"skills": ["../escape"]},
                            {"home": "/tmp/escape"}, {"templateId": "unapproved"}):
                assert client.put("/internal/bots/bot-alpha", headers=ADMIN, json=spec(**changes)).status_code == 422
            assert client.put("/internal/bots/bot-link", headers=ADMIN, json=spec("bot-link")).status_code == 422
            assert not list(outside.iterdir())
            assert client.put("/internal/bots/bot-alpha", headers=ADMIN, json=spec()).status_code == 200
            assert "credential" not in client.get("/internal/bots", headers=ADMIN).text
            assert client.put("/internal/bots/bot-alpha", headers=ADMIN, json=spec(principal="other")).status_code == 409


class HeldService:
    def __init__(self, config, **_options):
        self.config = config
        self.future = Future()
        self.callbacks = None

    def submit(self, _session, _message, *, run_id, callbacks):
        self.callbacks = callbacks
        return self.future

    def cancel(self, *_args):
        return False

    def close(self):
        self.future.cancel()


def test_active_run_prevents_unload_and_reconfiguration(tmp_path, native_config):
    with FakeLLMServer([]) as provider:
        config = settings(tmp_path, native_config, provider)
        app = create_host([], management=config, service_factory=HeldService)
        with TestClient(app) as client:
            assert client.put("/internal/bots/bot-alpha", headers=ADMIN, json=spec()).status_code == 200
            adapter = app.state.adapters["bot-alpha"]
            # Admit through the same adapter as HTTP without consuming its open SSE stream.
            from hermes_agui.message_adapter import TurnInput
            client.portal.call(adapter.start, TurnInput("t", "r", "m", "wait"))
            for method, url, data in (("POST", "/internal/bots/bot-alpha/disable", None),
                                      ("DELETE", "/internal/bots/bot-alpha", None),
                                      ("PUT", "/internal/bots/bot-alpha", spec(description="updated"))):
                assert client.request(method, url, headers=ADMIN, json=data).status_code == 409
            adapter.service.future.set_result({"completed": True, "final_response": "done"})
            from tests.waiting import wait_until
            wait_until(lambda: not adapter.active, timeout=5)
            assert client.delete("/internal/bots/bot-alpha", headers=ADMIN).status_code == 200


def test_postgres_managed_host_rebuilds_and_observes_remote_disable(tmp_path, native_config, monkeypatch):
    import hashlib
    import hmac
    import json
    import os
    from shutil import rmtree
    from urllib.parse import urlencode
    from uuid import uuid4

    import pytest

    from hermes_agui.storage.host_settings import HostStorage
    from hermes_agui.storage.objects import FilesystemObjects
    from hermes_agui.storage.profile import ProfileObjects

    socket = os.environ.get("HERMES_AGUI_TEST_DB_SOCKET")
    if not socket:
        pytest.skip("Requires disposable PostgreSQL with Host migrations")
    pool_type = pytest.importorskip("psycopg_pool").ConnectionPool
    url = "postgresql://hermes@localhost/postgres?" + urlencode({"host": socket})
    seed = bytes.fromhex("93" * 32)
    monkeypatch.setenv("AGUI_BOT_CREDENTIAL_SEED", seed.hex())
    project = str(uuid4())
    bot = spec(projectId=project, ownerId="registered-owner")

    def credential(purpose):
        value = json.dumps([purpose, bot["ownerId"], project, bot["principal"], bot["id"]],
                           separators=(",", ":")).encode()
        return hmac.new(seed, value, hashlib.sha256).hexdigest()

    bot.update(token=credential("host-token"), memoryKey=credential("memory-key"))
    management_path = f"/internal/bots/{bot['id']}"
    agent_path = f"/bots/{bot['id']}/agent"
    bearer = {"Authorization": f"Bearer {bot['token']}"}

    with FakeLLMServer([Text("persisted response"), Text("resumed response")]) as provider:
        config = settings(tmp_path, native_config, provider)
        objects = ProfileObjects(FilesystemObjects(tmp_path / "objects"))

        def app():
            pool = pool_type(url, min_size=1, max_size=4, open=False)
            storage = HostStorage(pool, objects, project, None, {})
            return create_host([], management=config, storage=storage)

        def chat(client, run_id, message):
            reply = client.post(agent_path, headers=bearer, json=payload(threadId="shared-thread",
                runId=run_id, messages=[{"id": run_id, "role": "user", "content": message}]))
            assert events(reply)[-1]["type"] == "RUN_FINISHED", reply.text

        first_app, other_app = app(), app()
        with TestClient(first_app) as first, TestClient(other_app) as other:
            assert first.put(management_path, headers=ADMIN, json={**bot, "token": "wrong" * 8}).status_code == 422
            assert first.put(management_path, headers=ADMIN, json=bot).status_code == 200
            assert first.put(management_path, headers=ADMIN, json=bot).status_code == 200
            assert other.get(management_path, headers=ADMIN).json()["status"] == "active"
            chat(other, "first", "retain the original message")
            stale = other_app.state.adapters[bot["id"]].durable_runs
            assert first.post(management_path + "/disable", headers=ADMIN).status_code == 200
            assert stale.runs.begin(stale.scope, "shared-thread", "stale", uuid4(), 90,
                                    managed_revision=stale.managed_revision) is None
            assert other.post(agent_path, headers=bearer, json=payload()).status_code == 409
            assert first.put(management_path, headers=ADMIN, json=bot).status_code == 200
        rmtree(config.root)
        with TestClient(app()) as restarted:
            chat(restarted, "second", "continue the same thread")
            assert restarted.delete(management_path, headers=ADMIN).status_code == 200
            assert restarted.put(management_path, headers=ADMIN, json=bot).status_code == 409
        messages = provider.main_requests()[-1]["messages"]
        assert "retain the original message" in str(messages)
        assert "persisted response" in str(messages)
        with pool_type(url, min_size=1, max_size=1) as pool, pool.connection() as conn:
            stored, = conn.execute("SELECT spec FROM hermes_agui_host.managed_bots WHERE project=%s",
                                   (project,)).fetchone()
        assert "token" not in stored and "memoryKey" not in stored


def test_postgres_management_operations_fence_delayed_writes_and_scope(tmp_path, native_config, monkeypatch):
    import hashlib
    import json
    import os
    from urllib.parse import urlencode
    from uuid import uuid4

    import pytest

    from hermes_agui.storage.host_settings import HostStorage
    from hermes_agui.storage.objects import FilesystemObjects
    from hermes_agui.storage.profile import ProfileObjects

    socket = os.environ.get("HERMES_AGUI_TEST_DB_SOCKET")
    if not socket:
        pytest.skip("Requires disposable PostgreSQL with Host migrations")
    pool_type = pytest.importorskip("psycopg_pool").ConnectionPool
    url = "postgresql://hermes@localhost/postgres?" + urlencode({"host": socket})
    monkeypatch.setenv("AGUI_BOT_CREDENTIAL_SEED", "93" * 32)
    project = str(uuid4())
    bot = {key: value for key, value in spec(projectId=project, ownerId="owner").items()
           if key not in {"token", "memoryKey"}}

    def operation(revision, state="active", **changes):
        data = {**bot, **changes}
        fingerprint = hashlib.sha256(json.dumps([state, data], ensure_ascii=False, sort_keys=True,
                                                separators=(",", ":")).encode()).hexdigest()
        return {"operationId": str(uuid4()), "desiredRevision": str(revision), "state": state,
                "specHash": fingerprint, "spec": data}

    with FakeLLMServer([]) as provider:
        config = settings(tmp_path, native_config, provider)
        objects = ProfileObjects(FilesystemObjects(tmp_path / "objects"))
        storage = HostStorage(pool_type(url, min_size=1, max_size=4, open=False), objects, project, None, {})
        app = create_host([], management=config, storage=storage)
        path = f"/internal/bots/{bot['id']}/operation"
        with TestClient(app) as client:
            def apply(value):
                return client.put(path, headers=ADMIN, json=value)

            first = operation(1)
            ack = apply(first)
            assert ack.status_code == 200, ack.text
            assert apply(first).json() == ack.json()
            assert apply(operation(1, name="changed")).status_code == 409
            disabled = operation(2, "disabled")
            from hermes_agui.storage.profile import BotScope
            scope = BotScope(project, bot["principal"], bot["id"])
            with storage.runs.pool.connection() as conn:
                revision = conn.execute("SELECT revision FROM hermes_agui_host.managed_bots WHERE project=%s AND bot=%s",
                                        (project, bot["id"])).fetchone()[0]
            held = storage.runs.begin(scope, "busy-thread", "busy-run", uuid4(), 90, managed_revision=revision)
            assert held is not None
            assert apply(disabled).status_code == 409
            assert storage.runs.finish(held, status="failed", reason="fixture release")
            assert apply(disabled).status_code == 200
            assert apply(operation(1)).status_code == 409
            assert apply(operation(3, principal="other")).status_code == 409
            assert apply(operation(3, projectId="other")).status_code == 422
            query = {"principal": bot["principal"], "projectId": project, "ownerId": bot["ownerId"]}
            assert client.get(path, headers=ADMIN, params=query).json()["desiredRevision"] == "2"
            assert client.get(path, headers=ADMIN, params={**query, "ownerId": "other"}).status_code == 404
            assert client.get(path, params=query).status_code == 401
            # A retained older ACK is evidence only; redelivery cannot re-enable the Bot.
            assert apply(first).status_code == 200
            assert client.get(path, headers=ADMIN, params=query).json()["state"] == "disabled"
            assert client.put(path.removesuffix("/operation"), headers=ADMIN,
                              json={**bot, **app.state.management._credentials(bot)}).status_code == 409
            assert apply(operation(3)).status_code == 200
            assert apply(operation(4, "deleted")).status_code == 200
            assert apply(operation(5)).status_code == 409
            assert client.get(path, headers=ADMIN, params=query).json()["state"] == "deleted"
