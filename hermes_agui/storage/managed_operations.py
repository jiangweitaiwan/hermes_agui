"""Runtime desired state operations; Host acknowledgement is committed with applied state."""

import hashlib
import json
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from hermes_agui.adapter import AdmissionError
from hermes_agui.provisioner import BotSpec


class ManagementOperation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operationId: str = Field(min_length=36, max_length=36)
    desiredRevision: str = Field(pattern=r"^[1-9][0-9]{0,18}$")
    state: Literal["active", "disabled", "deleted"]
    specHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    spec: dict


def _ack(bot, principal, project, owner, revision, operation, spec_hash, state):
    return {"id": bot, "principal": principal, "projectId": project, "ownerId": owner,
            "desiredRevision": str(revision), "operationId": str(operation), "specHash": spec_hash, "state": state}


def status(manager, bot_id, principal, project, owner):
    with manager.pool.connection() as conn:
        row = conn.execute("""SELECT principal,spec,applied_revision,applied_operation,applied_spec_hash,status
            FROM hermes_agui_host.managed_bots WHERE project=%s AND bot=%s""", (project, bot_id)).fetchone()
    if not row or project != manager.project or (row[0], row[1]["ownerId"]) != (principal, owner):
        raise AdmissionError(404, "Unknown managed Bot in scope")
    if not row[3]:
        return {"id": bot_id, "principal": principal, "projectId": project, "ownerId": owner,
                "desiredRevision": "0", "operationId": None, "specHash": None, "state": row[5]}
    return _ack(bot_id, principal, project, owner, row[2], row[3], row[4], row[5])


def apply(manager, bot_id, operation):
    UUID(operation.operationId)
    revision = int(operation.desiredRevision)
    if revision > 2**63 - 1 or {"token", "memoryKey"} & operation.spec.keys():
        raise AdmissionError(422, "Invalid management operation")
    spec = BotSpec.model_validate({**operation.spec, **manager._credentials(operation.spec)})
    data = manager._validate_spec(spec)
    if spec.id != bot_id:
        raise AdmissionError(422, "Bot binding mismatch")
    fingerprint = hashlib.sha256(json.dumps([operation.state, data], sort_keys=True,
                                           ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    if fingerprint != operation.specHash:
        raise AdmissionError(422, "Operation spec hash mismatch")
    with manager._write(bot_id) as (conn, previous):
        duplicate = conn.execute("""SELECT project,principal,bot,desired_revision,spec_hash,state
            FROM hermes_agui_host.management_operations WHERE operation_id=%s""", (operation.operationId,)).fetchone()
        if duplicate:
            if duplicate != (manager.project, spec.principal, bot_id, revision, fingerprint, operation.state):
                raise AdmissionError(409, "Operation identity conflict")
            return _ack(bot_id, spec.principal, manager.project, spec.ownerId, revision,
                        operation.operationId, fingerprint, operation.state)
        if previous:
            _, prior_state, old, _ = previous
            applied = conn.execute("""SELECT applied_revision FROM hermes_agui_host.managed_bots
                WHERE project=%s AND bot=%s""", (manager.project, bot_id)).fetchone()[0]
            if (old["principal"], old["ownerId"]) != (spec.principal, spec.ownerId):
                raise AdmissionError(409, "Bot identity cannot change")
            if revision <= applied or prior_state == "deleted":
                raise AdmissionError(409, "Stale operation or deleted Bot")
            manager._lock_profile(conn, old)
        else:
            count = conn.execute("SELECT count(*) FROM hermes_agui_host.managed_bots WHERE project=%s",
                                 (manager.project,)).fetchone()[0]
            if count >= manager.config.max_bots:
                raise AdmissionError(409, "Managed Host capacity reached")
            conn.execute("""INSERT INTO hermes_agui_host.bot_state(project,principal,bot) VALUES (%s,%s,%s)
                ON CONFLICT DO NOTHING""", (manager.project, spec.principal, bot_id))
            manager._lock_profile(conn, data)
        conn.execute("""INSERT INTO hermes_agui_host.managed_bots
            (project,principal,bot,revision,status,spec,applied_revision,applied_operation,applied_spec_hash)
            VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s) ON CONFLICT (project,bot) DO UPDATE
            SET revision=excluded.revision,status=excluded.status,spec=excluded.spec,applied_revision=excluded.applied_revision,
                applied_operation=excluded.applied_operation,applied_spec_hash=excluded.applied_spec_hash""",
            (manager.project, spec.principal, bot_id, uuid4(), operation.state, json.dumps(data), revision, operation.operationId, fingerprint))
        conn.execute("""INSERT INTO hermes_agui_host.management_operations
            (operation_id,project,principal,bot,desired_revision,spec_hash,state) VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (operation.operationId, manager.project, spec.principal, bot_id, revision, fingerprint, operation.state))
    return _ack(bot_id, spec.principal, manager.project, spec.ownerId, revision, operation.operationId, fingerprint, operation.state)
