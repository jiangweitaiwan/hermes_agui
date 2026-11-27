"""Conservative maintenance-window rollout; SQL/release transitions never image-rollback."""
import json
import subprocess
import time

from scripts.ci.llm_rollout import RolloutState, SERVICES, JOBS, TAG, task, traffic, tags, config_hash, require, Blocked


class DatabaseRollout(RolloutState):
    def __init__(self, *args, database_job, host_job, schedulers, **kwargs):
        super().__init__(*args, **kwargs)
        require(database_job and host_job and database_job != host_job, 'Two dedicated preparation Job templates required')
        require(schedulers and len(set(schedulers)) == len(schedulers), 'Explicit Scheduler inventory required')
        self.database_job, self.host_job, self.schedulers = database_job, host_job, schedulers
        self.maintenance = False
        self.preparation = []
        self.result['database_operations'] = self.preparation
        self.result['rollback_policy'] = 'No automatic old-Image rollback after maintenance starts'

    def scheduler(self, action, name=None):
        def call(operation):
            args = ['gcloud', 'scheduler', 'jobs', operation]
            if name:
                args.append(name)
            result = subprocess.run([*args, '--project=' + self.cloud.project,
                                     '--location=' + self.cloud.region, '--format=json', '--quiet'],
                                    capture_output=True, text=True, timeout=60, check=False)
            require(result.returncode == 0, 'Scheduler ' + operation + ' failed')
            return json.loads(result.stdout or '{}')
        if action not in ('pause', 'resume'):
            return call(action)
        desired = 'PAUSED' if action == 'pause' else 'ENABLED'
        current = call('describe')
        if current.get('state') != desired:
            call(action)
            current = call('describe')
        require(current.get('state') == desired, 'Scheduler state read-back failed: ' + name)
        return current

    def inventory(self):
        scheduled = self.scheduler('list')
        found = {item['name'].split('/')[-1]: item for item in scheduled}
        require(set(self.schedulers).issubset(found), 'Scheduler inventory incomplete')
        # Unknown Scheduler consumers of this app would invalidate quiescence.
        for name, item in found.items():
            uri = item.get('httpTarget', {}).get('uri', '')
            consumes = any(job in uri for job in JOBS) or any(
                value['status']['url'].split('://')[-1] in uri for key, value in self.old.items() if key in SERVICES)
            require(not consumes or name in self.schedulers, 'Unknown application Scheduler: ' + name)
        for name in self.schedulers:
            require(found[name]['state'] == 'ENABLED', 'Scheduler must start ENABLED: ' + name)
        for name in (self.database_job, self.host_job):
            resource = self.cloud.call('jobs', 'describe', name)
            spec = task(resource, True)
            require(len(spec['containers']) == 1 and spec.get('maxRetries', 0) == 0,
                    'Preparation Job needs one container and max-retries=0')
            self.old[name] = resource
            container = spec['containers'][0]
            expected = ['node'] if name == self.database_job else ['python']
            require(container.get('command') == expected, 'Unexpected preparation entrypoint')
            args = container.get('args', [])
            require(args[:3] == ['--import', 'tsx', 'server/storage/deployment-cli.ts'] if name == self.database_job
                    else args == ['-m', 'hermes_agui.storage.migrate'], 'Unexpected preparation arguments')

        self.idle_jobs([self.database_job, self.host_job])

    def execute(self, name, *args):
        execution = self.cloud.call('jobs', 'execute', name, '--async', *args)
        execution_name = execution['metadata']['name']
        entry = {'job': name, 'execution': execution_name, 'status': 'RUNNING'}
        self.result.setdefault('executions', []).append(entry)
        self.save()
        running = True
        try:
            deadline = time.monotonic() + 600
            while True:
                completed = next((c for c in execution.get('status', {}).get('conditions', [])
                                  if c.get('type') == 'Completed'), {})
                if completed.get('status') in ('True', 'False'):
                    running = False
                    entry['status'] = 'PASS' if completed['status'] == 'True' else 'FAILED'
                    require(completed['status'] == 'True', 'Preparation Job failed; inspect execution ' + execution_name)
                    return execution
                require(time.monotonic() < deadline, 'Preparation Job timed out: ' + execution_name)
                time.sleep(2)
                execution = self.cloud.call('jobs', 'executions', 'describe', execution_name)
        except (Exception, KeyboardInterrupt):
            if running:
                entry['status'] = 'CANCEL_REQUESTED'
                try:
                    self.cloud.call('jobs', 'executions', 'cancel', execution_name)
                    observed = self.cloud.call('jobs', 'executions', 'describe', execution_name)
                    require(any(c.get('type') == 'Completed' and c.get('status') in ('True', 'False')
                                for c in observed.get('status', {}).get('conditions', [])), 'Execution cancellation not confirmed')
                    entry['status'] = 'STOPPED'
                except Exception:
                    self.result['execution_cancel_unconfirmed'] = True
            raise
        finally:
            self.save()

    def database(self, command):
        entry = {'operation': command, 'status': 'STARTED'}
        self.preparation.append(entry)
        self.save()
        try:
            execution = self.execute(self.database_job, '--args=--import,tsx,server/storage/deployment-cli.ts,' + command)
            entry.update(status='PASS', execution=execution.get('metadata', {}).get('name'))
        except (Exception, KeyboardInterrupt):
            entry['status'] = 'FAILED_OR_UNKNOWN'
            raise
        finally:
            self.save()

    def idle_jobs(self, names=None):
        deadline = time.monotonic() + 300
        while True:
            active = []
            for name in (names or JOBS):
                executions = self.cloud.call('jobs', 'executions', 'list', '--job=' + name)
                if not all(any(c.get('type') == 'Completed' and c.get('status') in ('True', 'False')
                               for c in execution.get('status', {}).get('conditions', []))
                           for execution in executions):
                    active.append(name)
            if not active:
                return
            require(time.monotonic() < deadline, 'Old Job executions still active: ' + ', '.join(active))
            time.sleep(2)

    def verify_templates(self):
        for name, original in self.old.items():
            job = name not in SERVICES
            current = self.cloud.call('jobs' if job else 'services', 'describe', name)
            require(config_hash(current, job) == config_hash(original, job), 'Concurrent template change: ' + name)

    def update_job(self, name, key):
        self.verify_templates()
        self.changed_jobs.append(name)
        self.save()
        image = self.manifest['images'][key]
        self.cloud.call('jobs', 'update', name, '--image=' + image)
        current = self.cloud.call('jobs', 'describe', name)
        require(task(current, True)['containers'][0]['image'] == image, 'Job image read-back failed: ' + name)
        self.verify_templates()

    def stop_services(self):
        for name in SERVICES:
            self.cloud.call('services', 'update', name, '--scaling=0')

    def run(self):
        try:
            self.eligible()
            self.preflight()
            require(all(not tags(self.old[name]) for name in SERVICES), 'Remove historical revision tags before maintenance rollout')
            require(all(self.old[name].get('metadata', {}).get('annotations', {}).get('run.googleapis.com/scalingMode') != 'manual'
                        for name in SERVICES), 'Existing manual scaling requires operator recovery first')
            self.inventory()
            for name, key in ((self.database_job, 'runtime_image'), (self.host_job, 'host_image')):
                self.update_job(name, key)
            self.database('check')  # Read-only; schema drift/unknown versions fail before maintenance.
            self.maintenance = True  # Record intent before any ambiguous cloud/database mutation.
            self.result['result'] = 'MAINTENANCE'
            self.save()
            self.database('fence')
            # Let old Workers/Completion/Reconcile finish, including their normal Scheduler deliveries.
            self.database('drain')
            for name in self.schedulers:
                self.scheduler('pause', name)
            self.idle_jobs()
            self.stop_services()
            self.idle_jobs()
            self.database('drain')  # Close the race on first installation (no prior DB fence).
            self.database('seal')
            self.eligible()
            self.execute(self.host_job, '--update-env-vars=AGUI_APPLY_DATABASE_GRANTS=true')
            self.database('migrate')
            self.database('check')
            self.database('seal')  # Also installs the closed state on brand-new schemas.
            self.verify_templates()
            self.database('release')  # Atomic bootstrap/upgrade and activation, all old consumers stopped.
            for name in SERVICES:
                image = self.manifest['images']['host_image' if name == 'hermes-host' else 'runtime_image']
                self.attempted_candidates.append(name)
                self.save()
                self.cloud.call('services', 'update', name, '--image=' + image, '--no-traffic',
                                '--tag=' + TAG, '--no-deploy-health-check', '--update-labels=ci-contract=' + self.contract)
                resource = self.cloud.call('services', 'describe', name)
                revision = resource['status']['latestCreatedRevisionName']
                self.candidates[name] = revision
                self.result['revisions'][name] = revision
                self.save()
                # Maintenance window: select the new revision before waking service instances.
                # Admission remains database-fenced until every service passes smoke.
                self.changed_traffic.append(name)
                self.save()
                self.cloud.call('services', 'update-traffic', name, '--to-revisions=' + revision + '=100')
                self.cloud.call('services', 'update', name, '--scaling=auto')
                resource = self.cloud.call('services', 'describe', name)
                require(traffic(resource) == {revision: 100}, 'Candidate traffic read-back failed')
                candidate = self.cloud.call('revisions', 'describe', revision)
                require(candidate['status']['imageDigest'] == image, 'Candidate digest mismatch')
                require(any(c.get('type') == 'Ready' and c.get('status') == 'True'
                            for c in candidate['status']['conditions']), 'Candidate readiness failed')
                url = next(t['url'] for t in resource['status']['traffic'] if t.get('tag') == TAG)
                self.cloud.smoke(url, resource['status']['url'], '/internal/bots' if name == 'hermes-host' else '/api/bots')
            for name in JOBS:
                self.update_job(name, 'host_image')
            for name in SERVICES:
                self.cloud.call('services', 'update-traffic', name, '--remove-tags=' + TAG)
                current = self.cloud.call('services', 'describe', name)
                require(not tags(current) and traffic(current) == {self.candidates[name]: 100}, 'Final traffic/tag read-back failed')
                self.cloud.smoke(current['status']['url'], current['status']['url'],
                                 '/internal/bots' if name == 'hermes-host' else '/api/bots')
            self.eligible()
            self.verify_templates()
            self.database('resume')
            for name in self.schedulers:
                self.scheduler('resume', name)
            self.result['result'] = 'DEPLOYED'
        except (Exception, KeyboardInterrupt) as error:
            self.result['reason'] = str(error) if isinstance(error, Blocked) else type(error).__name__
            self.result['result'] = 'RECOVERY_REQUIRED' if self.maintenance else 'FAILED_SAFE'
            if self.maintenance:
                # SQL and/or pointer may already have committed. Never advertise image-only rollback.
                for operation in (lambda: self.database('seal'), self.stop_services,
                                  *[lambda name=name: self.scheduler('pause', name) for name in self.schedulers]):
                    try:
                        operation()
                    except Exception:
                        self.result['containment_incomplete'] = True
            self.save()
            raise Blocked(self.result['result']) from None
        finally:
            self.save()
