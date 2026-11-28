"""Fake GCP state machine contracts for clean order and containment."""
from copy import deepcopy
import json
from unittest.mock import Mock
import pytest
from scripts.ci.clean_rollout import CleanRollout
from scripts.ci.llm_rollout import Blocked, JOBS, SERVICES, task
from tests.scripts.test_llm_image_rollout import FakeCloud, FixtureRollout, NEW, RUNTIME


class MemoryJournal:
    records = {}
    def __init__(self, bucket, operation, token):
        self.operation = operation
        self.generation = 0
    def write(self, value):
        if self.generation == 0 and self.operation in self.records:
            raise Blocked('existing intent')
        self.records[self.operation] = deepcopy(value)
        self.generation += 1
    def read(self):
        self.generation = 1
        return deepcopy(self.records[self.operation])


class CleanCloud(FakeCloud):
    def __init__(self, failure=None):
        super().__init__(failure)
        self.project, self.region = 'copilotkit-agui', 'asia-east1'
        for n in SERVICES + tuple(JOBS):
            spec = task(self.resources[n], n in JOBS)
            spec['serviceAccountName'] = 'old@copilotkit-agui.iam.gserviceaccount.com'
            spec['containers'][0].setdefault('env', []).append({'name':'AGUI_HOST_DATABASE_URL', 'valueFrom':{'secretKeyRef':{'name':'old-dsn','key':'1'}}})
        self.old_capability_queries = 0
    def call(self, kind, action, name, *args):
        if action == 'update':
            if kind == 'services':
                for arg in args:
                    if arg.startswith('--scaling='):
                        scaling=arg.split('=')[1]
                        annotations=self.resources[name]['metadata'].setdefault('annotations', {})
                        annotations['run.googleapis.com/scalingMode']='manual' if scaling=='0' else 'automatic'
                        annotations['run.googleapis.com/manualInstanceCount']='0'
            spec = task(self.resources[name], kind == 'jobs')
            for arg in args:
                if arg.startswith('--service-account='):
                    spec['serviceAccountName'] = arg.split('=',1)[1]
                if arg.startswith('--update-secrets='):
                    env = {e['name']: e for e in spec['containers'][0].get('env', [])}
                    for binding in arg.split('=',1)[1].split(','):
                        key, value = binding.split('='); secret, version = value.split(':')
                        env[key] = {'name':key,'valueFrom':{'secretKeyRef':{'name':secret,'key':version}}}
                    spec['containers'][0]['env'] = list(env.values())
                if arg.startswith('--task-timeout='):
                    spec['timeoutSeconds'] = int(arg.split('=')[1])
        return super().call(kind, action, name, *args)
    def capabilities(self, url):
        if not any(c[0:2] == ('services','update') and any(a.startswith('--image=') for a in c[3]) for c in self.calls):
            self.old_capability_queries += 1
            return {}
        return {'completionFence':1,'graphFence':1}


class FixtureClean(CleanRollout):
    scheduler = FixtureRollout.scheduler
    def bindings(self):
        super().bindings()
    secret_denied = Mock()
    account_ready = Mock()
    verify_journal_boundary = Mock()
    verify_authority_boundary = Mock()
    clean_inventory = Mock()


def setup(tmp_path, monkeypatch, failure=None, recovery='', existing_cloud=None):
    monkeypatch.setattr('scripts.ci.clean_rollout.Journal', MemoryJournal)
    for key, value in dict(GITHUB_RUN_ID='100' if not recovery else '101', CLEAN_RECOVERY_OPERATION=recovery,
        CLEAN_SQL_INSTANCE='copilotkit-agui:asia-east1:existing', CLEAN_JOURNAL_BUCKET='fixture-bucket',
        GCP_DEPLOY_SERVICE_ACCOUNT='ci@copilotkit-agui.iam.gserviceaccount.com', LLM_MANAGED_PRODUCERS_CONFIRMED='true').items():
        monkeypatch.setenv(key,value)
    cloud=existing_cloud or CleanCloud(failure)
    # Reuse the real rolling fixture's authenticated Scheduler/Completion inventory.
    if existing_cloud is None:
        FixtureRollout(cloud,tmp_path/'unused.json')
    if existing_cloud is None:
        task(cloud.resources['hermes-host'])['containers'][0]['env'].append({'name':'AGUI_HOST_DATABASE_URL','valueFrom':{'secretKeyRef':{'name':'old-dsn','key':'1'}}})
    bindings={n:{'service_account':'new@copilotkit-agui.iam.gserviceaccount.com',
                    'secrets':{'AGUI_HOST_DATABASE_URL':{'name':'new-dsn','version':'1'}}} for n in SERVICES+tuple(JOBS)}
    monkeypatch.setenv('CLEAN_APPLICATION_BINDINGS',json.dumps(bindings))
    rollout=FixtureClean(cloud,{'phase':'BUILT','commit':'a'*40,'images':{'host_image':NEW,'runtime_image':RUNTIME},'policy':{'contract':'a'*64},'offline_ci':{}},
        tmp_path/'report.json',Mock(),database_job='database-prepare',host_job='host-migrate',
        schedulers=['completion','reconcile','worker'],queues=['completion','graph'])
    task(cloud.resources['database-prepare'],True)['containers'][0]['env']=[{'name':'AGUI_CLEAN_HOST_URL','valueFrom':{'secretKeyRef':{'name':'new-dsn','key':'1'}}}, {'name':'AGUI_OLD_HOST_URL','valueFrom':{'secretKeyRef':{'name':'old-dsn','key':'1'}}}]
    for prep_name in ('database-prepare','host-migrate'):
        task(cloud.resources[prep_name],True)['serviceAccountName']='prep@copilotkit-agui.iam.gserviceaccount.com'
    rollout.paused=set();rollout.queues=Mock()
    return cloud,rollout


@pytest.fixture(autouse=True)
def clear_journal():
    MemoryJournal.records.clear()


def test_clean_skips_old_capabilities_drift_and_drain_then_uses_shared_candidates(tmp_path,monkeypatch):
    cloud,rollout=setup(tmp_path,monkeypatch)
    try:
        rollout.run()
    except Blocked:
        pytest.fail(str(rollout.result))
    assert rollout.result['result']=='DEPLOYED'
    assert cloud.old_capability_queries==0
    commands=cloud.database_commands
    assert 'drain' not in commands and 'fence' not in commands
    assert commands.index('isolate') < commands.index('reset-host') < commands.index('host-migrate') < commands.index('migrate') < commands.index('release') < commands.index('resume')
    assert task(cloud.resources['hermes-completion'],True)['timeoutSeconds']>=300
    with pytest.raises(Blocked):
        setup(tmp_path,monkeypatch)[1].run()
    assert MemoryJournal.records['100']['result']=='DEPLOYED'


@pytest.mark.parametrize('failure',['reset-host','reset-runtime','host-migrate','migrate','seal','epoch','release','smoke','resume'])
def test_each_failed_clean_stage_contains_without_old_image_rollback(tmp_path,monkeypatch,failure):
    cloud,rollout=setup(tmp_path,monkeypatch,failure)
    with pytest.raises(Blocked): rollout.run()
    assert rollout.result['result']=='RECOVERY_REQUIRED'
    assert rollout.paused==set(rollout.schedulers)
    assert all(cloud.resources[n]['scaling']=='0' for n in SERVICES)
    assert 'drain' not in cloud.database_commands
    assert any(e['operation'].startswith('reset-') for e in rollout.preparation)
    assert MemoryJournal.records['100']['result']=='RECOVERY_REQUIRED'


def test_forward_recovery_uses_same_operation_and_original_manifest(tmp_path,monkeypatch):
    cloud,failed=setup(tmp_path,monkeypatch,'migrate')
    with pytest.raises(Blocked): failed.run()
    epoch=failed.intent['epoch']
    cloud.failure=None
    _,recovery=setup(tmp_path,monkeypatch,recovery='100',existing_cloud=cloud)
    recovery.run()
    assert recovery.result['result']=='DEPLOYED'
    assert recovery.intent['epoch']==epoch and recovery.intent['operation']=='100'
    assert 'recovery-check' in cloud.database_commands
    with pytest.raises(Blocked,match='Successful reset'):
        setup(tmp_path,monkeypatch,recovery='100',existing_cloud=cloud)
