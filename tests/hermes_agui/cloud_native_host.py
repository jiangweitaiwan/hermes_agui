"""Disposable Host process/container for the shared Part 1 restart scenario."""
import json
import os
import sqlite3
from tempfile import TemporaryDirectory
import sys
from pathlib import Path

import httpx
import uvicorn
from fastapi import HTTPException, Request
from psycopg_pool import ConnectionPool

from hermes_agui.management import ManagementConfig
from hermes_agui.provisioner import ProvisionTemplate
from hermes_agui.server import create_host
from hermes_agui.storage.completion_delivery import GraphCompletionDispatcher
from hermes_agui.storage.host_settings import HostStorage
from hermes_agui.storage.objects import FilesystemObjects
from hermes_agui.storage.profile import BotScope, ProfileObjects
from hermes_agui.storage.run_outbox import PostgresRunOutbox


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    scratch = Path(config["scratch"])
    scratch.mkdir(parents=True, exist_ok=True)
    storage = HostStorage(ConnectionPool(os.environ["AGUI_HOST_DATABASE_URL"], min_size=1, max_size=4, open=False),
                          ProfileObjects(FilesystemObjects(Path(config["objects"]))), config["project"], scratch,
                          {bot: frozenset(paths) for bot, paths in config.get("approved", {}).items()}, graph_completions=True)
    management = ManagementConfig(scratch / "managed", "fixture-manager-token", {"native": ProvisionTemplate(
        model="fake-model", provider="custom", api_key="sk-fake-e2e", base_url=config["modelUrl"],
        config=config["nativeConfig"], toolsets=("memory", "skills"),
        agent_options={"skip_background_review": True, "max_iterations": 5})})
    app = create_host([], management=management, storage=storage)

    @app.get("/__test/snapshot/{bot}")
    async def snapshot(bot: str, request: Request):
        if request.headers.get("authorization") != "Bearer fixture-manager-token":
            raise HTTPException(401)
        with storage.runs.pool.connection() as conn:
            principal = conn.execute("SELECT principal FROM hermes_agui_host.managed_bots WHERE project=%s AND bot=%s",
                                     (config["project"], bot)).fetchone()[0]
        scope = BotScope(config["project"], principal, bot)
        manifest = storage.runs.profile(scope)
        with TemporaryDirectory() as temporary:
            storage.profiles.hydrate(scope, manifest, Path(temporary), approved=storage.approved.get(bot, frozenset()))
            with sqlite3.connect(Path(temporary) / "state.db") as db:
                ids = [row[0] for row in db.execute("SELECT id FROM sessions ORDER BY id")]
                tools = db.execute("SELECT count(*) FROM messages WHERE role='tool'").fetchone()[0]
        return {"nativeSessionIds": ids, "toolResults": tools, "revision": manifest.revision}

    @app.post("/__test/dispatch")
    async def dispatch(request: Request):
        if request.headers.get("authorization") != "Bearer fixture-manager-token":
            raise HTTPException(401)
        outbox = PostgresRunOutbox(storage.runs.pool)
        with httpx.Client(timeout=30, verify=config["caFile"], trust_env=False) as client:
            dispatcher = GraphCompletionDispatcher(storage.profiles, client, config["completionUrl"], "c" * 32)
            if request.query_params.get("loseAck") == "1":
                event = outbox.claim()
                if event:
                    dispatcher.deliver(event)
            else:
                event = outbox.dispatch_once(dispatcher)
        return {"id": str(event.id), "attempt": event.attempt} if event else None

    uvicorn.run(app, host="0.0.0.0", port=config["port"], log_level="warning")


if __name__ == "__main__":
    main()
