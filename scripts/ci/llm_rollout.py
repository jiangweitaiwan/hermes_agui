"""Image-only coordinated rollout. No DDL, bootstrap, queue or application writes."""
import argparse
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
from urllib.request import Request, urlopen

SERVICES = ('hermes-runtime', 'hermes-host', 'hermes-worker')
JOBS = {'hermes-completion': 'hermes_agui.storage.completion_delivery',
        'hermes-reconcile': 'hermes_agui.storage.reconcile'}
TAG = 'ci-candidate'


class Blocked(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise Blocked(message)


def task(resource, job=False):
    return resource['spec']['template']['spec']['template']['spec'] if job else resource['spec']['template']['spec']


def config_hash(resource, job=False):
    value = deepcopy(resource['spec'])
    if not job:
        value.pop('traffic', None)
    template = value['template']
    template.get('metadata', {}).pop('name', None)
    for key in ('labels', 'annotations'):
        metadata = template.get('metadata', {}).get(key, {})
        for name in list(metadata):
            if name.startswith(('client.', 'run.googleapis.com/operation', 'serving.knative.dev/creator', 'run.googleapis.com/client-', 'serving.knative.dev/lastModifier')) or name == 'ci-contract':
                metadata.pop(name)
    spec = template['spec']['template']['spec'] if job else template['spec']
    for container in spec['containers']:
        container.pop('image', None)
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def traffic(resource):
    result = {}
    for item in resource['status']['traffic']:
        if item.get('percent', 0):
            name = item['revisionName']
            result[name] = result.get(name, 0) + item['percent']
    require(sum(result.values()) == 100, 'Unknown traffic allocation')
    return result


def tags(resource):
    return {item['tag']: item['revisionName'] for item in resource['status']['traffic'] if item.get('tag')}


class Cloud:
    def __init__(self, project, region, invoker):
        self.project, self.region, self.invoker = project, region, invoker

    def call(self, *args):
        result = subprocess.run(['gcloud', 'run', *args, '--project=' + self.project,
                                 '--region=' + self.region, '--format=json', '--quiet'],
                                capture_output=True, text=True, encoding='utf-8', timeout=420, check=False)
        # Cloud errors may include environment data; retain only command class and code.
        require(result.returncode == 0, f'gcloud {args[0]} {args[1]} failed ({result.returncode})')
        return json.loads(result.stdout or '{}')

    def smoke(self, url, audience, guarded):
        access = subprocess.check_output(['gcloud', 'auth', 'print-access-token'],
                                         text=True, encoding='utf-8', timeout=30).strip()
        mint = Request('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
                       self.invoker + ':generateIdToken',
                       data=json.dumps({'audience': audience, 'includeEmail': True}).encode(),
                       headers={'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json'})
        with urlopen(mint, timeout=20) as response:
            token = json.load(response)['token']
        request = Request(url + '/health', headers={'X-Serverless-Authorization': 'Bearer ' + token})
        with urlopen(request, timeout=20) as response:
            require(response.status == 200 and json.load(response) == {'status': 'ok'}, 'Read-only health smoke failed')
        # Missing app credentials must be rejected, even with Cloud Run invocation permission.
        from urllib.error import HTTPError
        try:
            with urlopen(Request(url + guarded, headers={'X-Serverless-Authorization': 'Bearer ' + token}), timeout=20):
                raise Blocked('API authentication guard missing')
        except HTTPError as error:
            require(error.code in (401, 403), 'Unexpected API guard response')


class Rollout:
    def __init__(self, cloud, manifest, approved, report, eligible):
        self.cloud, self.manifest, self.approved = cloud, manifest, set(approved)
        self.report, self.eligible = report, eligible
        self.contract = manifest['policy']['contract'][:40]
        self.old, self.candidates, self.changed_jobs, self.changed_traffic = {}, {}, [], []
        self.attempted_candidates = []
        self.result = {'commit': manifest['commit'], 'images': manifest['images'],
                       'tests': manifest['offline_ci'], 'revisions': {}, 'result': 'PREFLIGHT'}

    def save(self):
        self.result['attempted_candidates'] = list(self.attempted_candidates)
        self.result['attempted_jobs'] = list(self.changed_jobs)
        self.result['attempted_traffic'] = list(self.changed_traffic)
        self.report.write_text(json.dumps(self.result, indent=2) + '\n', encoding='utf-8')

    def compatible(self, image, labels):
        require(image in self.approved or labels.get('ci-contract') == self.contract,
                'MANUAL_REQUIRED: old image compatibility is unproven')
        require(re.fullmatch(r'.+@sha256:[a-f0-9]{64}', image), 'Old image is not immutable')

    def preflight(self):
        require(self.manifest['phase'] == 'BUILT', 'Missing built manifest')
        for name in SERVICES:
            resource = self.cloud.call('services', 'describe', name)
            require(TAG not in tags(resource), 'Unfinished candidate tag; manual recovery required')
            require(len(task(resource)['containers']) == 1, 'Multi-container service needs manual review')
            if name == 'hermes-runtime':
                require('--require-existing-control' in task(resource)['containers'][0].get('args', []),
                        'Runtime must already require existing managed control state')
            if name == 'hermes-worker':
                require('--worker' in task(resource)['containers'][0].get('args', []), 'Worker HTTP entrypoint flag is missing')
            for revision in set(traffic(resource)) | set(tags(resource).values()):
                old = self.cloud.call('revisions', 'describe', revision)
                self.compatible(old['status']['imageDigest'], old['metadata'].get('labels', {}))
            self.old[name] = resource
        for name, module in JOBS.items():
            resource = self.cloud.call('jobs', 'describe', name)
            container = task(resource, True)['containers'][0]
            require(len(task(resource, True)['containers']) == 1, 'Multi-container Job needs manual review')
            require(container.get('command') == ['python'] and container.get('args', [])[:2] == ['-m', module],
                    'Unexpected Job entrypoint')
            self.compatible(container['image'], resource['metadata'].get('labels', {}))
            self.old[name] = resource
        self.result['previous'] = {
            name: {'traffic': traffic(value), 'tags': tags(value), 'config': config_hash(value)}
            if name in SERVICES else {'image': task(value, True)['containers'][0]['image'],
                                     'config': config_hash(value, True)} for name, value in self.old.items()}
        self.save()

    def unchanged(self, name, job=False):
        current = self.cloud.call('jobs' if job else 'services', 'describe', name)
        require(config_hash(current, job) == config_hash(self.old[name], job), 'Concurrent template change; manual recovery required')
        return current

    def run(self):
        try:
            self.eligible()
            self.preflight()
            for name in SERVICES:
                self.unchanged(name)
                image = self.manifest['images']['host_image' if name == 'hermes-host' else 'runtime_image']
                self.attempted_candidates.append(name)
                self.save()
                self.cloud.call('services', 'update', name, '--image=' + image, '--no-traffic',
                                '--tag=' + TAG, '--deploy-health-check', '--update-labels=ci-contract=' + self.contract)
                resource = self.unchanged(name)
                require(traffic(resource) == traffic(self.old[name]), 'Candidate changed existing traffic')
                revision = resource['status']['latestCreatedRevisionName']
                require(revision == resource['status']['latestReadyRevisionName'], 'Candidate is not ready')
                candidate = self.cloud.call('revisions', 'describe', revision)
                require(any(c.get('type') == 'Ready' and c.get('status') == 'True'
                            for c in candidate['status']['conditions']), 'Candidate readiness failed')
                require(candidate['status']['imageDigest'] == image, 'Candidate digest mismatch')
                self.candidates[name] = revision
                self.result['revisions'][name] = revision
                self.save()
                url = next(t['url'] for t in resource['status']['traffic'] if t.get('tag') == TAG)
                self.cloud.smoke(url, resource['status']['url'], '/internal/bots' if name == 'hermes-host' else '/api/bots')
            self.eligible()
            # Job entrypoints live in Host, never in the Node Runtime image. Do not execute jobs.
            for name in JOBS:
                current = self.unchanged(name, True)
                require(task(current, True)['containers'][0]['image'] == task(self.old[name], True)['containers'][0]['image'], 'Concurrent Job update')
                self.changed_jobs.append(name)  # Record intent before a possibly ambiguous API failure.
                self.save()
                self.cloud.call('jobs', 'update', name, '--image=' + self.manifest['images']['host_image'],
                                '--update-labels=ci-contract=' + self.contract)
                updated = self.unchanged(name, True)
                require(task(updated, True)['containers'][0]['image'] == self.manifest['images']['host_image'], 'Job image read-back failed')
            for name in SERVICES:
                self.eligible()
                current = self.unchanged(name)
                require(traffic(current) == traffic(self.old[name]), 'Concurrent traffic change')
                self.changed_traffic.append(name)
                self.save()
                self.cloud.call('services', 'update-traffic', name, '--to-revisions=' + self.candidates[name] + '=100')
                require(traffic(self.unchanged(name)) == {self.candidates[name]: 100}, 'Traffic read-back failed')
            for name in SERVICES:
                current = self.unchanged(name)
                self.cloud.smoke(current['status']['url'], current['status']['url'],
                                 '/internal/bots' if name == 'hermes-host' else '/api/bots')
            self.cleanup_tags()
            self.result['result'] = 'DEPLOYED'
        except (Blocked, subprocess.SubprocessError, OSError, ValueError, KeyError, StopIteration, KeyboardInterrupt) as error:
            self.result['reason'] = str(error) if isinstance(error, Blocked) else type(error).__name__
            self.result['result'] = 'FAILED_SAFE'
            try:
                self.rollback()
                self.cleanup_tags()
                if self.changed_jobs or self.changed_traffic:
                    self.result['result'] = 'ROLLED_BACK'
            except (Blocked, subprocess.SubprocessError, OSError, ValueError, KeyError, StopIteration):
                self.result['result'] = 'RECOVERY_REQUIRED'
            self.save()
            raise Blocked(self.result['result']) from None
        finally:
            self.save()

    def cleanup_tags(self):
        for name in self.attempted_candidates:
            current = self.unchanged(name)
            observed = tags(current)
            if TAG not in observed:
                require(observed == tags(self.old[name]), 'External tag change')
                continue
            revision = self.cloud.call('revisions', 'describe', observed[TAG])
            expected_image = self.manifest['images']['host_image' if name == 'hermes-host' else 'runtime_image']
            require(revision['spec']['containers'][0]['image'] == expected_image, 'Unknown tagged candidate')
            require({k: v for k, v in observed.items() if k != TAG} == tags(self.old[name]), 'External tag change')
            self.cloud.call('services', 'update-traffic', name, '--remove-tags=' + TAG)
            require(tags(self.unchanged(name)) == tags(self.old[name]), 'Tag cleanup failed')

    def rollback(self):
        # Compatibility was established before mutation. Never reverse a schema or release pin.
        for name in reversed(self.changed_traffic):
            current = self.unchanged(name)
            require(traffic(current) in (traffic(self.old[name]), {self.candidates[name]: 100}), 'External traffic change; stop rollback')
            allocation = ','.join(f'{rev}={percent}' for rev, percent in traffic(self.old[name]).items())
            self.cloud.call('services', 'update-traffic', name, '--to-revisions=' + allocation)
            require(traffic(self.unchanged(name)) == traffic(self.old[name]), 'Traffic restore failed')
        for name in reversed(self.changed_jobs):
            current = self.unchanged(name, True)
            old_image = task(self.old[name], True)['containers'][0]['image']
            require(task(current, True)['containers'][0]['image'] in (old_image, self.manifest['images']['host_image']), 'External Job update; stop rollback')
            old_label = self.old[name]['metadata'].get('labels', {}).get('ci-contract')
            label_arg = '--update-labels=ci-contract=' + old_label if old_label else '--remove-labels=ci-contract'
            self.cloud.call('jobs', 'update', name, '--image=' + old_image, label_arg)
            require(task(self.unchanged(name, True), True)['containers'][0]['image'] == old_image, 'Job restore failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding='utf-8-sig'))
    from scripts.ci.llm_release_manifest import OFFLINE_GATES
    from scripts.ci.rollout_policy import check
    require(manifest.get('image_integrity') == 'PASS', 'Image integrity evidence missing')
    require(manifest['commit'] == os.environ['GITHUB_SHA'], 'Manifest commit mismatch')
    require(set(manifest['offline_ci']) == OFFLINE_GATES and
            all(v == 'PASS' for v in manifest['offline_ci'].values()), 'Required gates did not pass')
    require(check(Path.cwd(), manifest['policy']['baseline']) == manifest['policy'], 'Policy evidence mismatch')
    for key, name in (('host_image', 'hermes-host'), ('runtime_image', 'hermes-runtime')):
        prefix = f"{os.environ['GCP_IMAGE_REGION']}-docker.pkg.dev/{os.environ['GCP_PROJECT_ID']}/{os.environ['GCP_ARTIFACT_REPOSITORY']}"
        require(re.fullmatch(re.escape(prefix + '/' + name) + r'@sha256:[a-f0-9]{64}', manifest['images'][key]), 'Unexpected image repository/digest')
    def eligible():
        tip = subprocess.check_output(['gh', 'api', 'repos/' + os.environ['GITHUB_REPOSITORY'] + '/commits/main',
                                       '--jq', '.sha'], text=True, encoding='utf-8', timeout=30).strip()
        require(tip == manifest['commit'], 'Stale main candidate')
    cloud = Cloud(os.environ['GCP_PROJECT_ID'], os.environ['GCP_BUILD_REGION'], os.environ['GCP_SMOKE_SERVICE_ACCOUNT'])
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    Rollout(cloud, manifest, json.loads(os.environ.get('APPROVED_ROLLBACK_IMAGES', '[]')), args.report, eligible).run()


if __name__ == '__main__':
    main()
