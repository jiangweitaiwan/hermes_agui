"""Hermetic native capability fixtures for the AG-UI host."""

import pytest

from hermes_agui.core import AgentConfig
from tests.fakes.fake_llm_provider import write_hermes_home


@pytest.fixture
def native_config(tmp_path):
    def build(provider, *, name="profile", extra="", toolsets=("memory", "skills")):
        home = write_hermes_home(tmp_path / name, provider.base_url, extra_config=(
            "updates:\n  check: false\nmodels_dev:\n  url: http://127.0.0.1:9/api.json\n" + extra
        ))
        workspace = tmp_path / f"{name}-workspace"
        workspace.mkdir(exist_ok=True)
        return AgentConfig(home=home, cwd=workspace, enabled_toolsets=toolsets,
                           agent_options={"skip_background_review": True, "max_iterations": 5})
    return build
