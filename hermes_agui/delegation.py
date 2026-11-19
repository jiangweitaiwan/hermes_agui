"""Opt-in AG-UI tool bridge. Identity is bound by the host, never tool arguments."""

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field
import json
import math
from urllib.parse import urlsplit

import httpx

_execution = ContextVar("agui_delegation_execution", default=None)


@dataclass(frozen=True)
class DelegationConfig:
    url: str
    token: str = field(repr=False)
    timeout: float = 60
    audience: str | None = None

    def __post_init__(self):
        parsed = urlsplit(self.url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
                or parsed.fragment or not self.token or not math.isfinite(self.timeout)
                or not 0 < self.timeout <= 300):
            raise ValueError("Invalid delegation configuration")
        if self.audience is not None:
            audience = urlsplit(self.audience)
            if (parsed.scheme != "https" or audience.scheme != "https" or audience.netloc != parsed.netloc
                    or audience.path not in {"", "/"} or audience.query or audience.fragment):
                raise ValueError("Delegation service audience must match its HTTPS destination")


@dataclass(frozen=True)
class DelegationInvocation:
    config: DelegationConfig
    source: str
    thread: str
    run: str
    depth: int
    source_token: str = field(repr=False)


async def _request_from_worker(invocation, payload):
    # The isolated worker owns the HTTP connection. Killing the worker closes
    # it, so the coordinator can observe the parent disconnect.
    return await _request(invocation.config, invocation.source_token, payload, asyncio.Event())


def register_tool(home):
    from tools.registry import registry

    registry.register(name="message_bot", toolset="agui_bots", scope=str(home),
        schema={"name": "message_bot", "description": "Delegate a short task to another configured Bot and wait for its result. Only one delegation level is allowed.",
                "parameters": {"type": "object", "properties": {
                    "target_bot_id": {"type": "string"}, "task": {"type": "string"}},
                    "required": ["target_bot_id", "task"], "additionalProperties": False}},
        handler=_message_bot)


def _message_bot(args, **_kwargs):
    from tools.approval_context import _approval_tool_call_id

    execution = _execution.get()
    call_id = _approval_tool_call_id.get()
    if execution is None or not call_id:
        return json.dumps({"status": "denied"})
    invocation, loop, stop = execution
    if invocation.depth:
        return json.dumps({"status": "depth_exceeded"})
    target, task = args.get("target_bot_id"), args.get("task")
    if (not isinstance(target, str) or not isinstance(task, str) or not task.strip()
            or len(task.encode()) > 16384):
        return json.dumps({"status": "invalid_request"})
    payload = {"sourceBotId": invocation.source, "threadId": invocation.thread, "runId": invocation.run,
               "toolCallId": call_id, "targetBotId": target, "task": task}
    if loop is None:
        return json.dumps(asyncio.run(_request_from_worker(invocation, payload)))
    future = asyncio.run_coroutine_threadsafe(
        _request(invocation.config, invocation.source_token, payload, stop), loop,
    )
    return json.dumps(future.result())


async def _request(config, source_token, payload, stop):
    headers = {"Authorization": f"Bearer {source_token}"}
    if config.audience:
        from hermes_agui.cloud_identity import identity_headers

        headers.update(await asyncio.to_thread(identity_headers, config.audience))
    async with httpx.AsyncClient(timeout=config.timeout, trust_env=False) as client:
        request = asyncio.create_task(client.post(config.url, json=payload,
            headers=headers))
        cancelled = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait({request, cancelled}, timeout=config.timeout,
                                         return_when=asyncio.FIRST_COMPLETED)
            if cancelled in done:
                return {"status": "cancelled"}
            if request not in done:
                return {"status": "timeout"}
            response = request.result()
            rejection = {403: "denied", 422: "invalid_request"}.get(response.status_code)
            if rejection:
                return {"status": rejection}
            if response.status_code != 200 or len(response.content) > 262144:
                return {"status": "unavailable"}
            return response.json()
        except httpx.TimeoutException:
            return {"status": "timeout"}
        except (httpx.HTTPError, ValueError):
            return {"status": "unavailable"}
        finally:
            request.cancel()
            cancelled.cancel()
            await asyncio.gather(request, cancelled, return_exceptions=True)
