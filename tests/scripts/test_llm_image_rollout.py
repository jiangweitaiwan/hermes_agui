"""Candidate artifact completeness and fail-closed Cloud Run rollout contracts."""

import json
import os
import subprocess
from pathlib import Path

import pytest

from scripts.ci.llm_build_outputs import resolve_images


PREFIX = "asia-east1-docker.pkg.dev/copilotkit-agui/hermes"
DIGEST = "sha256:" + "a" * 64


def test_only_complete_successful_builds_produce_deployable_digests():
    build = {"status": "SUCCESS", "results": {"images": [
        {"name": f"{PREFIX}/hermes-host:commit", "digest": DIGEST},
        {"name": f"{PREFIX}/hermes-runtime:commit", "digest": DIGEST},
    ]}}
    assert resolve_images(build, PREFIX) == {
        "host_image": f"{PREFIX}/hermes-host@{DIGEST}",
        "runtime_image": f"{PREFIX}/hermes-runtime@{DIGEST}",
    }
    build["results"]["images"].pop()
    with pytest.raises(ValueError, match="Missing or ambiguous"):
        resolve_images(build, PREFIX)
    build["status"] = "FAILURE"
    with pytest.raises(ValueError, match="did not succeed"):
        resolve_images(build, PREFIX)


@pytest.mark.platforms("linux", "macos")
@pytest.mark.parametrize("fail_host", [False, True])
def test_rollout_waits_for_all_candidates_before_switching_traffic(tmp_path, fail_host):
    executable = tmp_path / "gcloud"
    executable.write_text("""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
service = args[3]
if args[2] == 'update':
    if service == 'hermes-host' and os.environ['FAIL_HOST'] == '1':
        sys.exit(1)
    print(service + '-candidate')
elif args[2] == 'describe':
    print(service + '-candidate' if 'value(status.latestCreatedRevisionName)' in str(args) else service)
""", encoding="utf-8")
    executable.chmod(0o755)
    log = tmp_path / "calls.jsonl"
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "CALL_LOG": str(log),
           "FAIL_HOST": "1" if fail_host else "0", "GCP_PROJECT_ID": "copilotkit-agui",
           "GCP_BUILD_REGION": "asia-east1", "HOST_IMAGE": f"{PREFIX}/hermes-host@{DIGEST}",
           "RUNTIME_IMAGE": f"{PREFIX}/hermes-runtime@{DIGEST}"}
    script = Path(__file__).resolve().parents[2] / "scripts/ci/deploy_llm_cloud_run.sh"
    result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True, check=False)
    calls = [json.loads(line) for line in log.read_text(encoding="utf-8-sig").splitlines()]
    updates = [call[3] for call in calls if call[2] == "update"]
    traffic = [call for call in calls if call[2] == "update-traffic"]
    assert updates == (["hermes-runtime", "hermes-host"] if fail_host else
                       ["hermes-runtime", "hermes-host", "hermes-worker"])
    if fail_host:
        assert result.returncode != 0
        assert traffic == []
    else:
        assert result.returncode == 0, result.stderr
        assert [call[3] for call in traffic] == updates
        assert calls.index(traffic[0]) > max(i for i, call in enumerate(calls) if call[2] == "update")
