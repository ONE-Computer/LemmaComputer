import assert from "node:assert/strict";
import test from "node:test";
import { sendChatTurnSchema } from "@lemmacomputer/contracts";
import {
  qualifiedAgentReasoningAdapter,
  RoutingDecisionBindingAuthority,
} from "@lemmacomputer/model-router";
import type { RoutingStore, TeamStore } from "@lemmacomputer/workspace-store";
import { RoutingExecutionService } from "../apps/control-api/src/routing.js";
import { UsageTaskBindingAuthority } from "../apps/control-api/src/usage-ledger.js";

const message = {
  id: "message-1",
  role: "user",
  metadata: {
    agentCatalogId: "codex-cli",
    state: "completed",
    createdAt: "2026-07-31T10:00:00.000Z",
  },
  parts: [{ type: "text", text: "Prepare the launch analysis." }],
};

test("chat accepts only stable model modes and defaults old clients to Auto", () => {
  assert.equal(
    sendChatTurnSchema.parse({ message }).requestedServiceClass,
    "auto",
  );
  assert.equal(
    sendChatTurnSchema.parse({ message, requestedServiceClass: "pro" })
      .requestedServiceClass,
    "pro",
  );
  assert.throws(() =>
    sendChatTurnSchema.parse({
      message,
      requestedServiceClass: "bedrock/opus",
    }),
  );
});

test("chat accepts only Phase 0.5 Claude reasoning efforts", () => {
  for (const reasoningEffort of ["auto", "low", "medium", "high"] as const) {
    assert.equal(
      sendChatTurnSchema.parse({ message, reasoningEffort }).reasoningEffort,
      reasoningEffort,
    );
  }
  assert.throws(() => sendChatTurnSchema.parse({ message, reasoningEffort: "xhigh" }));
  assert.throws(() => sendChatTurnSchema.parse({ message, reasoningEffort: "max" }));
});

test("the selected chat model mode is part of the signed AI task context", () => {
  const authority = new UsageTaskBindingAuthority(
    "chat-model-mode-test-secret-at-least-32-characters",
    () => new Date("2026-07-31T10:00:00.000Z"),
  );
  const token = authority.issue({
    tenantId: "acme",
    subjectId: "alex",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    contextKind: "chat",
    taskId: "message-1",
    sessionId: "session-1",
    requestedServiceClass: "pro",
  });
  assert.equal(authority.verify(token).requestedServiceClass, "pro");
});
test("the selected Claude effort and protected ceiling are part of the signed AI task context", () => {
  const authority = new UsageTaskBindingAuthority(
    "chat-reasoning-effort-test-secret-at-least-32-characters",
    () => new Date("2026-08-13T10:00:00.000Z"),
  );
  const token = authority.issue({
    tenantId: "acme",
    subjectId: "alex",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    contextKind: "chat",
    taskId: "message-1",
    sessionId: "session-1",
    requestedServiceClass: "balanced",
    requestedReasoningEffort: "auto",
    maximumReasoningEffort: "medium",
  });
  assert.equal(authority.verify(token).requestedReasoningEffort, "auto");
  assert.equal(authority.verify(token).maximumReasoningEffort, "medium");
});
test("routing rejects a callback model mode that differs from the signed chat task", async () => {
  const taskSecret = "chat-model-mode-test-secret-at-least-32-characters";
  const taskBindings = new UsageTaskBindingAuthority(
    taskSecret,
    () => new Date("2026-07-31T10:00:00.000Z"),
  );
  const taskBinding = taskBindings.issue({
    tenantId: "acme",
    subjectId: "alex",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    contextKind: "chat",
    taskId: "message-1",
    sessionId: "session-1",
    requestedServiceClass: "pro",
  });
  const store = {
    decisionByRequest: async () => null,
  } as unknown as RoutingStore;
  const teams = {
    getCurrentDefaultSpendingTeam: async () => {
      throw new Error("team lookup must not run");
    },
  } as Pick<TeamStore, "getCurrentDefaultSpendingTeam">;
  const service = new RoutingExecutionService(
    store,
    teams,
    new RoutingDecisionBindingAuthority(taskSecret),
    taskBindings,
  );
  await assert.rejects(
    service.decide({
      schemaVersion: 1,
      tenantId: "acme",
      subjectId: "alex",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      taskBinding,
      requestId: "request-1",
      requestedServiceClass: "lite",
      boundedSignals: [],
      estimatedInputTokens: 0,
      requiredCapabilities: {},
      expectedUsage: [{ unit: "request", quantity: "1" }],
    }),
    /task binding does not match/,
  );
});

test("routing rejects an effort above the protected task ceiling before Team lookup", async () => {
  const taskSecret = "chat-effort-policy-test-secret-at-least-32-characters";
  const taskBindings = new UsageTaskBindingAuthority(
    taskSecret,
    () => new Date("2026-08-13T10:00:00.000Z"),
  );
  const taskBinding = taskBindings.issue({
    tenantId: "acme",
    subjectId: "alex",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    contextKind: "chat",
    taskId: "message-1",
    sessionId: "session-1",
    requestedServiceClass: "balanced",
    requestedReasoningEffort: "high",
    maximumReasoningEffort: "medium",
  });
  const service = new RoutingExecutionService(
    { decisionByRequest: async () => null } as unknown as RoutingStore,
    { getCurrentDefaultSpendingTeam: async () => { throw new Error("Team lookup must not run"); } },
    new RoutingDecisionBindingAuthority(taskSecret),
    taskBindings,
  );
  await assert.rejects(service.decide({
    schemaVersion: 1,
    tenantId: "acme",
    subjectId: "alex",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    taskBinding,
    requestId: "request-effort",
    requestedServiceClass: "balanced",
    requestedReasoningEffort: "high",
    boundedSignals: [],
    estimatedInputTokens: 0,
    requiredCapabilities: {},
    expectedUsage: [{ unit: "request", quantity: "1" }],
  }), /exceeds protected policy/);
});

test("a duplicate request cannot reuse a persisted route without the signed effort capability", async () => {
  const taskSecret = "chat-effort-duplicate-test-secret-at-least-32-characters";
  const taskBindings = new UsageTaskBindingAuthority(
    taskSecret,
    () => new Date("2026-08-13T10:00:00.000Z"),
  );
  const taskBinding = taskBindings.issue({
    tenantId: "acme",
    subjectId: "alex",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    contextKind: "chat",
    taskId: "message-duplicate",
    requestedServiceClass: "balanced",
    requestedReasoningEffort: "medium",
    maximumReasoningEffort: "high",
  });
  const service = new RoutingExecutionService(
    {
      decisionByRequest: async () => ({
        id: "11111111-1111-4111-8111-111111111111",
        request_id: "request-duplicate",
        tenant_id: "acme",
        executed_deployment_id: "22222222-2222-4222-8222-222222222222",
        executed_capabilities: { outputTokens: 4096, reasoning: null },
      }),
    } as unknown as RoutingStore,
    { getCurrentDefaultSpendingTeam: async () => { throw new Error("Team lookup must not run"); } },
    new RoutingDecisionBindingAuthority(taskSecret),
    taskBindings,
  );

  await assert.rejects(service.decide({
    schemaVersion: 1,
    tenantId: "acme",
    subjectId: "alex",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    taskBinding,
    requestId: "request-duplicate",
    requestedServiceClass: "balanced",
    requestedReasoningEffort: "medium",
    boundedSignals: [],
    estimatedInputTokens: 0,
    requiredCapabilities: {},
    expectedUsage: [{ unit: "request", quantity: "1" }],
  }), /does not satisfy/);
});

test("reasoning options intersect a registered agent adapter with qualified model routes", async () => {
  const adapter = qualifiedAgentReasoningAdapter({
    agentCatalogId: "future-agent",
    clientVersion: "1.0.0",
  }, [{
    qualificationId: "future-agent-1.0-governed-effort-adapter",
    agentCatalogId: "future-agent",
    clientVersion: "1.0.0",
    effortLevels: ["low", "medium"],
  }]);
  assert.ok(adapter);
  const route = {
    id: "deployment-balanced",
    provider: "anthropic",
    serviceClass: "balanced",
    approved: true,
    healthy: true,
    evaluationPassed: true,
    capabilities: {
      reasoning: {
        effortLevels: ["low", "medium", "high"],
      },
    },
  };
  const service = new RoutingExecutionService(
    {
      resolveEffectivePolicy: async () => ({
        policy: {
          identity: {
            allowedServiceClasses: ["balanced"],
            allowedDeploymentIds: [route.id],
          },
          team: null,
          deployments: [route],
          approvedProviders: ["anthropic"],
          fixedDeploymentId: route.id,
        },
      }),
    } as unknown as RoutingStore,
    { getCurrentDefaultSpendingTeam: async () => ({ id: "team-1" }) } as Pick<TeamStore, "getCurrentDefaultSpendingTeam">,
    new RoutingDecisionBindingAuthority("future-agent-routing-secret-at-least-32-characters"),
    new UsageTaskBindingAuthority("future-agent-routing-secret-at-least-32-characters"),
  );

  assert.deepEqual(await service.reasoningOptions("acme", "alex", adapter), {
    auto: ["low", "medium"],
    lite: [],
    balanced: ["low", "medium"],
    pro: [],
  });
});
