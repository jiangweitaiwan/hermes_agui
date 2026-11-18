"""Lifecycle owner for static and dynamically provisioned Bot services."""
from dataclasses import replace

from hermes_agui.adapter import AgentAdapter, AdmissionError
from hermes_agui.host import validate_bots
from hermes_agui.receipts import ReceiptStore


class HostRuntime:
    def __init__(self, registry, service_factory, delegation, max_active_runs, storage=None):
        self.registry = registry
        self.adapters = {}
        self.disabled = set()
        self.service_factory = service_factory
        self.delegation = delegation
        self.max_active_runs = max_active_runs
        self.storage = storage

    def register_bot(self, bot, *, managed_revision=None, template_skills=frozenset(), managed_skill_names=frozenset()):
        if bot.bot_id in self.registry and bot.bot_id in self.adapters:
            raise AdmissionError(409, "Bot already registered")
        validate_bots([b for key, b in self.registry.items() if key != bot.bot_id] + [bot], None,
                      self.max_active_runs)
        bot = self._with_delegation(bot)
        try:
            adapter = self._create_adapter(bot, managed_revision, template_skills, managed_skill_names)
        except Exception:
            self._remove_tool(bot)
            raise
        self.registry[bot.bot_id] = bot
        self.adapters[bot.bot_id] = adapter
        self.disabled.discard(bot.bot_id)

    def _create_adapter(self, bot, managed_revision, template_skills, managed_skill_names):
        def capacity():
            return sum(len(a.active) for a in self.adapters.values()) < self.max_active_runs

        if self.storage is not None:
            return AgentAdapter(None, bot.server, bot_id=bot.bot_id, host_has_capacity=capacity,
                                delegation=self.delegation, durable_runs=self.storage.for_bot(
                                    bot, managed_revision, template_skills, managed_skill_names))
        receipts = ReceiptStore(bot.agent.home, bot.agent.principal, bot.server.max_receipts)
        options = {"authorize": bot.authorize} if bot.authorize else {}
        service = self.service_factory(bot.agent, max_workers=bot.server.max_active_runs,
                                       max_pending=bot.server.max_active_runs, **options)
        adapter = AgentAdapter(service, bot.server, receipt_store=receipts,
            delegation=self.delegation, bot_id=bot.bot_id,
            host_has_capacity=capacity)
        return adapter

    def _with_delegation(self, bot):
        if not self.delegation or self.storage is not None:
            return bot
        from hermes_agui.delegation import register_tool
        from hermes_cli.tools_config import _get_platform_tools
        from hermes_cli.config import load_config_readonly
        from agent.runtime_scope import bind_profile_scope

        register_tool(bot.agent.home)
        with bind_profile_scope(bot.agent.home):
            enabled = bot.agent.enabled_toolsets
            if enabled is None:
                enabled = sorted(_get_platform_tools(load_config_readonly(), "api_server",
                                                    include_default_mcp_servers=True))
        return replace(bot, agent=replace(bot.agent,
            enabled_toolsets=tuple(dict.fromkeys([*enabled, "agui_bots"]))))

    def require_idle(self, bot_id):
        if bot_id in self.adapters and self.adapters[bot_id].active:
            raise AdmissionError(409, "Bot has active runs")

    def configure_bot(self, bot):
        self.require_idle(bot.bot_id)
        current = self.registry[bot.bot_id]
        if (current.agent.home, current.agent.cwd, current.agent.principal, current.server.bearer_token) != (
                bot.agent.home, bot.agent.cwd, bot.agent.principal, bot.server.bearer_token):
            raise ValueError("Cannot change an existing Bot's identity")
        bot = self._with_delegation(bot)
        self.registry[bot.bot_id] = bot
        adapter = self.adapters[bot.bot_id]
        # Cached agents keep their prompt/tool surface. New sessions use the updated profile.
        adapter.service.config = bot.agent
        adapter.config = bot.server

    async def unregister_bot(self, bot_id):
        self.require_idle(bot_id)
        self.disabled.add(bot_id)
        adapter = self.adapters.get(bot_id)
        if adapter is not None:
            await adapter.close()
            self.adapters.pop(bot_id)
            self._remove_tool(self.registry[bot_id])
        self.registry.pop(bot_id, None)

    def _remove_tool(self, bot):
        if self.delegation and self.storage is None:
            from tools.registry import registry
            registry.deregister("message_bot", scope=str(bot.agent.home))

    async def close(self):
        for adapter in self.adapters.values():
            for run in adapter.active.values():
                run.stop.set()
        for bot_id, adapter in list(self.adapters.items()):
            await adapter.close()
            self._remove_tool(self.registry[bot_id])
        self.adapters.clear()
