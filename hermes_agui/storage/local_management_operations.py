"""Versioned management compatibility for the local Host, using its existing SQLite registry."""
import hashlib
import hmac
import json
import os
from uuid import UUID

from hermes_agui.adapter import AdmissionError
from hermes_agui.provisioner import BotSpec
from hermes_agui.storage.managed_operations import _ack


def initialize(manager):
    manager.db.execute("""CREATE TABLE IF NOT EXISTS management_operations (
        operation_id TEXT PRIMARY KEY,bot TEXT NOT NULL,revision INTEGER NOT NULL,hash TEXT NOT NULL,
        state TEXT NOT NULL,spec TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 0,UNIQUE(bot,revision))""")
    manager.db.commit()


def require_legacy(manager, bot):
    if manager.db.execute("SELECT 1 FROM management_operations WHERE bot=? LIMIT 1", (bot,)).fetchone():
        raise AdmissionError(409, "Versioned management operation required")


def restore_intents(manager):
    for bot, state in manager.db.execute("""SELECT bot,state FROM management_operations o
        WHERE revision=(SELECT max(revision) FROM management_operations n WHERE n.bot=o.bot) AND state<>'active'"""):
        previous = manager.specs.get(bot)
        if previous:
            manager._save(previous[0], state)


def status(manager, bot, principal, project, owner):
    row = manager.db.execute("""SELECT operation_id,revision,hash,state,spec FROM management_operations
        WHERE bot=? AND applied=1 ORDER BY revision DESC LIMIT 1""", (bot,)).fetchone()
    if not row:
        raise AdmissionError(404, "Unknown managed operation")
    operation, revision, fingerprint, state, encoded = row
    data = json.loads(encoded)
    if (data["principal"], data["projectId"], data["ownerId"]) != (principal, project, owner):
        raise AdmissionError(404, "Unknown managed Bot in scope")
    return _ack(bot, principal, project, owner, revision, operation, fingerprint, state)


async def apply(manager, bot, operation):
    UUID(operation.operationId)
    if bot != operation.spec.get("id") or {"token", "memoryKey"} & operation.spec.keys():
        raise AdmissionError(422, "Invalid management operation")
    seed = bytes.fromhex(os.environ.get("AGUI_BOT_CREDENTIAL_SEED", ""))
    if len(seed) != 32:
        raise AdmissionError(422, "Versioned local Host requires the shared credential seed")
    data = operation.spec
    def credential(purpose):
        value = json.dumps([purpose, data["ownerId"], data["projectId"], data["principal"], bot],
                           ensure_ascii=False, separators=(",", ":")).encode()
        return hmac.new(seed, value, hashlib.sha256).hexdigest()
    spec = BotSpec.model_validate({**data, "token": credential("host-token"), "memoryKey": credential("memory-key")})
    data = spec.model_dump(exclude={"token", "memoryKey"})
    fingerprint = hashlib.sha256(json.dumps([operation.state, data], sort_keys=True, ensure_ascii=False,
                                           separators=(",", ":")).encode()).hexdigest()
    revision = int(operation.desiredRevision)
    if fingerprint != operation.specHash or revision > 2**63 - 1:
        raise AdmissionError(422, "Operation spec hash or revision mismatch")
    async with manager.operation_lock:
        duplicate = manager.db.execute("SELECT bot,revision,hash,state,applied FROM management_operations WHERE operation_id=?",
                                       (operation.operationId,)).fetchone()
        if duplicate and duplicate[:4] != (bot, revision, fingerprint, operation.state):
            raise AdmissionError(409, "Operation identity conflict")
        previous = manager.specs.get(bot)
        if previous and (previous[0].principal, previous[0].projectId, previous[0].ownerId) != (spec.principal, spec.projectId, spec.ownerId):
            raise AdmissionError(409, "Bot identity cannot change")
        if duplicate and duplicate[4]:
            return _ack(bot, spec.principal, spec.projectId, spec.ownerId, revision, operation.operationId, fingerprint, operation.state)
        latest = manager.db.execute("SELECT max(revision) FROM management_operations WHERE bot=?", (bot,)).fetchone()[0]
        if latest is not None and (revision < latest or (revision == latest and not duplicate)):
            raise AdmissionError(409, "Stale management operation")
        if previous and previous[1] == "deleted" and not (duplicate and operation.state == "deleted"):
            raise AdmissionError(409, "Bot was deleted")
        manager.host.require_idle(bot)
        if not duplicate:
            with manager.db:
                manager.db.execute("INSERT INTO management_operations VALUES (?,?,?,?,?,?,0)",
                                   (operation.operationId, bot, revision, fingerprint, operation.state, json.dumps(data)))
        if operation.state == "active":
            manager._register(spec)
        else:
            if previous is None:
                manager._save(spec, operation.state)
            else:
                await manager._deactivate(bot, delete=operation.state == "deleted")
        with manager.db:
            manager.db.execute("UPDATE management_operations SET applied=1 WHERE operation_id=?", (operation.operationId,))
        return _ack(bot, spec.principal, spec.projectId, spec.ownerId, revision, operation.operationId, fingerprint, operation.state)
