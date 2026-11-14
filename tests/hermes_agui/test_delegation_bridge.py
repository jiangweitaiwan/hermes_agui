"""Tool results preserve explicit coordinator refusal and transport outcomes."""

import asyncio

import httpx
import pytest

from hermes_agui.delegation import DelegationConfig, _request


@pytest.mark.asyncio
@pytest.mark.parametrize(('outcome', 'expected'), [
    (403, 'denied'), (422, 'invalid_request'), (503, 'unavailable'),
    ('deadline', 'timeout'), ('connection', 'unavailable'),
])
async def test_bridge_preserves_error_contract(monkeypatch, outcome, expected):
    client_type = httpx.AsyncClient

    async def respond(request):
        assert request.headers['authorization'] == 'Bearer source-token'
        if outcome == 'deadline':
            raise httpx.ReadTimeout('private transport details')
        if outcome == 'connection':
            raise httpx.ConnectError('private transport details')
        return httpx.Response(outcome, json={'status': 'private transport details'})

    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: client_type(
        **kwargs, transport=httpx.MockTransport(respond)))
    result = await _request(DelegationConfig('http://127.0.0.1/internal/delegations', 'internal'),
                            'source-token', {'task': 'short'}, asyncio.Event())
    assert result == {'status': expected}
