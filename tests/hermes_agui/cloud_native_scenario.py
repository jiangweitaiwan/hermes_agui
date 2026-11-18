"""Shared fake-model scenario with separate application containers and external PG/object storage."""
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
import subprocess
from uuid import uuid4

import httpx
import psycopg

from tests.waiting import wait_until

ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE = "資料庫研究確認：PostgreSQL 使用預寫日誌保護已提交資料，重新部署後必須從外部儲存復原對話、原生記憶、核准技能以及知識圖譜，並驗證來源與授權。"
MEMORY = "資料庫專案使用藍色筆記本記錄復原步驟。"
PROCEDURE = "Read the blue notebook index before database recovery."
SKILL = f"---\nname: notebook\ndescription: Database recovery notebook\n---\n{PROCEDURE}\n"


def docker(*args):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=180, check=False)
    assert result.returncode == 0, result.stderr
    return (result.stdout + result.stderr).strip() if args[0] == "logs" else result.stdout.strip()


class ContainerScenario:
    def __init__(self, directory, native_config, model_url):
        self.directory = directory
        self.prefix = "agui-part1-" + uuid4().hex[:12]
        self.project = uuid4().hex
        self.apps = []
        self.network_created = self.volume_created = self.pg_created = False
        self.host_config = {"project": self.project, "modelUrl": model_url, "nativeConfig": native_config,
                            "scratch": "/scratch", "objects": "/objects", "port": 8000,
                            "completionUrl": "https://runtime:3443/internal/graph/completions", "caFile": "/deployment/runtime.crt"}
        self.runtime_config = {"project": self.project, "hostUrl": "http://host:8000", "port": 3000, "objects": "/objects/graph", "tlsKey": "/deployment/runtime.key", "tlsCert": "/deployment/runtime.crt"}
        self.url = self.host_url = self.database_url = None

    def create_tls(self):
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "runtime")])
        now = datetime.now(UTC)
        certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                       .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
                       .not_valid_after(now + timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName("runtime")]), critical=False)
                       .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(key, hashes.SHA256()))
        (self.directory / "runtime.key").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        (self.directory / "runtime.crt").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))

    def initialize(self):
        self.create_tls()
        docker("network", "create", self.prefix)
        self.network_created = True
        docker("volume", "create", self.prefix)
        self.volume_created = True
        docker("run", "--rm", "--user", "0", "--mount", f"type=volume,src={self.prefix},dst=/objects", "--entrypoint", "sh",
               "hermes-agui:part1", "-c", "chown 10000:10000 /objects && chmod 700 /objects")
        docker("run", "-d", "--name", self.prefix + "-pg", "--network", self.prefix, "--network-alias", "postgres",
               "-e", "POSTGRES_PASSWORD=part1-fixture-only", "-p", "127.0.0.1::5432", "postgres:17")
        self.pg_created = True
        port = docker("port", self.prefix + "-pg", "5432").rsplit(":", 1)[1]
        self.database_url = f"postgresql://postgres:part1-fixture-only@127.0.0.1:{port}/postgres"
        def database_ready():
            try:
                with psycopg.connect(self.database_url, connect_timeout=1):
                    return True
            except psycopg.OperationalError:
                return False
        wait_until(database_ready, timeout=40, what="PostgreSQL container ready")
        with psycopg.connect(self.database_url, autocommit=True) as conn:
            for area in ("hermes_agui/storage/migrations", "examples/copilotkit/server/storage/migrations"):
                for path in sorted((ROOT / area).glob("*.sql")):
                    conn.execute(path.read_text(), prepare=False)
            conn.execute((ROOT / "tests/hermes_agui/cloud_native_grants.sql").read_text(), prepare=False)

        for role, table in (("runtime", "hermes_agui_host.runs"), ("host", "hermes_agui_runtime.bot_registry")):
            restricted = self.database_url.replace("postgres:part1-fixture-only@", f"fixture_{role}:part1-fixture-only@")
            with psycopg.connect(restricted, autocommit=True) as conn:
                try:
                    conn.execute(f"SELECT * FROM {table} LIMIT 0")
                except psycopg.errors.InsufficientPrivilege:
                    continue
                raise AssertionError("Service role crossed schema ownership")

    def start(self):
        (self.directory / "host.json").write_text(json.dumps(self.host_config))
        (self.directory / "runtime.json").write_text(json.dumps(self.runtime_config))
        internal_db = "postgresql://fixture_{role}:part1-fixture-only@postgres:5432/postgres"
        for service, port, image, filename, command in (
            ("host", 8000, "hermes-agui:part1-test", "host.json", []),
            ("runtime", 3000, "hermes-runtime:part1", "runtime.json", ["node", "--import", "tsx", "tests/fixtures/cloud-native-runtime.ts"]),
        ):
            name = self.prefix + "-" + service
            args = ["run", "-d", "--name", name, "--network", self.prefix, "--network-alias", service,
                    "--add-host", "host.docker.internal:host-gateway", "--read-only", "--tmpfs", "/scratch:uid=10000,gid=10000,mode=700", "--tmpfs", "/tmp:mode=1777",
                    "--mount", f"type=volume,src={self.prefix},dst=/objects",
                    "--mount", f"type=bind,src={self.directory},dst=/deployment,readonly",
                    "-p", f"127.0.0.1::{port}", "-e", f"AGUI_HOST_DATABASE_URL={internal_db.format(role='host')}",
                    "-e", f"AGUI_RUNTIME_DATABASE_URL={internal_db.format(role='runtime')}", "-e", "AGUI_BOT_CREDENTIAL_SEED=" + "93" * 32,
                    "-e", "HERMES_HOME=/scratch/launch-profile", "-e", "HERMES_RUNTIME_DIR=/opt/hermes/tools"]
            docker(*args, image, *command, "/deployment/" + filename)
            self.apps.append(name)
            published = docker("port", name, str(port)).rsplit(":", 1)[1]
            url = f"http://127.0.0.1:{published}"
            if service == "host":
                self.host_url = url
            else:
                self.url = url
            def ready():
                assert docker("inspect", "--format", "{{.State.Running}}", name) == "true", docker("logs", name)
                try:
                    return httpx.get(url + "/health", timeout=1).status_code == 200
                except httpx.TransportError:
                    return False
            wait_until(ready, timeout=90, what=service + " container ready")

    def stop_apps(self):
        for name in self.apps:
            docker("stop", "--time", "30", name)
            (self.directory.parent / (name + ".log")).write_text(docker("logs", name))
            docker("rm", "-v", name)
        self.apps.clear()

    def close(self):
        self.stop_apps()
        if self.pg_created:
            docker("rm", "-fv", self.prefix + "-pg")
        if self.volume_created:
            docker("volume", "rm", self.prefix)
        if self.network_created:
            docker("network", "rm", self.prefix)

    def request(self, path, *, owner="owner", method="GET", body=None):
        return httpx.request(method, self.url + path, headers={"Authorization": "Bearer " + owner + "-token"}, json=body, timeout=120)

    def run(self, bot, text, thread="original-browser-thread"):
        run = str(uuid4())
        response = self.request(f"/api/copilotkit/agent/{bot}/run", method="POST", body={
            "threadId": thread, "runId": run, "state": {}, "tools": [], "context": [], "forwardedProps": {},
            "messages": [{"id": str(uuid4()), "role": "user", "content": text}]})
        assert response.status_code == 200, response.text
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert events[-1]["type"] == "RUN_FINISHED", events
        return run, events

    def snapshot(self, bot):
        response = httpx.get(self.host_url + "/__test/snapshot/" + bot,
                             headers={"Authorization": "Bearer fixture-manager-token"}, timeout=40)
        assert response.status_code == 200, response.text
        return response.json()

    def dispatch(self, lost=False):
        response = httpx.post(self.host_url + "/__test/dispatch" + ("?loseAck=1" if lost else ""),
                              headers={"Authorization": "Bearer fixture-manager-token"}, timeout=40)
        assert response.status_code == 200, response.text
        return response.json()

    def sql(self, query, params=()):
        with psycopg.connect(self.database_url) as conn:
            cursor = conn.execute(query, params)
            return cursor.fetchall() if cursor.description else None


@contextmanager
def scenario(directory, native_config, model_url):
    fixture = ContainerScenario(directory, native_config, model_url)
    try:
        fixture.initialize()
        yield fixture
    finally:
        fixture.close()


def create_bots(fixture):
    ids = []
    for name, owner in (("A", "owner"), ("B", "owner"), ("C", "other")):
        response = fixture.request("/api/bots", owner=owner, method="POST", body={"name": name, "harness": "hermes",
            "templateId": "native", "toolsets": ["memory", "skills"]})
        assert response.status_code == 201, response.text
        ids.append(response.json()["id"])
    assert fixture.request(f"/api/graph/{ids[0]}/pages", owner="other").status_code == 404
    fixture.stop_apps()
    fixture.host_config["approved"] = {ids[0]: ["skills/notebook/SKILL.md"]}
    fixture.start()
    return ids


def learn_and_lose_ack(fixture, bot):
    run, events = fixture.run(bot, "learn")
    assert any(event["type"] == "TOOL_CALL_RESULT" for event in events)
    rows = fixture.sql("SELECT profile FROM hermes_agui_host.bot_state WHERE project=%s AND bot=%s", (fixture.project, bot))
    assert {entry["path"] for entry in rows[0][0]["files"]} >= {"state.db", "memories/MEMORY.md", "skills/notebook/SKILL.md"}
    original_mapping = fixture.sql("SELECT browser_thread,host_thread FROM hermes_agui_runtime.thread_mappings WHERE project=%s AND bot=%s",
                                   (fixture.project, bot))
    lost = fixture.dispatch(lost=True)
    assert lost is not None
    tick = fixture.request("/__test/tick", method="POST")
    assert tick.status_code == 200, tick.text
    assert fixture.request(f"/api/graph/{bot}/search?q=資料庫").json()["pages"]
    source, = fixture.sql("SELECT source FROM hermes_agui_runtime.graph_jobs WHERE ns IN (SELECT id FROM hermes_agui_runtime.graph_namespaces WHERE metadata->>'botId'=%s)", (bot,))[0]
    snapshot = fixture.snapshot(bot)
    assert snapshot["nativeSessionIds"] and snapshot["toolResults"] >= 2
    return run, lost, original_mapping, str(source), snapshot


def recover(fixture, bots, evidence):
    bot, private_bot, _other = bots
    run, lost, original_mapping, source, snapshot = evidence
    fixture.stop_apps()
    fixture.sql("UPDATE hermes_agui_host.run_outbox SET lease_until=clock_timestamp() WHERE id=%s", (lost["id"],))
    fixture.start()
    assert fixture.snapshot(bot) == snapshot
    assert fixture.dispatch()["id"] == lost["id"]
    assert fixture.sql("SELECT count(*) FROM hermes_agui_runtime.graph_jobs")[0][0] == 1
    assert fixture.sql("SELECT browser_thread,host_thread FROM hermes_agui_runtime.thread_mappings WHERE project=%s AND bot=%s",
                       (fixture.project, bot)) == original_mapping
    assert {row["id"] for row in fixture.request("/api/bots").json()} == {bot, private_bot}
    assert fixture.request(f"/api/graph/{bot}/search?q=資料庫").json()["pages"]
    assert not fixture.request(f"/api/graph/{private_bot}/search?q=資料庫").json()["pages"]
    fixture.run(bot, "continue")
    fixture.run(bot, "memory-check", "new-native-memory-thread")
    shared = fixture.request("/__test/share", method="POST", body={"botId": bot, "source": source})
    assert shared.status_code == 200, shared.text
    assert fixture.request("/__test/tick", method="POST").status_code == 200
    assert fixture.request(f"/api/graph/{private_bot}/search?q=資料庫").json()["pages"]
    fixture.run(private_bot, "retrieve", "new-thread")
    assert fixture.request(f"/api/bots/{bot}/disable", method="POST").status_code == 204
    denied = fixture.request(f"/api/copilotkit/agent/{bot}/run", method="POST", body={})
    assert denied.status_code == 404
    assert fixture.sql("SELECT status FROM hermes_agui_host.runs WHERE project=%s AND bot=%s AND run_id=%s",
                       (fixture.project, bot, run))[0][0] == "completed"
