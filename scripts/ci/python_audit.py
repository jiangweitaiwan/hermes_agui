"""Scan the installed, lockfile-selected Python test environment using an isolated tool."""

import json
import subprocess
import sysconfig
from pathlib import Path

import pm


def validate_report(report: dict) -> None:
    dependencies = report.get("dependencies", [])
    if not any(not item.get("skip_reason") for item in dependencies):
        raise ValueError("Security scan did not audit any dependencies")
    for item in dependencies:
        # The checked-out project has no PyPI advisory identity. Only this local
        # package is exempt; unavailable third-party advisory data blocks CI.
        if item.get("skip_reason") and item.get("name") != "hermes-agent":
            raise ValueError("Security scan skipped a third-party dependency")
        if not item.get("skip_reason") and not isinstance(item.get("vulns"), list):
            raise ValueError("Incomplete security scan record")
        if item.get("vulns"):
            raise ValueError("Known Python dependency advisory")


def main():
    python = pm.ensure_environment("cicd-pip-audit", ["pip-audit==2.9.0"], explicit=True)
    # Any known Python advisory fails. No ignore list or automatic exception.
    result = subprocess.run([str(python), "-m", "pip_audit",
                             "--format=json", "--path", str(Path(sysconfig.get_path("purelib")))],
                            capture_output=True, text=True, timeout=600, check=False)
    # Preserve the scanner result even when validation blocks publication.
    print(result.stdout)
    validate_report(json.loads(result.stdout))
    result.check_returncode()


if __name__ == "__main__":
    main()
