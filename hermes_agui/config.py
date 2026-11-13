"""Trusted HTTP host settings; never accepted from RunAgentInput."""

from dataclasses import dataclass, field
from typing import Callable, Any


@dataclass(frozen=True)
class ServerConfig:
    bearer_token: str = field(repr=False)
    max_active_runs: int = 4
    max_receipts: int = 4096
    event_capacity: int = 256
    event_bytes: int = 1048576
    tool_projection: Callable[[str, str, Any], Any] | None = field(default=None, repr=False)

    def __post_init__(self):
        if (not self.bearer_token or min(self.max_active_runs, self.max_receipts,
                                       self.event_capacity, self.event_bytes) < 1):
            raise ValueError("A bearer token and positive capacity limits are required")
