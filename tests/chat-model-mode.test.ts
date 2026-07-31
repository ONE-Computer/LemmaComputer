import assert from "node:assert/strict";
import test from "node:test";
import { sendChatTurnSchema } from "@onecomputer/contracts";
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
  assert.equal(sendChatTurnSchema.parse({ message }).requestedServiceClass, "auto");
  assert.equal(sendChatTurnSchema.parse({ message, requestedServiceClass: "pro" }).requestedServiceClass, "pro");
  assert.throws(() => sendChatTurnSchema.parse({ message, requestedServiceClass: "bedrock/opus" }));
});

test("the selected chat model mode is part of the signed AI task context", () => {
  const authority = new UsageTaskBindingAuthority(
    "chat-model-mode-test-secret-at-least-32-characters",
    () => new Date("2026-07-31T10:00:00.000Z"),
  );
  const token = authority.issue({
    tenantId: "acme", subjectId: "alex", workspaceId: "workspace-1", agentId: "agent-1",
    contextKind: "chat", taskId: "message-1", sessionId: "session-1", requestedServiceClass: "pro",
  });
  assert.equal(authority.verify(token).requestedServiceClass, "pro");
});
