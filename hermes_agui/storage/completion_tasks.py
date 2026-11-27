"""Bounded ADC-authenticated notification; PostgreSQL remains the work authority."""
import base64
import json
import logging
import os
import re
from urllib.parse import urlsplit


def event_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", value) or int(value) > 2**63 - 1:
        raise ValueError("Invalid completion event ID")
    return int(value)


def validate_token(token):
    if not isinstance(token, str) or not 32 <= len(token) <= 256 or not all(33 <= ord(c) <= 126 for c in token):
        raise ValueError("Invalid completion task token")
    return token


class CompletionTasks:
    def __init__(self, project, location, queue, host_url, service_account, token, credentials):
        for value in (project, location, queue):
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,99}", value):
                raise ValueError("Invalid completion queue configuration")
        url = urlsplit(host_url)
        if url.scheme != 'https' or not url.hostname or url.username or url.port or url.path or url.query or url.fragment:
            raise ValueError("Completion Host URL must be an HTTPS service base URL")
        if not re.fullmatch(r"[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com", service_account):
            raise ValueError("Invalid completion dispatch identity")
        if not service_account.endswith("@" + project + ".iam.gserviceaccount.com"):
            raise ValueError("Dispatch identity must belong to the queue project")
        self.parent = f"projects/{project}/locations/{location}/queues/{queue}"
        self.host_url, self.service_account = host_url, service_account
        self.token, self.credentials = validate_token(token), credentials

    def enqueue(self, identifier):
        import httpx
        from google.auth.transport.requests import Request

        identifier = str(event_id(str(identifier)))
        headers = {}
        # Bound ADC refresh as well as the Tasks API. No retry/thread after the request ends.
        def bounded_request(**kwargs):
            kwargs['timeout'] = 2
            return Request()(**kwargs)
        self.credentials.before_request(bounded_request, 'POST', 'https://cloudtasks.googleapis.com/', headers)
        body = base64.b64encode(json.dumps({'schema': 1, 'eventId': identifier}).encode()).decode()
        task = {'httpRequest': {'httpMethod': 'POST', 'url': self.host_url + '/internal/completions/process',
                'headers': {'Content-Type': 'application/json', 'x-completion-token': self.token},
                'body': body, 'oidcToken': {'serviceAccountEmail': self.service_account, 'audience': self.host_url}},
                'dispatchDeadline': '120s'}
        # Random server-assigned task names permit recovery after a task name tombstone.
        with httpx.Client(timeout=3, trust_env=False) as client:
            response = client.post('https://cloudtasks.googleapis.com/v2/' + self.parent + '/tasks',
                                   headers=headers, json={'task': task})
            response.raise_for_status()

    def notify(self, identifier):
        try:
            self.enqueue(identifier)
        except Exception:  # health: allow BLE001 -- committed work must survive notification failure
            logging.warning('completion_enqueue_failed event_id=%s', identifier)


def load_completion_tasks():
    enabled = os.environ.get('AGUI_COMPLETION_TASKS_ENABLED', 'false')
    if enabled not in {'true', 'false'}:
        raise ValueError('Invalid completion feature flag')
    if enabled == 'false':
        return None
    import google.auth

    credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    return CompletionTasks(*(os.environ['AGUI_COMPLETION_TASKS_' + key] for key in
                             ('PROJECT', 'LOCATION', 'QUEUE', 'HOST_URL', 'SERVICE_ACCOUNT')),
                           os.environ['AGUI_COMPLETION_TASK_TOKEN'], credentials)
