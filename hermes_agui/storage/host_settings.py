"""Load the opt-in Host PostgreSQL and GCS adapters."""

import os
from pathlib import Path

from hermes_agui.storage.host_runs import DurableHostRuns
from hermes_agui.storage.objects import GCSObjects
from hermes_agui.storage.profile import BotScope, ProfileObjects, _allowed_path
from hermes_agui.storage.runs import PostgresRunStore


class HostStorage:
    def __init__(self, pool, profiles, project, scratch, approved, *, graph_completions=False):
        self.runs = PostgresRunStore(pool, publish_completions=graph_completions)
        self.profiles, self.project, self.scratch = profiles, project, scratch
        self.approved = approved
        self.graph_completions = graph_completions

    def open(self):
        open_host_pool(self.runs.pool)
        with self.runs.pool.connection() as connection:
            connection.execute("SELECT cancel_requested,input FROM hermes_agui_host.runs LIMIT 0")
            connection.execute("SELECT seq FROM hermes_agui_host.run_events LIMIT 0")

    def close(self):
        self.runs.pool.close()

    def for_bot(self, bot, managed_revision=None, template_skills=frozenset(), managed_skill_names=frozenset()):
        tools = bot.agent.enabled_toolsets
        if tools is None or not set(tools) <= {"memory", "skills"}:
            raise ValueError("Durable Bots require an explicit memory/skills toolset allowlist")
        scope = BotScope(self.project, bot.agent.principal, bot.bot_id)
        if (self.graph_completions and bot.server.runtime_memory_key
                and bot.server.runtime_memory_project != scope.project):
            raise ValueError("Durable Host and Runtime Graph projects must match")
        # Provisioning supplies this row. Do not create it from run input.
        self.runs.profile(scope)
        approved = frozenset(path for path in self.approved.get(bot.bot_id, ())
                             if not (path.startswith("skills/") and path.split("/")[1] in managed_skill_names))
        return DurableHostRuns(self.runs, self.profiles, scope, bot, scratch=self.scratch,
                               approved=approved, graph_completions=self.graph_completions,
                               managed_revision=managed_revision, template_skills=template_skills)


def open_host_pool(pool):
    pool.open(wait=True, timeout=10)
    with pool.connection() as connection:
        row = connection.execute("SELECT max(version) FROM hermes_agui_host.schema_version").fetchone()
        if row not in {(3,), (4,), (5,), (6,)}:
            raise RuntimeError("Apply the Host storage migrations before starting")


def load_adapters(prefix):
    database, bucket = os.environ.get("AGUI_HOST_DATABASE_URL"), os.environ.get("AGUI_GCS_BUCKET")
    if not database or not bucket:
        raise ValueError("Durable Host requires AGUI_HOST_DATABASE_URL and AGUI_GCS_BUCKET")
    from psycopg_pool import ConnectionPool

    profiles = ProfileObjects(GCSObjects.from_adc(bucket), prefix=prefix)
    return ConnectionPool(database, min_size=1, max_size=4, timeout=10, open=False), profiles


def load_storage(settings):
    backend = os.environ.get("AGUI_STORAGE_BACKEND", "local")
    if backend == "local" and not settings:
        return None
    if backend != "gcp":
        raise ValueError("Configure AGUI_STORAGE_BACKEND=gcp to load durable Host storage")

    project = settings.get("project")
    if not isinstance(project, str) or not project.strip():
        raise ValueError("Durable Host requires storage.project")
    scratch = settings.get("scratch")
    if scratch is not None:
        scratch = Path(scratch).resolve(strict=True)
        if not scratch.is_dir():
            raise ValueError("storage.scratch must be a directory")
    approved = {}
    for bot, paths in settings.get("approved_files", {}).items():
        if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
            raise ValueError("storage.approved_files values must be lists of paths")
        approved[bot] = frozenset(paths)
        for path in paths:
            relative = _allowed_path(path, approved[bot])
            if relative.parts[0] not in {"skills", "workspace"}:
                raise ValueError("Only skills and workspace paths may be explicitly approved")

    graph_completions = settings.get("graph_completions", False)
    if not isinstance(graph_completions, bool):
        raise ValueError("storage.graph_completions must be a boolean")
    pool, profiles = load_adapters(settings.get("prefix", "profiles"))
    return HostStorage(pool, profiles, project, scratch, approved, graph_completions=graph_completions)
