"""Trusted multi-Bot deployment configuration, never supplied by browser input."""

from dataclasses import dataclass
import os
from pathlib import Path
import re
from typing import Callable

from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig


@dataclass(frozen=True)
class BotConfig:
    bot_id: str
    agent: AgentConfig
    server: ServerConfig
    authorize: Callable | None = None


def validate_bots(bots, default_bot, max_active_runs):
    registry = {}
    paths = []
    tokens = set()
    if not isinstance(max_active_runs, int) or max_active_runs < 1:
        raise ValueError("Host capacity must be positive")
    for bot in bots:
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", bot.bot_id) or bot.bot_id in registry:
            raise ValueError("Invalid or duplicate Bot ID")
        # Nested roots also permit one Bot's tools to overwrite another's profile.
        for path in (bot.agent.home, bot.agent.cwd):
            if any(path == old or path in old.parents or old in path.parents for old in paths):
                raise ValueError("Bot profile/workspace roots must be disjoint")
        paths.extend((bot.agent.home, bot.agent.cwd))
        if bot.server.bearer_token in tokens:
            raise ValueError("Each Bot needs a distinct credential")
        tokens.add(bot.server.bearer_token)
        registry[bot.bot_id] = bot
    if not registry or (default_bot is not None and default_bot not in registry):
        raise ValueError("Configure Bots and a valid optional default Bot")
    return registry


def load_host(path: Path):
    from utils import load_yaml_file_readonly
    from hermes_agui.server import create_host

    data = load_yaml_file_readonly(path)
    if os.environ.get("K_SERVICE") and not data.get("cloud"):
        raise ValueError("Cloud Run requires explicit cloud settings")
    llm = data.get("llm")
    from hermes_agui.core.managed_llm import source_control_policy
    control = source_control_policy(data.get("llmControl"))
    if control is not None:
        from hermes_agui.core.llm_registry import parse_registry
        if (set(control) != {"mode", "taskFingerprint", "approved"} or control["mode"] != "managed"
                or not re.fullmatch(r"[a-f0-9]{64}", control["taskFingerprint"]) or llm is None):
            raise ValueError("Invalid Host managed LLM contract")
        parse_registry(control["approved"])
        from hermes_agui.core.managed_llm import ready_host
        ready_host(control)
    if llm is not None:
        from hermes_agui.core.llm_registry import parse_registry, fingerprint
        import logging
        registry = parse_registry(llm)
        if data.get("llmFingerprint") and data["llmFingerprint"] != fingerprint(registry):
            raise ValueError("LLM config fingerprint mismatch")
        logging.getLogger(__name__).info("llm_config version=1 fingerprint=%s", fingerprint(registry))
    credential_registry = parse_registry(control["approved"]) if control else registry if llm is not None else None
    llm_credentials = {p.keyEnv: os.environ.get(p.keyEnv, "") for p in credential_registry.providers if hasattr(p, "keyEnv")} if credential_registry else {}
    bots = []
    for item in data.get("bots", []):
        agent = dict(item["agent"])
        if llm is not None:
            agent["llm_registry"] = llm
            agent["llm_credentials"] = llm_credentials
            agent["llm_control"] = control
        if "api_key_env" in agent:
            agent["api_key"] = os.environ[agent.pop("api_key_env")]
        for key in ("home", "cwd"):
            value = Path(agent[key]).expanduser()
            agent[key] = value if value.is_absolute() else path.resolve().parent / value
        token = os.environ[item["token_env"]]
        server = dict(item.get("server", {}))
        if "runtime_memory_key_env" in server:
            server["runtime_memory_key"] = os.environ[server.pop("runtime_memory_key_env")]
        bots.append(BotConfig(item["id"], AgentConfig(**agent),
                              ServerConfig(bearer_token=token, **server)))
    delegation = None
    if data.get("delegation"):
        from hermes_agui.delegation import DelegationConfig

        settings = dict(data["delegation"])
        settings["token"] = os.environ[settings.pop("token_env")]
        delegation = DelegationConfig(**settings)
        if data.get("cloud") and delegation.audience is None:
            raise ValueError("Cloud delegation requires a service audience")
    management = None
    if data.get("management"):
        from hermes_agui.management import ManagementConfig
        from hermes_agui.provisioner import ProvisionTemplate

        settings = dict(data["management"])
        root = Path(settings.pop("root")).expanduser()
        if not root.is_absolute():
            root = path.resolve().parent / root
        templates = {}
        for name, raw in settings.pop("templates").items():
            template = dict(raw)
            if llm is not None:
                template["llm_registry"] = llm
                template["llm_credentials"] = llm_credentials
                template["llm_control"] = control
            if "api_key_env" in template:
                template["api_key"] = os.environ[template.pop("api_key_env")]
            template["toolsets"] = tuple(template.get("toolsets", ("memory", "skills")))
            template["skills"] = {key: (path.resolve().parent / value).resolve()
                                  for key, value in template.get("skills", {}).items()}
            templates[name] = ProvisionTemplate(**template)
        management = ManagementConfig(root, os.environ[settings.pop("token_env")], templates, **settings)
    from hermes_agui.storage.host_settings import load_storage

    storage = load_storage(data.get("storage", {}))
    app = create_host(bots, delegation=delegation, management=management, default_bot=data.get("default_bot"),
                       max_active_runs=data.get("max_active_runs", 8), storage=storage)

    from hermes_agui.cloud_host import configure_cloud_host

    return configure_cloud_host(app, data.get("cloud"), storage)
