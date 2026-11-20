"""Re-run the accepted Part 1 storage scenario on current images; preserve prior tags."""
import os
from pathlib import Path
import subprocess

root = Path.cwd()
evidence = root / "artifacts/part2-final-local-20261120"
previous = {}
tags = ("hermes-agui:part1", "hermes-runtime:part1", "hermes-agui:part1-test")


def docker(*args, check=True):
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check, timeout=180)


for tag in tags:
    result = docker("image", "inspect", "--format", "{{.Id}}", tag, check=False)
    previous[tag] = result.stdout.strip() if result.returncode == 0 else None
try:
    docker("tag", "hermes-agui:part2", tags[0])
    docker("tag", "hermes-runtime:part2", tags[1])
    with (evidence / "legacy-fixture-build.log").open("w") as output:
        subprocess.run(["docker", "build", "-f", "Dockerfile.agui.part1-test", "-t", tags[2], "."],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)
    with (evidence / "legacy-restart.log").open("w") as output:
        result = subprocess.run(["scripts/run_tests.sh", "-j", "1", "--file-timeout", "900",
                                 "tests/hermes_agui/test_cloud_native_restart.py", "-m", "integration", "-k", "dual_container_restart"],
                                stdout=output, stderr=subprocess.STDOUT, env={**os.environ, "HERMES_TEST_FILE_RETRIES": "0"},
                                check=False, timeout=1020)
    (evidence / "legacy-restart-exit.txt").write_text(str(result.returncode) + "\n")
    print("Legacy container restart exit:", result.returncode, flush=True)
finally:
    for tag in reversed(tags):
        if previous[tag]:
            docker("tag", previous[tag], tag)
        else:
            docker("image", "rm", tag, check=False)
