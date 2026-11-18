"""Existing managed-profile importer remains compatible with versioned Host management."""
import json
import os
from pathlib import Path
import sqlite3
from types import SimpleNamespace
from urllib.parse import urlencode
from uuid import uuid4

import pytest

from tests.fakes.fake_llm_provider import FakeLLMServer, Text


def test_managed_profile_import_preserves_identity_and_new_defaults(tmp_path, native_config, monkeypatch):
    socket = os.environ.get("HERMES_AGUI_TEST_DB_SOCKET")
    if not socket:
        pytest.skip("Requires disposable PostgreSQL with Host migrations")
    psycopg = pytest.importorskip("psycopg")
    from hermes_agui.core import HermesAgentService
    from hermes_agui.storage.import_profile import _managed_spec, _publish
    from hermes_agui.storage.objects import FilesystemObjects, GCSObjects
    from hermes_agui.storage.profile import BotScope, ProfileObjects
    url = "postgresql://hermes@localhost/postgres?" + urlencode({"host": socket})
    scope = BotScope(str(uuid4()), "owner", "imported")
    monkeypatch.setenv("AGUI_HOST_DATABASE_URL", url)
    monkeypatch.setenv("AGUI_GCS_BUCKET", "fixture-object-double")
    objects = FilesystemObjects(tmp_path / "external-objects")
    monkeypatch.setattr(GCSObjects, "from_adc", staticmethod(lambda _bucket: objects))
    with FakeLLMServer([Text("original imported history")]) as model:
        config = native_config(model)
        with HermesAgentService(config) as service:
            assert service.run("original-thread", "keep the imported transcript")["final_response"] == "original imported history"
        registry = tmp_path / "legacy.sqlite"
        value = {"id": scope.bot, "name": "Imported", "description": "Import compatibility", "templateId": "native",
                 "principal": scope.principal, "projectId": scope.project, "token": "legacy-private-token", "memoryKey": "legacy-memory-key",
                 "skills": [], "toolsets": ["memory", "skills"]}
        with sqlite3.connect(registry) as db:
            db.execute("CREATE TABLE bots(id TEXT PRIMARY KEY,spec TEXT,status TEXT)")
            db.execute("INSERT INTO bots VALUES (?,?,?)", (scope.bot, json.dumps(value), "active"))
        args = SimpleNamespace(managed_registry=registry, owner_id="owner", source=config.home, prefix="profiles",
                               session_home_identity=str(config.home))
        managed = _managed_spec(args, scope)
        manifest = _publish(args, scope, frozenset(), managed)
        restored = tmp_path / "restored"
        restored.mkdir()
        ProfileObjects(objects).hydrate(scope, manifest, restored)
        with sqlite3.connect(restored / "state.db") as db:
            assert "original imported history" in str(db.execute("SELECT * FROM messages").fetchall())
        with psycopg.connect(url) as conn:
            row = conn.execute("""SELECT spec,session_home_identity,applied_revision,applied_operation
                FROM hermes_agui_host.managed_bots WHERE project=%s AND bot=%s""", (scope.project, scope.bot)).fetchone()
        assert not {"token", "memoryKey"} & row[0].keys()
        assert row[1:] == (str(config.home), 0, None)
        with pytest.raises(SystemExit, match="already exists"):
            _publish(args, scope, frozenset(), managed)
