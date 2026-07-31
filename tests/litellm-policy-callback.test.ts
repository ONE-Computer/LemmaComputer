import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("the LiteLLM policy callback retries one lost idempotent Control response", () => {
  const callback = path.resolve(import.meta.dirname, "../integrations/litellm/onecomputer_policy_callback.py");
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
    "schemaId": "onecomputer.m365.send-chat-message.v1",
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
assert calls == [2, 2]

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
assert http_calls == [2]
`;
  const result = spawnSync("python3", ["-c", script, callback], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the pinned LiteLLM callback normalizes provider units and preserves governed attempt lineage", () => {
  const callback = path.resolve(import.meta.dirname, "../integrations/litellm/onecomputer_policy_callback.py");
  const script = String.raw`
import json
import os
import runpy
import sys
import types

os.environ["ONECOMPUTER_AI_USAGE_TOKEN"] = "u" * 32

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
completion_payload = module["_completion_payload"]
callback_type = module["OneComputerMcpPolicyCallback"]

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
    {"unit": "output_token", "quantity": "38"},
    {"unit": "reasoning_token", "quantity": "12"},
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
    {"unit": "output_token", "quantity": "10"},
    {"unit": "reasoning_token", "quantity": "6"},
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
    {"unit": "output_token", "quantity": "23"},
    {"unit": "reasoning_token", "quantity": "7"},
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
        "onecomputer_tenant_id": "tenant-real",
        "onecomputer_subject_id": "subject-real",
        "onecomputer_workspace_id": "workspace-real",
        "onecomputer_agent_id": "agent-real",
        "onecomputer_policy_model_alias": "balanced",
        "onecomputer_policy_version_id": "policy-real",
        "onecomputer_route_mapping_version": "mapping-real",
    }

openai_route = {
    "onecomputer_provider": "openai",
    "onecomputer_provider_account_id": "account-real",
    "onecomputer_base_model": "openai/gpt-real",
    "onecomputer_deployment_id": "deployment-openai",
    "onecomputer_region": "us-east",
}
spoofed_request_metadata = {
    "onecomputer_task_binding": "initial.signed-binding",
    "user_api_key_metadata": {
        "onecomputer_tenant_id": "tenant-foreign",
        "onecomputer_subject_id": "subject-foreign",
    },
    "model_info": {
        "onecomputer_provider": "foreign-provider",
        "onecomputer_deployment_id": "foreign-deployment",
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
assert all(not key.startswith("onecomputer_") for key in first["metadata"])

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
request_billed_route = {**openai_route, "onecomputer_billable_request_unit": True}
assert budget_bounds(first, request_billed_route)["requestUnits"] == "1"

set_usage_state(first, {
    "admissionId": "admission-first",
    "tenantId": "tenant-real",
    "provider": "openai",
}, task_binding)
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
retry_binding, retry_parent = request_context(retry)
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
}, retry_binding)
anthropic_route = {
    "onecomputer_provider": "anthropic",
    "onecomputer_provider_account_id": "account-real",
    "onecomputer_base_model": "anthropic/claude-real",
    "onecomputer_deployment_id": "deployment-anthropic",
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
fallback_binding, fallback_parent = request_context(fallback)
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
            "onecomputer_tenant_id": "tenant-foreign",
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
`;
  const result = spawnSync("python3", ["-c", script, callback], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
