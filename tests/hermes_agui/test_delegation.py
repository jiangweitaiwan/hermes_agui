"""Real native loop → Node coordinator → same Python host with isolated child history."""

from contextlib import closing, contextmanager
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
from urllib.parse import urlencode
import socket
import sqlite3
import subprocess
import threading

import httpx
import pytest
import uvicorn

from hermes_agui.core import HermesAgentService
from hermes_agui.config import ServerConfig
from hermes_agui.delegation import DelegationConfig
from hermes_agui.host import BotConfig
from hermes_agui.server import create_host
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall
from tests.hermes_agui.test_message_adapter import payload
from tests.hermes_agui.test_server import events
from tests.waiting import wait_until


@contextmanager
def host_server(app):
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    server = uvicorn.Server(uvicorn.Config(app, log_level='error'))
    worker = threading.Thread(target=server.run, kwargs={'sockets': [listener]})
    worker.start()
    try:
        wait_until(lambda: server.started, timeout=30)
        yield f'http://127.0.0.1:{listener.getsockname()[1]}'
    finally:
        server.should_exit = True
        worker.join(60)
        listener.close()
        assert not worker.is_alive()


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


@contextmanager
def node_coordinator(tmp_path, bots, internal_port, *, project=None, database_url=None, graph_token=None):
    root = Path(__file__).resolve().parents[2]
    settings = {'bots': [{'id': name, 'agentUrl': f'{bots}/bots/{name}/agent',
                         'tokenEnv': f'{name.upper()}_TOKEN'} for name in ('researcher', 'reviewer')],
                'delegation': {'tokenEnv': 'DELEGATION_TOKEN', 'allow': {
                    'researcher': ['reviewer'], 'reviewer': ['researcher']},
                    'listenPort': internal_port, 'timeoutMs': 5000}}
    if project:
        settings["delegation"]["timeoutMs"] = 45000
        settings["storage"] = {"threadMappings": "postgres"}
        for bot in settings["bots"]:
            bot["threadScope"] = {"projectId": project, "principal": "local-owner"}
    if graph_token:
        settings["storage"]["graphCompletions"] = True
        settings["graph"] = {"enabled": True, "dataRoot": str(tmp_path / "graph"), "evolution": {
            "enabled": True, "pollMs": 60000, "compiler": {
                "baseUrl": f"http://127.0.0.1:{internal_port}", "model": "fixture", "keyEnv": "GRAPH_COMPILER_KEY",
            },
        }}
        for bot in settings["bots"]:
            bot["memory"] = {**bot["threadScope"], "keyEnv": "MEMORY_SIGNING_KEY"}
    config = tmp_path / 'bots.json'
    config.write_text(json.dumps(settings))
    env = {**os.environ, 'AGUI_BOTS_CONFIG': str(config), 'RESEARCHER_TOKEN': 'researcher',
           'REVIEWER_TOKEN': 'reviewer', 'DELEGATION_TOKEN': 'internal-secret', 'PORT': str(free_port())}
    if graph_token:
        env.update(AGUI_GRAPH_COMPLETION_TOKEN=graph_token, MEMORY_SIGNING_KEY="memory-signing-fixture",
                   GRAPH_COMPILER_KEY="compiler-fixture")
    if database_url:
        env["AGUI_RUNTIME_DATABASE_URL"] = database_url
    # Use the installed toolchain, with an explicit override for hermetic local acceptance.
    from hermes_platform.resolver import locate_command

    node = locate_command('node').command
    if not node:
        pytest.skip('Node is required for cross-language acceptance')
    log = (tmp_path / 'node.log').open('w+')
    process = subprocess.Popen([*node, '--import', 'tsx', 'server/index.ts', '--production'],
        cwd=root / 'examples/copilotkit', env=env, stdout=log, stderr=log)
    try:
        def ready():
            if process.poll() is not None:
                log.seek(0)
                raise AssertionError(log.read())
            try:
                return httpx.get(f'http://127.0.0.1:{env["PORT"]}/api/bots', timeout=1).status_code == 200
            except httpx.HTTPError:
                return False
        wait_until(ready, timeout=60)
        yield f'http://127.0.0.1:{env["PORT"]}'
    finally:
        process.terminate()
        try:
            process.wait(15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()


def test_bidirectional_native_delegation_and_capacity(tmp_path, native_config):
    def reply(record):
        messages = record['body']['messages']
        task = next(m['content'] for m in reversed(messages) if m['role'] == 'user')
        if task.startswith('delegate '):
            if messages[-1]['role'] == 'tool':
                result = json.loads(messages[-1]['content'])
                return Text('Parent received: ' + result['status'] + ' ' + result.get('text', ''))
            return ToolCall('message_bot', {'target_bot_id': task.split()[1], 'task': ' '.join(task.split()[2:]) or 'child only'})
        if task == 'ask human':
            return ToolCall('clarify', {'questions': [{'question': 'Approve?', 'choices': ['Yes', 'No']}]})
        if task == 'nested':
            if messages[-1]['role'] == 'tool':
                return Text('Child received: ' + json.loads(messages[-1]['content'])['status'])
            return ToolCall('message_bot', {'target_bot_id': 'researcher', 'task': 'no recursion'})
        return Text('independent child result' if task == 'child only' else 'direct answer')

    entered, released = threading.Event(), threading.Event()

    class GatedService(HermesAgentService):
        def submit(self, session_id, message, *, run_id, callbacks=None):
            if message == 'child wait':
                callbacks = dict(callbacks)
                delta = callbacks['stream_delta_callback']

                def gated(value):
                    delta(value)
                    if value:
                        entered.set()
                        assert released.wait(30), 'Node did not cancel waiting child'
                callbacks['stream_delta_callback'] = gated
            return super().submit(session_id, message, run_id=run_id, callbacks=callbacks)

        def cancel(self, session_id, run_id):
            if session_id.startswith('delegation-'):
                released.set()
            return super().cancel(session_id, run_id)

    port = free_port()
    delegation = DelegationConfig(f'http://127.0.0.1:{port}/internal/delegations', 'internal-secret', timeout=10)
    with FakeLLMServer(reply) as provider:
        bots = [BotConfig(name, native_config(provider, name=name, toolsets=("clarify",)), ServerConfig(name))
                for name in ('researcher', 'reviewer')]
        app = create_host(bots, delegation=delegation, service_factory=GatedService)
        with host_server(app) as url, node_coordinator(tmp_path, url, port):
            def send(bot, task, thread='root/中文', marker=None):
                return httpx.post(f'{url}/bots/{bot}/agent', headers={'Authorization': f'Bearer {bot}',
                    **({'X-Hermes-Delegation': marker} if marker else {})}, json=payload(threadId=thread,
                    messages=[{'id': 'u1', 'role': 'user', 'content': task}]), timeout=60)
            # Both parents wait concurrently; each target still has a native worker.
            with ThreadPoolExecutor(2) as pool:
                responses = list(pool.map(lambda pair: send(*pair), (
                    ('researcher', 'delegate reviewer'), ('reviewer', 'delegate researcher'))))
            for response in responses:
                output = events(response)
                assert output[-1]['type'] == 'RUN_FINISHED', response.text
                assert 'Parent received: completed independent child result' in ''.join(e.get('delta', '') for e in output)
            assert send('researcher', 'hello', 'direct').status_code == 200
            human = events(send('researcher', 'delegate reviewer ask human', 'human-parent'))
            assert 'Parent received: human_required' in ''.join(e.get('delta', '') for e in human)
            wait_until(lambda: not any(adapter.active for adapter in app.state.adapters.values()), timeout=20)
            entered.clear()
            released.clear()
            timeout = events(send('researcher', 'delegate reviewer child wait', 'timeout-parent'))
            assert 'Parent received: timeout' in ''.join(e.get('delta', '') for e in timeout)
            assert released.is_set()
            entered.clear()
            released.clear()
            with ThreadPoolExecutor(1) as pool:
                pending = pool.submit(send, 'researcher', 'delegate reviewer child wait', 'cancel-parent')
                assert entered.wait(30)
                cancelled = httpx.post(f'{url}/bots/researcher/threads/cancel-parent/cancel',
                    headers={'Authorization': 'Bearer researcher'}, timeout=10)
                assert cancelled.status_code == 200
                assert events(pending.result(30))[-1]['type'] == 'RUN_ERROR'
                assert released.wait(10)
            wait_until(lambda: not any(adapter.active for adapter in app.state.adapters.values()), timeout=20)

            assert send('reviewer', 'hello', 'forged', 'browser').status_code == 403
            nested = events(send('reviewer', 'nested', 'nested-child', 'internal-secret'))
            assert 'Child received: depth_exceeded' in ''.join(e.get('delta', '') for e in nested)
        child_requests = [r for r in provider.main_requests() if any(
            m.get('content') == 'child only' for m in r['messages'])]
        assert len(child_requests) == 2
        for request in child_requests:
            assert not any(str(m.get('content', '')).startswith('delegate ') for m in request['messages'])
        # Capacity is checked in the same ASGI process, never queued behind a waiting parent.
        app = create_host(bots, delegation=delegation, max_active_runs=1)
        with host_server(app) as url, node_coordinator(tmp_path, url, port):
            response = httpx.post(f'{url}/bots/researcher/agent', headers={'Authorization': 'Bearer researcher'},
                json=payload(threadId='capacity', messages=[{'id': 'u1', 'role': 'user', 'content': 'delegate reviewer'}]), timeout=60)
            assert 'Parent received: busy' in ''.join(e.get('delta', '') for e in events(response))

def test_durable_host_delegates_and_redelivers_graph_completion(tmp_path, native_config):
    from dataclasses import replace
    from uuid import uuid4

    from hermes_agui.storage.completion_delivery import GraphCompletionDispatcher
    from hermes_agui.storage.host_settings import HostStorage
    from hermes_agui.storage.objects import FilesystemObjects
    from hermes_agui.storage.profile import ProfileObjects
    from hermes_agui.storage.run_outbox import PostgresRunOutbox

    socket_dir = os.environ.get("HERMES_AGUI_TEST_DB_SOCKET")
    if not socket_dir:
        pytest.skip("Requires disposable PostgreSQL Unix socket with Host and Runtime migrations")
    assert Path(socket_dir).is_absolute() and Path(socket_dir).is_dir()
    database_url = "postgresql://hermes@localhost/postgres?" + urlencode({"host": socket_dir})
    connection_pool = pytest.importorskip("psycopg_pool").ConnectionPool
    project = str(uuid4())
    pool = connection_pool(database_url, min_size=1, max_size=4, open=False)
    names = ("researcher", "reviewer")
    with connection_pool(database_url, min_size=1, max_size=1) as admin, admin.connection() as conn:
        for name in names:
            conn.execute("INSERT INTO hermes_agui_host.bot_state (project,principal,bot) VALUES (%s,%s,%s)",
                         (project, "local-owner", name))
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    profiles = ProfileObjects(FilesystemObjects(tmp_path / "objects"))
    storage = HostStorage(pool, profiles, project, scratch, {}, graph_completions=True)
    graph_token = "graph-completion-fixture-internal-token"
    knowledge = "Observed completed. Confirmed database configuration can be restored from the durable profile."
    port = free_port()
    completion_url = f"http://127.0.0.1:{port}/internal/graph/completions"
    delegation = DelegationConfig(f"http://127.0.0.1:{port}/internal/delegations", "internal-secret", timeout=60)

    def reply(record):
        messages = record["body"]["messages"]
        task = next(msg["content"] for msg in reversed(messages) if msg["role"] == "user")
        if messages[-1]["role"] == "tool":
            status = json.loads(messages[-1]["content"])["status"]
            return Text(knowledge if status == "completed" else "Observed " + status)
        if task == "continue":
            assert any(msg.get("content") == knowledge for msg in messages)
            return Text("Recovered parent history")
        if task == "delegate":
            return ToolCall("message_bot", {"target_bot_id": "reviewer", "task": "nested"})
        return ToolCall("message_bot", {"target_bot_id": "researcher", "task": "forbidden recursion"})

    def bot_configs(model):
        return [BotConfig(name, replace(native_config(model, name=name), api_key="fixture-key"),
                          ServerConfig(name, runtime_memory_key="memory-signing-fixture",
                                       runtime_memory_project=project)) for name in names]

    with FakeLLMServer(reply) as model:
        bots = bot_configs(model)
        app = create_host(bots, delegation=delegation, storage=storage)
        with host_server(app) as url, node_coordinator(
            tmp_path, url, port, project=project, database_url=database_url, graph_token=graph_token,
        ) as runtime_url:
            request = payload(runId=str(uuid4()), messages=[{"id": "parent", "role": "user", "content": "delegate"}])
            headers = {"Authorization": "Bearer researcher"}
            response = httpx.post(f"{url}/bots/researcher/agent", headers={**headers, "X-Hermes-Delegation": "forged"},
                                  json=request, timeout=30)
            assert response.status_code == 403
            response = httpx.post(f"{runtime_url}/api/copilotkit/agent/researcher/run", json=request, timeout=90)
            output = events(response)
            assert output[-1]["type"] == "RUN_FINISHED", response.text
            assert "Observed completed" in "".join(event.get("delta", "") for event in output)
            with pool.connection() as conn:
                assert conn.execute("SELECT bot,status FROM hermes_agui_host.runs WHERE project=%s ORDER BY bot",
                                    (project,)).fetchall() == [("researcher", "completed"), ("reviewer", "completed")]
            assert not list(scratch.iterdir())
            outbox = PostgresRunOutbox(pool)
            with httpx.Client(timeout=10) as client:
                dispatcher = GraphCompletionDispatcher(profiles, client, completion_url, graph_token)
                assert client.post(completion_url, json={}).status_code == 401
                # Deliver both turns after terminal. The short child answer is
                # skipped by the same Graph policy used for stream ingestion.
                with closing(sqlite3.connect(tmp_path / "graph" / "wiki.sqlite")) as graph:
                    assert graph.execute("SELECT count(*) FROM ingest_jobs").fetchone() == (0,)
                first = outbox.dispatch_once(dispatcher)
                lost_ack = outbox.claim()
                assert first is not None and lost_ack is not None
                assert lost_ack.scope.bot == "researcher"
                body = next((tmp_path / "objects").glob(f"profiles/*/{lost_ack.profile_revision}/completion.json"))
                foreign = json.loads(body.read_text())
                foreign["namespace"]["principal"] = "unrelated-owner"
                authorization = {"Authorization": f"Bearer {graph_token}"}
                assert client.post(completion_url, json=foreign, headers=authorization).status_code == 403
                dispatcher.deliver(lost_ack)
                with pool.connection() as conn:
                    conn.execute("UPDATE hermes_agui_host.run_outbox SET lease_until=clock_timestamp() WHERE id=%s",
                                 (lost_ack.id,))

        # Retain PostgreSQL, object storage and the current local Graph store.
        from shutil import rmtree

        rmtree(scratch)
        scratch.mkdir()
        for bot in bots:
            rmtree(bot.agent.home)
            rmtree(bot.agent.cwd)
        for name in ("bots.json", "node.log"):
            (tmp_path / name).unlink()
        rebuilt_storage = HostStorage(
            connection_pool(database_url, min_size=1, max_size=4, open=False),
            profiles, project, scratch, {}, graph_completions=True,
        )
        app = create_host(bot_configs(model), delegation=delegation, storage=rebuilt_storage)
        with host_server(app) as url, node_coordinator(
            tmp_path, url, port, project=project, database_url=database_url, graph_token=graph_token,
        ) as runtime_url:
            with httpx.Client(timeout=10) as client:
                outbox = PostgresRunOutbox(rebuilt_storage.runs.pool)
                retry = outbox.dispatch_once(GraphCompletionDispatcher(profiles, client, completion_url, graph_token))
                assert retry is not None and retry.id == lost_ack.id and retry.attempt == 2
                assert outbox.claim() is None
            with closing(sqlite3.connect(tmp_path / "graph" / "wiki.sqlite")) as graph:
                assert graph.execute("SELECT count(*) FROM ingest_jobs").fetchone() == (1,)
                assert knowledge in graph.execute("SELECT content FROM document_sources").fetchone()[0]
            request = payload(runId=str(uuid4()), messages=[{"id": "next", "role": "user", "content": "continue"}])
            response = httpx.post(f"{runtime_url}/api/copilotkit/agent/researcher/run", json=request, timeout=90)
            output = events(response)
            assert output[-1]["type"] == "RUN_FINISHED", response.text
            assert "Recovered parent history" in "".join(event.get("delta", "") for event in output)
    assert any(msg.get("role") == "tool" and json.loads(msg["content"]).get("status") == "depth_exceeded"
               for request in model.main_requests() for msg in request["messages"])
