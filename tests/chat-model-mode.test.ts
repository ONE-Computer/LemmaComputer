import assert from "node:assert/strict";
import test from "node:test";
import { sendChatTurnSchema } from "@onecomputer/contracts";
import { RoutingDecisionBindingAuthority } from "@onecomputer/model-router";
import type { RoutingStore, TeamStore } from "@onecomputer/workspace-store";
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
