"""Database preparation and maintenance traffic switch failure contracts."""
import json
from copy import deepcopy

import pytest

from scripts.ci.database_rollout import DatabaseRollout
from scripts.ci.llm_rollout import Blocked, JOBS, SERVICES, TAG, task, traffic, tags

PREFIX = 'asia-east1-docker.pkg.dev/copilotkit-agui/hermes'
OLD = PREFIX + '/hermes-host@sha256:' + 'b' * 64
NEW = PREFIX + '/hermes-host@sha256:' + 'a' * 64
RUNTIME = PREFIX + '/hermes-runtime@sha256:' + 'c' * 64


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
            container = {'image': OLD, 'command': ['python'], 'args': ['-m', module]}
            if name == 'database-prepare':
                container.update(command=['node'], args=['--import', 'tsx', 'server/storage/deployment-cli.ts', 'check'])
            self.resources[name] = {'metadata': {}, 'spec': {'template': {'spec': {'template': {'spec': {
                'maxRetries': 0, 'containers': [container]}}}}}}

    def call(self, kind, action, name, *args):
        self.calls.append((kind, action, name, args))
        if action == 'describe':
            return deepcopy(self.revisions[name] if kind == 'revisions' else self.resources[name])
        if action == 'executions':
            return []
        if action == 'execute':
            command = next((a.rsplit(',', 1)[-1] for a in args if a.startswith('--args=')), name)
            self.database_commands.append(command)
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

    def smoke(self, url, audience, guarded):
        assert self.fenced, 'Admission must remain closed through ALL smoke checks'
        if self.failure == 'smoke':
            raise Blocked('smoke failed')


class FixtureRollout(DatabaseRollout):
    def __init__(self, cloud, report):
        manifest = {'commit': 'a' * 40, 'phase': 'BUILT', 'policy': {'contract': 'e' * 64},
                    'images': {'host_image': NEW, 'runtime_image': RUNTIME}, 'offline_ci': {'fixture': 'PASS'}}
        super().__init__(cloud, manifest, report, lambda: None,
                         database_job='database-prepare', host_job='host-migrate', schedulers=['completion', 'reconcile'])
        self.paused = set()

    def scheduler(self, action, name=None):
        if action == 'list':
            return [{'name': n, 'state': 'ENABLED', 'httpTarget': {'uri': 'https://run.invalid/jobs/hermes-' + n}}
                    for n in self.schedulers]
        if action == 'pause':
            self.paused.add(name)
        if action == 'resume':
            self.paused.remove(name)
        return {}


@pytest.mark.parametrize('failure', ['check', 'host-migrate', 'migrate', 'release', 'smoke', 'traffic', None])
def test_database_aware_rollout_contains_partial_failures(tmp_path, failure):
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
        assert cloud.database_commands == ['check', 'fence', 'drain', 'drain', 'seal', 'host-migrate',
                                           'migrate', 'check', 'seal', 'release', 'resume']
        for name in SERVICES:
            assert traffic(cloud.resources[name]) == {name + '-new': 100}
            assert not tags(cloud.resources[name])
            assert cloud.resources[name]['scaling'] == 'auto'
