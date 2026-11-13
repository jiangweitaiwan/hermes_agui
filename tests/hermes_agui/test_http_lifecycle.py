"""Run ownership survives response cancellation and queued-to-active races."""

import asyncio
from concurrent.futures import Future

import pytest

from hermes_agui.adapter import AdmissionError, AgentAdapter
from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig
from hermes_agui.message_adapter import TurnInput
from hermes_agui.server import create_app
from tests.hermes_agui.test_message_adapter import payload
from tests.waiting import async_wait_until


class ControlledService:
    def __init__(self, *_args, **_kwargs):
        self.submitted = asyncio.Event()
        self.interrupted = asyncio.Event()
        self.future = Future()
        self.future.set_running_or_notify_cancel()
        self.closed = False
        self.cancels = 0

    def submit(self, *_args, **_kwargs):
        self.submitted.set()
        return self.future

    def cancel(self, *_args):
        self.cancels += 1
        if self.cancels < 2:
            return False  # construction has not yet exposed the native active run
        self.future.set_result({"interrupted": True})
        return True

    def close(self):
        assert self.future.done()
        self.closed = True


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_raises", [False, True])
async def test_admission_shutdown_and_repeated_cancel_until_worker_settles(cancel_raises):
    service = ControlledService()
    if cancel_raises:
        native_cancel = service.cancel

        def cancel(*args):
            accepted = native_cancel(*args)
            if not accepted:
                raise RuntimeError("private native cancellation error")
            return accepted

        service.cancel = cancel
    adapter = AgentAdapter(service, ServerConfig("secret", max_active_runs=1, max_receipts=4))
    turn = TurnInput("thread", "run", "message", "hello")
    run = adapter.start(turn)
    with pytest.raises(AdmissionError) as conflict:
        adapter.start(TurnInput("thread", "second", "u2", "next"))
    assert conflict.value.status == 409
    with pytest.raises(AdmissionError) as capacity:
        adapter.start(TurnInput("other", "run", "message", "hello"))
    assert capacity.value.status == 503
    await asyncio.wait_for(service.submitted.wait(), 10)
    await asyncio.wait_for(adapter.close(), 10)
    assert await run.task == {"interrupted": True}
    assert service.cancels >= 2 and service.closed and not adapter.active
    with pytest.raises(AdmissionError):
        adapter.start(turn)


@pytest.mark.asyncio
@pytest.mark.parametrize("spec", ["2.0", "2.4"])
@pytest.mark.parametrize("after_delta", [False, True])
async def test_asgi_disconnect_cancels_owned_run(tmp_path, spec, after_delta):
    import json

    class Service(ControlledService):
        def submit(self, *args, **kwargs):
            future = super().submit(*args, **kwargs)
            if after_delta:
                kwargs["callbacks"]["stream_delta_callback"]("visible partial")
            return future

    app = create_app(AgentConfig(home=tmp_path, cwd=tmp_path), ServerConfig("secret"),
                     service_factory=Service)
    started = asyncio.Event()
    body = json.dumps(payload()).encode()
    received = False

    async def receive():
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": body, "more_body": False}
        await started.wait()
        await app.state.adapter.service.submitted.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        marker = b"TEXT_MESSAGE_CONTENT" if after_delta else b"RUN_STARTED"
        if message["type"] == "http.response.body" and marker in message.get("body", b""):
            started.set()

    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": spec}, "http_version": "1.1",
             "method": "POST", "scheme": "http", "path": "/agent", "raw_path": b"/agent",
             "query_string": b"", "root_path": "", "server": ("localhost", 80), "client": ("127.0.0.1", 1),
             "headers": [(b"content-type", b"application/json"), (b"authorization", b"Bearer secret")]}
    async with app.router.lifespan_context(app):
        await asyncio.wait_for(app(scope, receive, send), 10)
        service = app.state.adapter.service
        await async_wait_until(lambda: not app.state.adapter.active, timeout=10)
        assert service.cancels >= 2 and service.future.done()
    assert service.closed


@pytest.mark.asyncio
async def test_overflow_cancels_native_work_before_admission_is_released():
    class Flood(ControlledService):
        def submit(self, *args, **kwargs):
            future = super().submit(*args, **kwargs)
            for _ in range(3):
                kwargs["callbacks"]["stream_delta_callback"]("delta")
            return future

    service = Flood()
    adapter = AgentAdapter(service, ServerConfig("secret", event_capacity=1))
    run = adapter.start(TurnInput("thread", "run", "user", "hello"))

    async def consume():
        return [e async for e in run.bridge.events(run.task)]

    output = await asyncio.wait_for(consume(), 10)
    assert output[-1].type.value == "RUN_ERROR"
    assert service.future.done() and service.cancels >= 2 and not adapter.active
    await adapter.close()
    assert service.closed
