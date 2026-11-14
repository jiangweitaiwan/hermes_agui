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
    bots = []
    for item in data["bots"]:
        agent = dict(item["agent"])
        for key in ("home", "cwd"):
            value = Path(agent[key]).expanduser()
            agent[key] = value if value.is_absolute() else path.resolve().parent / value
        token = os.environ[item["token_env"]]
        bots.append(BotConfig(item["id"], AgentConfig(**agent),
                              ServerConfig(bearer_token=token, **item.get("server", {}))))
    return create_host(bots, default_bot=data.get("default_bot"),
                       max_active_runs=data.get("max_active_runs", 8))
