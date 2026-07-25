#!/usr/bin/env python3
"""Credentialless stdio MCP bridge for Claude Desktop inside a managed workspace."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request


BROKER = os.environ.get("ONECOMPUTER_MCP_BROKER", "http://127.0.0.1:4312")
if BROKER not in {
    "http://127.0.0.1:4312",
    "http://127.0.0.1:4314",
    "http://127.0.0.1:4315",
    "http://127.0.0.1:4316",
    "http://127.0.0.1:4317",
}:
    raise SystemExit("invalid ONEComputer MCP broker")
PROTOCOL_VERSION = "2024-11-05"
TOOLS: dict[str, dict] = {}
WAIT_TOOL_NAME = "wait-for-governed-operation"
WRITE_TOOLS = {
    "create-draft-email", "update-mail-message", "delete-mail-message", "move-mail-message",
    "send-mail", "send-draft-message", "reply-mail-message", "reply-all-mail-message", "forward-mail-message",
    "create-calendar-event", "update-calendar-event", "delete-calendar-event", "create-onedrive-folder",
    "upload-file-content", "move-rename-onedrive-item", "copy-drive-item", "delete-onedrive-file",
    "send-chat-message", "reply-to-chat-message", "send-channel-message", "reply-to-channel-message",
}
DELETE_ONEDRIVE_DESCRIPTION = """Delete one Microsoft OneDrive or SharePoint drive item through ONEComputer governance.

This is a remote Microsoft 365 action, not a local filesystem action. Before calling it, get the item's current top-level eTag with get-drive-item (includeHeaders=true and select=id,name,eTag,parentReference). Pass that exact eTag as If-Match. Call this tool directly; do not request Cowork or local-file deletion permission. ONEComputer Control will obtain any required signed approval and this call will wait for the final result."""
DELETE_ONEDRIVE_MISSING_ETAG = """The remote OneDrive deletion was not submitted because If-Match is missing. Call get-drive-item for this driveId and driveItemId with includeHeaders=true and select=id,name,eTag,parentReference, then call delete-onedrive-file again with the exact top-level eTag as If-Match. Do not use Cowork or local-filesystem deletion permission; ONEComputer handles approval when this remote tool is called."""
CALENDAR_VIEW_DESCRIPTION = """Get chronological event occurrences from the signed-in user's default Outlook calendar within an explicit time window.

Use this tool for requests such as next, upcoming, today, this week, or events between two dates. For upcoming events, set startDateTime to the current time and endDateTime to a bounded future time in ISO 8601 format. Do not use list-calendar-events for upcoming events because that tool returns event series without an implicit from-now window."""


def request_json(path: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"{BROKER}{path}",
        data=None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8"),
        method="GET" if body is None else "POST",
        headers={} if body is None else {"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=70) as response:
        return json.load(response)


def operation_id(value: object) -> str | None:
    if isinstance(value, dict):
        candidate = value.get("operation_id")
        if isinstance(candidate, str):
            return candidate
        for child in value.values():
            found = operation_id(child)
            if found:
                return found
    if isinstance(value, list):
        for child in value:
            found = operation_id(child)
            if found:
                return found
    return None


def omit_nulls(value: object) -> object:
    """Remove null optional fields emitted by upstream MCP adapters.

    MCP result metadata, annotations, and structuredContent are optional
    objects, not nullable values. Some gateway REST projections serialize
    absent fields as null; strict Desktop clients discard those responses and
    eventually report a misleading tool timeout.
    """
    if isinstance(value, dict):
        return {key: omit_nulls(child) for key, child in value.items() if child is not None}
    if isinstance(value, list):
        return [omit_nulls(child) for child in value]
    return value


def normalize_graph_etag(value: str) -> str:
    """Restore the HTTP quoting Graph requires around a drive-item eTag.

    Models sometimes preserve the opaque version value while dropping the
    outer quotes shown in the JSON result. Only normalize the documented
    Graph drive-item shape; leave every other value unchanged so Microsoft can
    reject malformed or unsupported validators.
    """
    candidate = value.strip()
    if ((candidate.startswith('"') and candidate.endswith('"'))
            or (candidate.startswith('W/"') and candidate.endswith('"'))):
        return candidate
    if candidate.startswith("{") and "}," in candidate:
        return f'"{candidate}"'
    return candidate


def discover_tools() -> list[dict]:
    response = request_json("/mcp-rest/tools/list")
    tools = response.get("tools", [])
    if not isinstance(tools, list):
        raise RuntimeError("gateway returned an invalid tool list")
    result = []
    TOOLS.clear()
    for raw in tools:
        if not isinstance(raw, dict) or not isinstance(raw.get("name"), str):
            continue
        TOOLS[raw["name"]] = raw
        input_schema = raw.get("inputSchema", raw.get("input_schema", {"type": "object"}))
        if raw["name"] in WRITE_TOOLS and isinstance(input_schema, dict):
            # Connector execution flags are Control-owned. Do not advertise
            # them as agent inputs; Control adds them only after approval.
            input_schema = json.loads(json.dumps(input_schema))
            properties = input_schema.get("properties")
            if isinstance(properties, dict):
                properties.pop("confirm", None)
                properties.pop("excludeResponse", None)
                properties.pop("includeHeaders", None)
            required = input_schema.get("required")
            if isinstance(required, list):
                required = [item for item in required if item not in {"confirm", "excludeResponse", "includeHeaders"}]
                if raw["name"] == "delete-onedrive-file":
                    required = list(dict.fromkeys(required + ["If-Match"]))
                input_schema["required"] = required
            input_schema["additionalProperties"] = False
        result.append({
            "name": raw["name"],
            "description": DELETE_ONEDRIVE_DESCRIPTION if raw["name"] == "delete-onedrive-file" else CALENDAR_VIEW_DESCRIPTION if raw["name"] == "get-calendar-view" else raw.get("description", "Microsoft 365 tool governed by ONEComputer policy."),
            "inputSchema": input_schema,
        })
    TOOLS[WAIT_TOOL_NAME] = {"name": WAIT_TOOL_NAME, "onecomputer_local": True}
    result.append({
        "name": WAIT_TOOL_NAME,
        "description": "Wait for a protected ONEComputer operation after another Microsoft 365 tool reports that signed approval is pending. Waits for up to 75 seconds. If the operation is still pending, call this tool again with the same operationId. Do not retry the original destructive tool.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "operationId": {
                    "type": "string",
                    "description": "The ONEComputer governed operation ID returned by the protected tool.",
                },
            },
            "required": ["operationId"],
            "additionalProperties": False,
        },
    })
    return result


def wait_for_operation(identifier: str, timeout_seconds: int = 75) -> dict:
    deadline = time.monotonic() + timeout_seconds
    operation: dict = {"id": identifier, "state": "approval_required"}
    while time.monotonic() < deadline:
        operation = request_json(f"/onecomputer/operations/{identifier}")
        state = operation.get("state")
        if state in {"succeeded", "denied", "failed", "expired"}:
            return operation
        time.sleep(1)
    return operation


def operation_result(operation: dict, identifier: str) -> dict:
    if operation.get("state") == "succeeded":
        receipt = operation.get("receipt") if isinstance(operation.get("receipt"), dict) else {}
        summary = receipt.get("resultSummary") or f"{operation.get('safeSummary', 'The governed action')} completed after approval."
        return {
            "content": [{"type": "text", "text": str(summary)}],
            "isError": False,
            "_meta": {"onecomputer": {"operationId": identifier, "state": "succeeded", "approval": "openvtc-task-consent"}},
        }
    state = operation.get("state", "failed")
    if state in {"approval_required", "approved", "executing"}:
        return {
            "content": [{"type": "text", "text": f"The signed approval for operation {identifier} is still pending or being executed. The protected action has not returned a final result. Call {WAIT_TOOL_NAME} again with this same operationId; do not retry the original destructive tool."}],
            "isError": False,
            "_meta": {"onecomputer": {"operationId": identifier, "state": state, "approval": "openvtc-task-consent"}},
        }
    return error_result(f"The governed action was {state}. No further tool execution occurred.", identifier, state)


def call_tool(name: str, arguments: dict) -> dict:
    selected = TOOLS.get(name)
    if selected is None:
        discover_tools()
        selected = TOOLS.get(name)
    if name == WAIT_TOOL_NAME:
        identifier = arguments.get("operationId")
        if not isinstance(identifier, str) or not identifier:
            return error_result("A governed operationId is required.")
        return operation_result(wait_for_operation(identifier), identifier)
    server_id = (selected or {}).get("mcp_info", {}).get("server_id")
    if not isinstance(server_id, str):
        return error_result("That tool is not assigned to this workspace.")
    if name in WRITE_TOOLS:
        # Connector execution flags are never accepted from the model. The
        # managed bridge supplies Softeria's confirmation flag, while Control
        # independently decides whether the action is allowed, held for signed
        # approval, or denied before the connector can execute it.
        arguments = {key: value for key, value in arguments.items() if key not in {"confirm", "excludeResponse", "includeHeaders"}}
        arguments["confirm"] = True
    if name == "delete-onedrive-file":
        if not isinstance(arguments.get("If-Match"), str) or not arguments["If-Match"].strip():
            return error_result(DELETE_ONEDRIVE_MISSING_ETAG)
        arguments["If-Match"] = normalize_graph_etag(arguments["If-Match"])
    try:
        response = request_json("/mcp-rest/tools/call", {
            "server_id": server_id,
            "name": name,
            "arguments": arguments,
        })
        if not isinstance(response.get("content"), list):
            return error_result("The Microsoft 365 connector returned an invalid tool result.")
        return omit_nulls(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {}
        identifier = operation_id(payload)
        if error.code != 409 or not identifier:
            message = nested_error(payload) or f"ONEComputer rejected the tool call (HTTP {error.code})."
            return error_result(message)

    return {
        "content": [{"type": "text", "text": f"Signed approval is required for operation {identifier}. The action has not run. Call {WAIT_TOOL_NAME} now with this operationId and keep calling it while approval remains pending. Do not retry the original destructive tool."}],
        "isError": False,
        "_meta": {"onecomputer": {"operationId": identifier, "state": "approval_required", "approval": "openvtc-task-consent"}},
    }


def nested_error(value: object) -> str | None:
    if isinstance(value, dict):
        candidate = value.get("error")
        if isinstance(candidate, str):
            return candidate
        for child in value.values():
            found = nested_error(child)
            if found:
                return found
    return None


def error_result(message: str, identifier: str | None = None, state: str | None = None) -> dict:
    result = {"content": [{"type": "text", "text": message}], "isError": True}
    if identifier:
        result["_meta"] = {"onecomputer": {"operationId": identifier, "state": state}}
    return result


def respond(identifier: object, result: dict | None = None, error: dict | None = None) -> None:
    document = {"jsonrpc": "2.0", "id": identifier}
    document["result" if error is None else "error"] = result if error is None else error
    print(json.dumps(document, separators=(",", ":")), flush=True)


def handle(message: dict) -> None:
    method = message.get("method")
    identifier = message.get("id")
    if identifier is None:
        return
    try:
        if method == "initialize":
            respond(identifier, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "onecomputer-microsoft-365", "version": "0.1.0"},
                "instructions": "Microsoft 365 tools operate on remote Outlook Mail, Calendar, OneDrive, and Teams resources. Use the corresponding MCP tool directly. Read calls normally run immediately. Writes may return a governed operation; call wait-for-governed-operation with that operationId until signed approval or denial is final. Never substitute Cowork or local-filesystem permission tools. ONEComputer Control enforces policy and obtains signed approval inside protected tool calls.",
            })
        elif method == "ping":
            respond(identifier, {})
        elif method == "tools/list":
            respond(identifier, {"tools": discover_tools()})
        elif method == "tools/call":
            params = message.get("params", {})
            name = params.get("name")
            arguments = params.get("arguments", {})
            if not isinstance(name, str) or not isinstance(arguments, dict):
                raise ValueError("invalid tool call")
            respond(identifier, call_tool(name, arguments))
        else:
            respond(identifier, error={"code": -32601, "message": "Method not found"})
    except Exception as error:  # MCP must report failures without terminating the managed connector.
        print(f"onecomputer-mcp: {type(error).__name__}", file=sys.stderr, flush=True)
        respond(identifier, error={"code": -32603, "message": "The governed Microsoft 365 connector is unavailable."})


for line in sys.stdin:
    try:
        message = json.loads(line)
        if isinstance(message, dict):
            handle(message)
    except json.JSONDecodeError:
        print("onecomputer-mcp: ignored malformed input", file=sys.stderr, flush=True)
