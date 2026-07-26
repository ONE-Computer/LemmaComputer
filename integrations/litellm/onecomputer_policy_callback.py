"""Fail-closed LiteLLM MCP pre-call policy callback owned by ONEComputer."""

import asyncio
import hashlib
import json
import os
import urllib.error
import urllib.request

from fastapi import HTTPException
import litellm
from litellm.integrations.custom_logger import CustomLogger


POLICY_URL = os.environ.get(
    "ONECOMPUTER_MCP_POLICY_URL",
    "http://control-api:4100/internal/v1/mcp/authorize",
)
POLICY_TOKEN = os.environ.get("ONECOMPUTER_MCP_POLICY_TOKEN", "")
POLICY_TIMEOUT_SECONDS = 2
POLICY_ATTEMPTS = 2
MS365_SERVER_NAME = "onecomputer_ms365"
MS365_SERVER_ID = hashlib.sha256(
    b"onecomputer_ms365|http://ms365-mcp:3000/mcp|http|oauth2|"
).hexdigest()[:32]
MS365_ACCOUNT_LOOKUP_TOOL = "get-current-user"
MS365_ACCOUNT_LOOKUP_ARGUMENTS = {
    "$select": "displayName,mail,userPrincipalName",
}
AUDIT_ONLY_ARGUMENTS = {"onecomputerAudit"}


def _metadata(auth):
    value = getattr(auth, "metadata", None)
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = None
    return value if isinstance(value, dict) else {}


def _optional_string(metadata, name):
    value = metadata.get(name)
    return value if isinstance(value, str) and value else None


def _server_binding(metadata, data, permitted_servers):
    bindings = metadata.get("onecomputer_mcp_server_bindings")
    if not isinstance(bindings, dict):
        bindings = {}
    server_names = metadata.get("onecomputer_mcp_servers")
    if isinstance(server_names, list) and len(server_names) == len(permitted_servers):
        bindings = {
            **dict(zip(permitted_servers, server_names)),
            **bindings,
        }
    server_id = data.get("server_id")
    if not isinstance(server_id, str) or not server_id:
        server_id = permitted_servers[0] if len(permitted_servers) == 1 else None
    if not isinstance(server_id, str) or server_id not in permitted_servers:
        return None, None
    server_name = bindings.get(server_id)
    if server_id == MS365_SERVER_ID and not isinstance(server_name, str):
        server_name = MS365_SERVER_NAME
    if not isinstance(server_name, str) or not server_name:
        return None, None
    return server_id, server_name


def _is_connection_account_lookup(metadata, payload):
    return (
        metadata.get("onecomputer_connection_credential") is True
        and metadata.get("onecomputer_connection_account_lookup") is True
        and metadata.get("onecomputer_connection_server") == MS365_SERVER_NAME
        and payload.get("tenantId") is not None
        and payload.get("subjectId") is not None
        and payload.get("serverName") == MS365_SERVER_NAME
        and payload.get("toolName") == MS365_ACCOUNT_LOOKUP_TOOL
        and payload.get("arguments") == MS365_ACCOUNT_LOOKUP_ARGUMENTS
    )


def _contains_image_input(value):
    if isinstance(value, str):
        return value.startswith("data:image/")
    if isinstance(value, list):
        return any(_contains_image_input(child) for child in value)
    if not isinstance(value, dict):
        return False
    content_type = value.get("type")
    if content_type in {"image", "image_url", "input_image"}:
        return True
    source = value.get("source")
    if isinstance(source, dict) and (
        source.get("type") == "base64"
        and isinstance(source.get("media_type"), str)
        and source["media_type"].startswith("image/")
    ):
        return True
    return any(_contains_image_input(child) for child in value.values())


def _supports_vision(kwargs):
    candidates = [
        kwargs.get("model_info"),
        kwargs.get("litellm_model_info"),
        kwargs.get("litellm_params", {}).get("model_info")
        if isinstance(kwargs.get("litellm_params"), dict)
        else None,
        kwargs.get("metadata", {}).get("model_info")
        if isinstance(kwargs.get("metadata"), dict)
        else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, dict) and isinstance(candidate.get("supports_vision"), bool):
            return candidate["supports_vision"]
    model = kwargs.get("model")
    if not isinstance(model, str) or not model:
        return False
    try:
        return litellm.get_model_info(model).get("supports_vision") is True
    except Exception:
        return False


def _request_decision(payload):
    if len(POLICY_TOKEN) < 24:
        raise RuntimeError("MCP policy callback token is not configured")
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    result = None
    for attempt in range(POLICY_ATTEMPTS):
        request = urllib.request.Request(
            POLICY_URL,
            data=encoded,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-onecomputer-mcp-policy-token": POLICY_TOKEN,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=POLICY_TIMEOUT_SECONDS) as response:
                if response.status != 200:
                    raise RuntimeError("MCP policy authority returned a non-success status")
                result = json.load(response)
            break
        except urllib.error.HTTPError:
            raise
        except (OSError, urllib.error.URLError):
            # Authorization is idempotent for an exact tool call. If Control
            # committed the operation but the response was lost, one immediate
            # retry recovers the same operation ID instead of making the model
            # retry the original write with newly generated arguments.
            if attempt + 1 >= POLICY_ATTEMPTS:
                raise
    required = {
        "schemaVersion",
        "decision",
        "code",
        "capabilityId",
        "schemaId",
        "schemaHash",
        "operationId",
    }
    if not isinstance(result, dict) or set(result) != required or result.get("schemaVersion") != 1:
        raise RuntimeError("MCP policy authority returned a malformed decision")
    if result.get("decision") not in ("allow", "deny", "approval_required"):
        raise RuntimeError("MCP policy authority returned an unknown decision")
    return result


class OneComputerMcpPolicyCallback(CustomLogger):
    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        image_input = _contains_image_input(kwargs.get("messages")) or _contains_image_input(
            kwargs.get("input")
        )
        if image_input and not _supports_vision(kwargs):
            raise HTTPException(
                status_code=422,
                detail={
                    "error": "MODEL_IMAGE_INPUT_UNSUPPORTED",
                    "message": "The selected model route does not support image input.",
                },
            )
        return kwargs

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if call_type != "call_mcp_tool":
            return data

        metadata = _metadata(user_api_key_dict)
        permission = getattr(user_api_key_dict, "object_permission", None)
        permitted_servers = getattr(permission, "mcp_servers", None)
        if permitted_servers is None and isinstance(permission, dict):
            permitted_servers = permission.get("mcp_servers")
        if not isinstance(permitted_servers, list) or not permitted_servers:
            raise HTTPException(status_code=403, detail={"error": "MCP_SERVER_BINDING_INVALID"})
        # LiteLLM invokes the hook once during request parsing and again from
        # the resolved MCP dispatcher. Enforce policy on the resolved call.
        if data.get("name") is None and data.get("arguments") is None:
            return data
        if not isinstance(data.get("server_id"), str) and len(permitted_servers) > 1:
            bindings = metadata.get("onecomputer_mcp_server_bindings")
            server_names = metadata.get("onecomputer_mcp_servers")
            if not isinstance(bindings, dict):
                bindings = {}
            if isinstance(server_names, list) and len(server_names) == len(permitted_servers):
                bindings = {**dict(zip(permitted_servers, server_names)), **bindings}
            tool_permissions = getattr(permission, "mcp_tool_permissions", None)
            if tool_permissions is None and isinstance(permission, dict):
                tool_permissions = permission.get("mcp_tool_permissions")
            if isinstance(bindings, dict) and isinstance(tool_permissions, dict):
                candidates = [
                    identifier
                    for identifier, name in bindings.items()
                    if isinstance(identifier, str)
                    and isinstance(name, str)
                    and data.get("name") in (
                        tool_permissions.get(identifier, [])
                        or tool_permissions.get(name, [])
                    )
                ]
                if len(candidates) == 1:
                    data = {**data, "server_id": candidates[0]}
        server_id, server_name = _server_binding(metadata, data, permitted_servers)
        if server_id is None or server_name is None:
            raise HTTPException(status_code=403, detail={"error": "MCP_SERVER_BINDING_INVALID"})

        payload = {
            "schemaVersion": 1,
            "tenantId": _optional_string(metadata, "onecomputer_tenant_id"),
            "subjectId": _optional_string(metadata, "onecomputer_subject_id"),
            "workspaceId": _optional_string(metadata, "onecomputer_workspace_id"),
            "agentId": _optional_string(metadata, "onecomputer_agent_id"),
            "policyVersionId": _optional_string(metadata, "onecomputer_policy_version_id"),
            "policyHash": _optional_string(metadata, "onecomputer_policy_hash"),
            "operationId": _optional_string(metadata, "onecomputer_operation_id"),
            "operationDigest": _optional_string(metadata, "onecomputer_operation_digest"),
            "leaseId": _optional_string(metadata, "onecomputer_lease_id"),
            "serverId": server_id,
            "serverName": server_name,
            "toolName": data.get("name"),
            "arguments": data.get("arguments"),
        }
        # A connection credential may read only the non-secret account label
        # displayed on the Connections page. It has no workspace or agent
        # context and is independently restricted to this exact tool by the
        # LiteLLM key's MCP tool permissions.
        if _is_connection_account_lookup(metadata, payload):
            return data
        missing = [
            name
            for name in (
                "tenantId",
                "subjectId",
                "workspaceId",
                "agentId",
                "serverName",
                "toolName",
                "arguments",
            )
            if payload.get(name) is None
        ]
        if missing:
            raise HTTPException(
                status_code=403,
                detail={"error": "MCP_IDENTITY_CONTEXT_MISSING", "missing": missing},
            )
        try:
            decision = await asyncio.to_thread(_request_decision, payload)
        except (OSError, ValueError, RuntimeError, urllib.error.URLError):
            raise HTTPException(status_code=503, detail={"error": "MCP_POLICY_UNAVAILABLE"}) from None

        if decision["decision"] == "allow":
            # Audit context and onecomputerFile are bound into the signed
            # operation but are ONEComputer metadata, not Softeria arguments.
            if isinstance(data.get("arguments"), dict):
                data["arguments"] = {
                    key: value
                    for key, value in data["arguments"].items()
                    if key not in AUDIT_ONLY_ARGUMENTS
                    and not (
                        payload["toolName"] == "create-upload-session"
                        and key == "onecomputerFile"
                    )
                }
            return data
        if decision["decision"] == "approval_required":
            raise HTTPException(
                status_code=409,
                detail={
                    "error": decision["code"],
                    "operation_id": decision["operationId"],
                },
            )
        raise HTTPException(status_code=403, detail={"error": decision["code"]})


proxy_handler_instance = OneComputerMcpPolicyCallback(turn_off_message_logging=True)
