import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeReasoningQualificationId,
  qualifiedClaudeReasoningCapabilities,
} from "@lemmacomputer/model-router";

test("the pinned Claude client qualifies only reviewed direct Anthropic effort routes", () => {
  for (const providerModel of ["claude-sonnet-4-6", "claude-opus-4-8"]) {
    assert.deepEqual(
      qualifiedClaudeReasoningCapabilities({ provider: "anthropic", providerModel }),
      {
        qualificationId: claudeReasoningQualificationId,
        client: "claude-code",
        clientVersion: "2.1.215",
        thinkingMode: "adaptive",
        effortLevels: ["low", "medium", "high"],
        defaultEffort: "high",
        interleavedThinking: true,
        reasoningTokenTelemetry: true,
      },
    );
  }
});

test("provider mismatch, stale clients, and unreviewed models fail closed", () => {
  assert.equal(qualifiedClaudeReasoningCapabilities({
    provider: "bedrock",
    providerModel: "claude-sonnet-4-6",
  }), null);
  assert.equal(qualifiedClaudeReasoningCapabilities({
    provider: "anthropic",
    providerModel: "claude-sonnet-4-5",
  }), null);
  assert.equal(qualifiedClaudeReasoningCapabilities({
    provider: "anthropic",
    providerModel: "claude-sonnet-4-6",
    clientVersion: "2.1.216",
  }), null);
});
