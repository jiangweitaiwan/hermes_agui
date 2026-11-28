"""Clean orchestration. Reuses candidate rollout; never invokes legacy drain."""
from copy import deepcopy
import json
import os
import subprocess
from scripts.ci.clean_bootstrap import Journal, access_token, intent, manifest_digest, cloudsql_bindings
from scripts.ci.database_rollout import DatabaseRollout
from scripts.ci.llm_rollout import Blocked, JOBS, SERVICES, require, tags, task, config_hash


class CleanRollout(DatabaseRollout):
    clean = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.recovering = os.environ.get('CLEAN_RECOVERY_OPERATION', '') != ''
        self.intent = intent(os.environ, self.manifest)
        operation = os.environ.get('CLEAN_RECOVERY_OPERATION') or self.intent['operation']
        self.journal = Journal(os.environ.get('CLEAN_JOURNAL_BUCKET'), operation, access_token)
        self.recovery_record = self.journal.read() if self.recovering else None
        if self.recovering:
            prior = self.recovery_record
            require(prior.get('result') != 'DEPLOYED', 'Successful reset cannot be recovered or repeated')
            require(prior['manifest_digest'] == manifest_digest(self.manifest), 'Recovery must use original verified manifest')
            self.intent = prior['intent']
            require(self.intent['source'] == self.manifest['commit'], 'Recovery source mismatch')
            self.result.update(prior)
            self.result['recovery_run'] = os.environ['GITHUB_RUN_ID']
            self.preparation = self.result['database_operations']
            self.attempted_candidates = list(prior.get('attempted_candidates', []))
            self.candidates = dict(prior.get('revisions', {}))
        self.result.update(mode='clean-bootstrap', intent=self.intent, manifest_digest=manifest_digest(self.manifest),
                           confirmation=True, independent_approval=True)
        self.journal_started = self.recovering
        self.maintenance = self.recovering

    def save(self):
        super().save()
        if getattr(self, 'journal_started', False):
            self.journal.write(self.result)

    def phase(self, phase):
        from datetime import datetime, UTC
        self.result.setdefault('phase_history', []).append({'phase': phase, 'at': datetime.now(UTC).isoformat()})
        self.result['phase'] = phase
        self.journal.write(self.result)
        self.journal_started = True
        self.save()

    def database(self, command):
        # Non-secret intent reaches only the preparation Job; owner DSNs stay mounted.
        self.preparation.append({'operation': command, 'status': 'STARTED'})
        if self.journal_started:
            self.phase(command + '-intent')
        args = '--args=--import,tsx,server/storage/deployment-cli.ts,' + command
        encoded = json.dumps(self.intent, separators=(',', ':'))
        credentials = '|CLEAN_NEW_CREDENTIAL_ENVS=' + json.dumps(self.credential_envs['AGUI_CLEAN_']) + '|CLEAN_OLD_CREDENTIAL_ENVS=' + json.dumps(self.credential_envs['AGUI_OLD_'])
        self.execute(self.database_job, args, '--update-env-vars=^|^CLEAN_BOOTSTRAP_INTENT=' + encoded + '|CLEAN_BINDINGS_HASH=' + self.bindings_hash + credentials)
        self.preparation.append({'operation': command, 'status': 'PASS'})
        if command in {'reset-host', 'reset-runtime'}:
            schema = 'hermes_agui_host_migrations' if command == 'reset-host' else 'hermes_agui_runtime_migrations'
            self.result.setdefault('reset_commits', {})[schema] = {**self.intent, 'execution': self.result['executions'][-1]['execution'], 'status': 'COMMITTED_OR_VERIFIED_MARKER'}
        if self.journal_started:
            self.phase(command + '-complete')

    def clean_inventory(self):
        instance = self.intent['instance']
        known = set(SERVICES) | set(JOBS) | {self.database_job, self.host_job}
        for kind in ('services', 'jobs'):
            for resource in self.cloud.call(kind, 'list'):
                name = resource.get('metadata', {}).get('name', '')
                require(instance not in cloudsql_bindings(resource) or name in known, 'Unknown Cloud SQL application consumer: ' + name)
        for name, resource in self.old.items():
            require(cloudsql_bindings(resource) == {instance}, 'Expected single trusted Cloud SQL binding: ' + name)
            for entry in task(resource, name not in SERVICES)['containers'][0].get('env', []):
                if 'secretKeyRef' in entry.get('valueFrom', {}) or entry['name'].endswith('_DATABASE_URL'):
                    secret = entry.get('valueFrom', {}).get('secretKeyRef', {})
                    require(secret.get('name') and str(secret.get('key', '')).isdigit(), 'Database credentials require fixed Secret versions')

    def bindings(self):
        """Require disjoint identities and credentials; test effective Secret denial.

        A mere IAM-policy read misses inherited grants. Impersonation denial itself
        is not proof: only Secret Manager's permission-denied response is accepted.
        """
        config = json.loads(os.environ.get('CLEAN_APPLICATION_BINDINGS') or '{}')
        require(set(config) == set(SERVICES) | set(JOBS), 'Full new application binding inventory required')
        from scripts.ci.clean_bootstrap import manifest_digest
        self.bindings_hash = manifest_digest(config)
        old_accounts = set(self.recovery_record['old_application_accounts']) if self.recovering else {task(self.old[n], n in JOBS)['serviceAccountName'] for n in config}
        self.result['old_application_accounts'] = sorted(old_accounts)
        application_accounts = old_accounts | {change['service_account'] for change in config.values()}
        ci_account = os.environ.get('GCP_DEPLOY_SERVICE_ACCOUNT')
        require(ci_account, 'Explicit CI identity required')
        for job in (self.database_job, self.host_job):
            prep = task(self.old[job], True)
            require(prep['serviceAccountName'] not in application_accounts | {ci_account}, 'Owner preparation identity must be separate from application and CI identities')
            for entry in prep['containers'][0].get('env', []):
                if entry['name'] in {'AGUI_HOST_DATABASE_URL', 'AGUI_RUNTIME_DATABASE_URL'}:
                    ref = entry['valueFrom']['secretKeyRef']
                    for account in old_accounts | {ci_account}:
                        self.secret_denied(account, {'name': ref['name'], 'version': ref['key']})
        self.clean_expected, self.service_options = {}, {}
        old_credentials = set()
        for name, change in config.items():
            require(set(change) == {'service_account', 'secrets'}, 'Invalid application binding fields')
            account = change['service_account']
            require(account.endswith('@' + self.cloud.project + '.iam.gserviceaccount.com') and account not in old_accounts,
                    'New application identity must be isolated from every old revision/Job')
            self.account_ready(account, change['secrets'].values())
            expected = deepcopy(self.host_expected if name == 'hermes-host' else self.old[name])
            spec = task(expected, name in JOBS)
            env = {e['name']: e for e in spec['containers'][0].get('env', [])}
            database_keys = {key for key in env if key.endswith('_DATABASE_URL')}
            require(database_keys and set(change['secrets']) == database_keys, 'Replace every application database credential; no unrelated delta')
            replacements = []
            for key, binding in change['secrets'].items():
                require(set(binding) == {'name', 'version'}, 'Invalid Secret binding')
                import re
                require(re.fullmatch(r'[a-zA-Z0-9_-]+', binding['name']) and re.fullmatch(r'[1-9][0-9]*', str(binding['version'])), 'Pinned new Secret version required')
                old = env[key].get('valueFrom', {}).get('secretKeyRef', {})
                if old.get('name'):
                    old_credentials.add((old['name'], str(old.get('key', ''))))
                require(old.get('name') and (old.get('name') != binding['name'] or self.recovering), 'Generation credentials require separate Secret IAM boundary')
                for old_account in sorted(old_accounts):
                    self.secret_denied(old_account, binding)
                env[key] = {'name': key, 'valueFrom': {'secretKeyRef': {'name': binding['name'], 'key': str(binding['version'])}}}
                replacements.append(key + '=' + binding['name'] + ':' + str(binding['version']))
            spec['serviceAccountName'] = account
            spec['containers'][0]['env'] = list(env.values())
            self.clean_expected[name] = expected
            self.service_options[name] = ['--service-account=' + account, '--update-secrets=' + ','.join(replacements)]
        if self.recovering:
            for name, resource in self.old.items():
                require(config_hash(resource, name not in SERVICES) in self.recovery_record['approved_template_hashes'][name], 'Recovery template drift: ' + name)
        else:
            self.result['approved_template_hashes'] = {name: [config_hash(resource, name not in SERVICES), config_hash(self.clean_expected.get(name, resource), name not in SERVICES)] for name, resource in self.old.items()}
        prep_env = task(self.old[self.database_job], True)['containers'][0].get('env', [])
        self.credential_envs = {prefix: sorted(e['name'] for e in prep_env if e['name'].startswith(prefix)) for prefix in ('AGUI_CLEAN_', 'AGUI_OLD_')}
        old_required = {tuple(item) for item in self.recovery_record['old_credential_bindings']} if self.recovering else old_credentials
        old_mounted = {(e['valueFrom']['secretKeyRef']['name'], str(e['valueFrom']['secretKeyRef']['key'])) for e in prep_env if e['name'].startswith('AGUI_OLD_') and 'secretKeyRef' in e.get('valueFrom', {})}
        require(old_required and old_required.issubset(old_mounted), 'Preparation must validate every actual old application DSN role, including aliases')
        self.result['old_credential_bindings'] = sorted(old_required)
        mounted = { (e['valueFrom']['secretKeyRef']['name'], str(e['valueFrom']['secretKeyRef']['key']))
                    for e in task(self.old[self.database_job], True)['containers'][0].get('env', [])
                    if e['name'].startswith('AGUI_CLEAN_') and 'secretKeyRef' in e.get('valueFrom', {}) }
        required = {(b['name'], str(b['version'])) for change in config.values() for b in change['secrets'].values()}
        require(required.issubset(mounted), 'Preparation must independently validate every new application DSN')
        self.verify_journal_boundary(application_accounts)
        self.verify_authority_boundary(application_accounts, config)
        self.result['credential_binding_inventory'] = config

    def verify_journal_boundary(self, accounts):
        from urllib.request import Request, urlopen
        token = access_token()
        with urlopen(Request('https://storage.googleapis.com/storage/v1/b/' + self.journal.bucket,
                             headers={'Authorization': 'Bearer ' + token}), timeout=30) as response:
            metadata = json.load(response)
        require(metadata.get('iamConfiguration', {}).get('uniformBucketLevelAccess', {}).get('enabled'), 'Journal bucket requires uniform IAM; object ACLs are not accepted')
        resource = '//storage.googleapis.com/projects/_/buckets/' + self.journal.bucket + '/objects/' + self.journal.name
        for account in sorted(accounts):
            for permission in ('storage.objects.create', 'storage.objects.delete'):
                request = Request('https://policytroubleshooter.googleapis.com/v1/iam:troubleshoot',
                    data=json.dumps({'accessTuple': {'principal': account, 'fullResourceName': resource, 'permission': permission}}).encode(),
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with urlopen(request, timeout=30) as response:
                    require(json.load(response).get('access') == 'DENIED', 'Application identity must not mutate deployment journal; unknown IAM results fail closed')

    def require_iam_denied(self, account, resource, permission):
        from urllib.request import Request, urlopen
        request = Request('https://policytroubleshooter.googleapis.com/v1/iam:troubleshoot',
            data=json.dumps({'accessTuple': {'principal': account, 'fullResourceName': resource, 'permission': permission}}).encode(),
            headers={'Authorization': 'Bearer ' + access_token(), 'Content-Type': 'application/json'})
        with urlopen(request, timeout=30) as response:
            require(json.load(response).get('access') == 'DENIED', 'Application identity can acquire deployment authority, or IAM result is unknown')

    def verify_authority_boundary(self, accounts, config):
        targets = {change['service_account'] for change in config.values()}
        for job in (self.database_job, self.host_job):
            targets.add(task(self.old[job], True)['serviceAccountName'])
        secrets = {binding['name'] for change in config.values() for binding in change['secrets'].values()}
        for job in (self.database_job, self.host_job):
            secrets.update(e['valueFrom']['secretKeyRef']['name'] for e in task(self.old[job], True)['containers'][0].get('env', []) if e['name'] in {'AGUI_HOST_DATABASE_URL', 'AGUI_RUNTIME_DATABASE_URL'})
        project = '//cloudresourcemanager.googleapis.com/projects/' + self.cloud.project
        for account in sorted(accounts):
            self.require_iam_denied(account, project, 'resourcemanager.projects.setIamPolicy')
            for target in sorted(targets - {account}):
                resource = '//iam.googleapis.com/projects/' + self.cloud.project + '/serviceAccounts/' + target
                for permission in ('iam.serviceAccounts.actAs', 'iam.serviceAccounts.getAccessToken', 'iam.serviceAccounts.setIamPolicy'):
                    self.require_iam_denied(account, resource, permission)
            for secret in sorted(secrets):
                self.require_iam_denied(account, '//secretmanager.googleapis.com/projects/' + self.cloud.project + '/secrets/' + secret, 'secretmanager.secrets.setIamPolicy')
            for job in (self.database_job, self.host_job):
                resource = '//run.googleapis.com/projects/' + self.cloud.project + '/locations/' + self.cloud.region + '/jobs/' + job
                for permission in ('run.jobs.run', 'run.jobs.runWithOverrides', 'run.jobs.update'):
                    self.require_iam_denied(account, resource, permission)

    def account_ready(self, account, bindings):
        from urllib.request import Request, urlopen
        from urllib.parse import quote
        request = Request('https://iam.googleapis.com/v1/projects/-/serviceAccounts/' + quote(account, safe='') + ':testIamPermissions',
                          data=json.dumps({'permissions': ['iam.serviceAccounts.actAs']}).encode(),
                          headers={'Authorization': 'Bearer ' + access_token(), 'Content-Type': 'application/json'})
        with urlopen(request, timeout=30) as response:
            require('iam.serviceAccounts.actAs' in json.load(response).get('permissions', []), 'Cannot assign new application identity')
        for binding in bindings:
            result = subprocess.run(['gcloud', 'secrets', 'versions', 'describe', str(binding['version']),
                '--secret=' + binding['name'], '--project=' + self.cloud.project, '--format=json'],
                capture_output=True, text=True, encoding='utf-8', timeout=30, check=False)
            require(result.returncode == 0 and json.loads(result.stdout).get('state') == 'ENABLED', 'New credential Secret version must exist and be ENABLED')

    def secret_denied(self, account, binding):
        # First mint the token independently, so impersonation failures never pass.
        if account == os.environ.get('GCP_DEPLOY_SERVICE_ACCOUNT'):
            token = access_token()
        else:
            minted = subprocess.run(['gcloud', 'auth', 'print-access-token', '--impersonate-service-account=' + account],
                                    capture_output=True, text=True, encoding='utf-8', timeout=30, check=False)
            require(minted.returncode == 0, 'Cannot verify old identity Secret isolation')
            token = minted.stdout.strip()
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        resource = f"projects/{self.cloud.project}/secrets/{binding['name']}/versions/{binding['version']}:access"
        try:
            with urlopen(Request('https://secretmanager.googleapis.com/v1/' + resource,
                                headers={'Authorization': 'Bearer ' + token}), timeout=30):
                raise Blocked('Old application identity can retrieve new credential')
        except HTTPError as error:
            value = json.loads(error.read())
            require(error.code == 403 and value.get('error', {}).get('status') == 'PERMISSION_DENIED',
                    'Secret isolation could not be established')

    def stop_services(self):
        failures = []
        for name in SERVICES:
            try:
                self.cloud.call('services', 'update', name, '--scaling=0')
                current = self.cloud.call('services', 'describe', name)
                annotations = current.get('metadata', {}).get('annotations', {})
                require(annotations.get('run.googleapis.com/scalingMode') == 'manual' and
                        str(annotations.get('run.googleapis.com/manualInstanceCount')) == '0', 'Service stop read-back failed')
            except Exception:  # health: allow BLE001 -- aggregate sanitized containment failures; cloud errors can include credentials
                failures.append(name)
        require(not failures, 'Service stop not confirmed: ' + ', '.join(failures))

    def cancel_executions(self):
        failures = []
        for name in [*JOBS, self.database_job, self.host_job]:
            try:
                self.cancel_job_executions(name)
            except Exception:  # health: allow BLE001 -- aggregate sanitized containment failures; cloud errors can include credentials
                failures.append(name)
        require(not failures, 'Execution cancellation not confirmed: ' + ', '.join(failures))

    def cancel_job_executions(self, name):
        def terminal(execution):
            return any(c.get('type') == 'Completed' and c.get('status') in ('True', 'False')
                       for c in execution.get('status', {}).get('conditions', []))
        for execution in self.cloud.call('jobs', 'executions', 'list', '--job=' + name):
            if terminal(execution):
                continue
            identifier = execution['metadata']['name']
            entry = {'job': name, 'execution': identifier, 'status': 'CANCEL_REQUESTED'}
            self.result.setdefault('cancelled_executions', []).append(entry)
            self.save()
            self.cloud.call('jobs', 'executions', 'cancel', identifier)
            require(terminal(self.cloud.call('jobs', 'executions', 'describe', identifier)), 'Execution cancellation pending')
            entry['status'] = 'STOPPED'
            self.save()

    def contain(self):
        for operation in (self.stop_services, lambda: self.queues.transition('pause'), self.cancel_executions,
                          *[lambda n=n: self.scheduler('pause', n) for n in self.schedulers],
                          lambda: self.database('isolate'), lambda: self.database('seal')):
            try:
                operation()
            except Exception:  # health: allow BLE001 -- aggregate sanitized containment failures; cloud errors can include credentials
                self.result['containment_incomplete'] = True

    def run(self):
        try:
            self.eligible()
            self.preflight()
            require(self.recovering or all(not tags(self.old[n]) for n in SERVICES), 'Historical revision tags require recovery')
            require(self.recovering or all(self.old[n].get('metadata', {}).get('annotations', {}).get('run.googleapis.com/scalingMode') != 'manual' for n in SERVICES), 'Existing manual scaling requires recovery')
            require(len(self.schedulers) == 3, 'Exactly three Schedulers required')
            self.inventory()
            self.clean_inventory()
            self.bindings()
            # First write is create-only: a rerun/crash cannot overwrite intent.
            self.phase('RECOVERY_INTENT' if self.recovering else 'INTENT')
            for name, key in ((self.database_job, 'runtime_image'), (self.host_job, 'host_image')):
                self.update_job(name, key)
            self.database('reset-preflight')
            self.phase('MAINTENANCE_INTENT')
            self.maintenance = True
            # Ingress is blocked before producers are paused; no old DB fence assumed.
            self.stop_services()
            for name in self.schedulers:
                self.scheduler('pause', name)
            self.queues.transition('pause')
            self.cancel_executions()
            self.idle_jobs([*JOBS, self.database_job, self.host_job])
            self.database('isolate')
            self.eligible()
            self.verify_templates()
            self.database('verify-isolation')
            if self.recovering:
                self.database('recovery-check')
            self.phase('DESTRUCTIVE_BOUNDARY')
            self.database('reset-host')
            self.database('reset-runtime')
            self.execute(self.host_job, '--update-env-vars=AGUI_APPLY_DATABASE_GRANTS=true')
            self.phase('HOST_MIGRATED')
            self.database('migrate')
            self.database('check')
            self.database('seal')
            self.database('epoch')
            self.database('release')
            # Never automatically recover a run after admission may have opened.
            self.phase('CANDIDATES_AND_ADMISSION_INTENT')
            self.deploy_candidates()
            self.result['result'] = 'DEPLOYED'
            self.phase('DEPLOYED')
        except (Exception, KeyboardInterrupt) as error:  # health: allow BLE001 -- persist sanitized outcome and contain every failed deployment phase
            self.result['reason'] = str(error) if isinstance(error, Blocked) else type(error).__name__
            self.result['result'] = 'RECOVERY_REQUIRED' if self.maintenance else 'FAILED_SAFE'
            if self.maintenance:
                self.contain()
            if self.journal_started:
                try:
                    self.phase(self.result['result'])
                except Exception:  # health: allow BLE001 -- aggregate sanitized containment failures; cloud errors can include credentials
                    self.result['journal_incomplete'] = True
            raise Blocked(self.result['result']) from None
        finally:
            self.save()
