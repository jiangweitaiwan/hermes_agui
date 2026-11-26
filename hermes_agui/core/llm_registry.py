"""Trusted bilingual deployment registry. Never read routing from a chat message."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from typing import Literal
from urllib.parse import urlsplit
import re
from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CompatibleProvider(_Strict):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,99}$")
    driver: Literal["openai-compatible"]
    baseUrl: str
    keyEnv: str = Field(pattern=r"^[A-Z_][A-Z0-9_]*$")
    capabilities: list[Literal["chat", "structured_output", "embedding"]] = Field(min_length=1)


class VertexProvider(_Strict):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,99}$")
    driver: Literal["vertex"]
    project: str = Field(pattern=r"^[a-z][a-z0-9-]{4,62}$")
    location: str = Field(pattern=r"^(global|[a-z]+-[a-z]+[0-9])$")
    auth: Literal["adc"]
    capabilities: list[Literal["chat", "structured_output", "embedding"]] = Field(min_length=1)


class ModelRole(_Strict):
    alias: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,99}$")
    provider: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,99}$")
    model: str = Field(min_length=1, max_length=200)
    timeoutMs: int = Field(ge=1, le=120000)
    retries: int = Field(ge=0, le=2)
    maxTokens: int = Field(ge=1, le=8192)
    fallback: list[str] = Field(max_length=3)
    dimension: int | None = Field(default=None, ge=1, le=4096)
    version: str | None = Field(default=None, min_length=1, max_length=100)


class RegistrySettings(_Strict):
    version: Literal[1]
    providers: list[CompatibleProvider | VertexProvider] = Field(min_length=1)
    models: list[ModelRole] = Field(min_length=1)


def _validate_provider(provider):
    if isinstance(provider, CompatibleProvider):
        url = urlsplit(provider.baseUrl)
        if url.scheme not in {"http", "https"} or not url.netloc or url.username or url.password or url.query or url.fragment:
            raise ValueError("Invalid endpoint")


def _validate_vertex_model(model, provider, embedding):
    if embedding:
        if model.model != "gemini-embedding-001" or model.dimension > 3072 or provider.location == "global":
            raise ValueError("Unsupported Vertex embedding")
    elif not re.fullmatch(
        r"(google/)?gemini-[a-zA-Z0-9._-]+",
        model.model
    ):
        raise ValueError("Invalid Vertex Gemini model identifier")


def _validate_model(model, providers, models, roles):
    if model.alias not in roles:
        raise ValueError("Unknown model role")
    provider = providers[model.provider]
    embedding = model.alias == "graph_embedding"
    capability = "embedding" if embedding else "chat" if model.alias == "agent_primary" else "structured_output"
    if capability not in provider.capabilities or (embedding and (not model.dimension or not model.version)):
        raise ValueError("Incompatible role")
    if isinstance(provider, VertexProvider):
        _validate_vertex_model(model, provider, embedding)
    for target in model.fallback:
        if target == model.alias or models[target].fallback or models[target].dimension or embedding:
            raise ValueError("Invalid fallback")


def parse_registry(raw):
    """Validate before startup/logging; never echo credential-bearing values."""
    try:
        if type(raw.get("version")) is not int:
            raise ValueError("Invalid registry version")
        for model in raw.get("models", []):
            if model.get("dimension", 1) is None or model.get("version", "v1") is None:
                raise ValueError("Invalid registry value")
        registry = RegistrySettings.model_validate(raw)
        providers = {p.id: p for p in registry.providers}
        models = {m.alias: m for m in registry.models}
        if len(providers) != len(registry.providers) or len(models) != len(registry.models):
            raise ValueError("Duplicate alias")
        for provider in providers.values():
            _validate_provider(provider)
        roles = {"agent_primary", "graph_parser", "graph_matcher", "graph_relations", "graph_query", "graph_story", "graph_embedding"}
        roles.update(target for model in models.values() for target in model.fallback)
        for model in models.values():
            _validate_model(model, providers, models, roles)
        return registry
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ValueError("Invalid LLM registry configuration") from None


def fingerprint(registry):
    data = registry.model_dump(exclude_none=True)
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def agent_route(raw, role="agent_primary"):
    registry = parse_registry(raw)
    model = next((m for m in registry.models if m.alias == role), None)
    if model is None or model.dimension is not None:
        raise ValueError("Unknown or incompatible Agent model role")
    provider = next(p for p in registry.providers if p.id == model.provider)
    if "chat" not in provider.capabilities:
        raise ValueError("Agent role requires chat capability")
    # Native fallback has independent semantics. Do not inherit ambient profile fallback.
    if model.fallback:
        raise ValueError("Agent registry fallback is not supported; use an empty allowlist")
    return model, provider


@contextmanager
def registry_scope(raw, role="agent_primary"):
    if raw is None:
        yield
        return
    from agent.vertex_adapter import vertex_route_scope

    model, provider = agent_route(raw, role)
    from hermes_cli.timeouts import provider_timeout_scope
    route = {"project_id": provider.project, "region": provider.location} if isinstance(provider, VertexProvider) else None
    native_provider = "vertex" if isinstance(provider, VertexProvider) else "custom"
    from hermes_cli.model_normalize import normalize_model_for_provider
    native_model = normalize_model_for_provider(model.model, native_provider)
    with vertex_route_scope(route), provider_timeout_scope(native_provider, native_model, model.timeoutMs / 1000):
        yield


def native_settings(raw, role="agent_primary", credentials=None):
    model, provider = agent_route(raw, role)
    options = {"model": model.model, "provider": "vertex", "api_key": None, "base_url": None}
    if isinstance(provider, CompatibleProvider):
        key = (credentials or {}).get(provider.keyEnv)
        if not key:
            raise ValueError("Registry provider credential is unavailable")
        options.update(provider="custom", api_key=key, base_url=provider.baseUrl)
    options["max_tokens"] = model.maxTokens
    options["retries"] = model.retries
    return options
