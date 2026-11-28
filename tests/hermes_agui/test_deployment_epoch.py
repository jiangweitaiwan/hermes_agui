"""Old ID collisions are classified before looking up new work."""
from uuid import uuid4
import pytest
from hermes_agui.storage.epoch import payload_status


def test_generation_collision_and_rolling_compatibility():
    old, current = str(uuid4()), str(uuid4())
    legacy = {'schema': 1, 'eventId': '1'}
    assert payload_status(legacy, None, 'eventId') == 'current'
    assert payload_status(legacy, current, 'eventId') == 'stale'
    assert payload_status(dict(schema=2, epoch=old, eventId='1'), current, 'eventId') == 'stale'
    assert payload_status(dict(schema=2, epoch=current, eventId='1'), current, 'eventId') == 'current'
    with pytest.raises(ValueError):
        payload_status(dict(schema=2, epoch=current, eventId='1'), None, 'eventId')


@pytest.mark.parametrize('payload', [dict(schema=True,eventId='1'), dict(schema=3,eventId='1'),
    dict(schema=2,epoch='bad',eventId='1'), dict(schema=1,eventId='1',epoch='bad')])
def test_malformed_is_not_stale(payload):
    with pytest.raises(ValueError):
        payload_status(payload, str(uuid4()), 'eventId')
