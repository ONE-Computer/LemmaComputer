"""Executable v1.94.0 ComplexityRouter hook and telemetry qualification."""

import asyncio
import json
import statistics
import time
from unittest.mock import MagicMock

from litellm.router_strategy.complexity_router.complexity_router import ComplexityRouter


class MemoryCache:
    def __init__(self):
        self.values = {}

    async def async_get_cache(self, key):
        return self.values.get(key)

    async def async_set_cache(self, key, value, **_kwargs):
        self.values[key] = value


router_instance = MagicMock()
router_instance.cache = MemoryCache()
router = ComplexityRouter(
    model_name="onecomputer-auto",
    litellm_router_instance=router_instance,
    complexity_router_config={
        "tiers": {
            "SIMPLE": "onecomputer-lite",
            "MEDIUM": "onecomputer-balanced",
            "COMPLEX": "onecomputer-pro",
            "REASONING": "onecomputer-pro",
        },
        "default_model": "onecomputer-balanced",
        "classifier_type": "heuristic",
        "session_affinity": True,
    },
)

fixtures = [
    ("simple", "Hello", "onecomputer-lite"),
    ("medium", "Explain how an API endpoint works.", "onecomputer-balanced"),
    (
        "complex",
        "Design a distributed scalable architecture with encryption, concurrency, database and API requirements.",
        "onecomputer-pro",
    ),
    (
        "reasoning",
        "Think through the pros and cons step by step, then compare and contrast every option.",
        "onecomputer-pro",
    ),
]


async def hook(prompt, metadata=None):
    request_kwargs = {"metadata": metadata or {}}
    result = await router.async_pre_routing_hook(
        model="onecomputer-auto",
        request_kwargs=request_kwargs,
        messages=[{"role": "user", "content": prompt}],
    )
    if result is None:
        raise AssertionError("ComplexityRouter hook unexpectedly returned None")
    return result, request_kwargs


async def qualify():
    results = []
    for name, prompt, expected_model in fixtures:
        result, kwargs = await hook(prompt)
        if result.model != expected_model:
            raise AssertionError(f"{name}: expected {expected_model}, got {result.model}")
        typed = result.model_dump()
        if set(typed) != {"model", "messages"}:
            raise AssertionError(f"unexpected typed hook fields: {sorted(typed)}")
        if any(key in kwargs["metadata"] for key in ("tier", "score", "signals", "cause", "routing_decision")):
            raise AssertionError("normal complexity hook unexpectedly emitted typed decision telemetry")
        results.append({"fixture": name, "selected_model": result.model, "typed_fields": sorted(typed)})

    no_user = await router.async_pre_routing_hook(
        model="onecomputer-auto",
        request_kwargs={},
        messages=[{"role": "assistant", "content": "No user message"}],
    )
    if no_user is None or no_user.model != "onecomputer-balanced":
        raise AssertionError("no-user default did not route to onecomputer-balanced")

    first, _ = await hook("Hello", {"session_id": "session-1", "user_api_key_hash": "key-a"})
    pinned, _ = await hook(
        "Think through the pros and cons step by step, then compare and contrast every option.",
        {"session_id": "session-1", "user_api_key_hash": "key-a"},
    )
    isolated, _ = await hook(
        "Think through the pros and cons step by step, then compare and contrast every option.",
        {"session_id": "session-1", "user_api_key_hash": "key-b"},
    )
    if first.model != "onecomputer-lite" or pinned.model != "onecomputer-lite":
        raise AssertionError("session affinity did not pin the first selected model")
    if isolated.model != "onecomputer-pro":
        raise AssertionError("session affinity was not isolated by authenticated key hash")

    measurements_ms = []
    for _ in range(500):
        started = time.perf_counter()
        await hook(fixtures[2][1])
        measurements_ms.append((time.perf_counter() - started) * 1000)
    measurements_ms.sort()
    return {
        "image": "ghcr.io/berriai/litellm:v1.94.0",
        "index_digest": "sha256:65d84a2282137b4dc73bbe184650a7c807177c533e4223b3bfbc87963fe3fabe",
        "hook_results": results,
        "default_model": no_user.model,
        "session_affinity": {
            "first": first.model,
            "same_key": pinned.model,
            "different_key": isolated.model,
        },
        "typed_decision_telemetry": False,
        "typed_hook_fields": ["messages", "model"],
        "router_hook_overhead_ms": {
            "iterations": len(measurements_ms),
            "median": statistics.median(measurements_ms),
            "p95": measurements_ms[int(len(measurements_ms) * 0.95)],
        },
        "provider_calls": 0,
        "classifier_cost_usd": 0,
    }


print(json.dumps(asyncio.run(qualify()), sort_keys=True))
