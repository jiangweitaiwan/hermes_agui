"""Three real image entrypoints with real PG17 roles and startup-only SDK doubles."""
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from uuid import uuid4

import httpx
import psycopg
from psycopg import sql
from tests.waiting import wait_until

ROOT = Path.cwd()
EVIDENCE = ROOT / "artifacts/part2-final-local-20261120"
PG = "hermes-part2-local-pg-20261120"
OWNER = "postgresql://postgres:local-acceptance-only@127.0.0.1:55432/postgres"
PASSWORD = "local-startup-only"
TOKEN = "local-worker-business-credential-32-characters"


def docker(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=180, check=False)
    if check:
        assert result.returncode == 0, result.stdout + result.stderr
    return result


def main():
    prefix = "part2-startup-" + uuid4().hex[:10]
    database = "startup_" + uuid4().hex
    with psycopg.connect(OWNER, autocommit=True, connect_timeout=5) as owner:
        owner.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
        for role in ("hermes_host", "hermes_runtime"):
            if not owner.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone():
                owner.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(role), sql.Literal(PASSWORD)))
    docker("network", "create", prefix)
    names = []
    try:
        docker("network", "connect", "--alias", "postgres", prefix, PG)
        owner_url = f"postgresql://postgres:local-acceptance-only@postgres/{database}"
        for image, variable, executable, command in (
            ("hermes-agui:part2", "AGUI_HOST_DATABASE_URL", "python", ["-m", "hermes_agui.storage.migrate"]),
            ("hermes-runtime:part2", "AGUI_RUNTIME_DATABASE_URL", "node", ["--import", "tsx", "server/storage/migrate-cli.ts"]),
        ):
            result = docker("run", "--rm", "--network", prefix, "-e", f"{variable}={owner_url}", "--entrypoint", executable, image, *command)
            print("Image migration:", image, result.stdout, flush=True)
        with psycopg.connect(OWNER.removesuffix("/postgres") + "/" + database, connect_timeout=5) as owner:
            owner.execute((ROOT / "deploy/gcp/database-grants.sql").read_text(), prepare=False)
        with TemporaryDirectory(prefix="part2-startup-", dir="/private/tmp") as directory:
            probe = Path(directory)
            probe.chmod(0o755)
            shutil.copy(EVIDENCE / "sdk-double/sitecustomize.py", probe / "sitecustomize.py")
            shutil.copy(EVIDENCE / "cloud-sdk.mjs", probe / "cloud-sdk.mjs")
            shutil.copy(ROOT / "deploy/gcp/host.example.yaml", probe / "host.yaml")
            config = json.loads((ROOT / "deploy/gcp/runtime.example.json").read_text())
            config["cloud"]["hosts"] = ["runtime.local.test"]
            (probe / "runtime.json").write_text(json.dumps(config))
            records = []
            for service, image, port, command in (
                ("host", "hermes-agui:part2", 8137, ["--bots-config", "/probe/host.yaml", "--host", "0.0.0.0"]),
                ("runtime", "hermes-runtime:part2", 3137, []),
                ("worker", "hermes-runtime:part2", 3138, ["node", "--import", "tsx", "server/index.ts", "--production", "--worker"]),
            ):
                name = prefix + "-" + service
                names.append(name)
                env = {"PORT": str(port), "K_SERVICE": "local-startup-probe", "NODE_ENV": "test",
                       "AGUI_STORAGE_BACKEND": "gcp", "AGUI_GCS_BUCKET": "local-startup-bucket",
                       "AGUI_BOT_CREDENTIAL_SEED": "93" * 32, "AGUI_HOST_MANAGEMENT_TOKEN": TOKEN,
                       "AGUI_GRAPH_COMPLETION_TOKEN": TOKEN, "AGUI_WORKER_TOKEN": TOKEN,
                       "AGUI_DELEGATION_TOKEN": TOKEN, "OPENROUTER_API_KEY": "local-startup-only",
                       "AGUI_HOST_DATABASE_URL": f"postgresql://hermes_host:{PASSWORD}@postgres/{database}",
                       "AGUI_RUNTIME_DATABASE_URL": f"postgresql://hermes_runtime:{PASSWORD}@postgres/{database}"}
                if service == "host":
                    env["PYTHONPATH"] = "/probe:/opt/hermes"
                else:
                    env.update(AGUI_BOTS_CONFIG="/probe/runtime.json", NODE_OPTIONS="--import=/probe/cloud-sdk.mjs")
                # no-tmp: ok — explicit writable Docker scratch mount under a read-only root
                args = ["run", "-d", "--name", name, "--network", prefix, "--read-only", "--tmpfs", "/tmp:mode=1777",
                        "--mount", f"type=bind,src={probe},dst=/probe,readonly", "-p", f"127.0.0.1::{port}"]
                for key, value in env.items():
                    args.extend(["-e", f"{key}={value}"])
                docker(*args, image, *command)
                published_port = docker("port", name, str(port)).stdout.strip().rsplit(":", 1)[1]
                url = f"http://127.0.0.1:{published_port}"

                def ready():
                    assert docker("inspect", "--format", "{{.State.Running}}", name).stdout.strip() == "true", docker("logs", name).stdout
                    try:
                        return httpx.get(url + "/health", timeout=3).status_code == 200
                    except httpx.TransportError:
                        return False

                wait_until(ready, timeout=90, interval=0.5, what=service + " cloud startup")
                if service == "runtime":
                    assert httpx.get(url + "/api/bots", headers={"Host": "runtime.local.test"}, timeout=5).status_code == 401
                if service == "worker":
                    assert httpx.post(url + "/internal/jobs/reconcile", timeout=5).status_code == 401
                    assert httpx.post(url + "/internal/jobs/reconcile", headers={"X-Worker-Token": TOKEN}, timeout=10).status_code == 200
                readonly = docker("inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", name).stdout.strip()
                assert readonly == "true"
                records.append({"service": service, "port": port, "readOnlyRoot": True,
                                "image": docker("inspect", "--format", "{{.Image}}", name).stdout.strip()})
                print(service, "production command/cloud config/PORT/health/read-only root: PASS", flush=True)
            (EVIDENCE / "startup-images.json").write_text(json.dumps(records, indent=2))
        for image in ("hermes-agui:part2", "hermes-runtime:part2"):
            # no-tmp: ok — explicit Docker scratch mount for the production fail-closed startup check
            result = docker("run", "--rm", "--read-only", "--tmpfs", "/tmp", "-e", "K_SERVICE=local-startup-probe", image, check=False)
            assert result.returncode != 0 and "Cloud Run requires" in result.stdout + result.stderr
            print(image, "production without cloud config fails closed: PASS", flush=True)
    finally:
        for name in reversed(names):
            docker("stop", "--time", "10", name, check=False)
            logs = docker("logs", name, check=False)
            (EVIDENCE / (name + ".log")).write_text(logs.stdout + logs.stderr)
            docker("rm", "-f", name, check=False)
        docker("network", "disconnect", prefix, PG, check=False)
        docker("network", "rm", prefix, check=False)


if __name__ == "__main__":
    main()
