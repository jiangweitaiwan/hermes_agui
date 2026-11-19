"""Exercise the production image commands with read-only roots and explicit ports."""
import subprocess
from uuid import uuid4

from tests.hermes_agui.cloud_native_scenario import docker
from tests.waiting import wait_until


def production_image_smoke():
    prefix = "agui-part1-smoke-" + uuid4().hex[:12]
    host_probe = "import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:8137/health', timeout=2).status == 200"
    runtime_probe = "const r = await fetch('http://127.0.0.1:3137/api/bots'); if(r.status !== 200 || !(await r.json()).includes('hermes')) process.exit(1)"
    for service, image, environment, command, probe in (
        ("host", "hermes-agui:part1", ["-e", "AGUI_API_KEY=fixture-smoke-only", "-e", "HERMES_HOME=/scratch"],
         ["--home", "/scratch", "--cwd", "/scratch", "--host", "0.0.0.0", "--port", "8137"], ["python", "-c", host_probe]),
        ("runtime", "hermes-runtime:part1", ["-e", "PORT=3137"], [], ["node", "--input-type=module", "-e", runtime_probe]),
    ):
        name = prefix + "-" + service
        docker("run", "-d", "--name", name, "--read-only", "--tmpfs", "/scratch:uid=10000,gid=10000,mode=700",
               "--tmpfs", "/tmp:mode=1777", *environment, image, *command)
        try:
            def ready():
                assert docker("inspect", "--format", "{{.State.Running}}", name) == "true", docker("logs", name)
                result = subprocess.run(["docker", "exec", name, *probe], capture_output=True, text=True, timeout=10, check=False)
                return result.returncode == 0

            wait_until(ready, timeout=60, interval=0.2, what=service + " production entrypoint")
            print(service, "production command/configured port/read-only root: PASS", flush=True)
        finally:
            print(docker("logs", name), flush=True)
            docker("rm", "-fv", name)

    for image, environment, expected in (
        ("hermes-agui:part1", [], "Set the AGUI_API_KEY secret"),
        ("hermes-runtime:part1", ["-e", "PORT=invalid"], "Invalid PORT"),
    ):
        result = subprocess.run(["docker", "run", "--rm", "--read-only", "--tmpfs", "/tmp:mode=1777",
                                 *environment, image], capture_output=True, text=True, timeout=60, check=False)
        assert result.returncode != 0, "Missing configuration must fail closed"
        assert expected in result.stdout + result.stderr, result.stdout + result.stderr
        print(image, "missing/invalid configuration fail-fast: PASS", flush=True)
