"""Authorization and crash-safe journal contracts, without GCP mutations."""
from unittest.mock import Mock
import json
import pytest
from scripts.ci.clean_bootstrap import authorize, Journal
from scripts.ci.llm_rollout import Blocked


def valid():
    return dict(GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REF='refs/heads/main',
                DEPLOYMENT_MODE='clean-bootstrap', DEPLOY_REQUESTED='true', AUTO_DEPLOY_ENABLED='true',
                CONFIRM_RESET='RESET copilotkit-agui/hermes', GCP_PROJECT_ID='copilotkit-agui',
                GCP_BUILD_REGION='asia-east1', CLEAN_APPROVAL_VERIFIED='true', GITHUB_RUN_ATTEMPT='1')


@pytest.mark.parametrize('key,value', [('GITHUB_REF', 'refs/heads/topic'), ('CONFIRM_RESET', ''),
    ('GCP_PROJECT_ID', 'other'), ('GCP_BUILD_REGION', 'other'), ('DEPLOY_REQUESTED', 'false'),
    ('AUTO_DEPLOY_ENABLED', 'false'), ('CLEAN_APPROVAL_VERIFIED', 'false'), ('GITHUB_RUN_ATTEMPT', '2')])
def test_invalid_reset_never_reaches_cloud(key, value):
    env = valid(); env[key] = value
    with pytest.raises(Blocked):
        authorize(env)


def test_push_preserves_data_even_with_clean_inputs():
    env = valid(); env['GITHUB_EVENT_NAME'] = 'push'
    assert authorize(env) == 'rolling-upgrade'
    assert authorize(valid()) == 'clean-bootstrap'


def test_journal_writes_have_generation_preconditions(monkeypatch):
    calls = []
    def upload(request, **kwargs):
        calls.append(request)
        result = Mock()
        result.__enter__ = Mock(return_value=result)
        result.__exit__ = Mock(return_value=False)
        result.read.return_value = json.dumps({'generation': str(42 + len(calls))}).encode()
        return result
    monkeypatch.setattr('scripts.ci.clean_bootstrap.urlopen', upload)
    journal = Journal('fixture-bucket', '123', lambda: 'fixture')
    journal.write({'phase': 'INTENT'})
    journal.write({'phase': 'MAINTENANCE_INTENT'})
    assert 'ifGenerationMatch=0' in calls[0].full_url
    assert 'ifGenerationMatch=43' in calls[1].full_url


def test_clean_completion_preserves_authenticated_destination():
    from scripts.ci.completion_rollout import clean_completion_args
    args = clean_completion_args(['-m','hermes_agui.storage.completion_delivery','--once',
                                  '--audience','https://runtime.run.app','--prefix','profiles','--max-events=1'])
    assert args == ['-m','hermes_agui.storage.completion_delivery','--audience','https://runtime.run.app',
                    '--prefix','profiles','--drain','--max-events','100','--max-seconds','120']


def test_job_execution_cloudsql_annotations_are_not_confused_with_task_annotations():
    from scripts.ci.clean_bootstrap import cloudsql_bindings
    resource = {'spec':{'template':{'metadata':{'annotations':{'run.googleapis.com/cloudsql-instances':'project:region:db'}},'spec':{'template':{'spec':{'containers':[]}}}}}}
    assert cloudsql_bindings(resource) == {'project:region:db'}


def test_environment_review_must_be_independent(monkeypatch):
    from scripts.ci.clean_bootstrap import verify_approval
    env = dict(valid(), GITHUB_REPOSITORY='fixture/repo', GITHUB_RUN_ID='123', GITHUB_ACTOR='operator')
    env.pop('CLEAN_APPROVAL_VERIFIED')
    review = [{'state':'approved','user':{'login':'operator'},'environments':[{'name':'llm-deploy'}]}]
    monkeypatch.setattr('scripts.ci.clean_bootstrap.subprocess.check_output', lambda *a, **k: json.dumps(review))
    with pytest.raises(Blocked):
        verify_approval(env)
    review[0]['user']['login'] = 'reviewer'
    verify_approval(env)
    assert env['CLEAN_APPROVAL_VERIFIED'] == 'true'


def test_journal_rejects_existing_or_concurrently_changed_generation(monkeypatch):
    from urllib.error import HTTPError
    def conflict(*args, **kwargs):
        raise HTTPError('https://storage.googleapis.com/', 412, 'precondition', {}, None)
    monkeypatch.setattr('scripts.ci.clean_bootstrap.urlopen', conflict)
    journal = Journal('fixture-bucket', '123', lambda: 'fixture')
    with pytest.raises(Blocked, match='recovery required'):
        journal.write({'phase': 'INTENT'})
    assert journal.generation == 0
