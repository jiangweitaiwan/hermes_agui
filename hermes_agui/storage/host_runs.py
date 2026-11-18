"""Request-owned native runs with fenced profile snapshot publication."""

import asyncio
from contextlib import suppress
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from hermes_agui.storage.completion_delivery import stage_evidence
from hermes_agui.storage.isolated_service import IsolatedAgentService


class DurableHostRuns:
    def __init__(self, runs, profiles, scope, bot, *, scratch, approved, graph_completions=False,
                 managed_revision=None, template_skills=frozenset()):
        self.runs, self.profiles, self.scope = runs, profiles, scope
        self.bot = bot
        self.graph_completions = graph_completions
        self.scratch, self.approved = scratch, approved
        self.managed_revision = managed_revision
        self.template_skills = template_skills

    async def execute(self, run, execute_native):
        if run.stop.is_set():
            return {"interrupted": True}
        turn = run.turn
        options = {"managed_revision": self.managed_revision} if self.managed_revision else {}
        lease = await asyncio.to_thread(self.runs.begin, self.scope, turn.thread_id, turn.run_id, uuid4(), 90,
                                        **options)
        if lease is None:
            return {"failed": True}
        lost = asyncio.Event()
        heartbeat = asyncio.create_task(self._heartbeat(lease, run.stop, lost))
        try:
            return await self._run(lease, run, execute_native, lost)
        except Exception:  # health: allow BLE001 -- provider and storage exceptions may expose secrets
            await asyncio.to_thread(self.runs.finish, lease, status="failed", reason="profile_or_run_error")
            return {"failed": True}
        finally:
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat

    async def _heartbeat(self, lease, stop, lost):
        try:
            while True:
                await asyncio.sleep(20)
                if not await asyncio.to_thread(self.runs.renew, lease, 90):
                    break
        except asyncio.CancelledError:
            return
        except Exception:  # health: allow BLE001 -- inability to confirm ownership must stop the run
            pass
        lost.set()
        stop.set()

    async def _run(self, lease, run, execute_native, lost):
        manifest = await asyncio.to_thread(self.runs.profile, self.scope)
        with TemporaryDirectory(prefix="agui-run-", dir=self.scratch) as directory:
            home = Path(directory).resolve()
            if manifest is not None:
                await asyncio.to_thread(self.profiles.hydrate, self.scope, manifest, home,
                                        approved=self.approved)
            if manifest is None or self.managed_revision:
                await asyncio.to_thread(self.profiles.seed_template, self.bot.agent.home, home,
                                        approved=self.approved | self.template_skills, replace=manifest is not None)
            config = await asyncio.to_thread(self._configure, home)
            if run.stop.is_set():
                result = {"interrupted": True}
            else:
                service = IsolatedAgentService(config, authorize=self.bot.authorize)
                try:
                    result = await execute_native(run, service)
                finally:
                    await asyncio.to_thread(service.close)
            if lost.is_set():
                return {"interrupted": True}
            if run.stop.is_set() or result.get("interrupted"):
                status = "interrupted"
            elif run.bridge.failed or result.get("failed") or result.get("partial") or not result.get("completed"):
                status = "failed"
            else:
                status = "completed"
            profile = None
            generation = None
            if status == "completed":
                profile = await asyncio.to_thread(self.profiles.stage, self.scope, home, approved=self.approved)
                if self.graph_completions and self.bot.server.runtime_memory_key:
                    generation = await asyncio.to_thread(
                        stage_evidence, self.profiles, self.scope, profile.revision, run.turn, result,
                    )
                if run.stop.is_set():
                    status, profile = "interrupted", None
            committed = await asyncio.to_thread(
                self.runs.finish, lease, status=status, profile=profile,
                evidence_generation=generation if profile is not None else None,
                expected_revision=manifest.revision if manifest is not None else None,
            )
            if not committed:
                return {"interrupted": True}
            return result if status == "completed" else {status: True}

    def _configure(self, home):
        from ruamel.yaml import YAML

        from utils import load_yaml_file_readonly

        source = self.bot.agent
        template = source.home / "config.yaml"
        config = dict(load_yaml_file_readonly(template) or {}) if template.is_file() else {}
        # These native workers can otherwise write after the session handles close.
        auxiliary = dict(config.get("auxiliary") or {})
        auxiliary["title_generation"] = {
            **(auxiliary.get("title_generation") or {}), "model_upgrade_enabled": False,
        }
        config["auxiliary"] = auxiliary
        target = home / "config.yaml"
        with target.open("x", encoding="utf-8") as stream:
            target.chmod(0o600)
            YAML(typ="safe").dump(config, stream)
        cwd = home / "workspace"
        cwd.mkdir(mode=0o700, exist_ok=True)
        identity = source.session_home_identity or self.scope.object_namespace()
        return replace(source, home=home, cwd=cwd, session_home_identity=identity, ephemeral_workspace=True,
                       agent_options={**source.agent_options, "skip_background_review": True})
