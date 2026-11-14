"""Bot namespaces survive host recreation with the real loopback native loop."""

import json
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
import pytest

from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig
from hermes_agui.host import BotConfig, validate_bots
from hermes_agui.server import create_host
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, write_hermes_home
from tests.hermes_agui.test_message_adapter import payload
from tests.hermes_agui.test_server import events


def test_native_bot_history_credentials_and_receipts_survive_restart(tmp_path):
    def reply(record):
        users = [m['content'] for m in record['body']['messages'] if m['role'] == 'user']
        return Text('|'.join(users))

    with FakeLLMServer(reply) as provider:
        bots = []
        for name in ('researcher', 'reviewer'):
            cwd = tmp_path / f'{name}-workspace'
            cwd.mkdir()
            home = write_hermes_home(tmp_path / name, provider.base_url,
                extra_config="skills:\n  auto_load: [local-role]\n  creation_nudge_interval: 0\nmemory:\n  nudge_interval: 0\n")
            memories = home / 'memories'; memories.mkdir()
            (memories / 'MEMORY.md').write_text(f'{name.upper()} MEMORY')
            (cwd / 'AGENTS.md').write_text(f'{name.upper()} ROLE')
            from tests.hermes_agui.test_native_capabilities import _skill
            _skill(home, 'local-role', f'{name.upper()} SKILL')
            bots.append(BotConfig(name, AgentConfig(home, cwd, principal=name,
                enabled_toolsets=("memory", "skills"), agent_options={'skip_background_review': True}), ServerConfig(name)))
        def send(client, name, body):
            return client.post(f'/bots/{name}/agent', headers={'Authorization': f'Bearer {name}'}, json=body)
        for iteration in range(2):
            with TestClient(create_host(bots)) as client:
                assert client.post('/agent', json=payload()).status_code == 404
                assert client.post('/bots/reviewer/agent', headers={'Authorization': 'Bearer researcher'},
                                   json=payload()).status_code == 401
                if iteration == 0:
                    with ThreadPoolExecutor(2) as pool:
                        responses = list(pool.map(lambda name: send(client, name, payload(messages=[
                            {'id': 'user', 'role': 'user', 'content': name}])), ('researcher', 'reviewer')))
                    for response in responses:
                        assert events(response)[-1]['type'] == 'RUN_FINISHED'
                else:
                    for name in ('researcher', 'reviewer'):
                        assert send(client, name, payload(messages=[{'id': 'user', 'role': 'user', 'content': name}])).status_code == 409
                        response = send(client, name, payload(runId='second', messages=[
                            {'id': 'next', 'role': 'user', 'content': 'continue'}]))
                        output = ''.join(e.get('delta', '') for e in events(response))
                        assert f'{name}|continue' in output
                        assert ('reviewer' if name == 'researcher' else 'researcher') not in output
        for record in provider.main_requests():
            messages = record['messages']
            owner = next(m['content'] for m in messages if m['role'] == 'user')
            other = 'reviewer' if owner == 'researcher' else 'researcher'
            system = str(messages[0]['content'])
            assert all(f'{owner.upper()} {kind}' in system for kind in ('MEMORY', 'ROLE', 'SKILL')), system
            assert other.upper() not in system


def test_registry_rejects_colliding_real_paths(tmp_path):
    a = tmp_path / 'a'; b = tmp_path / 'b'; a.mkdir(); b.mkdir()
    bot = BotConfig('researcher', AgentConfig(a, b), ServerConfig('a'))
    with pytest.raises(ValueError, match='duplicate'):
        validate_bots([bot, bot], None, 2)
    alias = tmp_path / 'alias'; alias.symlink_to(a, target_is_directory=True)
    other = BotConfig('reviewer', AgentConfig(alias, b), ServerConfig('b'))
    with pytest.raises(ValueError, match='disjoint'):
        validate_bots([bot, other], None, 2)
    with pytest.raises(ValueError, match='default'):
        validate_bots([bot], 'missing', 2)


def test_host_capacity_cancel_and_failed_startup_cleanup(tmp_path):
    from concurrent.futures import Future
    import threading
    from tests.hermes_agui.test_server import StubService

    entered = {name: threading.Event() for name in ('researcher', 'reviewer')}
    services = {}

    class Blocking(StubService):
        def __init__(self, config, **kwargs):
            super().__init__(config, **kwargs)
            self.name = config.principal
            services[self.name] = self
            self.future = Future()

        def submit(self, *args, **kwargs):
            entered[self.name].set()
            return self.future

        def cancel(self, thread, run):
            self.future.set_result({'interrupted': True})
            return True

    bots = []
    for name in entered:
        cwd = tmp_path / f'{name}-workspace'; cwd.mkdir()
        bots.append(BotConfig(name, AgentConfig(tmp_path / name, cwd, principal=name), ServerConfig(name)))
    with TestClient(create_host(bots, max_active_runs=2, service_factory=Blocking)) as client:
        def request(name):
            return client.post(f'/bots/{name}/agent', headers={'Authorization': f'Bearer {name}'}, json=payload())
        with ThreadPoolExecutor(2) as pool:
            a = pool.submit(request, 'researcher'); assert entered['researcher'].wait(10)
            b = pool.submit(request, 'reviewer'); assert entered['reviewer'].wait(10)
            response = client.post('/bots/reviewer/agent', headers={'Authorization': 'Bearer reviewer'},
                                   json=payload(threadId='other'))
            assert response.status_code == 503
            assert request('researcher').status_code == 409
            response = client.post('/bots/researcher/threads/thread/cancel', headers={'Authorization': 'Bearer reviewer'})
            assert response.status_code == 401
            assert client.post('/bots/researcher/threads/thread/cancel', headers={'Authorization': 'Bearer researcher'}).status_code == 200
            assert events(a.result(10))[-1]['type'] == 'RUN_ERROR'
            assert not services['reviewer'].future.done()
            services['reviewer'].future.set_result({'completed': True, 'final_response': 'reviewer'})
            assert events(b.result(10))[-1]['type'] == 'RUN_FINISHED'
    assert all(service.closed for service in services.values())

    created = []
    def failing(config, **kwargs):
        if created:
            raise RuntimeError('initialization failed')
        service = StubService(config, **kwargs); created.append(service)
        return service
    with pytest.raises(RuntimeError, match='initialization failed'):
        with TestClient(create_host(bots, service_factory=failing)):
            pass
    assert created[0].closed


def test_explicit_default_alias_uses_its_credential_and_receipts(tmp_path):
    from tests.hermes_agui.test_server import StubService

    bots = []
    for name in ('researcher', 'reviewer'):
        cwd = tmp_path / f'{name}-workspace'; cwd.mkdir()
        bots.append(BotConfig(name, AgentConfig(tmp_path / name, cwd), ServerConfig(name)))
    with TestClient(create_host(bots, default_bot='researcher', service_factory=StubService)) as client:
        assert client.post('/agent', headers={'Authorization': 'Bearer reviewer'}, json=payload()).status_code == 401
        assert client.post('/agent', headers={'Authorization': 'Bearer researcher'}, json=payload()).status_code == 200
        assert client.post('/bots/researcher/agent', headers={'Authorization': 'Bearer researcher'}, json=payload()).status_code == 409
        assert client.post('/bots/reviewer/agent', headers={'Authorization': 'Bearer reviewer'}, json=payload()).status_code == 200


def test_identical_thread_interrupts_resume_only_the_target_bot(tmp_path):
    from tests.fakes.fake_llm_provider import ToolCall
    from tests.hermes_agui.test_human_input import resume

    def reply(record):
        if record['body']['messages'][-1]['role'] == 'tool':
            return Text('decision received')
        return ToolCall('clarify', {'questions': [{'question': 'Proceed?'}]})

    with FakeLLMServer(reply) as provider:
        bots = []
        for name in ('researcher', 'reviewer'):
            cwd = tmp_path / f'{name}-workspace'; cwd.mkdir()
            home = write_hermes_home(tmp_path / name, provider.base_url)
            bots.append(BotConfig(name, AgentConfig(home, cwd, principal=name,
                enabled_toolsets=('clarify',), agent_options={'skip_background_review': True}), ServerConfig(name)))
        app = create_host(bots)
        with TestClient(app) as client:
            def send(name, data):
                return client.post(f'/bots/{name}/agent', headers={'Authorization': f'Bearer {name}'}, json=data)
            interrupts = {}
            for name in ('researcher', 'reviewer'):
                output = events(send(name, payload()))
                interrupts[name] = output[-1]['outcome']['interrupts'][0]
            wrong = resume(interrupts['researcher'], status='resolved', payload={'answers': {'q0': 'yes'}})
            assert send('reviewer', wrong).status_code == 409
            assert events(send('researcher', wrong))[-1]['type'] == 'RUN_FINISHED'
            assert app.state.adapters['reviewer'].active['thread'].bridge.paused
            decision = resume(interrupts['reviewer'], status='resolved', payload={'answers': {'q0': 'no'}})
            assert events(send('reviewer', decision))[-1]['type'] == 'RUN_FINISHED'
        for request in provider.main_requests():
            results = [m['content'] for m in request['messages'] if m['role'] == 'tool']
            if results:
                answers = [json.loads(r)['responses'][0]['user_response'] for r in results]
                assert answers in (['yes'], ['no'])
