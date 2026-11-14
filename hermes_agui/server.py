"""FastAPI AG-UI endpoint with native callback streaming over official SSE."""

from contextlib import asynccontextmanager
import secrets

import anyio
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from hermes_agui.adapter import AdmissionError, AgentAdapter
from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig, HermesAgentService
from hermes_agui.message_adapter import adapt_input
from hermes_agui.receipts import ReceiptStore


class RunResponse(StreamingResponse):
    """Watch disconnect even while no text is being sent, on every ASGI version."""

    def __init__(self, content, run, **kwargs):
        super().__init__(content, **kwargs)
        self.run = run

    async def __call__(self, scope, receive, send):
        try:
            async with anyio.create_task_group() as group:
                async def stream():
                    await self.stream_response(send)
                    group.cancel_scope.cancel()

                group.start_soon(stream)
                await self.listen_for_disconnect(receive)
                group.cancel_scope.cancel()
        finally:
            # Also covers disconnect before the generator is first advanced.
            if not self.run.bridge.paused:
                self.run.stop.set()


def create_app(agent_config: AgentConfig, config: ServerConfig, *, service_factory=HermesAgentService,
               authorize=None) -> FastAPI:
    """Legacy single-Bot factory, preserving profile/history identity."""
    from hermes_agui.host import BotConfig

    return create_host([BotConfig("hermes", agent_config, config, authorize)],
                       default_bot="hermes", service_factory=service_factory,
                       max_active_runs=config.max_active_runs)


def create_host(bots, *, default_bot=None, max_active_runs=8,
                service_factory=HermesAgentService):
    """One lifespan; independent trusted service and HTTP state for each Bot."""
    from contextlib import AsyncExitStack
    from hermes_agui.host import validate_bots

    registry = validate_bots(bots, default_bot, max_active_runs)

    @asynccontextmanager
    async def lifespan(app):
        async with AsyncExitStack() as stack:
            app.state.adapters = {}
            for bot_id, bot in registry.items():
                receipts = ReceiptStore(bot.agent.home, bot.agent.principal, bot.server.max_receipts)
                options = {"authorize": bot.authorize} if bot.authorize else {}
                service = service_factory(bot.agent, max_workers=bot.server.max_active_runs,
                                          max_pending=bot.server.max_active_runs, **options)
                adapter = AgentAdapter(service, bot.server, receipt_store=receipts,
                                       host_has_capacity=lambda: sum(len(a.active) for a in app.state.adapters.values()) < max_active_runs)
                stack.push_async_callback(adapter.close)
                app.state.adapters[bot_id] = adapter
            if default_bot:
                app.state.adapter = app.state.adapters[default_bot]
            yield

    app = FastAPI(title="Hermes AG-UI", lifespan=lifespan)

    async def authenticate(request: Request, authorization: str | None = Header(default=None)):
        bot_id = request.path_params.get("bot_id", default_bot)
        bot = registry.get(bot_id)
        if bot is None:
            raise HTTPException(404, "Unknown Bot")
        expected = f"Bearer {bot.server.bearer_token}".encode()
        if authorization is None or not secrets.compare_digest(authorization.encode(), expected):
            raise HTTPException(401, "Authentication required", headers={"WWW-Authenticate": "Bearer"})
        return bot_id, bot, app.state.adapters[bot_id]

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request, _exc):
        return JSONResponse(status_code=422, content={"detail": "Invalid AG-UI RunAgentInput"})

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/agent")
    @app.post("/bots/{bot_id}/agent")
    async def agent(value: RunAgentInput, target=Depends(authenticate)):
        _bot_id, bot, adapter = target
        authorize, agent_config = bot.authorize, bot.agent
        try:
            if value.resume:
                if (not value.thread_id or len(value.thread_id) > 512 or value.tools or value.context
                        or value.state not in (None, {}) or value.forwarded_props not in (None, {})):
                    raise ValueError("Invalid interrupt resume input")
                turn = None
            else:
                turn = adapt_input(value)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        if authorize is not None:
            try:
                authorize(agent_config.principal, value.thread_id)
            except PermissionError:
                raise HTTPException(403, "Thread access denied") from None
        try:
            run = adapter.resume(value) if value.resume else adapter.start(turn)
        except AdmissionError as exc:
            raise HTTPException(exc.status, exc.detail) from None
        encoder = EventEncoder()

        async def events():
            try:
                async for event in run.bridge.events(run.task):
                    yield encoder.encode(event)
            finally:
                if not run.bridge.paused:
                    run.stop.set()

        return RunResponse(events(), run, media_type=encoder.get_content_type(),
                           headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/threads/{thread_id}/cancel")
    @app.post("/bots/{bot_id}/threads/{thread_id}/cancel")
    async def cancel(thread_id: str, target=Depends(authenticate)):
        _bot_id, bot, adapter = target
        authorize, agent_config = bot.authorize, bot.agent
        if authorize is not None:
            try:
                authorize(agent_config.principal, thread_id)
            except PermissionError:
                raise HTTPException(403, "Thread access denied") from None
        run = adapter.active.get(thread_id)
        if run is None:
            raise HTTPException(409, "No active run")
        run.stop.set()
        return {"status": "cancelling"}

    return app


def main():
    """Run locally with trusted CLI paths and a secret token from the environment."""
    import argparse
    import os
    from pathlib import Path

    import uvicorn
    from hermes_constants import get_hermes_home

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=get_hermes_home())
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bots-config", type=Path)
    args = parser.parse_args()
    if args.bots_config:
        from hermes_agui.host import load_host

        app = load_host(args.bots_config)
        uvicorn.run(app, host=args.host, port=args.port)
        return
    token = os.environ.get("AGUI_API_KEY", "")
    if not token:
        parser.error("Set the AGUI_API_KEY secret before starting the server")
    app = create_app(AgentConfig(home=args.home, cwd=args.cwd), ServerConfig(bearer_token=token))
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
