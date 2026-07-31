"""Fail-closed LiteLLM MCP pre-call policy callback owned by ONEComputer."""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
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
USAGE_URL = os.environ.get(
    "ONECOMPUTER_AI_USAGE_URL",
    "http://control-api:4100/internal/v1/ai-usage",
).rstrip("/")
USAGE_TOKEN = os.environ.get("ONECOMPUTER_AI_USAGE_TOKEN", "")
USAGE_STATE_KEY = "onecomputer_usage_state"
USAGE_CHAIN_KEY = "onecomputer_usage_chain"
USAGE_CHAIN_SECRET = hmac.new(
    USAGE_TOKEN.encode("utf-8"),
    b"onecomputer-usage-chain-secret/v1",
    hashlib.sha256,
).digest()
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
    params = kwargs.get("litellm_params")
    candidates = [
        params.get("model_info") if isinstance(params, dict) else None,
        kwargs.get("litellm_model_info"),
        kwargs.get("model_info"),
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


def _as_dict(value):
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        dumped = value.model_dump()
        return dumped if isinstance(dumped, dict) else {}
    if hasattr(value, "dict"):
        dumped = value.dict()
        return dumped if isinstance(dumped, dict) else {}
    return {}


def _metadata_dicts(kwargs):
    values = []
    direct = kwargs.get("metadata")
    if isinstance(direct, dict):
        values.append(direct)
    params = kwargs.get("litellm_params")
    if isinstance(params, dict) and isinstance(params.get("metadata"), dict):
        values.append(params["metadata"])
    return values


def _trusted_key_metadata(kwargs):
    """Read identity only from LiteLLM's authenticated key projection."""
    auth = kwargs.get("user_api_key_dict")
    return _metadata(auth) if auth is not None else {}


def _signed_usage_chain(value):
    encoded = base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).decode("ascii").rstrip("=")
    signature = hmac.new(
        USAGE_CHAIN_SECRET,
        b"onecomputer-usage-chain/v1\0" + encoded.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    return f"{encoded}.{signature}"


def _verified_usage_chain(value):
    if not isinstance(value, str):
        return None
    try:
        encoded, signature = value.split(".", 1)
        expected = hmac.new(
            USAGE_CHAIN_SECRET,
            b"onecomputer-usage-chain/v1\0" + encoded.encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        padding = "=" * (-len(encoded) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(encoded + padding))
        return decoded if isinstance(decoded, dict) else None
    except (ValueError, UnicodeError, json.JSONDecodeError):
        return None


def _request_usage_context_and_strip_reserved(kwargs):
    """Recover only callback-signed lineage or the proxy-owned initial binding."""
    task_binding = None
    parent_attempt_id = None
    for metadata in _metadata_dicts(kwargs):
        chain = _verified_usage_chain(metadata.get(USAGE_CHAIN_KEY))
        if chain is not None:
            candidate = chain.get("taskBinding")
            parent = chain.get("admissionId")
            if task_binding is None and isinstance(candidate, str):
                task_binding = candidate
            if parent_attempt_id is None and isinstance(parent, str):
                parent_attempt_id = parent
        requester = metadata.get("requester_metadata")
        if isinstance(requester, dict):
            candidate = requester.get("onecomputer_task_binding")
            if task_binding is None and isinstance(candidate, str):
                task_binding = candidate
            for name in list(requester):
                if isinstance(name, str) and name.startswith("onecomputer_"):
                    requester.pop(name, None)
        candidate = metadata.get("onecomputer_task_binding")
        if task_binding is None and isinstance(candidate, str):
            task_binding = candidate
        for name in list(metadata):
            if isinstance(name, str) and name.startswith("onecomputer_"):
                metadata.pop(name, None)
    return task_binding, parent_attempt_id


def _model_info(kwargs):
    candidates = []
    params = kwargs.get("litellm_params")
    if isinstance(params, dict):
        candidates.append(params.get("model_info"))
    candidates.extend([kwargs.get("litellm_model_info"), kwargs.get("model_info")])
    for metadata in _metadata_dicts(kwargs):
        candidates.append(metadata.get("model_info"))
    for candidate in candidates:
        if isinstance(candidate, dict) and candidate.get("onecomputer_deployment_id"):
            return candidate
    return {}


def _iso(value=None):
    current = value if isinstance(value, datetime) else datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _usage_request(path, payload):
    if len(USAGE_TOKEN) < 32:
        raise RuntimeError("AI usage callback token is not configured")
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    result = None
    for attempt in range(2):
        request = urllib.request.Request(
            f"{USAGE_URL}/{path}",
            data=encoded,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-onecomputer-ai-usage-token": USAGE_TOKEN,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                if response.status not in (200, 201):
                    raise RuntimeError("AI usage authority returned a non-success status")
                result = json.load(response)
            break
        except urllib.error.HTTPError:
            raise
        except (OSError, urllib.error.URLError):
            if attempt == 1:
                raise
    if not isinstance(result, dict) or result.get("schemaVersion") != 1:
        raise RuntimeError("AI usage authority returned a malformed response")
    return result


def _attempt_kind(kwargs, call_type):
    value = str(getattr(call_type, "value", call_type) or "")
    if "embedding" in value:
        return "embedding"
    previous = kwargs.get("previous_models")
    if not isinstance(previous, list):
        params = kwargs.get("litellm_params")
        previous = params.get("previous_models") if isinstance(params, dict) else None
    if isinstance(previous, list) and previous:
        models = {_as_dict(item).get("model") for item in previous}
        return "fallback" if len(models) > 1 else "retry"
    return "inference"


def _set_usage_state(kwargs, state, task_binding):
    kwargs[USAGE_STATE_KEY] = state
    metadata = kwargs.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        kwargs["metadata"] = metadata
    metadata[USAGE_STATE_KEY] = state
    metadata[USAGE_CHAIN_KEY] = _signed_usage_chain({
        "admissionId": state["admissionId"],
        "taskBinding": task_binding,
    })


def _usage_state(kwargs):
    direct = kwargs.get(USAGE_STATE_KEY)
    if isinstance(direct, dict):
        return direct
    for metadata in _metadata_dicts(kwargs):
        value = metadata.get(USAGE_STATE_KEY)
        if isinstance(value, dict):
            return value
    return None


def _nonnegative_integer(value, fallback=0, maximum=100):
    if isinstance(value, (int, float)) and value >= 0:
        return min(maximum, int(value))
    return fallback


def _nested_parameter(kwargs, name):
    value = kwargs.get(name)
    if value is not None:
        return value
    params = kwargs.get("litellm_params")
    return params.get(name) if isinstance(params, dict) else None


def _text_bytes(value):
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    if isinstance(value, list):
        return sum(_text_bytes(item) for item in value)
    if isinstance(value, dict):
        return sum(_text_bytes(item) for item in value.values())
    return 0


def _estimated_input_tokens(kwargs):
    messages = kwargs.get("messages")
    model = kwargs.get("model")
    try:
        count = litellm.token_counter(model=model, messages=messages)
        if isinstance(count, int) and count >= 0:
            return count
    except Exception:
        pass
    source = messages if messages is not None else kwargs.get("input")
    return max(1, _text_bytes(source))


def _maximum_output_tokens(kwargs, route):
    requested = _nested_parameter(kwargs, "max_tokens") or _nested_parameter(kwargs, "max_output_tokens")
    if isinstance(requested, (int, float)) and requested >= 0:
        return int(requested)
    declared = route.get("max_output_tokens")
    if isinstance(declared, (int, float)) and declared > 0:
        return int(declared)
    try:
        info = litellm.get_model_info(route.get("onecomputer_base_model"))
        declared = info.get("max_output_tokens")
        if isinstance(declared, (int, float)) and declared > 0:
            return int(declared)
    except Exception:
        pass
    return 32768


def _budget_bounds(kwargs, route):
    timeout = _nested_parameter(kwargs, "timeout") or _nested_parameter(kwargs, "request_timeout")
    seconds = float(timeout) if isinstance(timeout, (int, float)) and timeout > 0 else 120.0
    seconds = min(3600.0, max(30.0, seconds))
    maximum_output = _maximum_output_tokens(kwargs, route)
    bounds = {
        "inputTokens": str(_estimated_input_tokens(kwargs)),
        "cacheStatus": "unknown",
        "maximumOutputTokens": str(maximum_output),
        "requestUnits": "1",
        # The hook runs once for every concrete provider invocation, so a retry
        # or fallback receives its own admission rather than hiding here.
        "maxRetries": 0,
        "maxFallbacks": 0,
        "maxAgentSteps": 1,
        "reservationTtlSeconds": int(seconds),
        "providerDeadlineAt": _iso(datetime.now(timezone.utc) + timedelta(seconds=seconds)),
    }
    if route.get("supports_reasoning") is True:
        bounds["maximumReasoningTokens"] = str(maximum_output)
    return bounds


def _admission_payload(
    kwargs, call_type, task_binding, parent_attempt_id=None, budget_bounds=None
):
    trusted = _trusted_key_metadata(kwargs)
    if trusted.get("onecomputer_non_billable_exemption") == "provider-route-test-v1":
        return None
    identity_names = (
        "onecomputer_tenant_id", "onecomputer_subject_id",
        "onecomputer_workspace_id", "onecomputer_agent_id",
    )
    missing = [name for name in identity_names if not isinstance(trusted.get(name), str) or not trusted.get(name)]
    if missing:
        raise RuntimeError(f"AI usage authenticated identity is incomplete: {','.join(missing)}")
    route = _model_info(kwargs)
    route_names = (
        "onecomputer_provider", "onecomputer_provider_account_id",
        "onecomputer_base_model", "onecomputer_deployment_id",
    )
    missing_route = [name for name in route_names if not isinstance(route.get(name), str) or not route.get(name)]
    if missing_route:
        raise RuntimeError(f"AI usage concrete route is incomplete: {','.join(missing_route)}")
    alias = trusted.get("onecomputer_policy_model_alias") or trusted.get("onecomputer_client_model_alias")
    if not isinstance(alias, str) or not alias:
        raise RuntimeError("AI usage requested alias is missing")
    service_class = alias if alias in ("lite", "balanced", "pro") else None
    payload = {
        "schemaVersion": 1,
        "sourceSystem": "litellm",
        "sourceAttemptId": str(uuid.uuid4()),
        "tenantId": trusted["onecomputer_tenant_id"],
        "subjectId": trusted["onecomputer_subject_id"],
        "workspaceId": trusted["onecomputer_workspace_id"],
        "agentId": trusted["onecomputer_agent_id"],
        "taskBinding": task_binding,
        "policyVersionId": trusted.get("onecomputer_policy_version_id"),
        "policyHash": trusted.get("onecomputer_policy_hash"),
        "requestedAlias": alias,
        "requestedServiceClass": service_class,
        "selectedServiceClass": service_class,
        "routeMappingVersion": trusted.get("onecomputer_route_mapping_version"),
        "attemptKind": _attempt_kind(kwargs, call_type),
        "resolvedProvider": route["onecomputer_provider"],
        "providerAccountId": route["onecomputer_provider_account_id"],
        "resolvedModel": route["onecomputer_base_model"],
        "parentAttemptId": parent_attempt_id,
        "resolvedDeploymentId": route["onecomputer_deployment_id"],
        "region": route.get("onecomputer_region"),
        "providerServiceTier": route.get("onecomputer_provider_service_tier"),
        "admittedAt": _iso(),
        "budgetBounds": budget_bounds,
    }
    return {name: value for name, value in payload.items() if value is not None}


def _integer(source, *names):
    for name in names:
        value = source.get(name)
        if isinstance(value, (int, float)) and value >= 0:
            return int(value)
    return 0


def _normalized_units(provider, response_obj):
    response = _as_dict(response_obj)
    usage = _as_dict(response.get("usage"))
    if not usage:
        usage = _as_dict(getattr(response_obj, "usage", None))
    prompt = _integer(usage, "prompt_tokens", "input_tokens", "inputTokens")
    output_total = _integer(usage, "completion_tokens", "output_tokens", "outputTokens")
    total = _integer(usage, "total_tokens", "totalTokens") or prompt + output_total
    prompt_details = _as_dict(usage.get("prompt_tokens_details") or usage.get("input_tokens_details"))
    output_details = _as_dict(usage.get("completion_tokens_details") or usage.get("output_tokens_details"))
    cache_read = _integer(usage, "cache_read_input_tokens", "cacheReadInputTokens") or _integer(prompt_details, "cached_tokens")
    cache_write = _integer(usage, "cache_creation_input_tokens", "cache_write_input_tokens", "cacheWriteInputTokens")
    reasoning = _integer(usage, "reasoning_tokens") or _integer(output_details, "reasoning_tokens")
    input_uncached = prompt if provider in ("anthropic", "bedrock") else max(0, prompt - cache_read - cache_write)
    output = max(0, output_total - reasoning)
    values = [
        ("input_uncached_token", input_uncached, False),
        ("cache_read_token", cache_read, False),
        ("cache_write_token", cache_write, False),
        ("output_token", output, False),
        ("reasoning_token", reasoning, False),
        ("request", 1, False),
        ("provider:total_tokens", total, True),
    ]
    return [
        {"unit": unit, "quantity": str(quantity), **({"diagnostic": True} if diagnostic else {})}
        for unit, quantity, diagnostic in values
        if quantity or unit == "request"
    ], str(total) if total else None


def _cost_drivers(kwargs):
    messages = kwargs.get("messages")
    if not isinstance(messages, list):
        return {}
    attachments = 0
    system = 0
    for message in messages:
        value = _as_dict(message)
        if value.get("role") == "system":
            system += 1
        content = value.get("content")
        if isinstance(content, list):
            attachments += sum(
                1 for item in content
                if isinstance(item, dict) and item.get("type") in (
                    "image", "image_url", "input_image", "file",
                    "input_file", "audio", "input_audio",
                )
            )
    return {
        "conversationHistoryCount": max(0, len(messages) - 1),
        "attachmentCount": attachments,
        "systemPolicyContextCount": system,
    }


def _completion_payload(kwargs, response_obj, start_time, end_time, outcome):
    state = _usage_state(kwargs)
    if not state:
        return None
    units, provider_total = _normalized_units(state["provider"], response_obj)
    latency = None
    if isinstance(start_time, datetime) and isinstance(end_time, datetime):
        latency = max(0, int((end_time - start_time).total_seconds() * 1000))
    payload = {
        "schemaVersion": 1,
        "tenantId": state["tenantId"],
        "admissionId": state["admissionId"],
        "sourceSystem": "litellm",
        "sourceEventId": f"{state['admissionId']}:completion",
        "eventType": "usage",
        "occurredAt": _iso(end_time),
        "outcome": outcome,
        "errorClass": type(response_obj).__name__ if outcome == "failure" else None,
        "latencyMs": latency,
        "providerReportedTotalTokens": provider_total,
        "units": units,
        "costDrivers": _cost_drivers(kwargs),
    }
    return {name: value for name, value in payload.items() if value is not None}


class OneComputerMcpPolicyCallback(CustomLogger):
    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        task_binding, parent_attempt_id = _request_usage_context_and_strip_reserved(kwargs)
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
        route = _model_info(kwargs)
        try:
            payload = _admission_payload(
                kwargs,
                call_type,
                task_binding,
                parent_attempt_id,
                _budget_bounds(kwargs, route) if route else None,
            )
            if payload is None:
                return kwargs
            result = await asyncio.to_thread(_usage_request, "attempts/admit", payload)
        except urllib.error.HTTPError as error:
            status = error.code if error.code in (403, 409, 429) else 503
            raise HTTPException(
                status_code=status,
                detail={"error": "AI_USAGE_ADMISSION_DENIED" if status != 503 else "AI_USAGE_ADMISSION_UNAVAILABLE"},
            ) from None
        except (OSError, ValueError, RuntimeError, urllib.error.URLError):
            raise HTTPException(
                status_code=503,
                detail={"error": "AI_USAGE_ADMISSION_UNAVAILABLE"},
            ) from None
        admission_id = result.get("admissionId")
        if result.get("status") not in ("created", "duplicate") or not isinstance(admission_id, str):
            raise HTTPException(status_code=503, detail={"error": "AI_USAGE_ADMISSION_UNAVAILABLE"})
        _set_usage_state(kwargs, {
            "admissionId": admission_id,
            "tenantId": payload["tenantId"],
            "provider": payload["resolvedProvider"],
        }, task_binding)
        return kwargs

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        payload = _completion_payload(kwargs, response_obj, start_time, end_time, "success")
        if payload is None:
            return
        try:
            await asyncio.to_thread(_usage_request, "events", payload)
        except Exception:
            # Completion telemetry must never replace a successful model response.
            return

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        payload = _completion_payload(kwargs, response_obj, start_time, end_time, "failure")
        if payload is None:
            return
        try:
            await asyncio.to_thread(_usage_request, "events", payload)
        except Exception:
            return

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
