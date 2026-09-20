"""Request-local Hermes MCP identity projection.

The Hermes gateway is a long-lived, concurrent process. Browser chat turns
therefore cannot place their server-issued process identity in ``os.environ``
or in the environment of the shared MCP stdio child. Capture the identity
from LemmaComputer's task-local turn context at the tool-dispatch boundary and
project it into MCP request metadata instead.
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, NamedTuple

_SESSION_IDENTITY_KEY = "LEMMACOMPUTER_AGENT_INSTANCE_ID"
_TOOL_EVENTS = frozenset({"tool.started", "tool.completed", "tool.failed"})
_BINDING_HEADER = "x-lemmacomputer-ai-task-binding"
_IDENTITY_HEADER = "x-lemmacomputer-agent-instance-id"
_BINDING_PATTERN = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")


class TurnContext(NamedTuple):
    binding: str | None = None
    agent_instance_id: str | None = None


# None is a native process; an explicitly empty context is an API request and
# MUST NOT inherit a native process identity from the environment.
_TURN: ContextVar[TurnContext | None] = ContextVar("lemmacomputer_hermes_turn", default=None)


def _identity(value: Any) -> str | None:
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
    return raw


def parse_turn_context(headers: Any) -> TurnContext:
    """Validate transport shape; Control remains the signature authority.

    Browser turns carry BOTH fields. Never downgrade a partly missing pair to
    native intent. Neither field is permitted in prompts, tool arguments or logs.
    """
    binding = headers.get(_BINDING_HEADER, "").strip()
    identity = _identity(headers.get(_IDENTITY_HEADER, ""))
    if bool(binding) != bool(identity):
        raise ValueError("incomplete governed turn context")
    if binding and (not 32 <= len(binding) <= 4096 or _BINDING_PATTERN.fullmatch(binding) is None):
        raise ValueError("invalid AI usage task binding")
    return TurnContext(binding or None, identity)


@contextmanager
def bind_turn_context(context: TurnContext | None):
    """Bind inside the executor thread; reset even on cancellation/failure."""
    token = _TURN.set(context)
    try:
        yield
    finally:
        _TURN.reset(token)


def _current_identity() -> str | None:
    context = _TURN.get()
    return context.agent_instance_id if context is not None else _identity(os.environ.get(_SESSION_IDENTITY_KEY, ""))


def model_request_overrides(overrides: Any) -> dict[str, Any]:
    """Copy config-owned dictionaries before adding per-turn SDK headers."""
    if overrides is not None and not isinstance(overrides, dict):
        raise TypeError("runtime request_overrides must be a mapping")
    result = dict(overrides or {})
    raw_headers = result.get("extra_headers")
    if raw_headers is not None and not isinstance(raw_headers, dict):
        raise TypeError("runtime request_overrides.extra_headers must be a mapping")
    headers = {key: value for key, value in (raw_headers or {}).items()
               if str(key).lower() not in {_BINDING_HEADER, _IDENTITY_HEADER}}
    context = _TURN.get()
    identity = _current_identity()
    if context is not None and context.binding:
        headers[_BINDING_HEADER] = context.binding
    if identity:
        headers[_IDENTITY_HEADER] = identity
    if headers or raw_headers is not None:
        result["extra_headers"] = headers
    return result


def capture_agent_instance_meta(
    read_session_value: Callable[[str, str], Any] | None = None,
) -> dict[str, Any] | None:
    """Return the current turn's canonical v4 identity as reserved MCP metadata.

    ``None`` deliberately means there is no verified request-local identity.
    The downstream bridge and Control authorization remain fail-closed. A
    present malformed value is an internal trust-boundary violation and must
    never be silently downgraded to an anonymous tool call.
    """

    raw = (_identity(read_session_value(_SESSION_IDENTITY_KEY, ""))
           if read_session_value is not None else _current_identity())
    if not raw:
        return None
    return {"lemmacomputer": {"agentInstanceId": raw}}


def tool_activity_event(event_type: str, is_error: Any = False) -> str:
    """Map Hermes' terminal callback into a truthful browser Activity event."""

    if event_type not in _TOOL_EVENTS:
        raise ValueError("invalid Hermes tool event")
    if event_type == "tool.completed" and is_error is True:
        return "tool.failed"
    return event_type
