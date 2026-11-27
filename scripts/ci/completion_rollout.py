"""Reviewable first-activation delta; all other template drift remains forbidden."""
import json
import os
from copy import deepcopy
from scripts.ci.llm_rollout import require, task


def prepare_completion(rollout):
    host_env = {e['name']: e for e in task(rollout.old['hermes-host'])['containers'][0].get('env', [])}
    activation = json.loads(os.environ.get('LLM_COMPLETION_CONFIG') or '{}')
    rollout.host_options = []
    rollout.host_expected = deepcopy(rollout.old['hermes-host'])
    if activation:
        from hermes_agui.storage.completion_tasks import CompletionTasks
        import re
        keys = {'project', 'location', 'queue', 'host_url', 'service_account', 'token_secret', 'token_version'}
        require(set(activation) == keys, 'Invalid first-activation configuration keys')
        CompletionTasks(*(activation[k] for k in ('project','location','queue','host_url','service_account')), 'x'*32, None)
        require(activation['host_url'] == rollout.old['hermes-host']['status']['url'], 'Completion Host URL mismatch')
        require(activation['queue'] in rollout.queues.names and activation['project'] == rollout.cloud.project and activation['location'] == rollout.cloud.region, 'Completion queue coordinates mismatch')
        require(re.fullmatch(r'[a-zA-Z0-9_-]+', activation['token_secret']) and re.fullmatch(r'[1-9][0-9]*', str(activation['token_version'])), 'Pinned completion secret required')
        changes = {'AGUI_COMPLETION_TASKS_ENABLED': {'value':'true'}}
        for k in ('project','location','queue','host_url','service_account'):
            changes['AGUI_COMPLETION_TASKS_' + k.upper()] = {'value':activation[k]}
        changes['AGUI_COMPLETION_TASK_TOKEN'] = {'valueFrom':{'secretKeyRef':{'name':activation['token_secret'], 'key':str(activation['token_version'])}}}
        changes.update(graph_destination(rollout))
        host_env.update({k:{'name':k, **v} for k,v in changes.items()})
        task(rollout.host_expected)['containers'][0]['env'] = list(host_env.values())
        rollout.host_options = ['--update-env-vars=' + ','.join(k+'='+v['value'] for k,v in changes.items() if 'value' in v),
            '--update-secrets=' + ','.join(k+'='+v['valueFrom']['secretKeyRef']['name']+':'+str(v['valueFrom']['secretKeyRef']['key']) for k,v in changes.items() if 'valueFrom' in v)]
    require(host_env.get('AGUI_COMPLETION_TASKS_ENABLED', {}).get('value') == 'true',
            'First activation requires reviewed Host revision configuration; image-only rollout refuses implicit activation')
    required = ['PROJECT', 'LOCATION', 'QUEUE', 'HOST_URL', 'SERVICE_ACCOUNT']
    require(all(host_env.get('AGUI_COMPLETION_TASKS_' + k, {}).get('value') for k in required),
            'Completion feature configuration missing')
    token = host_env.get('AGUI_COMPLETION_TASK_TOKEN', {}).get('valueFrom', {}).get('secretKeyRef', {})
    require(str(token.get('key', '')).isdigit(), 'Completion secret must use a fixed version')
    rollout.result['completion_feature'] = {k: host_env['AGUI_COMPLETION_TASKS_' + k]['value'] for k in required}


def graph_destination(rollout):
    env = {e['name']:e for e in task(rollout.old['hermes-completion'],True)['containers'][0].get('env',[])}
    binding = env.get('AGUI_GRAPH_COMPLETION_TOKEN',{}).get('valueFrom',{}).get('secretKeyRef',{})
    require(binding.get('name') and str(binding.get('key','')).isdigit(), 'Completion Job Graph credential must use a fixed Secret version')
    url = rollout.old['hermes-runtime']['status']['url']
    return {'AGUI_GRAPH_COMPLETION_URL':{'value':url+'/internal/graph/completions'},
            'AGUI_GRAPH_COMPLETION_AUDIENCE':{'value':url},
            'AGUI_GRAPH_COMPLETION_TOKEN':{'valueFrom':{'secretKeyRef':deepcopy(binding)}}}
