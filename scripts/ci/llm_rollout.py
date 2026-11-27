"""Cloud Run primitives and database-aware deployment entrypoint."""
import argparse
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
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
        budget = (getattr(self, 'deadline', None) or float('inf')) - time.monotonic()
        require(budget > 0, 'Drain budget exhausted')
        result = subprocess.run(['gcloud', 'run', *args, '--project=' + self.project,
                                 '--region=' + self.region, '--format=json', '--quiet'],
                                capture_output=True, text=True, encoding='utf-8', timeout=min(420, budget), check=False)
        # Cloud errors may include environment data; retain only command class and code.
        require(result.returncode == 0, f'gcloud {args[0]} {args[1]} failed ({result.returncode})')
        return json.loads(result.stdout or '{}')

    def database_counts(self, execution):
        require(re.fullmatch(r'[a-zA-Z0-9-]+', execution), 'Invalid execution identifier')
        query = 'resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="' + execution + '" AND jsonPayload.event="database_drain_counts"'
        result = subprocess.run(['gcloud','logging','read',query,'--project=' + self.project,
            '--limit=1','--format=json(jsonPayload.counts)','--freshness=1d'], capture_output=True,text=True,timeout=30,check=False)
        require(result.returncode == 0, 'Drain count evidence query failed')
        entries = json.loads(result.stdout or '[]')
        counts = entries[0].get('jsonPayload', {}).get('counts') if entries else None
        require(isinstance(counts, dict) and counts and all(isinstance(v,int) and v>=0 for v in counts.values()), 'Drain count evidence not yet available')
        allowed = {'hermes_agui_host.runs','hermes_agui_host.run_outbox','hermes_agui_runtime.graph_jobs'}
        require(set(counts) <= allowed, 'Unknown drain evidence keys')
        return counts

    def identity(self, audience):
        access = subprocess.check_output(['gcloud', 'auth', 'print-access-token'],
                                         text=True, encoding='utf-8', timeout=30).strip()
        mint = Request('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
                       self.invoker + ':generateIdToken',
                       data=json.dumps({'audience': audience, 'includeEmail': True}).encode(),
                       headers={'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json'})
        with urlopen(mint, timeout=20) as response:
            token = json.load(response)['token']
        return token

    def capabilities(self, url):
        token = self.identity(url)
        with urlopen(Request(url + "/internal/execution-capabilities", headers={"X-Serverless-Authorization":"Bearer " + token}), timeout=20) as response:
            return json.load(response)

    def smoke(self, url, audience, guarded, *, method="GET"):
        token = self.identity(audience)
        request = Request(url + '/health', headers={'X-Serverless-Authorization': 'Bearer ' + token})
        with urlopen(request, timeout=20) as response:
            require(response.status == 200 and json.load(response) == {'status': 'ok'}, 'Read-only health smoke failed')
        # Missing app credentials must be rejected, even with Cloud Run invocation permission.
        from urllib.error import HTTPError
        try:
            with urlopen(Request(url + guarded, method=method, headers={'X-Serverless-Authorization': 'Bearer ' + token}), timeout=20):
                raise Blocked('API authentication guard missing')
        except HTTPError as error:
            require(error.code in (401, 403), 'Unexpected API guard response')


class RolloutState:
    def __init__(self, cloud, manifest, report, eligible):
        self.cloud, self.manifest = cloud, manifest
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

    def immutable_image(self, image):
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
                self.immutable_image(old['status']['imageDigest'])
            self.old[name] = resource
        for name, module in JOBS.items():
            resource = self.cloud.call('jobs', 'describe', name)
            container = task(resource, True)['containers'][0]
            require(len(task(resource, True)['containers']) == 1, 'Multi-container Job needs manual review')
            require(container.get('command') == ['python'] and container.get('args', [])[:2] == ['-m', module],
                    'Unexpected Job entrypoint')
            self.immutable_image(container['image'])
            self.old[name] = resource
        self.result['previous'] = {
            name: {'traffic': traffic(value), 'tags': tags(value), 'config': config_hash(value)}
            if name in SERVICES else {'image': task(value, True)['containers'][0]['image'],
                                     'config': config_hash(value, True)} for name, value in self.old.items()}
        self.save()


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
    from scripts.ci.database_rollout import DatabaseRollout
    DatabaseRollout(cloud, manifest, args.report, eligible,
                    database_job=os.environ['GCP_DATABASE_JOB'], host_job=os.environ['GCP_HOST_MIGRATION_JOB'],
                    schedulers=json.loads(os.environ['GCP_SCHEDULER_JOBS']),
                    queues=json.loads(os.environ['GCP_CLOUD_TASK_QUEUES']),
                    drain_seconds=int(os.environ.get('GCP_DRAIN_SECONDS', '300'))).run()


if __name__ == '__main__':
    main()
