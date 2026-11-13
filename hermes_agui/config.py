"""Trusted HTTP host settings; never accepted from RunAgentInput."""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ServerConfig:
    bearer_token: str = field(repr=False)
    max_active_runs: int = 4
    max_receipts: int = 4096

    def __post_init__(self):
        if not self.bearer_token or self.max_active_runs < 1 or self.max_receipts < 1:
            raise ValueError("A bearer token and positive capacity limits are required")
