"""Explicit queue inventory. Never purge tasks or infer arbitrary producers from metadata."""
import json
import re
import subprocess
from scripts.ci.llm_rollout import require


class QueueControl:
    def __init__(self, project, location, names, evidence):
        require(isinstance(names, list) and len(names) == 2 and len(set(names)) == 2,
                'Explicit two-queue inventory required')
        require(all(isinstance(n, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', n) for n in names),
                'Invalid queue inventory')
        self.project, self.location, self.names, self.evidence = project, location, names, evidence

    def call(self, action, name):
        result = subprocess.run(['gcloud', 'tasks', 'queues', action, name,
            '--project=' + self.project, '--location=' + self.location, '--format=json', '--quiet'],
            capture_output=True, text=True, timeout=30, check=False)
        require(result.returncode == 0, 'Queue ' + action + ' failed: ' + name)
        return json.loads(result.stdout or '{}')

    def verify(self, expected):
        for name in self.names:
            state = self.call('describe', name).get('state')
            self.evidence.append({'queue': name, 'operation': 'describe', 'state': state})
            require(state == expected, 'Unexpected queue state: ' + name)

    def transition(self, action):
        desired = 'PAUSED' if action == 'pause' else 'RUNNING'
        for name in self.names:
            self.evidence.append({'queue': name, 'operation': action, 'state': 'REQUESTED'})
            if self.call('describe', name).get('state') != desired:
                self.call(action, name)
            state = self.call('describe', name).get('state')
            self.evidence.append({'queue': name, 'operation': action, 'state': state})
            require(state == desired, 'Queue transition read-back failed: ' + name)
