"""Credential-free LiteLLM v1.94.0 complexity-router qualification."""

import json
import statistics
import time
from unittest.mock import MagicMock

from litellm.router_strategy.complexity_router.complexity_router import ComplexityRouter


router = ComplexityRouter(
    model_name="onecomputer-auto",
    litellm_router_instance=MagicMock(),
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
    ("simple", "Hello", "SIMPLE"),
    ("medium", "Explain how an API endpoint works.", "MEDIUM"),
    (
        "complex",
        "Design a distributed scalable architecture with encryption, concurrency, database and API requirements.",
        "COMPLEX",
    ),
    (
        "reasoning",
        "Think through the pros and cons step by step, then compare and contrast every option.",
        "REASONING",
    ),
]

results = []
for name, prompt, expected in fixtures:
    tier, score, signals = router.classify(prompt)
    if tier.value != expected:
        raise AssertionError(f"{name}: expected {expected}, got {tier.value}")
    results.append({"fixture": name, "tier": tier.value, "score": score, "signal_count": len(signals)})

measurements_ms = []
for _ in range(2000):
    started = time.perf_counter()
    router.classify(fixtures[2][1])
    measurements_ms.append((time.perf_counter() - started) * 1000)

measurements_ms.sort()
print(
    json.dumps(
        {
            "image": "ghcr.io/berriai/litellm:v1.94.0",
            "index_digest": "sha256:65d84a2282137b4dc73bbe184650a7c807177c533e4223b3bfbc87963fe3fabe",
            "classifications": results,
            "router_overhead_ms": {
                "median": statistics.median(measurements_ms),
                "p95": measurements_ms[int(len(measurements_ms) * 0.95)],
                "iterations": len(measurements_ms),
            },
            "provider_calls": 0,
            "classifier_cost_usd": 0,
        },
        sort_keys=True,
    )
)
