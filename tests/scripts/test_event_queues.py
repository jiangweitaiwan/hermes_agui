"""Queue state transitions require independent read-back; task deletion is never needed."""
from unittest.mock import Mock
import pytest
from scripts.ci.event_queues import QueueControl
from scripts.ci.llm_rollout import Blocked


def test_inventory_must_be_exact_and_explicit():
    for names in (None, [], ['one'], ['one','one'], ['../one','two']):
        with pytest.raises(Blocked):
            QueueControl('project','region',names,[])


def test_pause_and_resume_readback():
    evidence = []
    queues = QueueControl('project','region',['completion','graph'], evidence)
    states = {'completion':'RUNNING', 'graph':'RUNNING'}
    def call(action, name):
        if action == 'pause':
            states[name] = 'PAUSED'
        elif action == 'resume':
            states[name] = 'RUNNING'
        return {'state': states[name]}
    queues.call = Mock(side_effect=call)
    queues.verify('RUNNING')
    queues.transition('pause')
    assert set(states.values()) == {'PAUSED'}
    queues.transition('resume')
    assert set(states.values()) == {'RUNNING'}
    assert all(any(e['queue']==name and e['operation']=='pause' and e['state']=='PAUSED' for e in evidence) for name in states)


def test_transition_does_not_trust_mutation_response():
    queues = QueueControl('project','region',['completion','graph'], [])
    queues.call = Mock(return_value={'state':'RUNNING'})
    with pytest.raises(Blocked):
        queues.transition('pause')
