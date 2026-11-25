"""Real native Host; only vendor credentials/HTTP safety transport are replaced by local wire fixtures."""
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
import httpx
import uvicorn
from hermes_agui.core.managed_llm import ready_host
from hermes_agui.management import ManagementConfig
from hermes_agui.provisioner import ProvisionTemplate
from hermes_agui.server import create_host
from tests.fakes.fake_llm_provider import FakeLLMServer, Text, write_hermes_home
from utils import load_yaml_file_readonly


def main():
    raw = json.loads(Path(sys.argv[1]).read_text())
    root = Path(raw['root'])
    policy = raw['hostPolicy']
    ready_host(policy)
    with FakeLLMServer(lambda record: Text('Managed native answer.')) as wire:
        home = write_hermes_home(root / 'fixture-home', wire.base_url,
            extra_config='updates:\n  check: false\nmodels_dev:\n  url: http://127.0.0.1:9/api.json\n')
        template = ProvisionTemplate(llm_registry=raw['llm'], llm_control=policy,
            config=load_yaml_file_readonly(home / 'config.yaml'), toolsets=('todo',),
            agent_options={'skip_background_review': True, 'max_iterations': 2})
        app = create_host([], management=ManagementConfig(root / 'native-bots', 'fixture-manager', {'native': template}))

        @app.get('/__test/requests')
        async def requests():
            return wire.main_requests()

        # This test never invokes ADC or a public endpoint. Production safety is tested separately.
        with patch('agent.vertex_adapter.get_vertex_credentials', return_value=('fixture-token', 'hermes-test')), \
             patch('agent.vertex_adapter.has_vertex_credentials', return_value=True), \
             patch('agent.vertex_adapter.build_vertex_base_url', return_value=wire.base_url), \
             patch('tools.url_safety.create_ssrf_safe_client', side_effect=lambda **kwargs: httpx.Client()):
            uvicorn.run(app, host='127.0.0.1', port=3042, log_level='warning')


if __name__ == '__main__':
    main()
