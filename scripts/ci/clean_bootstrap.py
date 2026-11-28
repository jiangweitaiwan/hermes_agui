"""Explicit clean-mode authorization and durable create-only operation journal.

The journal is outside all reset schemas and uses GCS generation preconditions.
An interrupted operation requires forward recovery; never retry DROP from a rerun.
"""
import hashlib
import json
import os
import re
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
import subprocess
import uuid

from scripts.ci.llm_rollout import require


def authorize(env):
    mode = 'rolling-upgrade' if env.get('GITHUB_EVENT_NAME') == 'push' else env.get('DEPLOYMENT_MODE', 'rolling-upgrade')
    require(mode in {'rolling-upgrade', 'clean-bootstrap'}, 'Unknown deployment mode')
    if mode == 'clean-bootstrap':
        require(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'Reset requires workflow_dispatch')
        require(env.get('GITHUB_REF') == 'refs/heads/main', 'Reset requires main')
        require(env.get('DEPLOY_REQUESTED') == 'true' and env.get('AUTO_DEPLOY_ENABLED') == 'true', 'Reset requires enabled explicit deployment')
        recovery = env.get('CLEAN_RECOVERY_OPERATION', '')
        require(not recovery or re.fullmatch(r'[0-9]+', recovery), 'Invalid recovery operation')
        confirmation = f'RECOVER {recovery} copilotkit-agui/hermes' if recovery else 'RESET copilotkit-agui/hermes'
        require(env.get('CONFIRM_RESET') == confirmation, 'Reset/recovery confirmation mismatch')
        require(env.get('GCP_PROJECT_ID') == 'copilotkit-agui' and env.get('GCP_BUILD_REGION') == 'asia-east1', 'Reset target mismatch')
        require(env.get('CLEAN_APPROVAL_VERIFIED') == 'true', 'Independent reset approval evidence missing')
        require(env.get('GITHUB_RUN_ATTEMPT') == '1', 'Clean workflow reruns require dedicated forward recovery')
    return mode


class Journal:
    def __init__(self, bucket, operation, token):
        require(re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]', bucket or ''), 'Journal bucket required')
        require(re.fullmatch(r'[0-9]+', operation or ''), 'Invalid operation ID')
        self.bucket, self.operation, self.token = bucket, operation, token
        self.generation = 0
        self.name = 'deployment-journal/clean/' + operation + '.json'

    def read(self):
        request = Request(f'https://storage.googleapis.com/storage/v1/b/{self.bucket}/o/{quote(self.name, safe="")}?alt=media',
                          headers={'Authorization': 'Bearer ' + self.token()})
        with urlopen(request, timeout=30) as response:
            self.generation = int(response.headers['x-goog-generation'])
            return json.load(response)

    def write(self, value):
        params = urlencode({'uploadType': 'media', 'name': self.name, 'ifGenerationMatch': self.generation})
        request = Request(f'https://storage.googleapis.com/upload/storage/v1/b/{self.bucket}/o?{params}',
            data=json.dumps(value, sort_keys=True).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + self.token(), 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=30) as response:
                self.generation = int(json.load(response)['generation'])
        except HTTPError as error:
            require(False, 'Journal write rejected (' + str(error.code) + '); recovery required')


def intent(env, manifest):
    require(re.fullmatch(r'copilotkit-agui:asia-east1:[a-z][a-z0-9-]+', env.get('CLEAN_SQL_INSTANCE', '')), 'Expected Cloud SQL instance required')
    return {'operation': env['GITHUB_RUN_ID'], 'epoch': str(uuid.uuid4()), 'project': 'copilotkit-agui',
            'database': 'hermes', 'instance': env['CLEAN_SQL_INSTANCE'], 'source': manifest['commit']}


def access_token():
    return subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True, encoding='utf-8', timeout=30).strip()


def verify_approval(env):
    """A variable is not an approval. Require GitHub's completed, independent review."""
    if env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or env.get('DEPLOYMENT_MODE') != 'clean-bootstrap':
        return
    result = subprocess.check_output(['gh', 'api', f"repos/{env['GITHUB_REPOSITORY']}/actions/runs/{env['GITHUB_RUN_ID']}/approvals"], text=True, encoding='utf-8', timeout=30)
    records = json.loads(result)
    require(any(r.get('state') == 'approved' and r.get('user', {}).get('login') != env.get('GITHUB_ACTOR') and
                any(e.get('name') == 'llm-deploy' for e in r.get('environments', [])) for r in records),
            'llm-deploy requires an independent environment reviewer; configure required reviewers and prevent self-review')
    env['CLEAN_APPROVAL_VERIFIED'] = 'true'


def manifest_digest(manifest):
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def cloudsql_bindings(resource):
    """Cloud Run v1 places Job execution annotations above the task template."""
    template = resource.get('spec', {}).get('template', {})
    annotations = [template.get('metadata', {}).get('annotations', {}),
                   template.get('spec', {}).get('template', {}).get('metadata', {}).get('annotations', {})]
    return {name for annotation in annotations for name in
            annotation.get('run.googleapis.com/cloudsql-instances', '').split(',') if name}
