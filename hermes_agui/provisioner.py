"""Allowlisted native profile provisioning; paths and provider secrets are host-owned."""
from dataclasses import dataclass, field
from pathlib import Path
import shutil

from pydantic import BaseModel, ConfigDict, Field

from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig
from hermes_agui.host import BotConfig


class BotSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    name: str = Field(default="", max_length=100)
    description: str = Field(default="", max_length=2000)
    templateId: str = Field(min_length=1, max_length=64)
    principal: str = Field(min_length=1, max_length=512)
    projectId: str = Field(min_length=1, max_length=512)
    ownerId: str | None = Field(default=None, min_length=1, max_length=512)
    token: str = Field(min_length=16, max_length=512, repr=False)
    memoryKey: str = Field(min_length=16, max_length=512, repr=False)
    skills: list[str] = Field(default_factory=list, max_length=32)
    toolsets: list[str] = Field(default_factory=list, max_length=32)


@dataclass(frozen=True)
class ProvisionTemplate:
    model: str | None = None
    provider: str | None = None
    api_key: str | None = field(default=None, repr=False)
    base_url: str | None = None
    config: dict = field(default_factory=dict)
    skills: dict[str, Path] = field(default_factory=dict)
    toolsets: tuple[str, ...] = ("memory", "skills")
    agent_options: dict = field(default_factory=dict)
    llm_registry: dict | None = field(default=None, repr=False)
    model_role: str = "agent_primary"
    llm_credentials: dict[str, str] = field(default_factory=dict, repr=False)


    def __post_init__(self):
        object.__setattr__(self, "llm_credentials", dict(self.llm_credentials))
        if self.llm_registry is not None:
            from hermes_agui.core.llm_registry import parse_registry, agent_route
            if self.model or self.provider or self.api_key or self.base_url:
                raise ValueError("Registry role conflicts with legacy template routing")
            registry = parse_registry(self.llm_registry)
            agent_route(self.llm_registry, self.model_role)
            object.__setattr__(self, "llm_registry", registry.model_dump(exclude_none=True))


class HermesBotProvisioner:
    def __init__(self, root: Path, templates: dict[str, ProvisionTemplate]):
        root = Path(root).absolute()
        if root.is_symlink():
            raise ValueError("Managed root cannot be a symlink")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root = root.resolve()
        self.templates = templates

    def _directory(self, parent, name, *, create=True):
        path = parent / name
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError("Unsafe managed directory")
        if create:
            path.mkdir(exist_ok=True, mode=0o700)
        elif not path.is_dir():
            raise ValueError("Managed profile is unavailable")
        if path.resolve() != path or not path.is_relative_to(self.root):
            raise ValueError("Managed path escaped its root")
        return path

    def prepare(self, spec: BotSpec, previous: BotSpec | None = None, *, restore=False):
        template = self.templates.get(spec.templateId)
        if template is None or set(spec.skills) - template.skills.keys() or set(spec.toolsets) - set(template.toolsets):
            raise ValueError("Unknown template or capability")
        parent = self._directory(self.root, spec.id, create=not restore)
        home = self._directory(parent, "home", create=not restore)
        workspace = self._directory(parent, "workspace", create=not restore)
        # Refuse pre-existing links before native initialization/config writes.
        if any(path.is_symlink() for path in home.rglob("*")):
            raise ValueError("Managed profile contains a symlink")
        if restore:
            if not (home / "config.yaml").is_file():
                raise ValueError("Managed profile configuration is unavailable")
        else:
            self._initialize(home, spec, template, previous)
        return BotConfig(spec.id, AgentConfig(home, workspace, principal=spec.principal,
            model=template.model, provider=template.provider, api_key=template.api_key,
            llm_registry=template.llm_registry, model_role=template.model_role, llm_credentials=template.llm_credentials,
            base_url=template.base_url, enabled_toolsets=tuple(spec.toolsets),
            agent_options=template.agent_options), ServerConfig(spec.token,
                runtime_memory_key=spec.memoryKey, runtime_memory_project=spec.projectId))

    def _initialize(self, home, spec, template, previous):
        from agent.runtime_scope import bind_profile_scope
        from hermes_cli.config import ensure_hermes_home, save_config

        with bind_profile_scope(home):
            ensure_hermes_home()
            profile_config = dict(template.config)
            model = dict(profile_config.get("model", {}))
            if template.model:
                model["default"] = template.model
            if template.provider:
                model["provider"] = template.provider
            if template.base_url:
                model["base_url"] = template.base_url
            profile_config["model"] = model
            save_config(profile_config, merge_existing=True)
        if previous is None or (previous.name, previous.description) != (spec.name, spec.description):
            (home / "SOUL.md").write_text(f"# {spec.name or spec.id}\n\n{spec.description}\n", encoding="utf-8")
        self._install_skills(home, spec.skills, template, previous.skills if previous else [])

    def _install_skills(self, home, selected, template, previous):
        archive = self._directory(home, ".archived-managed-skills")
        for name in set(previous) - set(selected):
            target = home / "skills" / name
            destination = archive / name
            if destination.exists() and target.exists():
                raise ValueError("An archived skill already exists")
            if target.exists():
                shutil.move(str(target), destination)
        for name in selected:
            if not name or Path(name).name != name or name in {".", ".."}:
                raise ValueError("Invalid skill name")
            source = Path(template.skills[name])
            if source.is_symlink() or any(p.is_symlink() for p in source.rglob("*")):
                raise ValueError("Approved skill contains a symlink")
            target = home / "skills" / name
            if not target.exists():
                if (archive / name).exists():
                    shutil.move(str(archive / name), target)
                else:
                    shutil.copytree(source, target)
