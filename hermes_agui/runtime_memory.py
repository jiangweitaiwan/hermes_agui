"""Verify a bot-specific Runtime signature before accepting reference data."""
import base64
import hashlib
import hmac
import json
import re
import time

from pydantic import BaseModel, ConfigDict, Field, StrictStr
from typing import Literal


class MemoryRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: StrictStr = Field(min_length=1, max_length=512)
    content: StrictStr = Field(min_length=1, max_length=16384)
    sourceBotId: StrictStr = Field(min_length=1, max_length=512)
    sourceThreadId: StrictStr = Field(min_length=1, max_length=512)
    visibility: Literal["bot_private", "project_shared"]


class MemoryContext(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    records: list[MemoryRecord] = Field(max_length=20)


def _decode_envelope(props, key):
    if not key or set(props) != {"runtimeMemory"}:
        raise ValueError("Unsupported runtime metadata")
    envelope = props["runtimeMemory"]
    if not isinstance(envelope, dict) or set(envelope) != {"payload", "signature"}:
        raise ValueError("Invalid runtime envelope")
    payload, signature = envelope["payload"], envelope["signature"]
    if not isinstance(payload, str) or len(payload) > 16000 or not isinstance(signature, str):
        raise ValueError("Invalid runtime envelope size")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", payload) or not re.fullmatch(r"[a-f0-9]{64}", signature):
        raise ValueError("Invalid runtime envelope encoding")
    expected = hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("Invalid runtime signature")
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def _validate_binding(data, value, bot_id, bot):
    if set(data) != {"botId", "threadId", "runId", "principal", "projectId", "expires", "context"}:
        raise ValueError
    expected = {"botId": bot_id, "threadId": value.thread_id, "runId": value.run_id,
                "principal": bot.agent.principal, "projectId": bot.server.runtime_memory_project}
    if any(data[key] != expected_value for key, expected_value in expected.items()):
        raise ValueError
    now = time.time()
    if type(data["expires"]) is not int or not now < data["expires"] <= now + 90:
        raise ValueError


def _validate_context(data, bot_id):
    if not isinstance(data, dict) or type(data.get("version")) is not int:
        raise ValueError
    context = MemoryContext.model_validate(data).model_dump()
    if len(json.dumps(context, ensure_ascii=False, separators=(",", ":")).encode()) > 8192:
        raise ValueError
    if any(r["visibility"] == "bot_private" and r["sourceBotId"] != bot_id for r in context["records"]):
        raise ValueError
    return context


def verify_memory(value, bot_id, bot):
    if not value.forwarded_props:
        return None
    try:
        data = _decode_envelope(value.forwarded_props, bot.server.runtime_memory_key)
        _validate_binding(data, value, bot_id, bot)
        return _validate_context(data["context"], bot_id)
    except (ValueError, TypeError, KeyError):
        raise ValueError("Invalid runtime memory context") from None
