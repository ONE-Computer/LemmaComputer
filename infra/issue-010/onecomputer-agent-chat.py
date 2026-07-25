#!/usr/bin/env python3
"""Private native-agent adapter exposing ONEComputer's canonical Chat event stream."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

AGENT = os.environ["ONECOMPUTER_CHAT_AGENT"]
API_KEY = os.environ["ONECOMPUTER_CHAT_API_KEY"]
MODEL = os.environ["ONECOMPUTER_CHAT_MODEL_ALIAS"]
ALLOWED_TOOLS = tuple(item for item in os.environ["ONECOMPUTER_CHAT_ALLOWED_TOOLS"].split(",") if item)
BROKER = os.environ["ONECOMPUTER_CHAT_BROKER"]
PORT = int(os.environ["ONECOMPUTER_CHAT_PORT"])
HERMES_URL = os.environ.get("ONECOMPUTER_HERMES_CHAT_URL", "")
HERMES_KEY = os.environ.get("ONECOMPUTER_HERMES_CHAT_KEY", "")
HOME = Path("/home/kasm-user")
STATE_DIR = HOME / ".onecomputer-chat" / AGENT
STATE_FILE = STATE_DIR / "structured-sessions.json"
MAX_MESSAGE = 16_000
MAX_TEXT = 128_000
SYSTEM_PROMPT = (
    "You are the selected agent in a ONEComputer managed workspace. "
    "Use only the provided onecomputer_ms365 MCP tools for Microsoft 365 work. "
    "ONEComputer Control is the authority for tool policy and signed approvals. "
    "If a protected operation is pending, use wait-for-governed-operation and "
    "report the final result accurately. Never claim an operation completed until "
    "the tool confirms it."
)
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
OPERATION_PATTERN = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b"
)
APPROVAL_STATES = (
    "approval_required", "approved", "executing", "succeeded", "denied", "failed", "expired"
)

if (
    AGENT not in {"claude-cli", "codex-cli", "hermes-claw"}
    or len(API_KEY) < 32
    or not MODEL
    or not ALLOWED_TOOLS
    or BROKER not in {
        "http://127.0.0.1:4314",
        "http://127.0.0.1:4315",
        "http://127.0.0.1:4317",
    }
    or PORT not in {8642, 8643, 8644}
    or (AGENT == "hermes-claw" and (
        HERMES_URL != "http://127.0.0.1:8652" or len(HERMES_KEY) < 32
    ))
):
    raise SystemExit("invalid agent Chat configuration")

state_lock = asyncio.Lock()
active_lock = asyncio.Lock()
active_sessions: set[str] = set()
codex: Any = None
http: httpx.AsyncClient | None = None


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {"version": 2, "sessions": []}
    try:
        document = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise RuntimeError("chat state is unavailable") from None
    if document.get("version") != 2 or not isinstance(document.get("sessions"), list):
        raise RuntimeError("chat state is invalid")
    return document


def write_state(document: dict[str, Any]) -> None:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".structured-sessions-", dir=STATE_DIR)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(document, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, STATE_FILE)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def public_session(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "title": item.get("title"),
        "created_at": item["createdAt"],
        "updated_at": item["updatedAt"],
    }


async def body(request: Request) -> dict[str, Any]:
    try:
        value = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError("invalid JSON") from None
    if not isinstance(value, dict):
        raise ValueError("invalid JSON")
    return value


def authorized(request: Request) -> bool:
    supplied = request.headers.get("authorization", "")
    expected = f"Bearer {API_KEY}"
    return hmac.compare_digest(supplied.encode(), expected.encode())


def find_session(document: dict[str, Any], session_id: str) -> dict[str, Any] | None:
    return next((item for item in document["sessions"] if item.get("id") == session_id), None)


def safe_identifier(prefix: str, turn_id: str, source: str) -> str:
    return f"{prefix}-{uuid.uuid5(uuid.NAMESPACE_URL, f'onecomputer:{turn_id}:{source}').hex}"


def safe_tool_name(value: object) -> str:
    candidate = str(value or "workspace-tool").replace("mcp__onecomputer_ms365__", "")
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]", "-", candidate)[:160]
    return cleaned or "workspace-tool"


def safe_summary(value: object, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    return " ".join(value.split())[:500] or fallback


def approval_from(value: object) -> tuple[str, str] | None:
    text = value if isinstance(value, str) else json.dumps(value, default=str, separators=(",", ":"))
    identifier = OPERATION_PATTERN.search(text)
    if not identifier:
        return None
    lowered = text.lower()
    normalized = re.sub(r"[\s-]+", "_", lowered)
    if (
        "approval_required" in normalized
        or re.search(r"\bapproval\s+(?:is\s+)?required\b", lowered)
        or re.search(r"\bapproval\s+remains\s+pending\b", lowered)
        or re.search(r"\bwaiting\s+for\s+approval\b", lowered)
    ):
        state = "approval_required"
    else:
        state = next((candidate for candidate in APPROVAL_STATES[1:] if candidate in normalized), None)
    return (identifier.group(0).lower(), state) if state else None


def approval_summary(state: str) -> str:
    return {
        "approval_required": "Waiting for signed approval",
        "approved": "Approval received",
        "executing": "Approved action is running",
        "succeeded": "Approved action completed",
        "denied": "Approval was denied; the action did not run",
        "failed": "The governed action failed",
        "expired": "Approval expired; the action did not run",
    }[state]


def validate_user_message(value: object) -> tuple[dict[str, Any], str]:
    if not isinstance(value, dict) or value.get("role") != "user":
        raise ValueError("invalid message")
    message_id = value.get("id")
    metadata = value.get("metadata")
    parts = value.get("parts")
    if (
        not isinstance(message_id, str)
        or not ID_PATTERN.fullmatch(message_id)
        or not isinstance(metadata, dict)
        or metadata.get("agentCatalogId") != AGENT
        or metadata.get("state") != "completed"
        or not isinstance(metadata.get("createdAt"), str)
        or not isinstance(parts, list)
        or len(parts) != 1
        or not isinstance(parts[0], dict)
        or parts[0].get("type") != "text"
        or not isinstance(parts[0].get("text"), str)
    ):
        raise ValueError("invalid message")
    text = parts[0]["text"].strip()
    if not text or len(text) > MAX_MESSAGE:
        raise ValueError("invalid message")
    return {
        "id": message_id,
        "role": "user",
        "metadata": {
            "agentCatalogId": AGENT,
            "state": "completed",
            "createdAt": metadata["createdAt"],
        },
        "parts": [{"type": "text", "text": text, "state": "done"}],
    }, text


def apply_event(message: dict[str, Any], event: dict[str, Any]) -> None:
    parts: list[dict[str, Any]] = message["parts"]
    event_type = event["type"]
    if event_type == "text-delta":
        existing = next((part for part in parts if part.get("_id") == event["textId"]), None)
        if existing is None:
            existing = {"type": "text", "text": "", "state": "streaming", "_id": event["textId"]}
            parts.append(existing)
        existing["text"] = (existing["text"] + event["delta"])[:MAX_TEXT]
        return
    data_type = {
        "progress": "data-progress",
        "tool": "data-tool",
        "approval": "data-approval",
    }.get(event_type)
    if data_type:
        part_id = event.get("activityId") or event.get("toolCallId") or event.get("approvalId")
        if event_type == "progress":
            data = {
                "activityId": event["activityId"],
                "label": event["label"],
                "state": event["state"],
            }
        elif event_type == "tool":
            data = {
                "toolCallId": event["toolCallId"],
                "name": event["name"],
                "state": event["state"],
                **({"summary": event["summary"]} if event.get("summary") else {}),
            }
        else:
            data = {
                "approvalId": event["approvalId"],
                "toolCallId": event["toolCallId"],
                "operationId": event["operationId"],
                "state": event["state"],
                "summary": event["summary"],
            }
        existing = next((part for part in parts if part.get("id") == part_id), None)
        replacement = {"type": data_type, "id": part_id, "data": data}
        if existing is None:
            parts.append(replacement)
        else:
            parts[parts.index(existing)] = replacement
        return
    if event_type == "turn-finish":
        for part in parts:
            if part["type"] == "text":
                part["state"] = "done"
                part.pop("_id", None)
            elif part["type"] == "data-progress" and part["data"]["state"] == "running":
                part["data"]["state"] = "completed"
                part["data"]["label"] = {
                    "completed": "Work complete",
                    "cancelled": "Work stopped",
                    "failed": "Work failed",
                }[event["state"]]
            elif part["type"] == "data-tool" and part["data"]["state"] == "running":
                part["data"]["state"] = "failed"
                part["data"]["summary"] = (
                    "Stopped before the tool returned"
                    if event["state"] == "cancelled"
                    else "The tool did not return a final result"
                )
        parts.append({
            "type": "data-terminal",
            "id": f"terminal-{event['turnId']}",
            "data": {
                "turnId": event["turnId"],
                "state": event["state"],
                **({"message": event["message"]} if event.get("message") else {}),
            },
        })
        message["metadata"]["state"] = event["state"]


async def claude_vendor_events(item: dict[str, Any], text: str, turn_id: str) -> AsyncIterator[dict[str, Any]]:
    from claude_agent_sdk import (
        AssistantMessage, ClaudeAgentOptions, ResultMessage, StreamEvent,
        ToolResultBlock, ToolUseBlock, UserMessage, query,
    )

    tool_names = [f"mcp__onecomputer_ms365__{name}" for name in (*ALLOWED_TOOLS, "wait-for-governed-operation")]
    had_messages = bool(item["messages"])
    options = ClaudeAgentOptions(
        allowed_tools=tool_names,
        disallowed_tools=[
            "Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "Skill",
            "Task", "TodoWrite", "WebFetch", "WebSearch", "Write",
        ],
        system_prompt=SYSTEM_PROMPT,
        mcp_servers={
            "onecomputer_ms365": {
                "type": "stdio",
                "command": "/usr/local/libexec/onecomputer-mcp-stdio",
                "args": [],
                "env": {"ONECOMPUTER_MCP_BROKER": BROKER},
            },
        },
        strict_mcp_config=True,
        permission_mode="dontAsk",
        resume=item.get("vendorSessionId") if had_messages else None,
        session_id=None if had_messages else item["id"],
        max_turns=30,
        model=MODEL,
        cwd=str(HOME),
        cli_path="/opt/onecomputer/claude-code/2.1.215/claude",
        include_partial_messages=True,
        env={
            "ANTHROPIC_BASE_URL": BROKER,
            "ANTHROPIC_AUTH_TOKEN": "onecomputer-loopback-broker",
            "CLAUDE_CONFIG_DIR": str(HOME / ".claude-chat-sdk"),
            "HOME": str(HOME),
            "PATH": "/usr/local/bin:/usr/bin:/bin",
        },
    )
    result: Any = None
    streamed_text = False
    names: dict[str, str] = {}
    async for sdk_event in query(prompt=text, options=options):
        if isinstance(sdk_event, StreamEvent):
            raw = sdk_event.event
            delta = raw.get("delta") if isinstance(raw, dict) else None
            if isinstance(delta, dict) and delta.get("type") == "text_delta" and isinstance(delta.get("text"), str):
                streamed_text = True
                yield {"kind": "text", "delta": delta["text"]}
        elif isinstance(sdk_event, (AssistantMessage, UserMessage)) and isinstance(sdk_event.content, list):
            for block in sdk_event.content:
                if isinstance(block, ToolUseBlock):
                    tool_id = safe_identifier("tool", turn_id, block.id)
                    names[block.id] = safe_tool_name(block.name)
                    yield {"kind": "tool", "id": tool_id, "name": names[block.id], "state": "running"}
                elif isinstance(block, ToolResultBlock):
                    tool_id = safe_identifier("tool", turn_id, block.tool_use_id)
                    name = names.get(block.tool_use_id, "workspace-tool")
                    approval = approval_from(block.content)
                    approval_state = approval[1] if approval else None
                    state = (
                        "failed" if block.is_error or approval_state in {"denied", "failed", "expired"}
                        else "completed" if approval_state in {None, "succeeded"}
                        else "running"
                    )
                    yield {
                        "kind": "tool", "id": tool_id, "name": name, "state": state,
                        "summary": (
                            "Tool failed" if state == "failed"
                            else "Tool completed" if state == "completed"
                            else "Waiting for governed approval"
                        ),
                    }
                    if approval:
                        operation_id, approval_state = approval
                        yield {
                            "kind": "approval",
                            "id": f"approval-{operation_id}",
                            "toolId": tool_id,
                            "operationId": operation_id,
                            "state": approval_state,
                        }
        elif isinstance(sdk_event, ResultMessage):
            result = sdk_event
    if result is None or result.is_error:
        raise RuntimeError("Claude could not complete the request")
    if not streamed_text and result.result:
        yield {"kind": "text", "delta": result.result}
    yield {
        "kind": "vendor-finish",
        "vendorSessionId": result.session_id,
        "state": "cancelled" if result.terminal_reason in {"aborted_streaming", "aborted_tools"} else "completed",
    }


async def codex_vendor_events(item: dict[str, Any], text: str, turn_id: str) -> AsyncIterator[dict[str, Any]]:
    from openai_codex import ApprovalMode, Sandbox

    vendor_id = item.get("vendorSessionId")
    if vendor_id:
        thread = await codex.thread_resume(
            vendor_id,
            approval_mode=ApprovalMode.deny_all,
            base_instructions=SYSTEM_PROMPT,
            cwd=str(HOME),
            model=MODEL,
            sandbox=Sandbox.read_only,
        )
    else:
        thread = await codex.thread_start(
            approval_mode=ApprovalMode.deny_all,
            base_instructions=SYSTEM_PROMPT,
            cwd=str(HOME),
            model=MODEL,
            sandbox=Sandbox.read_only,
        )
    turn = await thread.turn(text, approval_mode=ApprovalMode.deny_all, sandbox=Sandbox.read_only)
    streamed_text = False
    final_text = ""
    tool_names: dict[str, str] = {}
    try:
        async for notification in turn.stream():
            payload = notification.payload
            if notification.method == "item/agentMessage/delta":
                delta = getattr(payload, "delta", None)
                if isinstance(delta, str) and delta:
                    streamed_text = True
                    yield {"kind": "text", "delta": delta}
            elif notification.method == "item/mcpToolCall/progress":
                raw_id = str(getattr(payload, "item_id", "tool"))
                yield {
                    "kind": "tool",
                    "id": safe_identifier("tool", turn_id, raw_id),
                    "name": tool_names.get(raw_id, "workspace-tool"),
                    "state": "running",
                    "summary": safe_summary(getattr(payload, "message", None), "Tool is running"),
                }
            elif notification.method in {"item/started", "item/completed"}:
                wrapped = getattr(payload, "item", None)
                sdk_item = getattr(wrapped, "root", wrapped)
                item_type = getattr(sdk_item, "type", None)
                if item_type == "mcpToolCall":
                    raw_id = str(getattr(sdk_item, "id", "tool"))
                    name = safe_tool_name(getattr(sdk_item, "tool", "workspace-tool"))
                    tool_names[raw_id] = name
                    status = getattr(getattr(sdk_item, "status", None), "value", "inProgress")
                    state = "failed" if status == "failed" else "completed" if notification.method == "item/completed" else "running"
                    approval = approval_from(getattr(sdk_item, "result", None))
                    approval_state = approval[1] if approval else None
                    if approval_state in {"approval_required", "approved", "executing"}:
                        state = "running"
                    elif approval_state in {"denied", "failed", "expired"}:
                        state = "failed"
                    yield {
                        "kind": "tool",
                        "id": safe_identifier("tool", turn_id, raw_id),
                        "name": name,
                        "state": state,
                        **({
                            "summary": (
                                "Tool failed" if state == "failed"
                                else "Tool completed" if state == "completed"
                                else "Waiting for governed approval"
                            )
                        } if approval else ({
                            "summary": "Tool failed" if state == "failed" else "Tool completed"
                        } if state != "running" else {})),
                    }
                    if approval:
                        operation_id, approval_state = approval
                        yield {
                            "kind": "approval",
                            "id": f"approval-{operation_id}",
                            "toolId": safe_identifier("tool", turn_id, raw_id),
                            "operationId": operation_id,
                            "state": approval_state,
                        }
                elif notification.method == "item/completed" and item_type == "agentMessage":
                    candidate = getattr(sdk_item, "text", "")
                    phase = getattr(getattr(sdk_item, "phase", None), "value", None)
                    if isinstance(candidate, str) and (phase == "final_answer" or not final_text):
                        final_text = candidate
            elif notification.method == "turn/completed":
                status = getattr(getattr(payload.turn, "status", None), "value", "failed")
                if status == "failed":
                    raise RuntimeError("Codex could not complete the request")
                if not streamed_text and final_text:
                    yield {"kind": "text", "delta": final_text}
                yield {
                    "kind": "vendor-finish",
                    "vendorSessionId": thread.id,
                    "state": "cancelled" if status == "interrupted" else "completed",
                }
    except asyncio.CancelledError:
        await turn.interrupt()
        raise


async def hermes_vendor_events(item: dict[str, Any], text: str, _: str) -> AsyncIterator[dict[str, Any]]:
    assert http is not None
    vendor_session_id = item.get("vendorSessionId")
    if not isinstance(vendor_session_id, str) or not vendor_session_id:
        raise RuntimeError("Hermes session is unavailable")
    response = await http.post(
        f"{HERMES_URL}/api/sessions/{vendor_session_id}/chat",
        headers={"authorization": f"Bearer {HERMES_KEY}"},
        json={"message": text},
        timeout=300,
    )
    response.raise_for_status()
    payload = response.json()
    message = payload.get("message") if isinstance(payload, dict) else None
    reply = message.get("content") if isinstance(message, dict) else None
    if not isinstance(reply, str) or not reply:
        raise RuntimeError("Hermes could not complete the request")
    yield {"kind": "text", "delta": reply}
    yield {
        "kind": "vendor-finish",
        "vendorSessionId": str(payload.get("session_id") or vendor_session_id),
        "state": "completed",
    }


def vendor_events(item: dict[str, Any], text: str, turn_id: str) -> AsyncIterator[dict[str, Any]]:
    if AGENT == "claude-cli":
        return claude_vendor_events(item, text, turn_id)
    if AGENT == "codex-cli":
        return codex_vendor_events(item, text, turn_id)
    return hermes_vendor_events(item, text, turn_id)


async def persist_turn(
    session_id: str,
    user_message: dict[str, Any],
    assistant_message: dict[str, Any],
    vendor_session_id: str | None,
    updated_at: str,
) -> None:
    async with state_lock:
        document = read_state()
        item = find_session(document, session_id)
        if item is None:
            return
        item["vendorSessionId"] = vendor_session_id or item.get("vendorSessionId")
        item["updatedAt"] = updated_at
        item["messages"].extend([user_message, assistant_message])
        write_state(document)


async def health(request: Request) -> Response:
    if not authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return JSONResponse({"status": "ready", "agent": AGENT, "protocol": "onecomputer-chat-events/v1"})


async def sessions(request: Request) -> Response:
    if not authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if request.method == "GET":
        async with state_lock:
            items = sorted(read_state()["sessions"], key=lambda item: item["updatedAt"], reverse=True)
        return JSONResponse({"sessions": [public_session(item) for item in items]})
    try:
        value = await body(request)
        title = value.get("title")
        if title is not None and (not isinstance(title, str) or not title.strip()):
            raise ValueError("invalid title")
        created = now()
        item = {
            "id": str(uuid.uuid4()),
            "vendorSessionId": None,
            "title": title.strip()[:120] if title else None,
            "createdAt": created,
            "updatedAt": created,
            "messages": [],
        }
        if AGENT == "hermes-claw":
            assert http is not None
            response = await http.post(
                f"{HERMES_URL}/api/sessions",
                headers={"authorization": f"Bearer {HERMES_KEY}"},
                json={"title": item["title"]} if item["title"] else {},
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json()
            upstream = payload.get("session", payload) if isinstance(payload, dict) else {}
            upstream_id = upstream.get("id") if isinstance(upstream, dict) else None
            if not isinstance(upstream_id, str) or not upstream_id:
                raise RuntimeError("Hermes session creation failed")
            item["vendorSessionId"] = upstream_id
        async with state_lock:
            document = read_state()
            document["sessions"].append(item)
            write_state(document)
        return JSONResponse(public_session(item), status_code=201)
    except (ValueError, RuntimeError, httpx.HTTPError):
        return JSONResponse({"error": "could not create chat session"}, status_code=400)


async def messages(request: Request) -> Response:
    if not authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    session_id = str(request.path_params["session_id"])
    async with state_lock:
        item = find_session(read_state(), session_id)
        if item is None:
            return JSONResponse({"error": "session not found"}, status_code=404)
        values = json.loads(json.dumps(item["messages"]))
    return JSONResponse({"messages": values})


async def turns(request: Request) -> Response:
    if not authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    session_id = str(request.path_params["session_id"])
    try:
        value = await body(request)
        user_message, text = validate_user_message(value.get("message"))
    except ValueError:
        return JSONResponse({"error": "invalid message"}, status_code=400)
    async with state_lock:
        item = find_session(read_state(), session_id)
        if item is None:
            return JSONResponse({"error": "session not found"}, status_code=404)
        snapshot = json.loads(json.dumps(item))
    async with active_lock:
        if session_id in active_sessions:
            return JSONResponse({"error": "turn already active"}, status_code=409)
        active_sessions.add(session_id)

    turn_id = f"turn-{uuid.uuid4()}"
    assistant_id = f"msg-{uuid.uuid4()}"
    created_at = now()
    assistant_message: dict[str, Any] = {
        "id": assistant_id,
        "role": "assistant",
        "metadata": {
            "agentCatalogId": AGENT,
            "turnId": turn_id,
            "state": "streaming",
            "createdAt": created_at,
        },
        "parts": [],
    }

    async def stream() -> AsyncIterator[bytes]:
        sequence = 0
        total_text = 0
        vendor_session_id = snapshot.get("vendorSessionId")

        def canonical(event_type: str, **values: Any) -> dict[str, Any]:
            nonlocal sequence
            event = {
                "version": 1,
                "sequence": sequence,
                "sessionId": session_id,
                "turnId": turn_id,
                "type": event_type,
                **values,
            }
            sequence += 1
            if event_type not in {"turn-start"}:
                apply_event(assistant_message, event)
            return event

        def frame(event: dict[str, Any]) -> bytes:
            return (json.dumps(event, separators=(",", ":")) + "\n").encode()

        try:
            yield frame(canonical("turn-start", messageId=assistant_id, createdAt=created_at))
            activity_id = safe_identifier("progress", turn_id, "agent")
            yield frame(canonical(
                "progress", activityId=activity_id,
                label=f"{AGENT.replace('-cli', '').replace('-claw', '').title()} is working",
                state="running",
            ))
            terminal_state: str | None = None
            async for vendor in vendor_events(snapshot, text, turn_id):
                kind = vendor["kind"]
                if kind == "text" and vendor.get("delta"):
                    raw_delta = str(vendor["delta"])
                    total_text += len(raw_delta)
                    if total_text > MAX_TEXT:
                        raise RuntimeError("agent response exceeded the text limit")
                    for offset in range(0, len(raw_delta), 16_000):
                        yield frame(canonical(
                            "text-delta", textId=f"text-{turn_id}",
                            delta=raw_delta[offset:offset + 16_000],
                        ))
                elif kind == "tool":
                    yield frame(canonical(
                        "tool",
                        toolCallId=vendor["id"],
                        name=vendor["name"],
                        state=vendor["state"],
                        **({"summary": vendor["summary"]} if vendor.get("summary") else {}),
                    ))
                elif kind == "approval":
                    yield frame(canonical(
                        "approval",
                        approvalId=vendor["id"],
                        toolCallId=vendor["toolId"],
                        operationId=vendor["operationId"],
                        state=vendor["state"],
                        summary=approval_summary(vendor["state"]),
                    ))
                elif kind == "vendor-finish":
                    vendor_session_id = vendor.get("vendorSessionId")
                    terminal_state = vendor.get("state", "completed")
            if terminal_state is None:
                raise RuntimeError("agent stream ended without a terminal event")
            yield frame(canonical(
                "progress", activityId=activity_id, label="Work complete", state="completed"
            ))
            completed_at = now()
            yield frame(canonical(
                "turn-finish", state=terminal_state, completedAt=completed_at,
                **({"message": "The turn was cancelled"} if terminal_state == "cancelled" else {}),
            ))
            await persist_turn(
                session_id, user_message, assistant_message, vendor_session_id, completed_at
            )
        except asyncio.CancelledError:
            completed_at = now()
            canonical(
                "turn-finish", state="cancelled", message="Stopped by the employee",
                completedAt=completed_at,
            )
            await asyncio.shield(persist_turn(
                session_id, user_message, assistant_message, vendor_session_id, completed_at
            ))
            raise
        except Exception:
            completed_at = now()
            failed = canonical(
                "turn-finish", state="failed",
                message=f"{AGENT.replace('-cli', '').replace('-claw', '').title()} could not complete the turn",
                completedAt=completed_at,
            )
            yield frame(failed)
            await persist_turn(
                session_id, user_message, assistant_message, vendor_session_id, completed_at
            )
        finally:
            async with active_lock:
                active_sessions.discard(session_id)

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"cache-control": "no-store", "x-onecomputer-chat-protocol": "1"},
    )


@asynccontextmanager
async def lifespan(_: Starlette):
    global codex, http
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    http = httpx.AsyncClient()
    if AGENT == "codex-cli":
        from openai_codex import AsyncCodex, CodexConfig

        codex = AsyncCodex(CodexConfig(
            cwd=str(HOME),
            env={
                "CODEX_HOME": str(HOME / ".codex-chat-sdk"),
                "HOME": str(HOME),
                "OPENAI_API_KEY": "onecomputer-loopback-broker",
                "OPENAI_BASE_URL": f"{BROKER}/v1",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "NO_PROXY": "localhost,127.0.0.1",
            },
        ))
        await codex.__aenter__()
    try:
        yield
    finally:
        if codex is not None:
            await codex.close()
        if http is not None:
            await http.aclose()


app = Starlette(
    routes=[
        Route("/health", health, methods=["GET"]),
        Route("/api/sessions", sessions, methods=["GET", "POST"]),
        Route("/api/sessions/{session_id:uuid}/messages", messages, methods=["GET"]),
        Route("/api/sessions/{session_id:uuid}/turns", turns, methods=["POST"]),
    ],
    lifespan=lifespan,
)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, access_log=False)
