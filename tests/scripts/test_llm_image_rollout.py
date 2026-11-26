"""Candidate artifact completeness and fail-closed Cloud Run rollout contracts."""

import json
from copy import deepcopy

import pytest

from scripts.ci.llm_build_outputs import resolve_images


PREFIX = "asia-east1-docker.pkg.dev/copilotkit-agui/hermes"
DIGEST = "sha256:" + "a" * 64


def test_only_complete_successful_builds_produce_deployable_digests():
    build = {"status": "SUCCESS", "results": {"images": [
        {"name": f"{PREFIX}/hermes-host:commit", "digest": DIGEST},
        {"name": f"{PREFIX}/hermes-runtime:commit", "digest": DIGEST},
    ]}}
    assert resolve_images(build, PREFIX) == {
        "host_image": f"{PREFIX}/hermes-host@{DIGEST}",
        "runtime_image": f"{PREFIX}/hermes-runtime@{DIGEST}",
    }
    build["results"]["images"].pop()
    with pytest.raises(ValueError, match="Missing or ambiguous"):
        resolve_images(build, PREFIX)
    build["status"] = "FAILURE"
    with pytest.raises(ValueError, match="did not succeed"):
        resolve_images(build, PREFIX)


from scripts.ci.llm_rollout import Blocked, JOBS, Rollout, SERVICES, TAG, tags, traffic

OLD = PREFIX + "/hermes-host@sha256:" + "b" * 64
NEW = PREFIX + "/hermes-host@" + DIGEST
RUNTIME = PREFIX + "/hermes-runtime@sha256:" + "c" * 64


class FakeCloud:
    def __init__(self, failure=None):
        self.failure, self.calls, self.resources, self.revisions = failure, [], {}, {}
        self.failed = False
        self.smokes = 0
        for name in SERVICES:
            revision = name + '-old'
            container = {'image': OLD, 'args': ['--require-existing-control'], 'env': [{'name': 'PRESERVED', 'value': 'yes'}]}
            if name == 'hermes-worker': container['args'].append('--worker')
            self.resources[name] = {'metadata': {}, 'spec': {'template': {'metadata': {}, 'spec': {'containers': [container]}}},
                'status': {'traffic': [{'revisionName': revision, 'percent': 100}], 'url': 'https://service.invalid',
                           'latestCreatedRevisionName': revision, 'latestReadyRevisionName': revision}}
            self.revisions[revision] = {'metadata': {}, 'spec': {'containers': [container]},
                'status': {'imageDigest': OLD, 'conditions': [{'type': 'Ready', 'status': 'True'}]}}
        for name, module in JOBS.items():
            self.resources[name] = {'metadata': {}, 'spec': {'template': {'spec': {'template': {'spec': {
                'serviceAccountName': 'original-account', 'timeoutSeconds': 120, 'maxRetries': 0,
                'containers': [{'image': OLD, 'command': ['python'], 'args': ['-m', module, '--once']}]}}}}}}

    def call(self, kind, action, name, *args):
        self.calls.append((kind, action, name, args))
        if action == 'describe':
            return deepcopy(self.revisions[name] if kind == 'revisions' else self.resources[name])
        from scripts.ci.llm_rollout import task
        resource = self.resources[name]
        arg = lambda prefix: next((a[len(prefix):] for a in args if a.startswith(prefix)), None)
        if action == 'update':
            if name == 'hermes-host' and self.failure == 'startup':
                raise Blocked('startup failed')
            image = arg('--image=')
            task(resource, kind == 'jobs')['containers'][0]['image'] = image
            label = arg('--update-labels=ci-contract=')
            if kind == 'jobs':
                if label:
                    resource['metadata']['labels'] = {'ci-contract': label}
                if '--remove-labels=ci-contract' in args:
                    resource['metadata'].pop('labels', None)
            else:
                rev = name + '-new'
                self.revisions[rev] = {'metadata': {'labels': {'ci-contract': label}},
                    'spec': deepcopy(task(resource)), 'status': {'imageDigest': image,
                    'conditions': [{'type': 'Ready', 'status': 'True'}]}}
                resource['status'].update(latestCreatedRevisionName=rev, latestReadyRevisionName=rev)
                resource['status']['traffic'].append({'tag': TAG, 'revisionName': rev, 'url': 'https://candidate.invalid'})
        elif action == 'update-traffic':
            if arg('--to-revisions='):
                allocation = arg('--to-revisions=')
                keep = [t for t in resource['status']['traffic'] if t.get('tag')]
                resource['status']['traffic'] = [dict(revisionName=r.split('=')[0], percent=int(r.split('=')[1])) for r in allocation.split(',')] + keep
            if arg('--remove-tags='):
                resource['status']['traffic'] = [t for t in resource['status']['traffic'] if t.get('tag') != TAG]
        # Simulate ambiguous failure AFTER mutation, not only a clean rejected API.
        if not self.failed and ((self.failure == 'traffic' and name == 'hermes-host' and action == 'update-traffic' and arg('--to-revisions=')) or
                                (self.failure == 'job' and name == 'hermes-reconcile' and action == 'update')):
            self.failed = True
            raise Blocked('API failed after mutation')
        return {}

    def smoke(self, url, audience, guarded):
        self.calls.append(('smoke', url, guarded, ()))
        self.smokes += 1
        if self.failure == 'smoke' or (self.failure == 'post_smoke' and self.smokes == 4):
            raise Blocked('smoke failed')


def deployment(tmp_path, cloud, approved=None):
    manifest = {'commit': 'a' * 40, 'phase': 'BUILT', 'policy': {'contract': 'e' * 64},
                'images': {'host_image': NEW, 'runtime_image': RUNTIME}, 'offline_ci': {'fixture': 'PASS'}}
    return Rollout(cloud, manifest, [OLD] if approved is None else approved, tmp_path / 'report.json', lambda: None)


@pytest.mark.parametrize('failure', ['startup', 'smoke', 'post_smoke', 'traffic', 'job', None])
def test_coordinated_rollout_and_partial_failure_restore(tmp_path, failure):
    from scripts.ci.llm_rollout import task
    cloud = FakeCloud(failure)
    # Preserve a split allocation, plus a pre-existing tag.
    original = cloud.resources['hermes-runtime']['status']['traffic']
    original[:] = [{'revisionName': 'hermes-runtime-old', 'percent': 80},
                   {'revisionName': 'hermes-host-old', 'percent': 20},
                   {'revisionName': 'hermes-runtime-old', 'tag': 'stable', 'url': 'https://stable.invalid'}]
    snapshots = deepcopy(cloud.resources)
    rollout = deployment(tmp_path, cloud)
    if failure:
        with pytest.raises(Blocked):
            rollout.run()
    else:
        rollout.run()
    report = json.loads((tmp_path / 'report.json').read_text())
    assert report['result'] == ('DEPLOYED' if failure is None else 'ROLLED_BACK' if failure in ('traffic', 'job', 'post_smoke') else 'FAILED_SAFE')
    for name in SERVICES:
        assert traffic(cloud.resources[name]) == ({name + '-new': 100} if failure is None else traffic(snapshots[name]))
        assert tags(cloud.resources[name]) == tags(snapshots[name])
    for name in JOBS:
        current = deepcopy(task(cloud.resources[name], True))
        assert current['containers'][0].pop('image') == (NEW if failure is None else OLD)
        before = deepcopy(task(snapshots[name], True))
        before['containers'][0].pop('image')
        assert current == before
    if failure in ('startup', 'smoke'):
        assert not any(c[0] == 'jobs' and c[1] == 'update' for c in cloud.calls)
    if failure is None:
        cut = next(i for i,c in enumerate(cloud.calls) if c[1] == 'update-traffic' and any(a.startswith('--to-revisions=') for a in c[3]))
        assert sum(c[0] == 'smoke' for c in cloud.calls[:cut]) == 3


def test_unknown_old_contract_blocks_before_mutation(tmp_path):
    cloud = FakeCloud()
    with pytest.raises(Blocked):
        deployment(tmp_path, cloud, []).run()
    assert all(c[1] == 'describe' for c in cloud.calls)


def test_external_template_change_stops_unsafe_rollback(tmp_path):
    cloud = FakeCloud('traffic')
    original = cloud.call
    def call(kind, action, name, *args):
        try:
            return original(kind, action, name, *args)
        except Blocked:
            cloud.resources['hermes-host']['spec']['template']['spec']['containers'][0]['args'] = ['external-change']
            raise
    cloud.call = call
    with pytest.raises(Blocked):
        deployment(tmp_path, cloud).run()
    report = json.loads((tmp_path / 'report.json').read_text())
    assert report['result'] == 'RECOVERY_REQUIRED'
    assert cloud.resources['hermes-host']['spec']['template']['spec']['containers'][0]['args'] == ['external-change']


def test_smoke_uses_only_identity_mint_and_readonly_unauthenticated_api(monkeypatch):
    import io
    from urllib.error import HTTPError
    from scripts.ci.llm_rollout import Cloud
    requests = []
    monkeypatch.setattr('scripts.ci.llm_rollout.subprocess.check_output', lambda *a, **k: 'access-token')
    def request(value, timeout):
        requests.append(value)
        if value.full_url.startswith('https://iamcredentials.googleapis.com/'):
            assert value.get_method() == 'POST'
            assert json.loads(value.data) == {'audience': 'https://service.run.app', 'includeEmail': True}
            return io.BytesIO(b'{"token":"identity-token"}')
        assert value.get_method() == 'GET'
        assert value.get_header('X-serverless-authorization') == 'Bearer identity-token'
        assert value.get_header('Authorization') is None
        if value.full_url.endswith('/health'):
            response = io.BytesIO(b'{"status":"ok"}')
            response.status = 200
            return response
        raise HTTPError(value.full_url, 401, 'Business auth required', {}, None)
    monkeypatch.setattr('scripts.ci.llm_rollout.urlopen', request)
    Cloud('project', 'region', 'smoke@example.invalid').smoke('https://candidate.run.app', 'https://service.run.app', '/api/bots')
    assert [r.full_url for r in requests][1:] == ['https://candidate.run.app/health', 'https://candidate.run.app/api/bots']
