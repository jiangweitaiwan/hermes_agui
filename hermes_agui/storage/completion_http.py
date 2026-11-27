"""Private Host completion consumer, using the existing fenced dispatcher."""
import hmac
import json
import logging
import os

from hermes_agui.storage.completion_tasks import event_id
from hermes_agui.storage.run_outbox import PostgresRunOutbox


def process(outbox, dispatcher, identifier):
    with outbox.pool.connection() as conn, conn.transaction():
        closed = conn.execute("SELECT hermes_agui_host.acquire_completion_delivery()").fetchone()
        if closed is None or not closed[0]:
            return 204 if outbox.state(identifier) in {None, "delivered", "failed"} else 503
        return _process(outbox, dispatcher, identifier)


def _process(outbox, dispatcher, identifier):
    event = outbox.claim(seconds=180, event_id=identifier)
    if event is None:
        return 204 if outbox.state(identifier) in {None, 'delivered', 'failed'} else 503
    try:
        dispatcher.deliver(event)
    except Exception:  # health: allow BLE001 -- only sanitized diagnostics may leave this boundary
        outbox.retry(event, seconds=min(300, 2 ** min(event.attempt, 9)))
        logging.warning('completion_delivery_retry event_id=%s', identifier)
        return 503
    return 204 if outbox.acknowledge(event) else 503


def mount_completion(app, storage):
    import anyio
    import httpx
    from fastapi import Request, Response
    from hermes_agui.storage.completion_delivery import GraphCompletionDispatcher

    producer = storage.completion_tasks

    @app.get('/internal/execution-capabilities')
    async def capabilities():
        return {"completionFence": 1}

    @app.post('/internal/completions/process')
    async def completion(request: Request):
        supplied = request.headers.get('x-completion-token', '')
        if not hmac.compare_digest(supplied.encode(), producer.token.encode()):
            return Response(status_code=401)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 1024:
                return Response(status_code=400)
        try:
            value = json.loads(body)
            if not isinstance(value, dict) or set(value) != {'schema', 'eventId'} or type(value['schema']) is not int or value['schema'] != 1:
                raise ValueError('Invalid schema')
            identifier = event_id(value['eventId'])
        except (ValueError, TypeError):
            return Response(status_code=400)

        def deliver():
            with httpx.Client(timeout=10, trust_env=False) as client:
                dispatcher = GraphCompletionDispatcher(storage.profiles, client,
                    os.environ['AGUI_GRAPH_COMPLETION_URL'], os.environ['AGUI_GRAPH_COMPLETION_TOKEN'],
                    audience=os.environ.get('AGUI_GRAPH_COMPLETION_AUDIENCE'))
                return process(PostgresRunOutbox(storage.runs.pool), dispatcher, identifier)
        try:
            status = await anyio.to_thread.run_sync(deliver)
        except Exception:  # health: allow BLE001 -- DB/HTTP errors may contain credentials
            logging.warning('completion_delivery_unavailable event_id=%s', identifier)
            status = 503
        return Response(status_code=status)
