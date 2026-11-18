"""PostgreSQL authority for dynamically provisioned Host Bots."""

from asyncio import Lock
from contextlib import contextmanager
from dataclasses import replace
import hashlib
import hmac
import json
import os
import secrets
from shutil import rmtree
from tempfile import TemporaryDirectory
from pathlib import Path
from uuid import uuid4

from hermes_agui.adapter import AdmissionError
from hermes_agui.provisioner import BotSpec, HermesBotProvisioner


class DurableHostManagement:
    def __init__(self, config, host):
        self.config, self.host = config, host
        self.project = host.storage.project
        self.pool = host.storage.runs.pool
        self.static_bots = frozenset(host.registry)
        seed = os.environ.get("AGUI_BOT_CREDENTIAL_SEED", "")
        try:
            self.seed = bytes.fromhex(seed)
        except ValueError:
            self.seed = b""
        if len(seed) != 64 or len(self.seed) != 32:
            raise ValueError("Managed durable Host requires a 32-byte hex Bot credential seed")
        with self.pool.connection() as conn:
            conn.execute("SELECT applied_revision,applied_operation,applied_spec_hash FROM hermes_agui_host.managed_bots LIMIT 0")
            conn.execute("SELECT operation_id FROM hermes_agui_host.management_operations LIMIT 0")
            collision = conn.execute("""SELECT bot FROM hermes_agui_host.managed_bots
                WHERE project=%s AND bot=ANY(%s) LIMIT 1""", (self.project, list(self.static_bots))).fetchone()
        if collision:
            raise ValueError("Static and managed Host Bot IDs overlap")
        if config.root.is_symlink():
            raise ValueError("Managed root cannot be a symlink")
        config.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.scratch = TemporaryDirectory(prefix="managed-", dir=config.root)
        self.provisioner = HermesBotProvisioner(Path(self.scratch.name), config.templates)
        self.managed_skill_names = frozenset(name for template in config.templates.values() for name in template.skills)
        self.loaded = {}
        self.load_lock = Lock()

    def close(self):
        self.scratch.cleanup()

    def _credentials(self, spec):
        def derive(purpose):
            payload = json.dumps([purpose, spec["ownerId"], spec["projectId"], spec["principal"], spec["id"]],
                                 ensure_ascii=False, separators=(",", ":")).encode()
            return hmac.new(self.seed, payload, hashlib.sha256).hexdigest()

        return {"token": derive("host-token"), "memoryKey": derive("memory-key")}

    def list_bots(self):
        with self.pool.connection() as conn:
            return [{"id": bot, "status": status} for bot, status in conn.execute(
                "SELECT bot,status FROM hermes_agui_host.managed_bots WHERE project=%s ORDER BY bot",
                (self.project,))]

    def status(self, bot_id):
        with self.pool.connection() as conn:
            row = self._record(conn, bot_id)
        return row[1] if row else None

    def _record(self, conn, bot_id):
        return conn.execute("""SELECT revision,status,spec,session_home_identity FROM hermes_agui_host.managed_bots
            WHERE project=%s AND bot=%s""", (self.project, bot_id)).fetchone()

    @contextmanager
    def _write(self, bot_id):
        with self.pool.connection() as conn:
            conn.execute("SET LOCAL lock_timeout = '5s'")
            conn.execute("SELECT pg_advisory_xact_lock(53859273, hashtext(%s))", (self.project,))
            yield conn, self._record(conn, bot_id)

    def _lock_profile(self, conn, spec):
        row = conn.execute("""SELECT expires_at > clock_timestamp()
            FROM hermes_agui_host.bot_state WHERE (project,principal,bot)=(%s,%s,%s) FOR UPDATE""",
            (self.project, spec["principal"], spec["id"])).fetchone()
        if row and row[0]:
            raise AdmissionError(409, "Bot has active runs")

    def _validate_spec(self, spec):
        if spec.id in self.static_bots:
            raise AdmissionError(409, "Bot ID belongs to deployment configuration")
        if spec.projectId != self.project or not spec.ownerId:
            raise AdmissionError(422, "Bot scope does not match Host configuration")
        data = spec.model_dump(exclude={"token", "memoryKey"})
        for name, expected in self._credentials(data).items():
            if not secrets.compare_digest(getattr(spec, name).encode(), expected.encode()):
                raise AdmissionError(422, "Bot credential binding mismatch")
        template = self.config.templates.get(spec.templateId)
        if (template is None or set(spec.skills) - template.skills.keys()
                or set(spec.toolsets) - set(template.toolsets) or set(spec.toolsets) - {"memory", "skills"}):
            raise AdmissionError(422, "Unknown durable Bot template or capability")
        return data

    def register(self, spec):
        data = self._validate_spec(spec)
        with self._write(spec.id) as (conn, previous):
            self._require_legacy(conn, spec.id)
            if previous:
                _, status, old, _identity = previous
                if status == "deleted" or (old["principal"], old["ownerId"]) != (spec.principal, spec.ownerId):
                    raise AdmissionError(409, "Bot identity cannot change or was deleted")
                if data == old and status == "active":
                    return
                self._lock_profile(conn, old)
            else:
                count = conn.execute("SELECT count(*) FROM hermes_agui_host.managed_bots WHERE project=%s",
                                     (self.project,)).fetchone()[0]
                if count >= self.config.max_bots:
                    raise AdmissionError(409, "Managed Host capacity reached")
                conn.execute("""INSERT INTO hermes_agui_host.bot_state (project,principal,bot)
                    VALUES (%s,%s,%s)""", (self.project, spec.principal, spec.id))
            conn.execute("""INSERT INTO hermes_agui_host.managed_bots (project,principal,bot,revision,status,spec)
                VALUES (%s,%s,%s,%s,'active',%s::jsonb) ON CONFLICT (project,bot) DO UPDATE
                SET revision=excluded.revision,status=excluded.status,spec=excluded.spec""",
                (self.project, spec.principal, spec.id, uuid4(), json.dumps(data)))

    def _require_legacy(self, conn, bot_id):
        row = conn.execute("""SELECT applied_revision FROM hermes_agui_host.managed_bots
            WHERE project=%s AND bot=%s""", (self.project, bot_id)).fetchone()
        if row and row[0]:
            raise AdmissionError(409, "Versioned management operation required")

    async def deactivate(self, bot_id, *, delete=False):
        with self._write(bot_id) as (conn, previous):
            self._require_legacy(conn, bot_id)
            if previous is None:
                raise AdmissionError(404, "Unknown managed Bot")
            _, status, data, _identity = previous
            if status == "deleted":
                if delete:
                    return
                raise AdmissionError(409, "Bot was deleted")
            self._lock_profile(conn, data)
            conn.execute("""UPDATE hermes_agui_host.managed_bots SET status=%s, revision=%s
                WHERE project=%s AND bot=%s""", ("deleted" if delete else "disabled", uuid4(), self.project, bot_id))

    async def resolve(self, bot_id, authorization):
        if not authorization:
            raise AdmissionError(401, "Authentication required")
        async with self.load_lock:
            with self.pool.connection() as conn:
                row = self._record(conn, bot_id)
            if row is None:
                raise AdmissionError(404, "Unknown Bot")
            revision, status, data, session_identity = row
            credentials = self._credentials(data)
            if not secrets.compare_digest(authorization.encode(), f"Bearer {credentials['token']}".encode()):
                raise AdmissionError(401, "Authentication required")
            if status != "active":
                raise AdmissionError(409, "Bot is disabled")
            if self.loaded.get(bot_id) != revision:
                await self.host.unregister_bot(bot_id)
                path = self.provisioner.root / bot_id
                if path.exists():
                    rmtree(path)
                spec = BotSpec.model_validate({**data, **credentials})
                bot = self.provisioner.prepare(spec)
                if session_identity:
                    bot = replace(bot, agent=replace(bot.agent, session_home_identity=session_identity))
                skill_root = bot.agent.home / "skills"
                template_skills = frozenset(path.relative_to(bot.agent.home).as_posix()
                                            for name in spec.skills for path in (skill_root / name).rglob("*")
                                            if path.is_file())
                self.host.register_bot(bot, managed_revision=revision, template_skills=template_skills,
                                       managed_skill_names=self.managed_skill_names)
                self.loaded[bot_id] = revision
            return bot_id, self.host.registry[bot_id], self.host.adapters[bot_id]
