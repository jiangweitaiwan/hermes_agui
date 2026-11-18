"""Protected Host management and durable restoration of managed services."""
from dataclasses import dataclass, field
from pathlib import Path
import secrets
import sqlite3

from fastapi import HTTPException, Request

from hermes_agui.adapter import AdmissionError
from hermes_agui.provisioner import BotSpec, HermesBotProvisioner, ProvisionTemplate


@dataclass(frozen=True)
class ManagementConfig:
    root: Path
    token: str = field(repr=False)
    templates: dict[str, ProvisionTemplate]
    max_bots: int = 128

    def __post_init__(self):
        if not self.token or not self.templates or self.max_bots < 1:
            raise ValueError("Management requires credentials, templates and capacity")


class HostManagement:
    def __init__(self, config, host):
        self.config, self.host = config, host
        self.provisioner = HermesBotProvisioner(config.root, config.templates)
        path = self.provisioner.root / "registry.sqlite3"
        if path.is_symlink():
            raise ValueError("Registry cannot be a symlink")
        self.db = sqlite3.connect(path)
        path.chmod(0o600)
        self.db.execute("CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, spec TEXT NOT NULL, status TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS installed (id TEXT PRIMARY KEY, spec TEXT NOT NULL)")
        self.db.commit()
        self.specs = {row[0]: (BotSpec.model_validate_json(row[1]), row[2])
                      for row in self.db.execute("SELECT id, spec, status FROM bots")}
        self.installed = {row[0]: BotSpec.model_validate_json(row[1])
                          for row in self.db.execute("SELECT id, spec FROM installed")}

    def _save(self, spec, status):
        with self.db:
            self.db.execute("INSERT INTO bots VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET spec=excluded.spec, status=excluded.status",
                            (spec.id, spec.model_dump_json(), status))
            if status == "active":
                self.db.execute("INSERT INTO installed VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET spec=excluded.spec",
                                (spec.id, spec.model_dump_json()))
                self.installed[spec.id] = spec
        self.specs[spec.id] = (spec, status)

    def restore(self):
        for spec, status in list(self.specs.values()):
            if status == "active":
                try:
                    self.host.register_bot(self.provisioner.prepare(spec, self.installed.get(spec.id), restore=True))
                except (ValueError, OSError, RuntimeError):
                    self._save(spec, "failed")

    def register(self, spec):
        previous = self.specs.get(spec.id)
        if previous and previous[1] == "deleted":
            raise AdmissionError(409, "Bot was deleted")
        if spec.id in self.host.registry and previous is None:
            raise AdmissionError(409, "Bot ID belongs to deployment configuration")
        if previous:
            old = previous[0]
            if (old.principal, old.projectId, old.token, old.memoryKey) != (
                    spec.principal, spec.projectId, spec.token, spec.memoryKey):
                raise AdmissionError(409, "Bot identity cannot change")
            if old == spec and previous[1] == "active" and spec.id in self.host.adapters:
                return
        if previous is None and len(self.specs) >= self.config.max_bots:
            raise AdmissionError(409, "Managed Host capacity reached")
        self.host.require_idle(spec.id)
        self.host.disabled.add(spec.id)
        self._save(spec, "provisioning")
        try:
            bot = self.provisioner.prepare(spec, self.installed.get(spec.id))
            if spec.id in self.host.adapters:
                self.host.configure_bot(bot)
            else:
                self.host.register_bot(bot)
            self._save(spec, "active")
            self.host.disabled.discard(spec.id)
        except Exception:
            self._save(spec, "failed")
            raise

    async def deactivate(self, bot_id, *, delete=False):
        previous = self.specs.get(bot_id)
        if previous is None:
            raise AdmissionError(404, "Unknown managed Bot")
        self.host.require_idle(bot_id)
        # Persist the tombstone before unloading; a crash must never reactivate it.
        self._save(previous[0], "deleted" if delete else "disabled")
        await self.host.unregister_bot(bot_id)

    def close(self):
        self.db.close()

    def list_bots(self):
        return [{"id": key, "status": value[1]} for key, value in self.specs.items()]

    def status(self, bot_id):
        previous = self.specs.get(bot_id)
        return previous[1] if previous else None


def mount_management(app, config):
    async def authenticate(request: Request):
        authorization = request.headers.get("authorization", "").encode()
        if request.headers.get("origin") or not secrets.compare_digest(authorization, f"Bearer {config.token}".encode()):
            raise HTTPException(401, "Host management authentication required")
        return app.state.management

    from fastapi import Depends

    @app.get("/internal/bots")
    async def list_bots(manager=Depends(authenticate)):
        return manager.list_bots()

    @app.get("/internal/bots/{bot_id}")
    async def get_bot(bot_id: str, manager=Depends(authenticate)):
        status = manager.status(bot_id)
        if status is None:
            raise HTTPException(404, "Unknown managed Bot")
        return {"id": bot_id, "status": status}

    @app.put("/internal/bots/{bot_id}")
    async def register_bot(bot_id: str, spec: BotSpec, manager=Depends(authenticate)):
        if spec.id != bot_id:
            raise HTTPException(422, "Bot binding mismatch")
        try:
            manager.register(spec)
        except AdmissionError as exc:
            raise HTTPException(exc.status, exc.detail) from None
        except (ValueError, OSError):
            raise HTTPException(422, "Profile provisioning failed") from None
        return {"id": bot_id, "status": "active"}

    async def deactivate(bot_id, manager, delete=False):
        try:
            await manager.deactivate(bot_id, delete=delete)
        except AdmissionError as exc:
            raise HTTPException(exc.status, exc.detail) from None
        return {"id": bot_id, "status": "deleted" if delete else "disabled"}

    @app.post("/internal/bots/{bot_id}/disable")
    async def disable_bot(bot_id: str, manager=Depends(authenticate)):
        return await deactivate(bot_id, manager)

    @app.delete("/internal/bots/{bot_id}")
    async def delete_bot(bot_id: str, manager=Depends(authenticate)):
        return await deactivate(bot_id, manager, True)
