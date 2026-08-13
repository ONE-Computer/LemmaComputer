import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("the LiteLLM policy callback retries one lost idempotent Control response", () => {
  const callback = path.resolve(import.meta.dirname, "../integrations/litellm/lemmacomputer_policy_callback.py");
  const script = String.raw`
import json
import runpy
import sys
import types
import urllib.error

fastapi = types.ModuleType("fastapi")
fastapi.HTTPException = type("HTTPException", (Exception,), {
    "__init__": lambda self, *args, **kwargs: Exception.__init__(self, args, kwargs),
})
litellm = types.ModuleType("litellm")
litellm.get_model_info = lambda model: {}
integrations = types.ModuleType("litellm.integrations")
custom_logger = types.ModuleType("litellm.integrations.custom_logger")
custom_logger.CustomLogger = type("CustomLogger", (), {
    "__init__": lambda self, *args, **kwargs: None,
})
sys.modules["fastapi"] = fastapi
sys.modules["litellm"] = litellm
sys.modules["litellm.integrations"] = integrations
sys.modules["litellm.integrations.custom_logger"] = custom_logger

module = runpy.run_path(sys.argv[1])
request_decision = module["_request_decision"]
request_decision.__globals__["POLICY_TOKEN"] = "p" * 24
decision = {
    "schemaVersion": 1,
    "decision": "approval_required",
    "code": "MCP_APPROVAL_REQUIRED",
    "capabilityId": "m365.send-chat-message",
    "schemaId": "lemmacomputer.m365.send-chat-message.v1",
    "schemaHash": "a" * 64,
    "operationId": "11111111-1111-4111-8111-111111111111",
}

class Response:
    status = 200
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self, *args):
        return json.dumps(decision).encode("utf-8")

calls = []
def recover_after_timeout(request, timeout):
    calls.append(timeout)
    if len(calls) == 1:
        raise TimeoutError("response lost after commit")
    return Response()

request_decision.__globals__["urllib"].request.urlopen = recover_after_timeout
assert request_decision({"toolName": "send-chat-message"}) == decision
assert calls == [15, 15]

http_calls = []
def terminal_http_error(request, timeout):
    http_calls.append(timeout)
    raise urllib.error.HTTPError("http://control.test", 500, "failure", {}, None)

request_decision.__globals__["urllib"].request.urlopen = terminal_http_error
try:
    request_decision({"toolName": "send-chat-message"})
except urllib.error.HTTPError:
    pass
else:
    raise AssertionError("HTTP errors must not be retried")
assert http_calls == [15]
`;
  const result = spawnSync("python3", ["-c", script, callback], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the LiteLLM policy callback authorizes the exact workspace generation and fails closed", () => {
  const callback = path.resolve(import.meta.dirname, "../integrations/litellm/lemmacomputer_policy_callback.py");
  const script = String.raw`
import json
import runpy
import sys
import types

fastapi = types.ModuleType("fastapi")
fastapi.HTTPException = Exception
litellm = types.ModuleType("litellm")
integrations = types.ModuleType("litellm.integrations")
custom_logger = types.ModuleType("litellm.integrations.custom_logger")
custom_logger.CustomLogger = type("CustomLogger", (), {
    "__init__": lambda self, *args, **kwargs: None,
})
sys.modules["fastapi"] = fastapi
sys.modules["litellm"] = litellm
sys.modules["litellm.integrations"] = integrations
sys.modules["litellm.integrations.custom_logger"] = custom_logger

module = runpy.run_path(sys.argv[1])
authorize = module["_authorize_workspace_access"]
authorize.__globals__["WORKSPACE_ACCESS_TOKEN"] = "t" * 32
calls = []
class Response:
    status = 200
    def __init__(self, allowed): self.allowed = allowed
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self): return json.dumps({"allowed": self.allowed}).encode("utf-8")
def allow(request, timeout):
    calls.append((json.loads(request.data), timeout, request.headers))
    return Response(True)
authorize.__globals__["urllib"].request.urlopen = allow
metadata = {
    "lemmacomputer_tenant_id": "tenant-real",
    "lemmacomputer_subject_id": "subject-real",
    "lemmacomputer_workspace_id": "11111111-1111-4111-8111-111111111111",
    "lemmacomputer_access_generation": 7,
}
authorize(metadata)
assert calls[0][0] == {
    "tenantId": "tenant-real",
    "subjectId": "subject-real",
    "workspaceId": "11111111-1111-4111-8111-111111111111",
    "accessGeneration": 7,
}
assert calls[0][1] == 0.9

authorize.__globals__["urllib"].request.urlopen = lambda request, timeout: Response(False)
try:
    authorize(metadata)
except RuntimeError as error:
    assert "no longer active" in str(error)
else:
    raise AssertionError("denied access must fail closed")

for invalid in ({**metadata, "lemmacomputer_access_generation": 6.5}, {**metadata, "lemmacomputer_subject_id": None}):
    try:
        authorize(invalid)
    except RuntimeError as error:
        assert "metadata is incomplete" in str(error)
    else:
        raise AssertionError("invalid access metadata must fail closed")
`;
  const result = spawnSync("python3", ["-c", script, callback], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the pinned LiteLLM callback normalizes provider units and preserves governed attempt lineage", () => {
  const callback = path.resolve(import.meta.dirname, "../integrations/litellm/lemmacomputer_policy_callback.py");
  const script = String.raw`
import asyncio
import json
import os
import runpy
import sys
import types


os.environ["LEMMACOMPUTER_AI_USAGE_TOKEN"] = "u" * 32

fastapi = types.ModuleType("fastapi")
fastapi.HTTPException = type("HTTPException", (Exception,), {
    "__init__": lambda self, *args, **kwargs: Exception.__init__(self, args, kwargs),
})
litellm = types.ModuleType("litellm")
litellm.get_model_info = lambda model: {"max_output_tokens": 4096}
litellm.token_counter = lambda **kwargs: 7
integrations = types.ModuleType("litellm.integrations")
custom_logger = types.ModuleType("litellm.integrations.custom_logger")
custom_logger.CustomLogger = type("CustomLogger", (), {
    "__init__": lambda self, *args, **kwargs: None,
})
sys.modules["fastapi"] = fastapi
sys.modules["litellm"] = litellm
sys.modules["litellm.integrations"] = integrations
sys.modules["litellm.integrations.custom_logger"] = custom_logger

module = runpy.run_path(sys.argv[1])
normalized_units = module["_normalized_units"]
admission_payload = module["_admission_payload"]
budget_bounds = module["_budget_bounds"]
set_usage_state = module["_set_usage_state"]
request_context = module["_request_usage_context_and_strip_reserved"]
source_attempt_id = module["_source_attempt_id"]
verified_usage_chain = module["_verified_usage_chain"]
completion_payload = module["_completion_payload"]
routing_payload = module["_routing_payload"]
callback_type = module["LemmaComputerMcpPolicyCallback"]
set_routing_state = module["_set_routing_state"]


# These are the supported callback names in the pinned LiteLLM v1.93 image.
assert hasattr(callback_type, "async_pre_call_deployment_hook")
assert hasattr(callback_type, "async_log_success_event")
assert hasattr(callback_type, "async_log_failure_event")

def assert_units(provider, usage, expected, provider_total):
    units, total = normalized_units(provider, {"usage": usage})
    assert units == expected, (provider, units)
    assert total == provider_total, (provider, total)
    billable = [item for item in units if not item.get("diagnostic") and item["unit"] != "request"]
    assert len({item["unit"] for item in billable}) == len(billable)

assert_units("openai", {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150,
    "prompt_tokens_details": {"cached_tokens": 20},
    "completion_tokens_details": {"reasoning_tokens": 12},
}, [
    {"unit": "input_uncached_token", "quantity": "80"},
    {"unit": "cache_read_token", "quantity": "20"},
    {"unit": "output_token", "quantity": "50"},
    {"unit": "provider:reasoning_tokens", "quantity": "12", "diagnostic": True},
    {"unit": "request", "quantity": "1", "diagnostic": True},
    {"unit": "provider:total_tokens", "quantity": "150", "diagnostic": True},
], "150")

assert_units("anthropic", {
    # v1.93 inflates prompt_tokens with cache creation and reads:
    # 60 uncached + 12 cache read + 8 cache write.
    "prompt_tokens": 80,
    "completion_tokens": 20,
    "total_tokens": 100,
    "cache_read_input_tokens": 12,
    "cache_creation_input_tokens": 8,
}, [
    {"unit": "input_uncached_token", "quantity": "60"},
    {"unit": "cache_read_token", "quantity": "12"},
    {"unit": "cache_write_token", "quantity": "8"},
    {"unit": "output_token", "quantity": "20"},
    {"unit": "request", "quantity": "1", "diagnostic": True},
    {"unit": "provider:total_tokens", "quantity": "100", "diagnostic": True},
], "100")

assert_units("glm", {
    "prompt_tokens": 40,
    "completion_tokens": 16,
    "prompt_tokens_details": {"cached_tokens": 4},
    "completion_tokens_details": {"reasoning_tokens": 6},
}, [
    {"unit": "input_uncached_token", "quantity": "36"},
    {"unit": "cache_read_token", "quantity": "4"},
    {"unit": "output_token", "quantity": "16"},
    {"unit": "provider:reasoning_tokens", "quantity": "6", "diagnostic": True},
    {"unit": "request", "quantity": "1", "diagnostic": True},
    {"unit": "provider:total_tokens", "quantity": "56", "diagnostic": True},
], "56")

assert_units("bedrock", {
    # Bedrock Converse v1.93 likewise emits normalized prompt_tokens as
    # 70 uncached + 10 cache read + 5 cache write.
    "prompt_tokens": 85,
    "completion_tokens": 30,
    "total_tokens": 100,
    "cache_read_input_tokens": 10,
    "cache_creation_input_tokens": 5,
    "completion_tokens_details": {"reasoning_tokens": 7},
}, [
    {"unit": "input_uncached_token", "quantity": "70"},
    {"unit": "cache_read_token", "quantity": "10"},
    {"unit": "cache_write_token", "quantity": "5"},
    {"unit": "output_token", "quantity": "30"},
    {"unit": "provider:reasoning_tokens", "quantity": "7", "diagnostic": True},
    {"unit": "request", "quantity": "1", "diagnostic": True},
    {"unit": "provider:total_tokens", "quantity": "100", "diagnostic": True},
], "100")

unknown_units, unknown_total = normalized_units("openai", RuntimeError("provider failed"))
assert unknown_units == [{"unit": "request", "quantity": "1", "diagnostic": True}]
assert unknown_total is None

request_units, request_total = normalized_units("provider-with-request-rate", {}, True)
assert request_units == [{"unit": "request", "quantity": "1"}]
assert request_total is None

class Auth:
    metadata = {
        "lemmacomputer_tenant_id": "tenant-real",
        "lemmacomputer_subject_id": "subject-real",
        "lemmacomputer_workspace_id": "workspace-real",
        "lemmacomputer_access_generation": 7,
        "lemmacomputer_agent_id": "agent-real",
        "lemmacomputer_policy_model_alias": "balanced",
        "lemmacomputer_policy_version_id": "policy-real",
        "lemmacomputer_route_mapping_version": "mapping-real",
    }

class AutoAuth:
    metadata = {**Auth.metadata, "lemmacomputer_policy_model_alias": "lemmacomputer-auto"}

routing = routing_payload({
    "user_api_key_dict": AutoAuth(),
    "model": "lemmacomputer-auto",
    "litellm_call_id": "route-call",
    "messages": [{"role": "user", "content": "hi"}],
    "max_tokens": 8,
    "metadata": {"lemmacomputer_task_binding": "b" * 64},
})
assert routing["expectedUsage"] == [
    {"unit": "input_uncached_token", "quantity": "7"},
    {"unit": "output_token", "quantity": "8"},
]

openai_route = {
    "lemmacomputer_provider": "openai",
    "lemmacomputer_provider_account_id": "account-real",
    "lemmacomputer_base_model": "openai/gpt-real",
    "lemmacomputer_deployment_id": "deployment-openai",
    "lemmacomputer_region": "us-east",
}
spoofed_request_metadata = {
    "lemmacomputer_task_binding": "initial.signed-binding",
    "user_api_key_metadata": {
        "lemmacomputer_tenant_id": "tenant-foreign",
        "lemmacomputer_subject_id": "subject-foreign",
    },
    "model_info": {
        "lemmacomputer_provider": "foreign-provider",
        "lemmacomputer_deployment_id": "foreign-deployment",
    },
}
first = {
    "user_api_key_dict": Auth(),
    "litellm_params": {"model_info": openai_route},
    "metadata": spoofed_request_metadata,
    "model": "openai/gpt-real",
    "messages": [{"role": "user", "content": "hello"}],
    "max_tokens": 32,
    "litellm_call_id": "litellm-call-stable",
    "litellm_metadata": {"attempted_retries": 0},
}
task_binding, parent = request_context(first)
assert task_binding == "initial.signed-binding"
assert parent is None
assert all(not key.startswith("lemmacomputer_") for key in first["metadata"])

first_bounds = budget_bounds(first, openai_route)
first_payload = admission_payload(first, "acompletion", task_binding, parent, first_bounds)
assert first_payload["tenantId"] == "tenant-real"
assert first_payload["subjectId"] == "subject-real"
assert first_payload["resolvedDeploymentId"] == "deployment-openai"
assert first_payload["attemptKind"] == "inference"
assert first_payload["taskBinding"] == "initial.signed-binding"
assert "parentAttemptId" not in first_payload
assert first_payload["budgetBounds"]["maxRetries"] == 0
assert first_payload["budgetBounds"]["maxFallbacks"] == 0
assert first_payload["budgetBounds"]["inputTokens"] == "7"
assert "requestUnits" not in first_payload["budgetBounds"]

# Replaying the same concrete LiteLLM v1.93 hook tuple must converge on the
# same source attempt instead of creating another charge.
first_replay = admission_payload(first, "acompletion", task_binding, parent, first_bounds)
assert first_replay["sourceAttemptId"] == first_payload["sourceAttemptId"]
request_billed_route = {**openai_route, "lemmacomputer_billable_request_unit": True}
assert budget_bounds(first, request_billed_route)["requestUnits"] == "1"

set_usage_state(first, {
    "admissionId": "admission-first",
    "tenantId": "tenant-real",
    "provider": "openai",
}, task_binding, first_payload["sourceAttemptId"], first_payload.get("parentAttemptId"))

# A second entry into the deployment hook for the same concrete invocation
# must preserve the original no-parent lineage and duplicate source identity.
first_chain = verified_usage_chain(first["metadata"]["lemmacomputer_usage_chain"])
assert first_chain == {
    "admissionId": "admission-first",
    "originalParentAttemptId": None,
    "sourceAttemptId": first_payload["sourceAttemptId"],
    "taskBinding": task_binding,
}
first_reentry_binding, first_reentry_parent = request_context(
    first, first_payload["sourceAttemptId"]
)
first_reentry_payload = admission_payload(
    first,
    "acompletion",
    first_reentry_binding,
    first_reentry_parent,
    budget_bounds(first, openai_route),
)
assert first_reentry_binding == task_binding
assert first_reentry_parent is None
assert first_reentry_payload["sourceAttemptId"] == first_payload["sourceAttemptId"]
assert "parentAttemptId" not in first_reentry_payload

# Restore the chain after the duplicate response for the distinct retry.
set_usage_state(first, {
    "admissionId": "admission-first",
    "tenantId": "tenant-real",
    "provider": "openai",
}, first_reentry_binding, first_reentry_payload["sourceAttemptId"], first_reentry_payload.get("parentAttemptId"))
retry = {
    "user_api_key_dict": Auth(),
    "litellm_params": {"model_info": openai_route},
    "metadata": {
        **dict(first["metadata"]),
        "previous_models": [{"model": "openai/gpt-real"}],
    },
    "model": "openai/gpt-real",
    "messages": first["messages"],
    "litellm_call_id": "litellm-call-stable",
    "litellm_metadata": {"attempted_retries": 1},
}
retry_source = source_attempt_id(retry, openai_route)
retry_binding, retry_parent = request_context(retry, retry_source)
assert retry_binding == task_binding
assert retry_parent == "admission-first"
retry_payload = admission_payload(
    retry, "acompletion", retry_binding, retry_parent, budget_bounds(retry, openai_route)
)
assert retry_payload["attemptKind"] == "retry"
assert retry_payload["parentAttemptId"] == "admission-first"
assert retry_payload["sourceAttemptId"] != first_payload["sourceAttemptId"]

set_usage_state(retry, {
    "admissionId": "admission-retry",
    "tenantId": "tenant-real",
    "provider": "openai",
}, retry_binding, retry_payload["sourceAttemptId"], retry_payload.get("parentAttemptId"))
anthropic_route = {
    "lemmacomputer_provider": "anthropic",
    "lemmacomputer_provider_account_id": "account-real",
    "lemmacomputer_base_model": "anthropic/claude-real",
    "lemmacomputer_deployment_id": "deployment-anthropic",
}
fallback = {
    "user_api_key_dict": Auth(),
    "litellm_params": {"model_info": anthropic_route},
    "metadata": {
        **dict(retry["metadata"]),
        "previous_models": [{"model": "openai/gpt-real"}],
    },
    "model": "anthropic/claude-real",
    "messages": first["messages"],
    # v1.93 stores one prior model in metadata on the first fallback and sets
    # fallback_depth before recursively selecting the next concrete route.
    "fallback_depth": 1,
    "litellm_call_id": "litellm-call-stable",
    "litellm_metadata": {"attempted_retries": 0},
}
fallback_source = source_attempt_id(fallback, anthropic_route)
fallback_binding, fallback_parent = request_context(fallback, fallback_source)
fallback_payload = admission_payload(
    fallback, "acompletion", fallback_binding, fallback_parent, budget_bounds(fallback, anthropic_route)
)
assert fallback_binding == task_binding
assert fallback_payload["attemptKind"] == "fallback"
assert fallback_payload["parentAttemptId"] == "admission-retry"
assert fallback_payload["resolvedDeploymentId"] == "deployment-anthropic"
assert fallback_payload["sourceAttemptId"] not in {
    first_payload["sourceAttemptId"], retry_payload["sourceAttemptId"]
}
fallback_replay = admission_payload(
    fallback, "acompletion", fallback_binding, fallback_parent, budget_bounds(fallback, anthropic_route)
)
assert fallback_replay["sourceAttemptId"] == fallback_payload["sourceAttemptId"]

# A tampered request chain cannot invent a parent admission.
signed_chain = first["metadata"]["lemmacomputer_usage_chain"]
tampered_chain = signed_chain[:-1] + ("0" if signed_chain[-1] != "0" else "1")
tampered = {
    "metadata": {
        "lemmacomputer_task_binding": "proxy.initial-binding",
        "lemmacomputer_usage_chain": tampered_chain,
    },
}
tampered_binding, tampered_parent = request_context(
    tampered, first_payload["sourceAttemptId"]
)
assert tampered_binding == "proxy.initial-binding"
assert tampered_parent is None
assert all(not key.startswith("lemmacomputer_") for key in tampered["metadata"])

completion = completion_payload(
    {"metadata": retry["metadata"], "messages": first["messages"]},
    {"usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}},
    None,
    None,
    "success",
)
assert completion["admissionId"] == "admission-retry"
assert completion["sourceEventId"] == "admission-retry:completion"
assert completion["providerReportedTotalTokens"] == "14"
assert next(item for item in completion["units"] if item["unit"] == "request")["diagnostic"] is True

class ForeignAuth:
    metadata = {}

try:
    admission_payload({
        "user_api_key_dict": ForeignAuth(),
        "metadata": {
            "user_api_key_metadata": Auth.metadata,
            "lemmacomputer_tenant_id": "tenant-foreign",
        },
        "litellm_params": {"model_info": openai_route},
    }, "acompletion", None)
except RuntimeError as error:
    assert "authenticated identity is incomplete" in str(error)
else:
    raise AssertionError("request metadata must not impersonate authenticated identity")

try:
    admission_payload({
        "user_api_key_dict": Auth(),
        "litellm_params": {"model_info": openai_route},
        "metadata": {},
        "model": "openai/gpt-real",
        "messages": [],
    }, "acompletion", "initial.signed-binding")
except RuntimeError as error:
    assert "concrete invocation ID is missing" in str(error)
else:
    raise AssertionError("admission must fail closed without LiteLLM's concrete invocation ID")

# Authentication projections are callback-only. They must remain available
# through routing and admission, but must never cross the provider boundary.
authority_calls = []


def usage_authority(path, payload):
    authority_calls.append((path, payload))
    if path == "routing/decide":
        return {
            "decisionId": "decision-ceiling",
            "executedDeploymentId": "routing-deployment-balanced",
            "executedModelGroup": "lemmacomputer-openai-balanced",
            "executedProviderDeployment": "ocp-tenant-real-balanced",
            "requestedServiceClass": "auto",
            "selectedServiceClass": "balanced",
            "executedOutputTokenLimit": 8192,
            **({
                "requestedReasoningEffort": payload["requestedReasoningEffort"],
                "resolvedReasoningEffort": "medium",
            } if payload.get("requestedReasoningEffort") else {}),
            "binding": {"requestId": "request-ceiling", "mappingVersionId": "mapping-real"},
        }
    if path == "attempts/admit":
        return {"status": "created", "admissionId": "admission-boundary"}
    if path == "routing/verify":
        return {"schemaVersion": 1, "status": "verified"}
    if path == "events":
        return {
            "schemaVersion": 1,
            "status": "created",
            "eventId": "event-boundary",
            "providerCost": "0.000078",
            "currency": "USD",
        }
    raise AssertionError(f"unexpected usage authority call: {path}")

callback_type.async_pre_call_deployment_hook.__globals__["_usage_request"] = usage_authority
callback_type.async_pre_routing_hook.__globals__["_usage_request"] = usage_authority
assert callback_type.async_pre_routing_hook.__globals__["_usage_request"] is usage_authority
workspace_access_calls = []
def workspace_access_authority(metadata):
    if metadata.get("lemmacomputer_workspace_id") is not None:
        assert metadata["lemmacomputer_access_generation"] == 7
        workspace_access_calls.append(dict(metadata))
callback_type.async_pre_call_hook.__globals__["_authorize_workspace_access"] = workspace_access_authority
callback = callback_type()


class ProbeAuth:
    metadata = {
        "lemmacomputer_non_billable_exemption": "provider-route-test-v1",
        "lemmacomputer_policy_model_alias": "balanced",
    }

async def assert_provider_boundary():
    transport_request = {
        "model": "lemmacomputer-auto",
        "messages": [{"role": "user", "content": "large client ceiling"}],
        "max_tokens": 32768,
        "litellm_params": {"max_tokens": 32768},
        "litellm_call_id": "route-ceiling-call",
        "metadata": {"lemmacomputer_task_binding": "signed." + "z" * 64},
    }
    routed_transport = await callback.async_pre_call_hook(
        AutoAuth(), None, transport_request, "acompletion"
    )
    assert routed_transport["model"] == "lemmacomputer-openai-balanced"
    assert routed_transport["max_tokens"] == 8192
    assert routed_transport["litellm_params"]["max_tokens"] == 8192
    authority_calls.clear()

    effort_transport = {
        "model": "lemmacomputer-auto",
        "messages": [{"role": "user", "content": "review this plan"}],
        "thinking": {"type": "enabled", "budget_tokens": 999999},
        "output_config": {"effort": "max"},
        "reasoning_effort": "max",
        "litellm_params": {
            "model_info": {**openai_route, "access_groups": ["ocp-tenant-real-balanced"]},
            "reasoning_effort": "max",
            "thinking": {"type": "enabled", "budget_tokens": 999999},
        },
        "litellm_call_id": "route-effort-call",
        "metadata": {
            "lemmacomputer_task_binding": "signed." + "e" * 64,
            "lemmacomputer_requested_reasoning_effort": "medium",
        },
    }
    routed_effort = await callback.async_pre_call_hook(
        AutoAuth(), None, effort_transport, "acompletion"
    )
    assert authority_calls[-1][0] == "routing/decide"
    assert authority_calls[-1][1]["requestedReasoningEffort"] == "medium"
    assert routed_effort["reasoning_effort"] == "medium"
    assert routed_effort["litellm_params"]["reasoning_effort"] == "medium"
    assert "thinking" not in routed_effort
    assert "output_config" not in routed_effort
    assert "thinking" not in routed_effort["litellm_params"]
    await callback.async_pre_call_deployment_hook(routed_effort, "acompletion")
    effort_admission = next(item for item in authority_calls if item[0] == "attempts/admit")
    assert effort_admission[1]["requestedReasoningEffort"] == "medium"
    assert effort_admission[1]["resolvedReasoningEffort"] == "medium"
    authority_calls.clear()

    disabled_tool_transport = {
        "model": "lemmacomputer-auto",
        "messages": [{"role": "user", "content": "use the available tool"}],
        "tools": [{"type": "function", "function": {"name": "lookup"}}],
        "reasoning_effort": "none",
        "litellm_params": {"reasoning_effort": "none"},
        "litellm_call_id": "route-disabled-tool-call",
        "metadata": {"lemmacomputer_task_binding": "signed." + "n" * 64},
    }
    routed_disabled_tool = await callback.async_pre_call_hook(
        AutoAuth(), None, disabled_tool_transport, "acompletion"
    )
    assert authority_calls[-1][0] == "routing/decide"
    assert "requestedReasoningEffort" not in authority_calls[-1][1]
    assert routed_disabled_tool["reasoning_effort"] == "none"
    assert routed_disabled_tool["litellm_params"]["reasoning_effort"] == "none"
    authority_calls.clear()

    probe = {
        "model": "openai/gpt-real",
        "messages": [{"role": "user", "content": "probe"}],
        "litellm_call_id": "probe-call",
        "litellm_params": {"model_info": openai_route},
        "user_api_key_metadata": {"untrusted": True},
    }
    routed_probe = await callback.async_pre_call_hook(
        ProbeAuth(), None, probe, "acompletion"
    )
    assert "user_api_key_dict" in routed_probe
    provider_probe = await callback.async_pre_call_deployment_hook(
        routed_probe, "acompletion"
    )
    assert provider_probe is not routed_probe
    assert "user_api_key_dict" in routed_probe
    assert "user_api_key_dict" not in provider_probe
    assert "user_api_key_metadata" not in provider_probe
    assert provider_probe["model"] == "openai/gpt-real"
    assert provider_probe["messages"] == probe["messages"]
    assert authority_calls == []

    admitted = {
        "model": "openai/gpt-real",
        "messages": [{"role": "user", "content": "billable request"}],
        "litellm_call_id": "admitted-call",
        "litellm_params": {"model_info": openai_route},
        "metadata": {"lemmacomputer_task_binding": "signed." + "x" * 64},
        "user_api_key_metadata": {"untrusted": True},
    }
    routed_admitted = await callback.async_pre_call_hook(
        Auth(), None, admitted, "acompletion"
    )
    provider_admitted = await callback.async_pre_call_deployment_hook(
        routed_admitted, "acompletion"
    )
    assert authority_calls[0][0] == "attempts/admit"
    assert authority_calls[0][1]["resolvedProvider"] == "openai"
    assert "user_api_key_dict" in routed_admitted
    assert "user_api_key_dict" not in provider_admitted
    assert "user_api_key_metadata" not in provider_admitted
    assert all(not key.startswith("lemmacomputer_") for key in provider_admitted)
    assert all(not key.startswith("lemmacomputer_") for key in provider_admitted["metadata"])
    signed_reentry = {
        **provider_admitted,
        "metadata": dict(routed_admitted["metadata"]),
        "lemmacomputer_usage_state": routed_admitted["lemmacomputer_usage_state"],
    }
    authority_count = len(authority_calls)
    provider_reentry = await callback.async_pre_call_deployment_hook(
        signed_reentry, "acompletion"
    )
    assert len(authority_calls) == authority_count
    assert all(not key.startswith("lemmacomputer_") for key in provider_reentry)
    assert "user_api_key_dict" not in provider_reentry

    internal_responses = {
        key: value
        for key, value in provider_admitted.items()
        if key != "lemmacomputer_usage_state"
    }
    internal_responses["litellm_call_id"] = "internal-responses-call"
    internal_responses["metadata"] = {
        key: value
        for key, value in provider_admitted["metadata"].items()
        if key not in ("lemmacomputer_usage_state", "lemmacomputer_usage_chain")
    }
    internal_provider = await callback.async_pre_call_deployment_hook(
        internal_responses, "aresponses"
    )
    assert len(authority_calls) == authority_count
    assert all(not key.startswith("lemmacomputer_") for key in internal_provider)

    ordinary_changed_call = {**internal_responses, "litellm_call_id": "ordinary-changed-call"}
    try:
        await callback.async_pre_call_deployment_hook(ordinary_changed_call, "acompletion")
    except Exception:
        pass
    else:
        raise AssertionError("ordinary changed-call re-entry must fail closed")
    assert len(authority_calls) == authority_count

    tampered_reentry = {
        **signed_reentry,
        "metadata": {
            **signed_reentry["metadata"],
            "lemmacomputer_usage_state": {
                **signed_reentry["metadata"]["lemmacomputer_usage_state"],
                "admissionId": "tampered-admission",
            },
        },
    }
    try:
        await callback.async_pre_call_deployment_hook(tampered_reentry, "acompletion")
    except Exception:
        pass
    else:
        raise AssertionError("tampered usage state must not reuse a signed admission")
    assert len(authority_calls) == authority_count

    # Anthropic-compatible requests can reach the completion hook with all
    # callback-owned kwargs and task context stripped. The bounded call-state
    # registry must still settle the event while provider kwargs stay clean.
    module["_INTERNAL_ADMISSION_CONTEXT"].set(None)
    await callback.async_log_success_event(
        internal_provider,
        {"usage": {"input_tokens": 9, "output_tokens": 5}},
        None,
        None,
    )
    event_call = next(item for item in authority_calls if item[0] == "events")
    assert event_call[1]["admissionId"] == "admission-boundary"
    assert event_call[1]["providerReportedTotalTokens"] == "14"
    assert event_call[1]["units"] == [
        {"unit": "input_uncached_token", "quantity": "9"},
        {"unit": "output_token", "quantity": "5"},
        {"unit": "request", "quantity": "1", "diagnostic": True},
        {"unit": "provider:total_tokens", "quantity": "14", "diagnostic": True},
    ]

    auto_route = {
        **openai_route,
        "access_groups": ["ocp-tenant-real-balanced"],
    }
    auto_request = {
        "model": "lemmacomputer-openai-balanced",
        "messages": [{"role": "user", "content": "auto-routed request"}],
        "litellm_call_id": "auto-routed-call",
        "litellm_params": {"model_info": auto_route},
        "metadata": {"lemmacomputer_task_binding": "signed." + "y" * 64},
    }
    routed_auto = {**auto_request, "user_api_key_dict": AutoAuth()}
    set_routing_state(routed_auto, {
        "decisionId": "decision-auto",
        "executedDeploymentId": "routing-deployment-balanced",
        "executedProviderDeployment": "ocp-tenant-real-balanced",
        "requestedServiceClass": "auto",
        "selectedServiceClass": "balanced",
        "binding": {
            "requestId": "request-auto",
            "mappingVersionId": "mapping-real",
        },
    })
    auto_provider = await callback.async_pre_call_deployment_hook(routed_auto, "acompletion")
    assert all(not key.startswith("lemmacomputer_") for key in auto_provider)
    assert all(not key.startswith("lemmacomputer_") for key in auto_provider["litellm_params"])
    verify_call = next(item for item in authority_calls if item[0] == "routing/verify")
    assert verify_call[1]["actual"] == {
        "tenantId": "tenant-real",
        "requestId": "request-auto",
        "deploymentId": "routing-deployment-balanced",
    }

asyncio.run(assert_provider_boundary())
`;
  const result = spawnSync("python3", ["-c", script, callback], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
