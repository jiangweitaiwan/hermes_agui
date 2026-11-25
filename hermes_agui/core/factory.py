"""Construct native agents under a host-owned profile, without starting a UI."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import threading
from typing import Any

_INITIALIZATION_LOCK = threading.Lock()


@dataclass(frozen=True)
class AgentConfig:
    """Trusted host configuration. Credentials and options never come from a client run."""

    home: Path
    cwd: Path
    principal: str = "local-owner"
    model: str | None = None
    provider: str | None = None
    api_key: str | None = field(default=None, repr=False)
    base_url: str | None = None
    enabled_toolsets: tuple[str, ...] | None = None
    disabled_toolsets: tuple[str, ...] = ()
    agent_options: dict[str, Any] = field(default_factory=dict, repr=False)
    # An imported profile keeps its original identity input after relocation.
    session_home_identity: str | None = None
    ephemeral_workspace: bool = False
    llm_registry: dict | None = field(default=None, repr=False)
    model_role: str = "agent_primary"
    managed_instruction: str = field(default="", repr=False)
    llm_credentials: dict[str, str] = field(default_factory=dict, repr=False)
    llm_control: dict | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "home", Path(self.home).expanduser().resolve())
        object.__setattr__(self, "cwd", Path(self.cwd).expanduser().resolve(strict=True))
        if not self.cwd.is_dir() or not self.principal:
            raise ValueError("cwd must be a directory and principal must be nonempty")
        if self.session_home_identity is not None and not self.session_home_identity:
            raise ValueError("session_home_identity must be nonempty")
        object.__setattr__(self, "agent_options", dict(self.agent_options))
        object.__setattr__(self, "llm_credentials", dict(self.llm_credentials))
        if self.llm_control is not None and self.model_role != "agent_primary":
            raise ValueError("Managed Bots use the deployment agent_primary role")
        if self.llm_registry is not None:
            from hermes_agui.core.llm_registry import agent_route, parse_registry
            if self.model or self.provider or self.api_key or self.base_url:
                raise ValueError("Registry role conflicts with legacy Agent routing")
            registry = parse_registry(self.llm_registry)
            agent_route(self.llm_registry, self.model_role)
            object.__setattr__(self, "llm_registry", registry.model_dump(exclude_none=True))


def create_agent(config: AgentConfig, session_id: str, db):
    """Caller binds profile/session context before entering this function."""
    # Discovery mutates process-wide plugin/tool registries. Cold constructions
    # must not discover different profiles simultaneously.
    with _INITIALIZATION_LOCK:
        return _create_agent(config, session_id, db)


def _create_agent(config: AgentConfig, session_id: str, db):
    from hermes_cli.config import load_config_readonly, resolve_turn_limit, split_model_config_default
    from hermes_cli.model_normalize import normalize_model_for_provider
    from hermes_cli.runtime_provider import frozen_runtime_config, resolve_runtime_with_fallback
    from hermes_cli.tools_config import _get_platform_tools
    from hermes_constants import resolve_reasoning_config
    from run_agent import AIAgent

    cfg = load_config_readonly()
    route = None
    if config.llm_registry is not None:
        from hermes_agui.core.llm_registry import native_settings
        route = native_settings(config.llm_registry, config.model_role, config.llm_credentials)
        cfg = dict(cfg, fallback_model={}, fallback_providers=[])
    model_cfg = cfg.get("model", {})
    model_cfg = model_cfg if isinstance(model_cfg, dict) else {"default": model_cfg}
    model, pinned_provider = split_model_config_default(model_cfg.get("default", ""))
    model = route["model"] if route else config.model or model
    with frozen_runtime_config(cfg):
        runtime, fallback = resolve_runtime_with_fallback(
            cfg, requested=route["provider"] if route else config.provider or pinned_provider or model_cfg.get("provider"),
            target_model=model, explicit_api_key=route["api_key"] if route else config.api_key, explicit_base_url=route["base_url"] if route else config.base_url,
        )
    model = (fallback or {}).get("model") or model or runtime.get("model")
    if not model:
        raise ValueError("Configure a native Hermes model or supply AgentConfig.model")
    options = dict(config.agent_options)
    if route:
        options["max_tokens"] = route["max_tokens"]
        options["fallback_model"] = {}
    if config.managed_instruction:
        existing = options.get("ephemeral_system_prompt", "") or ""
        options["ephemeral_system_prompt"] = (existing + "\n\nDeployment task guidance (subordinate to native role, security, tools and memory contracts):\n" + config.managed_instruction).strip()
    reserved = {"session_id", "session_db", "platform", "cwd", "user_id", "quiet_mode",
                "provider", "requested_provider", "api_key", "api_mode", "base_url", "model",
                "credential_pool", "enabled_toolsets", "disabled_toolsets", "acp_command", "acp_args"}
    if reserved.intersection(options):
        raise ValueError("agent_options cannot override host identity, routing or session ownership")
    options.setdefault("max_iterations", resolve_turn_limit(cfg.get("agent", {}).get("max_turns")))
    options.setdefault("reasoning_config", resolve_reasoning_config(cfg, model))
    options.setdefault("service_tier", model_cfg.get("service_tier"))
    options.setdefault("request_overrides", runtime.get("request_overrides"))
    options.setdefault("capabilities", runtime.get("capabilities"))
    options.setdefault("fallback_model", cfg.get("fallback_model"))
    enabled = (list(config.enabled_toolsets) if config.enabled_toolsets is not None
               else sorted(_get_platform_tools(cfg, "api_server", include_default_mcp_servers=True)))
    agent_class = AIAgent
    if config.llm_control is not None and runtime["provider"] == "custom":
        from hermes_agui.core.managed_llm import managed_agent_type
        agent_class = managed_agent_type(AIAgent)
    agent = agent_class(
        model=normalize_model_for_provider(model, runtime["provider"]),
        provider=runtime["provider"], requested_provider=runtime.get("requested_provider"),
        api_key=runtime.get("api_key"), base_url=runtime.get("base_url"), api_mode=runtime.get("api_mode"),
        acp_command=runtime.get("command"), acp_args=runtime.get("args"),
        credential_pool=runtime.get("credential_pool"),
        session_id=session_id, session_db=db, platform="api_server", cwd=str(config.cwd),
        user_id=config.principal, quiet_mode=True, enabled_toolsets=enabled,
        disabled_toolsets=list(config.disabled_toolsets), **options,
    )

    if route:
        agent._api_max_retries = route["retries"] + 1
    return agent
