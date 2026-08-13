import assert from "node:assert/strict";
import test from "node:test";
import { validateReasoningAdapterEvidence } from "../scripts/qualify-reasoning-adapter.mts";

const sourceCommit = "1".repeat(40);
const observation = (effort: "low" | "medium" | "high", suffix: string) => ({
  requestedEffort: effort,
  resolvedEffort: effort,
  conversationId: `conversation-${suffix}`,
  taskId: `task-${suffix}`,
  usageAttemptId: `attempt-${suffix}`,
  streamedTextObserved: true,
  toolLifecycle: { started: true, terminalState: "completed" },
  turnTerminalState: "completed",
  latencyMs: 1_250,
  usage: {
    providerConfirmed: true,
    inputTokens: { status: "reported", quantity: "120" },
    outputTokens: { status: "reported", quantity: "40" },
    reasoningTokens: { status: "unavailable" },
    cacheReadTokens: { status: "reported", quantity: "0" },
    cacheWriteTokens: { status: "unavailable" },
    cost: { status: "estimated", currency: "USD", amount: "0.0021" },
  },
});

const completeEvidence = () => ({
  schemaVersion: 1,
  qualificationId: "hermes-claw-0.19.0-openai-route-live-2026-08-13",
  recordedAt: "2026-08-13T18:00:00+08:00",
  sourceCommit,
  runtime: {
    reviewState: "qualified",
    agentCatalogId: "hermes-claw",
    clientVersion: "0.19.0",
    qualificationId: "hermes-claw-0.19.0-governed-effort-adapter-2026-08-13",
    proposedEffortLevels: ["low", "medium", "high"],
  },
  route: {
    reviewState: "qualified",
    qualificationId: "openai-gpt-5.6-responses-effort-route-2026-08-13",
    provider: "openai",
    providerModel: "gpt-5.6-terra",
    deploymentId: "deployment-balanced-v1",
    mappingVersionId: "mapping-v1",
  },
  levels: [observation("low", "low"), observation("medium", "medium"), observation("high", "high")],
  autoResolution: {
    conversationId: "conversation-auto",
    resolvedEffort: "high",
    organizationMaximumApplied: true,
  },
  resume: {
    conversationId: "conversation-medium",
    requestedEffort: "medium",
    resolvedEffort: "medium",
    sameSignedBindingSemantics: true,
    streamedTextObserved: true,
    toolTerminalState: "completed",
    turnTerminalState: "completed",
  },
  concurrency: {
    firstConversationId: "conversation-low",
    firstEffort: "low",
    secondConversationId: "conversation-high",
    secondEffort: "high",
    signedBindingsIsolated: true,
    usageAttemptsIsolated: true,
  },
  negativeCases: {
    forgedNativeReasoningField: "failed-closed",
    overPolicyEffort: "failed-closed",
    staleRuntimeVersion: "failed-closed",
    unsupportedRoute: "failed-closed",
    providerMismatch: "failed-closed",
  },
  hiddenReasoningSuppression: {
    transcript: true,
    activity: true,
    logs: true,
    artifacts: true,
  },
  evidenceLimitations: ["The provider did not expose a separate reasoning-token counter."],
});

test("a complete bounded Hermes live record passes without requiring a named provider", () => {
  const evidence = validateReasoningAdapterEvidence(completeEvidence(), { expectedSourceCommit: sourceCommit });
  assert.equal(evidence.runtime.agentCatalogId, "hermes-claw");
  assert.equal(evidence.route.provider, "openai");
  assert.deepEqual(evidence.runtime.proposedEffortLevels, ["low", "medium", "high"]);
});

test("qualification rejects incomplete level, resume, concurrency, and suppression claims", () => {
  const cases = [
    { ...completeEvidence(), levels: [observation("low", "low"), observation("medium", "medium")] },
    { ...completeEvidence(), resume: { ...completeEvidence().resume, requestedEffort: "high" } },
    { ...completeEvidence(), concurrency: { ...completeEvidence().concurrency, secondEffort: "low" } },
    { ...completeEvidence(), hiddenReasoningSuppression: { ...completeEvidence().hiddenReasoningSuppression, logs: false } },
  ];
  for (const candidate of cases) {
    assert.throws(() => validateReasoningAdapterEvidence(candidate), { code: "EVIDENCE_CONTRACT_INVALID" });
  }
});

test("qualification rejects fake promotion metadata, stale commits, raw fields, and likely secrets", () => {
  assert.throws(
    () => validateReasoningAdapterEvidence({
      ...completeEvidence(),
      runtime: { ...completeEvidence().runtime, qualificationId: "invented-qualification" },
    }),
    { code: "RUNTIME_QUALIFICATION_MISMATCH" },
  );
  assert.throws(
    () => validateReasoningAdapterEvidence({
      ...completeEvidence(),
      route: { ...completeEvidence().route, qualificationId: "invented-route-qualification" },
    }),
    { code: "ROUTE_QUALIFICATION_MISMATCH" },
  );
  assert.throws(
    () => validateReasoningAdapterEvidence(completeEvidence(), { expectedSourceCommit: "2".repeat(40) }),
    { code: "SOURCE_COMMIT_MISMATCH" },
  );
  assert.throws(
    () => validateReasoningAdapterEvidence({ ...completeEvidence(), rawPrompt: "do the work" }),
    { code: "EVIDENCE_CONTRACT_INVALID" },
  );
  assert.throws(
    () => validateReasoningAdapterEvidence({ ...completeEvidence(), evidenceLimitations: ["Used sk-do-not-store-this-value"] }),
    { code: "SENSITIVE_EVIDENCE_REJECTED" },
  );
});

test("qualification accepts the Codex discovery through the same contract", () => {
  const evidence = completeEvidence();
  evidence.qualificationId = "codex-cli-0.144.4-openai-route-live-2026-08-13";
  evidence.runtime = {
    ...evidence.runtime,
    reviewState: "candidate",
    agentCatalogId: "codex-cli",
    clientVersion: "0.144.4",
    discoveryId: "codex-cli-0.144.4-governed-effort-discovery-2026-08-13",
    qualificationId: undefined,
  };
  assert.equal(validateReasoningAdapterEvidence(evidence).runtime.agentCatalogId, "codex-cli");
});
