"""Credential-free qualification of the pinned LiteLLM governed transport."""

import asyncio
import importlib.util
import json
from types import SimpleNamespace

from fastapi import HTTPException


spec = importlib.util.spec_from_file_location("onecomputer_callback", "/callback.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

captured = []


def authority(path, payload):
    if path != "routing/decide":
        raise AssertionError(f"unexpected authority call: {path}")
    captured.append(payload)
    requested = payload["requestedServiceClass"]
    if requested != "auto":
        selected = requested
    elif "reasoning_request" in payload["boundedSignals"]:
        selected = "pro"
    elif "short_request" in payload["boundedSignals"]:
        selected = "lite"
    else:
        selected = "balanced"
    deployment = f"deployment-{selected}"
    return {
        "schemaVersion": 1,
        "status": "created",
        "decisionId": "11111111-1111-4111-8111-111111111111",
        "requestedServiceClass": requested,
        "selectedServiceClass": selected,
        "reasonCode": "qualification",
        "executedDeploymentId": deployment,
        "executedModelGroup": f"private-{selected}",
        "binding": {
            "schemaVersion": 1,
            "tenantId": payload["tenantId"],
            "requestId": payload["requestId"],
            "decisionId": "11111111-1111-4111-8111-111111111111",
            "deploymentId": deployment,
            "mappingVersionId": "22222222-2222-4222-8222-222222222222",
            "policyVersionId": "33333333-3333-4333-8333-333333333333",
            "expiresAt": "2099-01-01T00:00:00.000Z",
            "signature": "qualification",
        },
    }


module._usage_request = authority
callback = module.OneComputerMcpPolicyCallback()
auth = SimpleNamespace(metadata={
    "onecomputer_policy_model_alias": "onecomputer-auto",
    "onecomputer_tenant_id": "tenant-a",
    "onecomputer_subject_id": "user-a",
    "onecomputer_workspace_id": "workspace-a",
    "onecomputer_agent_id": "agent-a",
}, models=["onecomputer-auto"])


async def routed(text, requested="auto", model="onecomputer-auto"):
    data = {
        "model": model,
        "litellm_call_id": f"call-{len(captured)}",
        "messages": [{"role": "user", "content": text}],
        "metadata": {"requester_metadata": {
            "onecomputer_task_binding": "signed." + "x" * 64,
            "onecomputer_requested_service_class": requested,
        }},
    }
    return await callback.async_pre_call_hook(auth, None, data, "completion")


async def qualify():
    ambiguous = await routed("Please prepare a concise summary of the quarterly update for our team.")
    reasoning = await routed("Compare and justify the trade-offs step by step before recommending an option.")
    explicit = await routed("Use the administrator-permitted premium service class.", "pro")
    assert ambiguous["model"] == "private-balanced"
    assert reasoning["model"] == "private-pro"
    assert explicit["model"] == "private-pro"
    assert captured[0]["taskBinding"].startswith("signed.")
    assert captured[0]["boundedSignals"] == ["low_confidence_default"]
    try:
        await routed("bypass", model="bedrock/opus")
    except HTTPException as error:
        assert error.status_code == 503 and error.detail["error"] == "AI_ROUTING_UNAVAILABLE"
    else:
        raise AssertionError("an underlying model bypass was accepted")
    print(json.dumps({"pinned_hook": "pre_call_before_router", "grant_models": auth.models, "selected": [ambiguous["model"], reasoning["model"], explicit["model"]]}))


asyncio.run(qualify())
