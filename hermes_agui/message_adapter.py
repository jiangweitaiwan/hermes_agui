"""Hermes storage owns history; UI messages are never appended as a transcript."""

from dataclasses import dataclass

from ag_ui.core import RunAgentInput


@dataclass(frozen=True)
class TurnInput:
    thread_id: str
    run_id: str
    message_id: str
    text: str


def adapt_input(value: RunAgentInput) -> TurnInput:
    """Accept a new terminal text user message, ignoring preceding UI history.

    Unknown history is not imported on a new thread. Repeated terminal message IDs
    are rejected by the HTTP admission ledger rather than injected a second time.
    """
    for name, identifier in (("threadId", value.thread_id), ("runId", value.run_id)):
        if not identifier or len(identifier) > 512:
            raise ValueError(f"{name} must contain 1–512 characters")
    if value.tools or value.context or value.state not in (None, {}) or value.forwarded_props not in (None, {}):
        raise ValueError("Frontend tools, context, shared state and forwardedProps are not supported yet")
    if getattr(value, "resume", None):
        raise ValueError("Interrupt resume is not supported yet")
    if not value.messages or value.messages[-1].role != "user":
        raise ValueError("messages must end with a new user message")
    message = value.messages[-1]
    if not message.id or len(message.id) > 512:
        raise ValueError("The user message must have an ID of 1–512 characters")
    content = message.content
    if isinstance(content, list):
        if any(part.type != "text" for part in content):
            raise ValueError("Only text user messages are supported")
        content = "".join(part.text for part in content)
    if not isinstance(content, str) or not content.strip():
        raise ValueError("The final user message must contain text")
    return TurnInput(value.thread_id, value.run_id, message.id, content)
