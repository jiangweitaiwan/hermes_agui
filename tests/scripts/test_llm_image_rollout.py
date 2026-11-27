"""Database preparation and maintenance traffic switch failure contracts."""
import json
from copy import deepcopy
from unittest.mock import Mock

import pytest

from scripts.ci.database_rollout import DatabaseRollout
from scripts.ci.llm_rollout import Blocked, JOBS, SERVICES, TAG, task, traffic, tags

PREFIX = 'asia-east1-docker.pkg.dev/copilotkit-agui/hermes'
OLD = PREFIX + '/hermes-host@sha256:' + 'b' * 64
NEW = PREFIX + '/hermes-host@sha256:' + 'a' * 64
RUNTIME = PREFIX + '/hermes-runtime@sha256:' + 'c' * 64


@pytest.fixture(autouse=True)
def verified_scheduler_contract(monkeypatch):
    monkeypatch.setenv('LLM_PAUSED_SCHEDULER_RUN_VERIFIED','true')


class FakeCloud:
    def __init__(self, failure=None):
        self.project, self.region = 'fixture', 'fixture'
        self.failure, self.calls, self.resources, self.revisions = failure, [], {}, {}
        self.fenced = False
        self.failed = False
        self.database_commands = []
        for name in SERVICES:
            revision = name + '-old'
            container = {'image': OLD, 'args': ['--require-existing-control']}
            if name == 'hermes-worker':
                container['args'].append('--worker')
            self.resources[name] = {'metadata': {}, 'spec': {'template': {'metadata': {}, 'spec': {'containers': [container]}}},
                'status': {'traffic': [{'revisionName': revision, 'percent': 100}], 'url': 'https://service.invalid',
                           'latestCreatedRevisionName': revision, 'latestReadyRevisionName': revision}}
            self.revisions[revision] = {'metadata': {}, 'spec': {'containers': [container]},
                'status': {'imageDigest': OLD, 'conditions': [{'type': 'Ready', 'status': 'True'}]}}
        for name, module in {**JOBS, 'host-migrate': 'hermes_agui.storage.migrate', 'database-prepare': 'unused'}.items():
            container = {'image': OLD, 'command': ['python'], 'args': ['-m', module] + (['--once'] if name == 'hermes-completion' else [])}
            if name == 'database-prepare':
                container.update(command=['node'], args=['--import', 'tsx', 'server/storage/deployment-cli.ts', 'check'])
            self.resources[name] = {'metadata': {}, 'spec': {'template': {'spec': {'template': {'spec': {
                'maxRetries': 0, 'containers': [container]}}}}}}

    def call(self, kind, action, name, *args):
        self.calls.append((kind, action, name, args))
        if action == 'get-iam-policy':
            return {'bindings': []}
        if action == 'describe':
            return deepcopy(self.revisions[name] if kind == 'revisions' else self.resources[name])
        if action == 'executions':
            return []
        if action == 'execute':
            command = next((a.rsplit(',', 1)[-1] for a in args if a.startswith('--args=')), name)
            self.database_commands.append(command)
            if command == 'drain' and self.failure == 'drain-once' and not self.failed:
                self.failed = True
                raise Blocked('pending work')
            if command == self.failure:
                raise Blocked('injected Job failure')
            if command in ('fence', 'seal'):
                self.fenced = True
            elif command == 'resume':
                self.fenced = False
            return {'metadata': {'name': 'execution-' + command},
                    'status': {'conditions': [{'type': 'Completed', 'status': 'True'}]}}
        resource = self.resources[name]
        arg = lambda prefix: next((a[len(prefix):] for a in args if a.startswith(prefix)), None)
        if action == 'update':
            scaling = arg('--scaling=')
            if scaling:
                resource['scaling'] = scaling
            job_args = arg('--args=^|^')
            if job_args:
                task(resource, True)['containers'][0]['args'] = job_args.split('|')
            image = arg('--image=')
            if image:
                task(resource, kind == 'jobs')['containers'][0]['image'] = image
                if kind == 'services':
                    revision = name + '-new'
                    self.revisions[revision] = {'status': {'imageDigest': image,
                        'conditions': [{'type': 'Ready', 'status': 'True'}]}}
                    resource['status']['latestCreatedRevisionName'] = revision
                    resource['status']['traffic'].append({'tag': TAG, 'revisionName': revision, 'url': 'https://candidate.invalid'})
        if action == 'update-traffic':
            if arg('--to-revisions='):
                revision = arg('--to-revisions=').split('=')[0]
                resource['status']['traffic'] = [t for t in resource['status']['traffic'] if t.get('tag')]
                resource['status']['traffic'].append({'revisionName': revision, 'percent': 100})
                if self.failure == 'traffic' and not self.failed:
                    self.failed = True
                    raise Blocked('ambiguous traffic failure AFTER mutation')
            if arg('--remove-tags='):
                resource['status']['traffic'] = [t for t in resource['status']['traffic'] if t.get('tag') != TAG]
        return {}

    def database_counts(self, execution):
        return {"hermes_agui_host.runs":0,"hermes_agui_host.run_outbox":0,"hermes_agui_runtime.graph_jobs":0}

    def capabilities(self, url):
        return {"completionFence":1,"graphFence":1}

    def smoke(self, url, audience, guarded, **kwargs):
        assert self.fenced, 'Admission must remain closed through ALL smoke checks'
        if self.failure == 'smoke':
            raise Blocked('smoke failed')


class FixtureRollout(DatabaseRollout):
    def __init__(self, cloud, report):
        manifest = {'commit': 'a' * 40, 'phase': 'BUILT', 'policy': {'contract': 'e' * 64},
                    'images': {'host_image': NEW, 'runtime_image': RUNTIME}, 'offline_ci': {'fixture': 'PASS'}}
        super().__init__(cloud, manifest, report, lambda: None,
                         database_job='database-prepare', host_job='host-migrate', schedulers=['completion', 'reconcile', 'worker'], queues=['completion', 'graph'])
        self.queues = Mock()
        host = task(cloud.resources['hermes-host'])['containers'][0]
        host['env'] = [{'name':'AGUI_COMPLETION_TASKS_ENABLED', 'value':'true'}, *[{'name':'AGUI_COMPLETION_TASKS_'+k, 'value':'fixture'} for k in ('PROJECT','LOCATION','QUEUE','HOST_URL','SERVICE_ACCOUNT')], {'name':'AGUI_COMPLETION_TASK_TOKEN','valueFrom':{'secretKeyRef':{'name':'fixture','key':'1'}}}]
        self.paused = set()

    def scheduler(self, action, name=None):
        if action == 'list':
            return [{'name': n, 'state': 'ENABLED', 'httpTarget': ({'uri': 'https://service.invalid/internal/jobs/reconcile', 'oidcToken': {'serviceAccountEmail': 'fixture'}, 'headers': {'x-worker-token': 'fixture'}} if n == 'worker' else {'uri': 'https://run.invalid/jobs/hermes-' + n + ':run', 'oauthToken': {'serviceAccountEmail':'fixture'}})}
                    for n in self.schedulers]
        if action == 'pause':
            self.paused.add(name)
        if action == 'resume':
            self.paused.remove(name)
        return {}


@pytest.mark.parametrize('failure', ['check', 'host-migrate', 'migrate', 'release', 'smoke', 'traffic', None])
def test_database_aware_rollout_contains_partial_failures(tmp_path, failure, monkeypatch):
    monkeypatch.setenv('LLM_MANAGED_PRODUCERS_CONFIRMED', 'true')
    cloud = FakeCloud(failure)
    rollout = FixtureRollout(cloud, tmp_path / 'report.json')
    if failure:
        with pytest.raises(Blocked):
            rollout.run()
    else:
        rollout.run()
    report = json.loads((tmp_path / 'report.json').read_text())
    if failure == 'check':
        assert report['result'] == 'FAILED_SAFE'
        assert not cloud.fenced and not rollout.paused
        assert all(traffic(cloud.resources[n]) == {n + '-old': 100} for n in SERVICES)
    elif failure:
        assert report['result'] == 'RECOVERY_REQUIRED'
        assert cloud.fenced and rollout.paused == set(rollout.schedulers)
        assert all(cloud.resources[n]['scaling'] == '0' for n in SERVICES)
        assert 'resume' not in cloud.database_commands
        assert all(not any(a == '--image=' + OLD for a in args) for _, _, _, args in cloud.calls)
        if failure in ('host-migrate', 'migrate', 'release'):
            assert not report['revisions']
    else:
        assert report['result'] == 'DEPLOYED'
        assert not cloud.fenced and not rollout.paused
        assert cloud.database_commands == ['check', 'fence', 'hermes-completion', 'hermes-reconcile', 'drain', 'seal', 'drain', 'host-migrate',
                                           'migrate', 'check', 'seal', 'release', 'resume']
        for name in SERVICES:
            assert traffic(cloud.resources[name]) == {name + '-new': 100}
            assert not tags(cloud.resources[name])
            assert cloud.resources[name]['scaling'] == 'auto'


@pytest.mark.parametrize('action', ['pause', 'resume'])
def test_queue_failure_contains_deployment(tmp_path, monkeypatch, action):
    monkeypatch.setenv('LLM_MANAGED_PRODUCERS_CONFIRMED', 'true')
    cloud = FakeCloud()
    rollout = FixtureRollout(cloud, tmp_path / 'report.json')
    def fail(operation):
        if operation == action:
            raise Blocked('injected queue transition')
    rollout.queues.transition.side_effect = fail
    with pytest.raises(Blocked):
        rollout.run()
    assert rollout.result['result'] == 'RECOVERY_REQUIRED'
    assert cloud.fenced and rollout.paused == set(rollout.schedulers)
    assert all(cloud.resources[n]['scaling'] == '0' for n in SERVICES)
    assert rollout.result.get('containment_incomplete', False) == (action == 'pause')


def test_unbounded_legacy_job_fails_before_maintenance(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_MANAGED_PRODUCERS_CONFIRMED', 'true')
    cloud = FakeCloud()
    rollout = FixtureRollout(cloud, tmp_path / 'report.json')
    task(cloud.resources['hermes-completion'], True)['containers'][0]['args'].remove('--once')
    with pytest.raises(Blocked):
        rollout.run()
    assert rollout.result['result'] == 'FAILED_SAFE'
    assert not cloud.fenced and not rollout.paused
    rollout.queues.transition.assert_not_called()


def test_missing_first_activation_config_fails_safe(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_MANAGED_PRODUCERS_CONFIRMED', 'true')
    monkeypatch.delenv('LLM_COMPLETION_CONFIG', raising=False)
    cloud = FakeCloud()
    rollout = FixtureRollout(cloud, tmp_path / 'report.json')
    task(cloud.resources['hermes-host'])['containers'][0]['env'] = []
    with pytest.raises(Blocked):
        rollout.run()
    assert rollout.result['result'] == 'FAILED_SAFE'
    assert not cloud.fenced


def test_legacy_consumer_capability_is_rejected_before_mutation(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_MANAGED_PRODUCERS_CONFIRMED','true')
    cloud=FakeCloud()
    cloud.capabilities=lambda url: {}
    rollout=FixtureRollout(cloud,tmp_path/'report.json')
    with pytest.raises(Blocked):
        rollout.run()
    assert rollout.result['result']=='FAILED_SAFE'
    assert not cloud.fenced and not rollout.paused
    assert not any(action=='update' for _,action,_,_ in cloud.calls)


def test_active_drain_repeats_old_once_without_natural_scheduler_tick(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_MANAGED_PRODUCERS_CONFIRMED','true')
    cloud=FakeCloud('drain-once')
    rollout=FixtureRollout(cloud,tmp_path/'report.json')
    rollout.run()
    assert rollout.result['result']=='DEPLOYED'
    assert cloud.database_commands.count('hermes-completion')==2
    assert cloud.database_commands.count('hermes-reconcile')==2
    assert rollout.result['drain_iterations']==[1,2]


def test_active_drain_exhaustion_contains_before_migration(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_MANAGED_PRODUCERS_CONFIRMED','true')
    cloud=FakeCloud('drain')
    rollout=FixtureRollout(cloud,tmp_path/'report.json')
    rollout.drain_seconds=30
    ticks=iter(range(0,10000,10))
    monkeypatch.setattr('scripts.ci.database_rollout.time.monotonic',lambda:next(ticks))
    with pytest.raises(Blocked):rollout.run()
    assert rollout.result['result']=='RECOVERY_REQUIRED'
    assert 'migrate' not in cloud.database_commands
    assert cloud.fenced and rollout.paused==set(rollout.schedulers)


def test_repeated_deployment_restores_all_managed_states(tmp_path, monkeypatch):
    monkeypatch.setenv('LLM_MANAGED_PRODUCERS_CONFIRMED','true')
    cloud=FakeCloud()
    for attempt in range(2):
        rollout=FixtureRollout(cloud,tmp_path/f'report-{attempt}.json')
        rollout.run()
        assert rollout.result['result']=='DEPLOYED'
        assert not cloud.fenced and not rollout.paused
        assert all(not tags(cloud.resources[name]) for name in SERVICES)
        assert '--drain' in task(cloud.resources['hermes-completion'],True)['containers'][0]['args']


def test_activation_inherits_pinned_graph_credential_without_plaintext(tmp_path, monkeypatch):
    from scripts.ci.completion_rollout import prepare_completion
    cloud=FakeCloud()
    rollout=FixtureRollout(cloud,tmp_path/'report.json')
    rollout.old=deepcopy(cloud.resources)
    rollout.queues.names=['completion','graph']
    task(rollout.old['hermes-completion'],True)['containers'][0]['env']=[{'name':'AGUI_GRAPH_COMPLETION_TOKEN','valueFrom':{'secretKeyRef':{'name':'runtime-completion','key':'3'}}}]
    monkeypatch.setenv('LLM_COMPLETION_CONFIG',json.dumps({'project':'fixture','location':'fixture','queue':'completion','host_url':'https://service.invalid','service_account':'dispatch@fixture.iam.gserviceaccount.com','token_secret':'completion-task','token_version':'2'}))
    prepare_completion(rollout)
    env={e['name']:e for e in task(rollout.host_expected)['containers'][0]['env']}
    assert env['AGUI_GRAPH_COMPLETION_TOKEN']['valueFrom']['secretKeyRef']=={'name':'runtime-completion','key':'3'}
    assert env['AGUI_GRAPH_COMPLETION_AUDIENCE']['value']=='https://service.invalid'
    assert any('AGUI_GRAPH_COMPLETION_TOKEN=runtime-completion:3' in option for option in rollout.host_options)
