import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicReasoningRouteQualificationId,
  claudeReasoningAdapterQualificationId,
  qualifiedAgentReasoningAdapter,
  qualifiedReasoningRouteCapabilities,
  type AgentReasoningAdapterRegistration,
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
  });
  assert.equal(qualifiedAgentReasoningAdapter({
    agentCatalogId: "claude-cli",
    clientVersion: "2.1.216",
  }), null);
  assert.equal(qualifiedAgentReasoningAdapter({
    agentCatalogId: "hermes-claw",
    clientVersion: "0.19.0",
  }), null);
});

test("a future agent joins through registration without changing route or UI contracts", () => {
  const registrations: readonly AgentReasoningAdapterRegistration[] = [{
    qualificationId: "test-agent-1.0-governed-effort-adapter",
    agentCatalogId: "test-agent",
    clientVersion: "1.0.0",
    effortLevels: ["low", "medium"],
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
  });
});
