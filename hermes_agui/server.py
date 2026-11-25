"""FastAPI AG-UI endpoint with native callback streaming over official SSE."""

from contextlib import asynccontextmanager
import secrets

import anyio
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from hermes_agui.adapter import AdmissionError
from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig, HermesAgentService
from hermes_agui.message_adapter import adapt_input


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
                service_factory=HermesAgentService, delegation=None, management=None, storage=None):
    """One lifespan; independent trusted service and HTTP state for each Bot."""
    from hermes_agui.host import validate_bots
    from hermes_agui.host_runtime import HostRuntime
    from hermes_agui.core.managed_llm import ManagedResolver

    if not isinstance(max_active_runs, int) or max_active_runs < 1:
        raise ValueError("Host capacity must be positive")
    registry = validate_bots(bots, default_bot, max_active_runs) if bots else {}
    if not registry and (management is None or default_bot is not None):
        raise ValueError("Configure Bots or managed provisioning")
    configured_bots = list(registry.values())
    configured_ids = frozenset(registry)
    host = HostRuntime(registry, service_factory, delegation, max_active_runs, storage)
    release_resolver = ManagedResolver(max_active_runs)

    @asynccontextmanager
    async def lifespan(app):
        app.state.adapters = host.adapters
        app.state.host = host
        try:
            if storage is not None:
                await anyio.to_thread.run_sync(storage.open)
            registry.clear()
            host.disabled.clear()
            for bot in configured_bots:
                host.register_bot(bot)
            if management:
                if storage is None:
                    from hermes_agui.management import HostManagement

                    app.state.management = HostManagement(management, host)
                    app.state.management.restore()
                else:
                    from hermes_agui.storage.managed_bots import DurableHostManagement

                    app.state.management = DurableHostManagement(management, host)
            if default_bot:
                app.state.adapter = host.adapters[default_bot]
            yield
        finally:
            try:
                await host.close()
                if management and hasattr(app.state, "management"):
                    app.state.management.close()
            finally:
                if storage is not None:
                    await anyio.to_thread.run_sync(storage.close)

    app = FastAPI(title="Hermes AG-UI", lifespan=lifespan)

    if management:
        from hermes_agui.management import mount_management
        mount_management(app, management)

    async def authenticate(request: Request, authorization: str | None = Header(default=None)):
        bot_id = request.path_params.get("bot_id", default_bot)
        if management and storage is not None and bot_id is not None and bot_id not in configured_ids:
            try:
                return await app.state.management.resolve(bot_id, authorization)
            except AdmissionError as exc:
                raise HTTPException(exc.status, exc.detail) from None
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
    async def agent(value: RunAgentInput, request: Request, target=Depends(authenticate)):
        if target[0] in host.disabled:
            raise HTTPException(409, "Bot is disabled")
        depth = 0
        marker = request.headers.get("X-Hermes-Delegation")
        if marker is not None:
            if not delegation or not secrets.compare_digest(marker.encode(), delegation.token.encode()):
                raise HTTPException(403, "Invalid delegation credential")
            depth = 1
        _bot_id, bot, adapter = target
        authorize, agent_config = bot.authorize, bot.agent
        try:
            if value.resume:
                if (not value.thread_id or len(value.thread_id) > 512 or value.tools or value.context
                        or value.state not in (None, {}) or value.forwarded_props not in (None, {})):
                    raise ValueError("Invalid interrupt resume input")
                turn = None
            else:
                from dataclasses import replace
                from hermes_agui.runtime_memory import verify_memory
                props = dict(value.forwarded_props or {})
                envelope = props.pop("llmRelease", None)
                registry, release_id, release_fingerprint, instruction = None, None, None, ""
                if bot.agent.llm_control is not None:
                    try:
                        registry, release_id, release_fingerprint, instruction = await release_resolver.resolve(value, _bot_id, bot, envelope)
                    except Exception:  # health: allow BLE001 -- HTTP resolver boundary must redact database credentials
                        raise HTTPException(503, "Managed release unavailable or denied") from None
                elif envelope is not None:
                    raise ValueError("Managed metadata denied in static mode")
                clean = value.model_copy(update={"forwarded_props": props})
                memory = verify_memory(clean, _bot_id, bot)
                clean = clean.model_copy(update={"forwarded_props": {}}) if memory is not None else clean
                turn = replace(adapt_input(clean), runtime_memory=memory, llm_registry=registry,
                               llm_release_id=release_id,llm_release_fingerprint=release_fingerprint,llm_instruction=instruction)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        if authorize is not None:
            try:
                authorize(agent_config.principal, value.thread_id)
            except PermissionError:
                raise HTTPException(403, "Thread access denied") from None
        try:
            run = adapter.resume(value) if value.resume else adapter.start(turn, delegation_depth=depth)
        except AdmissionError as exc:
            raise HTTPException(exc.status, exc.detail) from None
        encoder = EventEncoder()

        async def events():
            try:
                async for event in run.bridge.events(run.task):
                    if adapter.durable_runs is not None:
                        from hermes_agui.storage.run_events import RunEvents

                        await run.durable_ready.wait()
                        if run.durable_lease is not None:
                            await anyio.to_thread.run_sync(RunEvents(storage.runs.pool).append, run.durable_lease, event)
                    yield encoder.encode(event)
            finally:
                if not run.bridge.paused:
                    run.stop.set()

        return RunResponse(events(), run, media_type=encoder.get_content_type(),
                           headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/bots/{bot_id}/delegation/parent")
    async def delegation_parent(thread_id: str, run_id: str, target=Depends(authenticate)):
        _bot_id, bot, adapter = target
        if not delegation:
            raise HTTPException(404, "Delegation disabled")
        if bot.authorize:
            try:
                bot.authorize(bot.agent.principal, thread_id)
            except PermissionError:
                raise HTTPException(403, "Thread access denied") from None
        run = adapter.active.get(thread_id)
        if run is None or run.turn.run_id != run_id or run.stop.is_set() or run.task.done():
            raise HTTPException(409, "Parent run is not active")
        return {"depth": run.delegation_depth}

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
        if adapter.durable_runs is not None:
            from hermes_agui.storage.run_events import RunEvents

            found = await anyio.to_thread.run_sync(RunEvents(storage.runs.pool).cancel, adapter.durable_runs.scope, thread_id)
            if not found:
                raise HTTPException(409, "No active run")
            return {"status": "cancelling"}
        run = adapter.active.get(thread_id)
        if run is None:
            raise HTTPException(409, "No active run")
        run.stop.set()
        return {"status": "cancelling"}

    @app.get("/bots/{bot_id}/threads/{thread_id}/history")
    async def history(thread_id: str, target=Depends(authenticate)):
        _bot_id, bot, adapter = target
        if adapter.durable_runs is None:
            raise HTTPException(409, "Durable history unavailable")
        if bot.authorize:
            try:
                bot.authorize(bot.agent.principal, thread_id)
            except PermissionError:
                raise HTTPException(403, "Thread access denied") from None
        from hermes_agui.storage.run_events import RunEvents

        return {"runs": await anyio.to_thread.run_sync(RunEvents(storage.runs.pool).history, adapter.durable_runs.scope, thread_id)}

    @app.get("/bots/{bot_id}/threads/{thread_id}/runs/{run_id}/events")
    async def replay(thread_id: str, run_id: str, after: int = 0, target=Depends(authenticate)):
        _bot_id, bot, adapter = target
        if adapter.durable_runs is None:
            raise HTTPException(409, "Durable replay unavailable")
        if after < 0:
            raise HTTPException(422, "Invalid sequence")
        if bot.authorize:
            try:
                bot.authorize(bot.agent.principal, thread_id)
            except PermissionError:
                raise HTTPException(403, "Thread access denied") from None
        from hermes_agui.storage.run_events import RunEvents

        values = await anyio.to_thread.run_sync(RunEvents(storage.runs.pool).replay, adapter.durable_runs.scope, thread_id, run_id, after)
        return {"events": values}

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
    parser.add_argument("--port", type=int, default=os.environ.get("PORT", "8000"))
    parser.add_argument("--bots-config", type=Path)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    if args.bots_config:
        from hermes_agui.host import load_host

        app = load_host(args.bots_config)
        uvicorn.run(app, host=args.host, port=args.port)
        return
    if os.environ.get("AGUI_STORAGE_BACKEND", "local") != "local":
        parser.error("Durable storage requires --bots-config")
    if os.environ.get("K_SERVICE"):
        parser.error("Cloud Run requires --bots-config with cloud settings")
    token = os.environ.get("AGUI_API_KEY", "")
    if not token:
        parser.error("Set the AGUI_API_KEY secret before starting the server")
    app = create_app(AgentConfig(home=args.home, cwd=args.cwd), ServerConfig(bearer_token=token))
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
