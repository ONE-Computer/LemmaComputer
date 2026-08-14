"""Request-local Hermes MCP identity projection.

The Hermes gateway is a long-lived, concurrent process. Browser chat turns
therefore cannot place their server-issued process identity in ``os.environ``
or in the environment of the shared MCP stdio child. Capture the identity
from Hermes' task-local session context at the tool-dispatch boundary and
project it into MCP request metadata instead.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

_SESSION_IDENTITY_KEY = "LEMMACOMPUTER_AGENT_INSTANCE_ID"
_TOOL_EVENTS = frozenset({"tool.started", "tool.completed", "tool.failed"})


def capture_agent_instance_meta(
    read_session_value: Callable[[str, str], Any] | None = None,
) -> dict[str, Any] | None:
    """Return the current turn's canonical v4 identity as reserved MCP metadata.

    ``None`` deliberately means there is no verified request-local identity.
    The downstream bridge and Control authorization remain fail-closed. A
    present malformed value is an internal trust-boundary violation and must
    never be silently downgraded to an anonymous tool call.
    """

    if read_session_value is None:
        from gateway.session_context import get_session_env

        read_session_value = get_session_env

    value = read_session_value(_SESSION_IDENTITY_KEY, "")
    if not isinstance(value, str):
        raise ValueError("invalid agent instance identity")
    raw = value.strip()
    if not raw:
        return None
    try:
        parsed = uuid.UUID(raw)
    except (AttributeError, ValueError) as error:
        raise ValueError("invalid agent instance identity") from error
    if parsed.version != 4 or str(parsed) != raw:
        raise ValueError("invalid agent instance identity")
    return {"lemmacomputer": {"agentInstanceId": raw}}


def tool_activity_event(event_type: str, is_error: Any = False) -> str:
    """Map Hermes' terminal callback into a truthful browser Activity event."""

    if event_type not in _TOOL_EVENTS:
        raise ValueError("invalid Hermes tool event")
    if event_type == "tool.completed" and is_error is True:
        return "tool.failed"
    return event_type
