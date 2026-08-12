"""Fail-closed LiteLLM MCP pre-call policy callback owned by LemmaComputer."""

import asyncio
import base64
import contextvars
import hashlib
import hmac
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
import urllib.error
import urllib.request

from fastapi import HTTPException
import litellm
from litellm.integrations.custom_logger import CustomLogger


LOGGER = logging.getLogger(__name__)


POLICY_URL = os.environ.get(
    "LEMMACOMPUTER_MCP_POLICY_URL",
    "http://control-api:4100/internal/v1/mcp/authorize",
)
POLICY_TOKEN = os.environ.get("LEMMACOMPUTER_MCP_POLICY_TOKEN", "")
WORKSPACE_ACCESS_URL = os.environ.get(
    "LEMMACOMPUTER_WORKSPACE_ACCESS_URL",
    "http://control-api:4100/internal/v1/workspace-access/authorize",
)
WORKSPACE_ACCESS_TOKEN = os.environ.get("LEMMACOMPUTER_WORKSPACE_ACCESS_TOKEN", "")
POLICY_TIMEOUT_SECONDS = 15
POLICY_ATTEMPTS = 2
USAGE_URL = os.environ.get(
    "LEMMACOMPUTER_AI_USAGE_URL",
    "http://control-api:4100/internal/v1/ai-usage",
).rstrip("/")
USAGE_TOKEN = os.environ.get("LEMMACOMPUTER_AI_USAGE_TOKEN", "")
ROUTING_STATE_KEY = "lemmacomputer_routing_state"
USAGE_STATE_KEY = "lemmacomputer_usage_state"
USAGE_CHAIN_KEY = "lemmacomputer_usage_chain"
USAGE_STATE_TTL_SECONDS = 15 * 60
ROUTING_HEALTH_TTL_SECONDS = 60
_ROUTING_HEALTH_LOCK = threading.Lock()
_ROUTING_UNAVAILABLE_UNTIL = {}
_USAGE_STATE_LOCK = threading.Lock()
_USAGE_STATES_BY_CALL = {}
_INTERNAL_ADMISSION_CONTEXT = contextvars.ContextVar(
    "lemmacomputer_internal_admission_context", default=None
)
USAGE_CHAIN_SECRET = hmac.new(
    USAGE_TOKEN.encode("utf-8"),
    b"lemmacomputer-usage-chain-secret/v1",
    hashlib.sha256,
).digest()
MS365_SERVER_NAME = "lemmacomputer_ms365"
MS365_SERVER_ID = hashlib.sha256(
    b"lemmacomputer_ms365|http://ms365-mcp:3000/mcp|http|oauth2|"
).hexdigest()[:32]
MS365_ACCOUNT_LOOKUP_TOOL = "get-current-user"
MS365_ACCOUNT_LOOKUP_ARGUMENTS = {
    "$select": "displayName,mail,userPrincipalName",
}
AUDIT_ONLY_ARGUMENTS = {"lemmacomputerAudit"}

_PROVIDER_INTERNAL_FIELDS = (
    "user_api_key_dict",
    "user_api_key_metadata",
)


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
    bindings = metadata.get("lemmacomputer_mcp_server_bindings")
    if not isinstance(bindings, dict):
        bindings = {}
    server_names = metadata.get("lemmacomputer_mcp_servers")
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
        metadata.get("lemmacomputer_connection_credential") is True
        and metadata.get("lemmacomputer_connection_account_lookup") is True
        and metadata.get("lemmacomputer_connection_server") == MS365_SERVER_NAME
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
                "x-lemmacomputer-mcp-policy-token": POLICY_TOKEN,
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


def _agent_instance_id(data):
    candidates = [data.get("request_headers"), data.get("headers")]
    proxy_request = data.get("proxy_server_request")
    if isinstance(proxy_request, dict):
        candidates.append(proxy_request.get("headers"))
    for headers in candidates:
        if not isinstance(headers, dict):
            continue
        for name, value in headers.items():
            if isinstance(name, str) and name.lower() == "x-lemmacomputer-agent-instance-id" and isinstance(value, str):
                return value
    return None


def _authorize_workspace_access(metadata):
    workspace_id = metadata.get("lemmacomputer_workspace_id")
    if not isinstance(workspace_id, str) or not workspace_id:
        return
    generation = metadata.get("lemmacomputer_access_generation")
    payload = {
        "tenantId": metadata.get("lemmacomputer_tenant_id"),
        "subjectId": metadata.get("lemmacomputer_subject_id"),
        "workspaceId": workspace_id,
        "accessGeneration": generation,
    }
    if (
        len(WORKSPACE_ACCESS_TOKEN) < 24
        or not isinstance(payload["tenantId"], str)
        or not isinstance(payload["subjectId"], str)
        or not isinstance(generation, int)
        or generation < 1
    ):
        raise RuntimeError("Workspace access metadata is incomplete")
    request = urllib.request.Request(
        WORKSPACE_ACCESS_URL,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            "x-lemmacomputer-mcp-policy-token": WORKSPACE_ACCESS_TOKEN,
        },
    )
    with urllib.request.urlopen(request, timeout=0.9) as response:
        result = json.load(response)
    if response.status != 200 or result != {"allowed": True}:
        raise RuntimeError("Workspace access is no longer active")


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


def _litellm_call_id(kwargs):
    candidates = [kwargs.get("litellm_call_id")]
    params = kwargs.get("litellm_params")
    if isinstance(params, dict):
        candidates.append(params.get("litellm_call_id"))
    for metadata in _metadata_dicts(kwargs):
        candidates.append(metadata.get("litellm_call_id"))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _usage_provider_deployment_id(kwargs):
    candidates = []
    params = kwargs.get("litellm_params")
    if isinstance(params, dict):
        candidates.append(params.get("model_info"))
    candidates.extend([kwargs.get("litellm_model_info"), kwargs.get("model_info")])
    for metadata in _metadata_dicts(kwargs):
        candidates.append(metadata.get("model_info"))
    for candidate in candidates:
        if isinstance(candidate, dict):
            deployment_id = candidate.get("lemmacomputer_deployment_id")
            if isinstance(deployment_id, str) and deployment_id:
                return deployment_id
    return None


def _prune_usage_states(now):
    for call_id in list(_USAGE_STATES_BY_CALL):
        live = [
            entry for entry in _USAGE_STATES_BY_CALL[call_id]
            if entry["expiresAt"] > now
        ]
        if live:
            _USAGE_STATES_BY_CALL[call_id] = live
        else:
            _USAGE_STATES_BY_CALL.pop(call_id, None)
    while len(_USAGE_STATES_BY_CALL) > 4096:
        oldest = min(
            _USAGE_STATES_BY_CALL,
            key=lambda call_id: _USAGE_STATES_BY_CALL[call_id][-1]["recordedAt"],
        )
        _USAGE_STATES_BY_CALL.pop(oldest, None)


def _remember_usage_state(kwargs, state):
    call_id = _litellm_call_id(kwargs)
    admission_id = state.get("admissionId") if isinstance(state, dict) else None
    if call_id is None or not isinstance(admission_id, str):
        return
    now = time.monotonic()
    entry = {
        "state": state,
        "providerDeploymentId": _usage_provider_deployment_id(kwargs),
        "recordedAt": now,
        "expiresAt": now + USAGE_STATE_TTL_SECONDS,
    }
    with _USAGE_STATE_LOCK:
        _prune_usage_states(now)
        current = [
            candidate for candidate in _USAGE_STATES_BY_CALL.get(call_id, [])
            if candidate["state"].get("admissionId") != admission_id
        ]
        _USAGE_STATES_BY_CALL[call_id] = (current + [entry])[-8:]
        _prune_usage_states(now)


def _registered_usage_state(kwargs):
    call_id = _litellm_call_id(kwargs)
    if call_id is None:
        return None
    now = time.monotonic()
    deployment_id = _usage_provider_deployment_id(kwargs)
    with _USAGE_STATE_LOCK:
        _prune_usage_states(now)
        entries = _USAGE_STATES_BY_CALL.get(call_id, [])
        if deployment_id is not None:
            matches = [
                entry for entry in entries
                if entry["providerDeploymentId"] == deployment_id
            ]
            if matches:
                return matches[-1]["state"]
        return entries[-1]["state"] if entries else None


def _forget_usage_state(state):
    admission_id = state.get("admissionId") if isinstance(state, dict) else None
    if not isinstance(admission_id, str):
        return
    with _USAGE_STATE_LOCK:
        for call_id in list(_USAGE_STATES_BY_CALL):
            remaining = [
                entry for entry in _USAGE_STATES_BY_CALL[call_id]
                if entry["state"].get("admissionId") != admission_id
            ]
            if remaining:
                _USAGE_STATES_BY_CALL[call_id] = remaining
            else:
                _USAGE_STATES_BY_CALL.pop(call_id, None)


def _trusted_key_metadata(kwargs):
    """Read identity only from LiteLLM's authenticated key projection."""
    auth = kwargs.get("user_api_key_dict")
    return _metadata(auth) if auth is not None else {}


def _provider_request(kwargs):
    """Return provider-bound kwargs without LiteLLM authentication internals."""
    request = {
        name: value
        for name, value in kwargs.items()
        if not (isinstance(name, str) and name.startswith("lemmacomputer_"))
    }
    for name in _PROVIDER_INTERNAL_FIELDS:
        request.pop(name, None)
    metadata = request.get("metadata")
    if isinstance(metadata, dict):
        request["metadata"] = {
            name: value
            for name, value in metadata.items()
            if not (isinstance(name, str) and name.startswith("lemmacomputer_"))
        }
    params = request.get("litellm_params")
    if isinstance(params, dict):
        params = {
            name: value
            for name, value in params.items()
            if not (isinstance(name, str) and name.startswith("lemmacomputer_"))
        }
        nested_metadata = params.get("metadata")
        if isinstance(nested_metadata, dict):
            params["metadata"] = {
                name: value
                for name, value in nested_metadata.items()
                if not (isinstance(name, str) and name.startswith("lemmacomputer_"))
            }
        request["litellm_params"] = params
    return request


def _signed_usage_chain(value):
    encoded = base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).decode("ascii").rstrip("=")
    signature = hmac.new(
        USAGE_CHAIN_SECRET,
        b"lemmacomputer-usage-chain/v1\0" + encoded.encode("ascii"),
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
            b"lemmacomputer-usage-chain/v1\0" + encoded.encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        padding = "=" * (-len(encoded) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(encoded + padding))
        return decoded if isinstance(decoded, dict) else None
    except (ValueError, UnicodeError, json.JSONDecodeError):
        return None


def _request_usage_context_and_strip_reserved(kwargs, source_attempt_id=None):
    """Recover only callback-signed lineage or the proxy-owned initial binding."""
    task_binding = None
    parent_attempt_id = None
    lineage_found = False
    for metadata in _metadata_dicts(kwargs):
        chain = _verified_usage_chain(metadata.get(USAGE_CHAIN_KEY))
        if chain is not None:
            candidate = chain.get("taskBinding")
            if task_binding is None and isinstance(candidate, str):
                task_binding = candidate
            prior_admission_id = chain.get("admissionId")
            prior_source_attempt_id = chain.get("sourceAttemptId")
            original_parent_attempt_id = chain.get("originalParentAttemptId")
            original_parent_is_valid = (
                original_parent_attempt_id is None
                or isinstance(original_parent_attempt_id, str)
            )
            if not lineage_found and isinstance(prior_admission_id, str):
                if (
                    isinstance(source_attempt_id, str)
                    and prior_source_attempt_id == source_attempt_id
                    and "originalParentAttemptId" in chain
                    and original_parent_is_valid
                ):
                    # LiteLLM may enter the deployment hook again for the same
                    # concrete invocation. Preserve the parent admitted the
                    # first time instead of making the attempt its own parent.
                    parent_attempt_id = original_parent_attempt_id
                else:
                    # A different concrete retry/fallback descends from the
                    # prior admitted invocation.
                    parent_attempt_id = prior_admission_id
                lineage_found = True
        requester = metadata.get("requester_metadata")
        if isinstance(requester, dict):
            candidate = requester.get("lemmacomputer_task_binding")
            if task_binding is None and isinstance(candidate, str):
                task_binding = candidate
            for name in list(requester):
                if isinstance(name, str) and name.startswith("lemmacomputer_"):
                    requester.pop(name, None)
        candidate = metadata.get("lemmacomputer_task_binding")
        if task_binding is None and isinstance(candidate, str):
            task_binding = candidate
        for name in list(metadata):
            if isinstance(name, str) and name.startswith("lemmacomputer_"):
                metadata.pop(name, None)
    return task_binding, parent_attempt_id


def _verified_usage_reentry(kwargs, source_attempt_id, route, call_type):
    """Accept a signed same attempt or LiteLLM's internal Responses conversion."""
    if not isinstance(source_attempt_id, str) or not source_attempt_id:
        return False
    route_provider = route.get("lemmacomputer_provider") if isinstance(route, dict) else None
    call_type_value = str(getattr(call_type, "value", call_type) or "").lower()
    internal_responses_conversion = "response" in call_type_value
    for metadata in _metadata_dicts(kwargs):
        chain = _verified_usage_chain(metadata.get(USAGE_CHAIN_KEY))
        state = metadata.get(USAGE_STATE_KEY)
        if (
            isinstance(chain, dict)
            and isinstance(state, dict)
            and (
                chain.get("sourceAttemptId") == source_attempt_id
                or internal_responses_conversion
            )
            and isinstance(chain.get("admissionId"), str)
            and chain.get("admissionId") == state.get("admissionId")
            and isinstance(state.get("tenantId"), str)
            and bool(state.get("tenantId"))
            and isinstance(state.get("provider"), str)
            and bool(state.get("provider"))
            and state.get("provider") == route_provider
        ):
            _remember_usage_state(kwargs, state)
            return True
    context = _INTERNAL_ADMISSION_CONTEXT.get()
    if internal_responses_conversion and isinstance(context, dict):
        state = context.get("state")
        signed_chain = context.get("signedChain")
        chain = _verified_usage_chain(signed_chain)
        if (
            isinstance(state, dict)
            and isinstance(signed_chain, str)
            and isinstance(chain, dict)
            and chain.get("admissionId") == state.get("admissionId")
            and context.get("provider") == route_provider
            and context.get("deploymentId") == route.get("lemmacomputer_deployment_id")
        ):
            kwargs[USAGE_STATE_KEY] = state
            metadata = kwargs.get("metadata")
            if not isinstance(metadata, dict):
                metadata = {}
                kwargs["metadata"] = metadata
            metadata[USAGE_STATE_KEY] = state
            metadata[USAGE_CHAIN_KEY] = signed_chain
            _remember_usage_state(kwargs, state)
            return True
    return False


def _model_info(kwargs):
    candidates = []
    params = kwargs.get("litellm_params")
    if isinstance(params, dict):
        candidates.append(params.get("model_info"))
    candidates.extend([kwargs.get("litellm_model_info"), kwargs.get("model_info")])
    for metadata in _metadata_dicts(kwargs):
        candidates.append(metadata.get("model_info"))
    for candidate in candidates:
        if isinstance(candidate, dict) and candidate.get("lemmacomputer_deployment_id"):
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
                "x-lemmacomputer-ai-usage-token": USAGE_TOKEN,
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


def _routing_state(kwargs):
    value = kwargs.get(ROUTING_STATE_KEY)
    if isinstance(value, dict):
        return value
    for metadata in _metadata_dicts(kwargs):
        value = metadata.get(ROUTING_STATE_KEY)
        if isinstance(value, dict):
            return value
    return None


def _set_routing_state(kwargs, state):
    kwargs[ROUTING_STATE_KEY] = state
    metadata = kwargs.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        kwargs["metadata"] = metadata
    metadata[ROUTING_STATE_KEY] = state


def _record_execution_health(tenant_id, deployment_id, outcome):
    if not isinstance(tenant_id, str) or not isinstance(deployment_id, str):
        return
    key = (tenant_id, deployment_id)
    with _ROUTING_HEALTH_LOCK:
        if outcome == "unavailable":
            _ROUTING_UNAVAILABLE_UNTIL[key] = time.monotonic() + ROUTING_HEALTH_TTL_SECONDS
        elif outcome == "healthy":
            _ROUTING_UNAVAILABLE_UNTIL.pop(key, None)


def _unavailable_deployment_ids(tenant_id):
    now = time.monotonic()
    with _ROUTING_HEALTH_LOCK:
        expired = [key for key, expires_at in _ROUTING_UNAVAILABLE_UNTIL.items() if expires_at <= now]
        for key in expired:
            _ROUTING_UNAVAILABLE_UNTIL.pop(key, None)
        return sorted(
            deployment_id
            for (candidate_tenant, deployment_id), expires_at in _ROUTING_UNAVAILABLE_UNTIL.items()
            if candidate_tenant == tenant_id and expires_at > now
        )[:100]


def _request_routing_metadata(kwargs):
    values = {}
    for metadata in _metadata_dicts(kwargs):
        requester = metadata.get("requester_metadata")
        if isinstance(requester, dict):
            values.update(requester)
        values.update(metadata)
    return values


def _bounded_request_text(value, remaining=8192):
    if remaining <= 0:
        return ""
    if isinstance(value, str):
        return value[:remaining]
    if isinstance(value, list):
        return " ".join(_bounded_request_text(item, remaining) for item in value)[:remaining]
    if isinstance(value, dict):
        return " ".join(_bounded_request_text(item, remaining) for item in value.values())[:remaining]
    return ""


def _routing_signals(kwargs, estimated):
    text = _bounded_request_text(kwargs.get("messages") or kwargs.get("input")).lower()
    signals = []
    if estimated < 20:
        signals.append("short_request")
    if "```" in text or re.search(r"\b(function|class|import|const|def|sql|typescript|python)\b", text):
        signals.append("code_request")
    if re.search(r"\b(api|database|debug|latency|schema|deployment|network|architecture)\b", text):
        signals.append("technical_request")
    if re.search(r"\b(reason|reasoning|prove|trade-?offs?|root cause|step by step|compare and justify)\b", text):
        signals.append("reasoning_request")
    if (isinstance(kwargs.get("messages"), list) and len(kwargs["messages"]) > 4) or re.search(r"(?:^|\n)\s*[1-3][.)]", text):
        signals.append("multi_step_request")
    if estimated > 16000:
        signals.extend(["long_request", "long_context_required"])
    return list(dict.fromkeys(signals)) or ["low_confidence_default"]


def _routing_payload(kwargs):
    trusted = _trusted_key_metadata(kwargs)
    if trusted.get("lemmacomputer_policy_model_alias") != "lemmacomputer-auto":
        return None
    if kwargs.get("model") != "lemmacomputer-auto":
        raise RuntimeError("Governed routing accepts only the synthetic Auto transport alias")
    tenant_id = trusted.get("lemmacomputer_tenant_id")
    subject_id = trusted.get("lemmacomputer_subject_id")
    if not isinstance(tenant_id, str) or not tenant_id or not isinstance(subject_id, str) or not subject_id:
        raise RuntimeError("Governed routing authenticated identity is incomplete")
    call_id = kwargs.get("litellm_call_id")
    if not isinstance(call_id, str) or not call_id:
        params = kwargs.get("litellm_params")
        call_id = params.get("litellm_call_id") if isinstance(params, dict) else None
    if not isinstance(call_id, str) or not call_id:
        raise RuntimeError("Governed routing invocation ID is missing")
    messages = kwargs.get("messages")
    estimated = _estimated_input_tokens(kwargs)
    signals = _routing_signals(kwargs, estimated)
    vision = _contains_image_input(messages) or _contains_image_input(kwargs.get("input"))
    tools = bool(_nested_parameter(kwargs, "tools"))
    if vision:
        signals.append("vision_required")
    if tools:
        signals.append("tools_required")
    signals = list(dict.fromkeys(signals))
    maximum_output = _maximum_output_tokens(kwargs, {})
    request_metadata = _request_routing_metadata(kwargs)
    task_binding = request_metadata.get("lemmacomputer_task_binding")
    if not isinstance(task_binding, str) or len(task_binding) < 32:
        raise RuntimeError("Governed routing requires a signed AI task binding")
    requested_class = request_metadata.get("lemmacomputer_requested_service_class", "auto")
    if requested_class not in ("auto", "lite", "balanced", "pro"):
        raise RuntimeError("Governed routing service class is invalid")
    workspace_id = trusted.get("lemmacomputer_workspace_id")
    agent_id = trusted.get("lemmacomputer_agent_id")
    if not isinstance(workspace_id, str) or not workspace_id or not isinstance(agent_id, str) or not agent_id:
        raise RuntimeError("Governed routing workspace identity is incomplete")
    payload = {
        "schemaVersion": 1,
        "tenantId": tenant_id,
        "subjectId": subject_id,
        "workspaceId": workspace_id,
        "agentId": agent_id,
        "taskBinding": task_binding,
        "requestId": call_id,
        "requestedServiceClass": requested_class,
        "boundedSignals": signals,
        "estimatedInputTokens": estimated,
        "requiredCapabilities": {
            "vision": vision,
            "tools": tools,
            "streaming": bool(kwargs.get("stream")),
            "contextTokens": estimated,
            "outputTokens": maximum_output,
        },
        "expectedUsage": [
            {"unit": "input_uncached_token", "quantity": str(estimated)},
            {"unit": "output_token", "quantity": str(maximum_output)},
        ],
    }
    unavailable = _unavailable_deployment_ids(tenant_id)
    if unavailable:
        payload["unavailableDeploymentIds"] = unavailable
    return payload


def _tracking_metadata(kwargs):
    candidates = [kwargs.get("litellm_metadata"), kwargs.get("metadata")]
    params = kwargs.get("litellm_params")
    if isinstance(params, dict):
        candidates.extend([params.get("litellm_metadata"), params.get("metadata")])
    return [candidate for candidate in candidates if isinstance(candidate, dict)]


def _previous_models(kwargs):
    previous = kwargs.get("previous_models")
    for candidate in _tracking_metadata(kwargs):
        if not isinstance(previous, list):
            previous = candidate.get("previous_models")
    params = kwargs.get("litellm_params")
    if not isinstance(previous, list) and isinstance(params, dict):
        previous = params.get("previous_models")
    return previous if isinstance(previous, list) else []


def _attempt_ordinal(kwargs):
    # LiteLLM v1.93 initializes this to zero before the first router call and
    # sets current_attempt + 1 immediately before each concrete retry.
    for candidate in _tracking_metadata(kwargs):
        value = candidate.get("attempted_retries")
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    # Non-router calls have no retry metadata. The previous-model list is the
    # v1.93 compatibility signal for retries created before tracking starts.
    return len(_previous_models(kwargs))


def _fallback_depth(kwargs):
    value = kwargs.get("fallback_depth")
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _attempt_kind(kwargs, call_type):
    value = str(getattr(call_type, "value", call_type) or "")
    if "embedding" in value:
        return "embedding"
    if _fallback_depth(kwargs) > 0:
        return "fallback"
    if _attempt_ordinal(kwargs) > 0 or _previous_models(kwargs):
        return "retry"
    return "inference"


def _source_attempt_id(kwargs, route):
    # In pinned LiteLLM v1.93 the proxy installs `litellm_call_id` from
    # x-litellm-call-id (or a generated UUID), provider wrappers preserve it,
    # and this hook runs after deployment selection. Never substitute fresh
    # randomness here: replaying the same concrete hook must be idempotent.
    call_id = kwargs.get("litellm_call_id")
    if not isinstance(call_id, str) or not call_id.strip():
        params = kwargs.get("litellm_params")
        call_id = params.get("litellm_call_id") if isinstance(params, dict) else None
    if not isinstance(call_id, str) or not call_id.strip():
        raise RuntimeError("LiteLLM concrete invocation ID is missing")
    identity = {
        "schemaVersion": 1,
        "litellmCallId": call_id.strip(),
        "retryOrdinal": _attempt_ordinal(kwargs),
        "fallbackDepth": _fallback_depth(kwargs),
        "deploymentId": route["lemmacomputer_deployment_id"],
    }
    encoded = json.dumps(identity, separators=(",", ":"), sort_keys=True).encode("utf-8")
    digest = hashlib.sha256(b"lemmacomputer-litellm-attempt/v1\0" + encoded).hexdigest()
    return f"litellm-attempt-{digest}"


def _set_usage_state(
    kwargs, state, task_binding, source_attempt_id, original_parent_attempt_id
):
    owned_state = {**state, "sourceAttemptId": source_attempt_id}
    kwargs[USAGE_STATE_KEY] = owned_state
    metadata = kwargs.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        kwargs["metadata"] = metadata
    metadata[USAGE_STATE_KEY] = owned_state
    metadata[USAGE_CHAIN_KEY] = _signed_usage_chain({
        "admissionId": owned_state["admissionId"],
        "taskBinding": task_binding,
        "sourceAttemptId": source_attempt_id,
        "originalParentAttemptId": original_parent_attempt_id,
    })
    _remember_usage_state(kwargs, owned_state)


def _usage_state(kwargs):
    direct = kwargs.get(USAGE_STATE_KEY)
    if isinstance(direct, dict):
        return direct
    for metadata in _metadata_dicts(kwargs):
        value = metadata.get(USAGE_STATE_KEY)
        if isinstance(value, dict):
            return value
    registered = _registered_usage_state(kwargs)
    if isinstance(registered, dict):
        return registered
    # LiteLLM's Anthropic Messages -> Responses conversion builds fresh hook
    # kwargs and removes callback-owned metadata before the completion hook.
    # Context variables follow the request task, so recover only the state
    # paired with the callback-signed chain created at admission.
    context = _INTERNAL_ADMISSION_CONTEXT.get()
    if isinstance(context, dict):
        value = context.get("state")
        chain = _verified_usage_chain(context.get("signedChain"))
        if (
            isinstance(value, dict)
            and isinstance(chain, dict)
            and isinstance(value.get("admissionId"), str)
            and chain.get("admissionId") == value.get("admissionId")
            and isinstance(value.get("tenantId"), str)
            and bool(value.get("tenantId"))
            and isinstance(value.get("provider"), str)
            and bool(value.get("provider"))
        ):
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
        info = litellm.get_model_info(route.get("lemmacomputer_base_model"))
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
        # The hook runs once for every concrete provider invocation, so a retry
        # or fallback receives its own admission rather than hiding here.
        "maxRetries": 0,
        "maxFallbacks": 0,
        "maxAgentSteps": 1,
        "reservationTtlSeconds": int(seconds),
        "providerDeadlineAt": _iso(datetime.now(timezone.utc) + timedelta(seconds=seconds)),
    }
    if route.get("lemmacomputer_billable_request_unit") is True:
        bounds["requestUnits"] = "1"
    return bounds


def _admission_payload(
    kwargs, call_type, task_binding, parent_attempt_id=None, budget_bounds=None
):
    trusted = _trusted_key_metadata(kwargs)
    if trusted.get("lemmacomputer_non_billable_exemption") == "provider-route-test-v1":
        return None
    identity_names = (
        "lemmacomputer_tenant_id", "lemmacomputer_subject_id",
        "lemmacomputer_workspace_id", "lemmacomputer_agent_id",
    )
    missing = [name for name in identity_names if not isinstance(trusted.get(name), str) or not trusted.get(name)]
    if missing:
        raise RuntimeError(f"AI usage authenticated identity is incomplete: {','.join(missing)}")
    route = _model_info(kwargs)
    route_names = (
        "lemmacomputer_provider", "lemmacomputer_provider_account_id",
        "lemmacomputer_base_model", "lemmacomputer_deployment_id",
    )
    missing_route = [name for name in route_names if not isinstance(route.get(name), str) or not route.get(name)]
    if missing_route:
        raise RuntimeError(f"AI usage concrete route is incomplete: {','.join(missing_route)}")
    alias = trusted.get("lemmacomputer_policy_model_alias") or trusted.get("lemmacomputer_client_model_alias")
    if not isinstance(alias, str) or not alias:
        raise RuntimeError("AI usage requested alias is missing")
    service_class = alias if alias in ("lite", "balanced", "pro") else None
    payload = {
        "schemaVersion": 1,
        "sourceSystem": "litellm",
        "sourceAttemptId": _source_attempt_id(kwargs, route),
        "tenantId": trusted["lemmacomputer_tenant_id"],
        "subjectId": trusted["lemmacomputer_subject_id"],
        "workspaceId": trusted["lemmacomputer_workspace_id"],
        "agentId": trusted["lemmacomputer_agent_id"],
        "taskBinding": task_binding,
        "policyVersionId": trusted.get("lemmacomputer_policy_version_id"),
        "policyHash": trusted.get("lemmacomputer_policy_hash"),
        "requestedAlias": alias,
        "requestedServiceClass": service_class,
        "selectedServiceClass": service_class,
        "routeMappingVersion": trusted.get("lemmacomputer_route_mapping_version"),
        "attemptKind": _attempt_kind(kwargs, call_type),
        "resolvedProvider": route["lemmacomputer_provider"],
        "providerAccountId": route["lemmacomputer_provider_account_id"],
        "resolvedModel": route["lemmacomputer_base_model"],
        "parentAttemptId": parent_attempt_id,
        "resolvedDeploymentId": route["lemmacomputer_deployment_id"],
        "region": route.get("lemmacomputer_region"),
        "providerServiceTier": route.get("lemmacomputer_provider_service_tier"),
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


def _normalized_units(provider, response_obj, billable_request_unit=False):
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
    input_uncached = prompt - cache_read - cache_write
    if input_uncached < 0:
        raise ValueError("provider cache buckets exceed the normalized prompt total")
    output = output_total
    values = [
        ("input_uncached_token", input_uncached, False),
        ("cache_read_token", cache_read, False),
        ("cache_write_token", cache_write, False),
        ("output_token", output, False),
        ("provider:reasoning_tokens", reasoning, True),
        ("request", 1, billable_request_unit is not True),
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
    units, provider_total = _normalized_units(
        state["provider"],
        response_obj,
        state.get("billableRequestUnit") is True,
    )
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


def _deployment_health_status(response_obj, outcome):
    if outcome == "success":
        return "healthy"
    response = _as_dict(response_obj)
    status = response.get("status_code") or response.get("status")
    if not isinstance(status, int):
        status = getattr(response_obj, "status_code", None)
    nested = getattr(response_obj, "response", None)
    if not isinstance(status, int) and nested is not None:
        status = getattr(nested, "status_code", None)
    if status == 429 or (isinstance(status, int) and status >= 500):
        return "unavailable"
    failure_class = type(response_obj).__name__.lower()
    if any(marker in failure_class for marker in (
        "timeout", "connection", "unavailable", "ratelimit", "authentication", "permission",
    )):
        return "unavailable"
    return None


async def _record_routing_observation(kwargs, event_result, completion_payload, response_obj):
    state = _usage_state(kwargs)
    if not state or not state.get("routingDecisionId"):
        return
    event_id = event_result.get("eventId")
    if not isinstance(event_id, str) or not event_id:
        return
    observation = {
        "schemaVersion": 1,
        "tenantId": state["tenantId"],
        "decisionId": state["routingDecisionId"],
        "usageEventId": event_id,
        "outcome": "success" if completion_payload["outcome"] == "success" else "error",
        "actualCost": event_result.get("providerCost"),
        "currency": event_result.get("currency"),
        "latencyMs": completion_payload.get("latencyMs"),
    }
    health_status = _deployment_health_status(response_obj, completion_payload["outcome"])
    if health_status:
        observation["deploymentHealth"] = health_status
    await asyncio.to_thread(_usage_request, "routing/observations", {key:value for key,value in observation.items() if value is not None})
    _record_execution_health(
        state["tenantId"],
        state.get("deploymentId"),
        health_status,
    )


class LemmaComputerMcpPolicyCallback(CustomLogger):
    async def async_pre_routing_hook(self, kwargs, call_type):
        try:
            payload = _routing_payload(kwargs)
            if payload is None:
                return kwargs
            result = await asyncio.to_thread(_usage_request, "routing/decide", payload)
            required = {
                "decisionId", "executedDeploymentId", "executedModelGroup",
                "executedProviderDeployment", "requestedServiceClass",
                "selectedServiceClass", "executedOutputTokenLimit", "binding",
            }
            if (
                not required.issubset(result)
                or not isinstance(result.get("binding"), dict)
                or not isinstance(result.get("executedOutputTokenLimit"), int)
                or result["executedOutputTokenLimit"] <= 0
            ):
                raise RuntimeError("Governed routing authority returned a malformed decision")
            _set_routing_state(kwargs, result)
            kwargs["model"] = result["executedModelGroup"]
            output_limit = result["executedOutputTokenLimit"]
            for name in ("max_tokens", "max_output_tokens"):
                requested = kwargs.get(name)
                if isinstance(requested, (int, float)) and requested > output_limit:
                    kwargs[name] = output_limit
            params = kwargs.get("litellm_params")
            if isinstance(params, dict):
                for name in ("max_tokens", "max_output_tokens"):
                    requested = params.get(name)
                    if isinstance(requested, (int, float)) and requested > output_limit:
                        params[name] = output_limit
            return kwargs
        except urllib.error.HTTPError as error:
            status = error.code if error.code in (403, 409, 429) else 503
            raise HTTPException(status_code=status, detail={"error": "AI_ROUTING_DENIED"}) from None
        except (OSError, ValueError, RuntimeError, urllib.error.URLError):
            raise HTTPException(status_code=503, detail={"error": "AI_ROUTING_UNAVAILABLE"}) from None

    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        routing_state = _routing_state(kwargs)
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
            trusted = _trusted_key_metadata(kwargs)
            if trusted.get("lemmacomputer_policy_model_alias") == "lemmacomputer-auto":
                if not routing_state:
                    raise RuntimeError("Governed routing decision binding is missing")
                access_groups = route.get("access_groups")
                if (
                    not isinstance(access_groups, list)
                    or routing_state.get("executedProviderDeployment") not in access_groups
                ):
                    raise RuntimeError("LiteLLM selected a deployment outside the governed decision")
                actual = {
                    "tenantId": trusted.get("lemmacomputer_tenant_id"),
                    "requestId": routing_state.get("binding", {}).get("requestId"),
                    "deploymentId": routing_state.get("executedDeploymentId"),
                }
                await asyncio.to_thread(_usage_request, "routing/verify", {
                    "binding": routing_state.get("binding"), "actual": actual,
                })
            source_attempt_id = _source_attempt_id(kwargs, route) if route else None
            if _verified_usage_reentry(kwargs, source_attempt_id, route, call_type):
                return _provider_request(kwargs)
            task_binding, parent_attempt_id = _request_usage_context_and_strip_reserved(
                kwargs, source_attempt_id
            )
            payload = _admission_payload(
                kwargs,
                call_type,
                task_binding,
                parent_attempt_id,
                _budget_bounds(kwargs, route) if route else None,
            )
            if payload is None:
                return _provider_request(kwargs)
            if routing_state:
                payload["requestedAlias"] = "lemmacomputer-auto"
                payload["requestedServiceClass"] = routing_state["requestedServiceClass"]
                payload["selectedServiceClass"] = routing_state["selectedServiceClass"]
                payload["routeMappingVersion"] = routing_state["binding"]["mappingVersionId"]
            result = await asyncio.to_thread(_usage_request, "attempts/admit", payload)
        except urllib.error.HTTPError as error:
            status = error.code if error.code in (403, 409, 429) else 503
            raise HTTPException(
                status_code=status,
                detail={"error": "AI_USAGE_ADMISSION_DENIED" if status != 503 else "AI_USAGE_ADMISSION_UNAVAILABLE"},
            ) from None
        except (OSError, ValueError, RuntimeError, urllib.error.URLError) as error:
            metadata_values = _metadata_dicts(kwargs)
            has_signed_chain = any(_verified_usage_chain(value.get(USAGE_CHAIN_KEY)) is not None for value in metadata_values)
            has_usage_state = any(isinstance(value.get(USAGE_STATE_KEY), dict) for value in metadata_values)
            LOGGER.warning(
                "AI usage admission authority failed (%s): %.240s; call_type=%s; model=%s; signed_chain=%s; usage_state=%s",
                type(error).__name__,
                str(error),
                str(getattr(call_type, "value", call_type) or ""),
                str(kwargs.get("model") or "")[:120],
                has_signed_chain,
                has_usage_state,
            )
            raise HTTPException(
                status_code=503,
                detail={"error": "AI_USAGE_ADMISSION_UNAVAILABLE"},
            ) from None
        admission_id = result.get("admissionId")
        if result.get("status") not in ("created", "duplicate") or not isinstance(admission_id, str):
            raise HTTPException(status_code=503, detail={"error": "AI_USAGE_ADMISSION_UNAVAILABLE"})
        usage_state = {
            "admissionId": admission_id,
            "tenantId": payload["tenantId"],
            "provider": payload["resolvedProvider"],
            "billableRequestUnit": route.get("lemmacomputer_billable_request_unit") is True,
            "routingDecisionId": routing_state.get("decisionId") if routing_state else None,
            "deploymentId": routing_state.get("executedDeploymentId") if routing_state else None,
        }
        _set_usage_state(
            kwargs, usage_state, task_binding, payload["sourceAttemptId"], payload.get("parentAttemptId")
        )
        _INTERNAL_ADMISSION_CONTEXT.set({
            "state": kwargs[USAGE_STATE_KEY],
            "signedChain": kwargs["metadata"][USAGE_CHAIN_KEY],
            "provider": route.get("lemmacomputer_provider"),
            "deploymentId": route.get("lemmacomputer_deployment_id"),
        })
        return _provider_request(kwargs)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        state = _usage_state(kwargs)
        recorded = False
        try:
            payload = _completion_payload(kwargs, response_obj, start_time, end_time, "success")
            if payload is None:
                LOGGER.warning(
                    "AI usage completion state missing; call_id=%s",
                    _litellm_call_id(kwargs),
                )
                return
            result = await asyncio.to_thread(_usage_request, "events", payload)
            recorded = True
            await _record_routing_observation(kwargs, result, payload, response_obj)
        except Exception as error:
            # Completion telemetry must never replace a successful model response.
            LOGGER.warning(
                "AI usage success callback failed (%s): %.240s; call_id=%s",
                type(error).__name__,
                str(error),
                _litellm_call_id(kwargs),
            )
            return
        finally:
            if recorded:
                _forget_usage_state(state)
            _INTERNAL_ADMISSION_CONTEXT.set(None)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        state = _usage_state(kwargs)
        recorded = False
        try:
            payload = _completion_payload(kwargs, response_obj, start_time, end_time, "failure")
            if payload is None:
                LOGGER.warning(
                    "AI usage failure state missing; call_id=%s",
                    _litellm_call_id(kwargs),
                )
                return
            result = await asyncio.to_thread(_usage_request, "events", payload)
            recorded = True
            await _record_routing_observation(kwargs, result, payload, response_obj)
        except Exception as error:
            LOGGER.warning(
                "AI usage failure callback failed (%s): %.240s; call_id=%s",
                type(error).__name__,
                str(error),
                _litellm_call_id(kwargs),
            )
            return
        finally:
            if recorded:
                _forget_usage_state(state)
            _INTERNAL_ADMISSION_CONTEXT.set(None)

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        metadata = _metadata(user_api_key_dict)
        try:
            await asyncio.to_thread(_authorize_workspace_access, metadata)
        except urllib.error.HTTPError as error:
            status = 403 if error.code in (401, 403) else 503
            raise HTTPException(status_code=status, detail={"error": "WORKSPACE_ACCESS_REVOKED"}) from None
        except (OSError, ValueError, RuntimeError, urllib.error.URLError):
            raise HTTPException(status_code=503, detail={"error": "WORKSPACE_ACCESS_UNAVAILABLE"}) from None
        if call_type != "call_mcp_tool":
            # v1.93 invokes this owned callback after key authorization for the
            # sole synthetic alias and before Router model-group lookup.
            data["user_api_key_dict"] = user_api_key_dict
            return await self.async_pre_routing_hook(data, call_type)

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
            bindings = metadata.get("lemmacomputer_mcp_server_bindings")
            server_names = metadata.get("lemmacomputer_mcp_servers")
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
            "tenantId": _optional_string(metadata, "lemmacomputer_tenant_id"),
            "subjectId": _optional_string(metadata, "lemmacomputer_subject_id"),
            "workspaceId": _optional_string(metadata, "lemmacomputer_workspace_id"),
            "agentId": _optional_string(metadata, "lemmacomputer_agent_id"),
            "agentInstanceId": _agent_instance_id(data),
            "policyVersionId": _optional_string(metadata, "lemmacomputer_policy_version_id"),
            "policyHash": _optional_string(metadata, "lemmacomputer_policy_hash"),
            "operationId": _optional_string(metadata, "lemmacomputer_operation_id"),
            "operationDigest": _optional_string(metadata, "lemmacomputer_operation_digest"),
            "leaseId": _optional_string(metadata, "lemmacomputer_lease_id"),
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
                "agentInstanceId",
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
            # Audit context and lemmacomputerFile are bound into the signed
            # operation but are LemmaComputer metadata, not Softeria arguments.
            if isinstance(data.get("arguments"), dict):
                data["arguments"] = {
                    key: value
                    for key, value in data["arguments"].items()
                    if key not in AUDIT_ONLY_ARGUMENTS
                    and not (
                        payload["toolName"] == "create-upload-session"
                        and key == "lemmacomputerFile"
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


proxy_handler_instance = LemmaComputerMcpPolicyCallback(turn_off_message_logging=True)
