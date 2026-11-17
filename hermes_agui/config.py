"""Trusted HTTP host settings; never accepted from RunAgentInput."""

from dataclasses import dataclass, field
from typing import Callable, Any


@dataclass(frozen=True)
class ServerConfig:
    bearer_token: str = field(repr=False)
    max_active_runs: int = 4
    max_receipts: int = 4096
    human_input_timeout: float = 90
    event_capacity: int = 256
    event_bytes: int = 1048576
    tool_projection: Callable[[str, str, Any], Any] | None = field(default=None, repr=False)

    runtime_memory_key: str = field(default="", repr=False)
    runtime_memory_project: str = ""

    def __post_init__(self):
        import math

        if self.runtime_memory_key and (self.runtime_memory_key == self.bearer_token or not self.runtime_memory_project):
            raise ValueError("Runtime memory requires a separate signing key and project")

        if not math.isfinite(self.human_input_timeout) or self.human_input_timeout <= 0:
            raise ValueError("human_input_timeout must be finite and positive")
        if (not self.bearer_token or min(self.max_active_runs, self.max_receipts,
                                       self.event_capacity, self.event_bytes) < 1):
            raise ValueError("A bearer token and positive capacity limits are required")
