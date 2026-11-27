"""Event notifications never replace the durable work/lease authority."""
from types import SimpleNamespace
from unittest.mock import Mock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_agui.storage.completion_tasks import CompletionTasks, event_id
from hermes_agui.storage.completion_http import mount_completion, _process as process
from hermes_agui.storage.completion_delivery import drain


@pytest.mark.parametrize('value', ['0', '-1', 1, True, '01', '1.0', str(2**63), '1'*100])
def test_reject_invalid_event_id(value):
    with pytest.raises(ValueError):
        event_id(value)


def test_bigint_preserves_precision():
    assert event_id(str(2**63-1)) == 2**63-1


@pytest.mark.parametrize('state,expected', [(None,204), ('delivered',204), ('failed',204), ('pending',503), ('leased',503)])
def test_unclaimed_event_is_not_false_ack(state, expected):
    outbox = Mock()
    outbox.claim.return_value = None
    outbox.state.return_value = state
    assert process(outbox, Mock(), 7) == expected
    outbox.claim.assert_called_once_with(seconds=180, event_id=7)


def test_ack_loss_and_http_failure_retry():
    outbox, dispatcher = MagicMock(), Mock()
    event = SimpleNamespace(id=7, attempt=2)
    outbox.claim.return_value = event
    outbox.acknowledge.return_value = False
    assert process(outbox, dispatcher, 7) == 503
    dispatcher.deliver.side_effect = TimeoutError
    assert process(outbox, dispatcher, 7) == 503
    outbox.retry.assert_called_once_with(event, seconds=4)


def test_db_failure_is_not_swallowed():
    outbox = Mock()
    outbox.claim.side_effect = RuntimeError('unavailable')
    with pytest.raises(RuntimeError):
        process(outbox, Mock(), 7)


def test_drain_empty_batch_and_individual_failure():
    outbox, dispatcher = MagicMock(), Mock()
    outbox.claim.return_value = None
    assert drain(outbox, dispatcher)['claimed'] == 0
    outbox.claim.side_effect = [SimpleNamespace(id=i, attempt=1) for i in range(101)]
    dispatcher.deliver.side_effect = [TimeoutError()] + [None]*99
    result = drain(outbox, dispatcher)
    assert result == {'claimed':100, 'delivered':99, 'retry':1, 'budget_exhausted':True}
    assert outbox.retry.call_count == 1


def test_drain_time_budget():
    outbox = MagicMock()
    result = drain(outbox, Mock(), clock=Mock(side_effect=[0, 121]))
    assert result['budget_exhausted']
    outbox.claim.assert_not_called()


def test_endpoint_auth_and_malformed():
    app = FastAPI()
    mount_completion(app, SimpleNamespace(completion_tasks=SimpleNamespace(token='x'*32)))
    client = TestClient(app)
    assert client.post('/internal/completions/process', json={}).status_code == 401
    headers = {'x-completion-token':'x'*32}
    for value in ({}, {'schema': True, 'eventId':'1'}, {'schema':1,'eventId':1}, {'schema':2,'eventId':'1'}):
        assert client.post('/internal/completions/process', headers=headers, json=value).status_code == 400
    assert client.post('/internal/completions/process', headers=headers, content='x'*1025).status_code == 400
    assert client.get('/internal/completions/process', headers=headers).status_code == 405


def test_notification_failure_keeps_success_and_redacts(caplog):
    producer = CompletionTasks('project', 'region', 'queue', 'https://host.run.app',
        'dispatch@project.iam.gserviceaccount.com', 'x'*32, Mock())
    producer.enqueue = Mock(side_effect=RuntimeError('secret-value'))
    assert producer.notify(7) is None
    assert 'event_id=7' in caplog.text and 'secret-value' not in caplog.text


def test_enqueue_payload_and_timeout(monkeypatch):
    import base64
    import json
    import httpx
    from unittest.mock import patch

    credentials = Mock()
    producer = CompletionTasks('project', 'asia-east1', 'completion', 'https://host.run.app',
        'dispatch@project.iam.gserviceaccount.com', 'x'*32, credentials)
    # A fake transport exercises real REST serialization, without GCP credentials.
    captured = []
    def receive(request):
        captured.append(request)
        return httpx.Response(200, json={})
    client = httpx.Client(transport=httpx.MockTransport(receive))
    with patch('httpx.Client', return_value=client):
        producer.enqueue(2**63-1)
    task = json.loads(captured[0].content)['task']
    assert json.loads(base64.b64decode(task['httpRequest']['body'])) == {'schema':1, 'eventId':str(2**63-1)}
    assert 'name' not in task
    assert task['httpRequest']['oidcToken']['audience'] == 'https://host.run.app'
