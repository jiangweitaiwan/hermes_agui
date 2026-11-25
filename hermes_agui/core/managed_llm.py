"""Resolve signed references with a dedicated SELECT-only Runtime database identity."""
import base64
import hashlib
import hmac
import json
import os
import re
import time
import asyncio

from hermes_agui.core.llm_registry import agent_route, fingerprint, parse_registry


class ManagedResolver:
    """Keep cancelled HTTP requests from releasing a still-running DB connection slot."""
    def __init__(self, capacity):
        self._slots = asyncio.Semaphore(capacity)

    async def resolve(self, value, bot_id, bot, envelope):
        if self._slots.locked():
            raise ValueError("Release resolver capacity reached")
        await self._slots.acquire()
        task = asyncio.create_task(asyncio.to_thread(resolve_run, value, bot_id, bot, envelope))
        task.add_done_callback(self._finished)
        return await asyncio.shield(task)

    def _finished(self, task):
        self._slots.release()
        if not task.cancelled():
            task.exception()


def managed_agent_type(native_class):
    """Reuse native construction/rebuilds, with the existing connect-time SSRF guard."""
    class ManagedNativeAgent(native_class):
        @staticmethod
        def _build_keepalive_http_client(base_url="", *, verify=True):
            from tools.url_safety import create_ssrf_safe_client
            if verify is False:
                raise ValueError("Managed provider TLS verification is required")
            return create_ssrf_safe_client(verify=verify, follow_redirects=False, trust_env=False)

    return ManagedNativeAgent


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def primary_route_key(raw, role):
    model, provider = agent_route(raw, role)
    return canonical_hash({"model": model.model_dump(exclude_none=True),
                           "provider": provider.model_dump(exclude_none=True)})


def validate_snapshot(snapshot, expected_hash, policy):
    part2 = snapshot.get("contract") == "management-part-2"
    expected_fields = {"version", "contract", "llm", "modelFingerprint", "taskFingerprint", "tasks"}
    if part2:
        expected_fields |= {"prompts", "codeTaskFingerprint"}
    if set(snapshot) != expected_fields:
        raise ValueError("Invalid release contract")
    if (type(snapshot["version"]) is not int or snapshot["version"] != 1 or snapshot["contract"] not in {"management-part-1", "management-part-2"}
            or canonical_hash(snapshot) != expected_hash
            or snapshot.get("codeTaskFingerprint", snapshot["taskFingerprint"]) != policy["taskFingerprint"]
            or canonical_hash(snapshot["tasks"]) != snapshot["taskFingerprint"]):
        raise ValueError("Incompatible release contract")
    registry = parse_registry(snapshot["llm"])
    roles = {"agent_primary", "graph_parser", "graph_matcher", "graph_relations", "graph_query", "graph_story", "graph_embedding"}
    if not roles.issubset({model.alias for model in registry.models}):
        raise ValueError("Missing release role")
    approved = parse_registry(policy["approved"])
    if fingerprint(registry) != snapshot["modelFingerprint"]:
        raise ValueError("Invalid model fingerprint")
    for provider in registry.providers:
        if provider not in approved.providers:
            raise ValueError("Unapproved provider")
    for model in registry.models:
        if not any(m.provider == model.provider and m.model == model.model for m in approved.models):
            raise ValueError("Unapproved model")
    embedding = next(m for m in registry.models if m.alias == "graph_embedding")
    if embedding != next(m for m in approved.models if m.alias == "graph_embedding"):
        raise ValueError("Embedding is read only")
    agent_route(snapshot["llm"])
    return snapshot["llm"]


def native_instruction(snapshot):
    text = snapshot.get("prompts", {}).get("agent_primary", "")
    if not isinstance(text, str) or len(text) > 4000:
        raise ValueError("Invalid native instruction slot")
    return text


def resolve_run(value, bot_id, bot, envelope):
    """No browser route or snapshot is trusted, even with a valid Bot bearer token."""
    policy = bot.agent.llm_control
    if policy is None or not bot.server.runtime_memory_key:
        raise ValueError("Managed release metadata denied")
    if not isinstance(envelope, dict) or set(envelope) != {"payload", "signature"}:
        raise ValueError("Invalid release envelope")
    payload, signature = envelope["payload"], envelope["signature"]
    if (not isinstance(payload, str) or len(payload) > 4096 or not re.fullmatch(r"[A-Za-z0-9_-]+", payload)
            or not isinstance(signature, str) or not re.fullmatch(r"[a-f0-9]{64}", signature)):
        raise ValueError("Invalid release envelope")
    expected = hmac.new(bot.server.runtime_memory_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("Invalid release signature")
    data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    binding = {"version": 1, "scope": "deployment", "botId": bot_id, "principal": bot.agent.principal,
               "projectId": bot.server.runtime_memory_project, "threadId": value.thread_id, "runId": value.run_id}
    if (set(data) != set(binding) | {"releaseId", "releaseFingerprint", "expires"}
            or any(data[key] != item for key, item in binding.items())
            or type(data["expires"]) is not int or not time.time() < data["expires"] <= time.time() + 90):
        raise ValueError("Release binding denied")
    import psycopg

    # Independent credentials never widen the Host owner's database boundary.
    url = os.environ.get("AGUI_LLM_DATABASE_URL")
    if not url:
        raise ValueError("Release resolver unavailable")
    with psycopg.connect(url, connect_timeout=2, options="-c statement_timeout=5000 -c default_transaction_read_only=on") as conn:
        row = conn.execute("""SELECT r.snapshot,r.release_fingerprint FROM hermes_agui_runtime.llm_releases r
            JOIN hermes_agui_runtime.llm_run_pins p USING(scope,release_id)
            WHERE p.scope=%s AND p.principal=%s AND p.bot=%s AND p.thread=%s AND p.run=%s AND r.release_id=%s""",
            (data["scope"], data["principal"], bot_id, value.thread_id, value.run_id, data["releaseId"])).fetchone()
    if row is None or row[1] != data["releaseFingerprint"]:
        raise ValueError("Persisted release pin unavailable")
    registry = validate_snapshot(row[0], row[1], policy)
    return registry, data["releaseId"], row[1], native_instruction(row[0])


def ready_host(policy):
    import psycopg

    url = os.environ.get("AGUI_LLM_DATABASE_URL")
    if not url:
        raise ValueError("Dedicated read-only control database identity required")
    try:
        with psycopg.connect(url, connect_timeout=2, options="-c statement_timeout=5000 -c default_transaction_read_only=on") as conn:
            conn.execute("SELECT release_id FROM hermes_agui_runtime.llm_run_pins LIMIT 0")
            row = conn.execute("""SELECT r.snapshot,r.release_fingerprint FROM hermes_agui_runtime.llm_releases r
                JOIN hermes_agui_runtime.llm_active_release a USING(scope,release_id) WHERE a.scope='deployment'""").fetchone()
    except psycopg.Error:
        raise ValueError("Managed control database unavailable") from None
    if row is None:
        raise ValueError("Managed active release unavailable; start Runtime initialization before Host readiness")
    validate_snapshot(row[0], row[1], policy)
