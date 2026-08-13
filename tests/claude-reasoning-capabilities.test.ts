import assert from "node:assert/strict";
import test from "node:test";
import {
  agentReasoningAdapterReview,
  anthropicReasoningRouteQualificationId,
  claudeReasoningAdapterQualificationId,
  codexReasoningAdapterDiscoveryId,
  hermesReasoningAdapterDiscoveryId,
  qualifiedAgentReasoningAdapter,
  qualifiedReasoningRouteCapabilities,
  type AgentReasoningAdapterReview,
  type AgentReasoningAdapterRegistration,
  type ReasoningRouteQualificationRegistration,
} from "@lemmacomputer/model-router";

test("reviewed direct Anthropic model routes expose provider effort capabilities", () => {
  for (const providerModel of ["claude-sonnet-4-6", "claude-opus-4-8"]) {
    assert.deepEqual(
      qualifiedReasoningRouteCapabilities({ provider: "anthropic", providerModel }),
      {
        qualificationId: anthropicReasoningRouteQualificationId,
        providerMechanism: "anthropic-adaptive-effort",
        thinkingMode: "adaptive",
        effortLevels: ["low", "medium", "high"],
        defaultEffort: "high",
        interleavedThinking: true,
        reasoningTokenTelemetry: true,
      },
    );
  }
});

test("provider mismatch and unreviewed model routes fail closed", () => {
  assert.equal(qualifiedReasoningRouteCapabilities({
    provider: "bedrock",
    providerModel: "claude-sonnet-4-6",
  }), null);
  assert.equal(qualifiedReasoningRouteCapabilities({
    provider: "anthropic",
    providerModel: "claude-sonnet-4-5",
  }), null);
});

test("a future provider route joins through registration without changing Web, Control, or agent adapters", () => {
  const registrations: readonly ReasoningRouteQualificationRegistration[] = [{
    qualificationId: "example-provider-reasoning-route-2026-08-13",
    provider: "openai",
    providerModels: ["example-reasoning-model"],
    providerMechanism: "openai-compatible-reasoning-effort",
    thinkingMode: "opaque",
    effortLevels: ["low", "medium"],
    defaultEffort: "medium",
    interleavedThinking: false,
    reasoningTokenTelemetry: true,
  }];
  assert.deepEqual(qualifiedReasoningRouteCapabilities({
    provider: "openai",
    providerModel: "example-reasoning-model",
  }, registrations), {
    qualificationId: "example-provider-reasoning-route-2026-08-13",
    providerMechanism: "openai-compatible-reasoning-effort",
    thinkingMode: "opaque",
    effortLevels: ["low", "medium"],
    defaultEffort: "medium",
    interleavedThinking: false,
    reasoningTokenTelemetry: true,
  });
  assert.equal(qualifiedReasoningRouteCapabilities({
    provider: "openai",
    providerModel: "unreviewed-model",
  }, registrations), null);
});

test("the pinned Claude runtime is the first registered reasoning adapter", () => {
  assert.deepEqual(qualifiedAgentReasoningAdapter({
    agentCatalogId: "claude-cli",
    clientVersion: "2.1.215",
  }), {
    qualificationId: claudeReasoningAdapterQualificationId,
    agentCatalogId: "claude-cli",
    clientVersion: "2.1.215",
    effortLevels: ["low", "medium", "high"],
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
  });
  assert.equal(qualifiedAgentReasoningAdapter({
    agentCatalogId: "claude-cli",
    clientVersion: "2.1.216",
  }), null);
  assert.equal(qualifiedAgentReasoningAdapter({
    agentCatalogId: "hermes-claw",
    clientVersion: "0.19.0",
  }), null);
  assert.equal(qualifiedAgentReasoningAdapter({
    agentCatalogId: "codex-cli",
    clientVersion: "0.144.4",
  }), null);
});

test("Hermes and Codex discoveries remain inspectable but fail closed before live qualification", () => {
  const expectedBlockingEvidence = [
    "live_reasoning_with_mcp_tools",
    "live_streaming_and_hidden_reasoning_suppression",
    "live_usage_cost_latency_and_cache_evidence",
  ];
  assert.deepEqual(agentReasoningAdapterReview({
    agentCatalogId: "hermes-claw",
    clientVersion: "0.19.0",
  }), {
    reviewStatus: "discovery",
    discoveryId: hermesReasoningAdapterDiscoveryId,
    agentCatalogId: "hermes-claw",
    clientVersion: "0.19.0",
    effortLevels: ["low", "medium", "high"],
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
    blockingEvidence: expectedBlockingEvidence,
  });
  assert.deepEqual(agentReasoningAdapterReview({
    agentCatalogId: "codex-cli",
    clientVersion: "0.144.4",
  }), {
    reviewStatus: "discovery",
    discoveryId: codexReasoningAdapterDiscoveryId,
    agentCatalogId: "codex-cli",
    clientVersion: "0.144.4",
    effortLevels: ["low", "medium", "high"],
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
    blockingEvidence: expectedBlockingEvidence,
  });
});

test("a discovery record cannot become a product qualification through metadata alone", () => {
  const discoveries: readonly AgentReasoningAdapterReview[] = [{
    reviewStatus: "discovery",
    discoveryId: "test-agent-1.0-effort-discovery",
    agentCatalogId: "test-agent",
    clientVersion: "1.0.0",
    effortLevels: ["low", "medium"],
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
    blockingEvidence: ["live_reasoning_with_mcp_tools"],
  }];
  assert.equal(qualifiedAgentReasoningAdapter({
    agentCatalogId: "test-agent",
    clientVersion: "1.0.0",
  }, discoveries), null);
});

test("a future agent joins through registration without changing route or UI contracts", () => {
  const registrations: readonly AgentReasoningAdapterRegistration[] = [{
    reviewStatus: "qualified",
    qualificationId: "test-agent-1.0-governed-effort-adapter",
    agentCatalogId: "test-agent",
    clientVersion: "1.0.0",
    effortLevels: ["low", "medium"],
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
  }];
  assert.deepEqual(qualifiedAgentReasoningAdapter({
    agentCatalogId: "test-agent",
    clientVersion: "1.0.0",
  }, registrations), {
    qualificationId: "test-agent-1.0-governed-effort-adapter",
    agentCatalogId: "test-agent",
    clientVersion: "1.0.0",
    effortLevels: ["low", "medium"],
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
  });
});
