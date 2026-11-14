"""Real native loop → Node coordinator → same Python host with isolated child history."""

from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import socket
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
def node_coordinator(tmp_path, bots, internal_port):
    root = Path(__file__).resolve().parents[2]
    settings = {'bots': [{'id': name, 'agentUrl': f'{bots}/bots/{name}/agent',
                         'tokenEnv': f'{name.upper()}_TOKEN'} for name in ('researcher', 'reviewer')],
                'delegation': {'tokenEnv': 'DELEGATION_TOKEN', 'allow': {
                    'researcher': ['reviewer'], 'reviewer': ['researcher']},
                    'listenPort': internal_port, 'timeoutMs': 5000}}
    config = tmp_path / 'bots.json'
    config.write_text(json.dumps(settings))
    env = {**os.environ, 'AGUI_BOTS_CONFIG': str(config), 'RESEARCHER_TOKEN': 'researcher',
           'REVIEWER_TOKEN': 'reviewer', 'DELEGATION_TOKEN': 'internal-secret', 'PORT': str(free_port())}
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
        yield
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
