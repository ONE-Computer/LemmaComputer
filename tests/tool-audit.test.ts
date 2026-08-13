import assert from "node:assert/strict";
import test from "node:test";
import {
  LemmaComputerError,
  toolAuditAdmissionInputSchema,
  toolAuditTerminalRecordSchema,
  type ToolAuditAdmissionInput,
  type ToolAuditTerminalOutcome,
} from "@lemmacomputer/contracts";
import { buildToolAuditTargetSummary, InMemoryToolAuditStore } from "@lemmacomputer/workspace-store";

const ids = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  agentInstanceId: "22222222-2222-4222-8222-222222222222",
  governedOperationId: "33333333-3333-4333-8333-333333333333",
};

const admission = (overrides: Partial<ToolAuditAdmissionInput> = {}): ToolAuditAdmissionInput => ({
  tenantId: "tenant-a",
  subjectId: "member-a",
  workspaceId: ids.workspaceId,
  agentId: "claude-desktop",
  agentInstanceId: ids.agentInstanceId,
  context: { kind: "interactive", taskId: null, sessionId: null, turnId: null },
  sourceSystem: "litellm_mcp",
  sourceInvocationId: "litellm-call-1",
  correlationId: "control-correlation-1",
  connectorId: "microsoft-365",
  serverId: "server-m365",
  serverName: "lemmacomputer_ms365",
  toolName: "list-mail-folders",
  policyDecision: "allow",
  policyCode: "MCP_POLICY_ALLOWED",
  policyVersionId: "policy-v7",
  policyHash: "a".repeat(64),
  governedOperationId: null,
  target: { provenance: "generic_template" },
  ...overrides,
});

const assertCode = (operation: () => unknown, code: string) => {
  assert.throws(operation, (error) => error instanceof LemmaComputerError && error.code === code);
};

test("tool audit contracts contain only bounded compliance facts", () => {
  const parsed = toolAuditAdmissionInputSchema.parse(admission());
  assert.deepEqual(parsed.context, { kind: "interactive", taskId: null, sessionId: null, turnId: null });
  for (const forbidden of ["arguments", "result", "argumentHash", "resultHash", "prompt", "response", "reasoning"]) {
    assert.equal(forbidden in parsed, false);
    assert.equal(toolAuditAdmissionInputSchema.safeParse({ ...parsed, [forbidden]: "must-not-enter" }).success, false);
  }
  assert.equal(toolAuditAdmissionInputSchema.safeParse(admission({
    policyDecision: "approval_required",
    policyCode: "MCP_APPROVAL_REQUIRED",
  })).success, false);
  assert.equal(toolAuditAdmissionInputSchema.safeParse({
    ...admission(),
    target: undefined,
    targetSummary: { targetType: "file", text: "File: password=hunter2", provenance: "managed_schema", redacted: false },
  }).success, false);
});

test("target summaries redact secrets, URLs, controls and HTML while generic connectors stay argument-free", () => {
  const secrets = [
    "password=hunter2",
    "Bearer abc.def.secret",
    "sk-supersecret0123456789",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signaturevalue",
    "A".repeat(48),
  ];
  const target = `<img src=x onerror=alert(1)> ${secrets.join(" ")}\u0000`;
  const managed = buildToolAuditTargetSummary({ provenance: "managed_schema", targetType: "file", target });
  const serialized = JSON.stringify(managed);
  assert.equal(managed.redacted, true);
  assert.doesNotMatch(serialized, /[<>\u0000]/u);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);

  const signedUrl = buildToolAuditTargetSummary({
    provenance: "managed_schema",
    targetType: "destination",
    target: "https://files.example.test/private/path?sig=secret#fragment",
  });
  assert.equal(signedUrl.text, "Destination: https://files.example.test");
  assert.equal(JSON.stringify(signedUrl).includes("secret"), false);

  const generic = buildToolAuditTargetSummary({ provenance: "generic_template" });
  assert.deepEqual(generic, {
    targetType: "connector",
    text: "Connector tool invocation",
    provenance: "generic_template",
    redacted: false,
  });
});

test("admission and terminal writes are tenant-scoped, idempotent and append-only", () => {
  let now = new Date("2026-08-12T08:00:00.000Z");
  const store = new InMemoryToolAuditStore(() => new Date(now));
  const created = store.admit(admission());
  assert.equal(created.status, "created");
  assert.equal(created.terminal, null);
  assert.equal(store.getPending("tenant-a", created.admission.invocationId)?.agentInstanceId, ids.agentInstanceId);
  assert.equal(store.getPending("tenant-b", created.admission.invocationId), null);

  const replay = store.admit(admission());
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.admission.invocationId, created.admission.invocationId);
  assertCode(() => store.admit(admission({ toolName: "list-mail-messages" })), "TOOL_AUDIT_IDEMPOTENCY_CONFLICT");

  now = new Date("2026-08-12T08:00:00.125Z");
  const terminalInput = {
    invocationId: created.admission.invocationId,
    tenantId: "tenant-a",
    subjectId: "member-a",
    workspaceId: ids.workspaceId,
    agentInstanceId: ids.agentInstanceId,
    outcome: "succeeded" as const,
    latencyMs: 125,
    failureClass: null,
  };
  const terminal = store.finalize(terminalInput);
  assert.equal(terminal.status, "created");
  assert.equal(store.getPending("tenant-a", created.admission.invocationId), null);
  assert.equal(store.getTerminal("tenant-a", created.admission.invocationId)?.outcome, "succeeded");
  assert.equal(store.finalize(terminalInput).status, "duplicate");
  assertCode(() => store.finalize({ ...terminalInput, outcome: "failed", failureClass: "UPSTREAM_FAILED" }), "TOOL_AUDIT_TERMINAL_CONFLICT");
  assertCode(() => store.finalize({ ...terminalInput, tenantId: "tenant-b" }), "TOOL_AUDIT_INVOCATION_NOT_FOUND");
  assertCode(() => store.finalize({ ...terminalInput, agentInstanceId: "44444444-4444-4444-8444-444444444444" }), "TOOL_AUDIT_INVOCATION_NOT_FOUND");
});

test("admission derives the persisted target summary and never accepts a caller-built summary", () => {
  const store = new InMemoryToolAuditStore(() => new Date("2026-08-12T08:00:00.000Z"));
  const created = store.admit(admission({
    target: {
      provenance: "managed_schema",
      targetType: "file",
      target: "board.docx password=hunter2 Bearer opaque-secret-token",
    },
  }));
  assert.equal(created.admission.targetSummary.redacted, true);
  assert.equal(JSON.stringify(created.admission).includes("hunter2"), false);
  assert.equal(JSON.stringify(created.admission).includes("opaque-secret-token"), false);
  assert.throws(() => store.admit({
    ...admission({ sourceInvocationId: "caller-summary" }),
    target: undefined,
    targetSummary: {
      targetType: "file",
      text: "File: password=hunter2",
      provenance: "managed_schema",
      redacted: false,
    },
  } as never));
});

test("every terminal class is represented without raw provider payloads", () => {
  let ordinal = 0;
  const now = new Date("2026-08-12T09:00:00.000Z");
  const store = new InMemoryToolAuditStore(() => now);
  const outcomes: Array<{ outcome: ToolAuditTerminalOutcome; failureClass: string | null }> = [
    { outcome: "succeeded", failureClass: null },
    { outcome: "failed", failureClass: "UPSTREAM_FAILED" },
    { outcome: "cancelled", failureClass: "CALLER_CANCELLED" },
    { outcome: "timed_out", failureClass: "UPSTREAM_TIMEOUT" },
  ];
  for (const value of outcomes) {
    ordinal += 1;
    const pending = store.admit(admission({ sourceInvocationId: `allowed-${ordinal}` })).admission;
    const result = store.finalize({
      invocationId: pending.invocationId,
      tenantId: pending.tenantId,
      subjectId: pending.subjectId,
      workspaceId: pending.workspaceId,
      agentInstanceId: pending.agentInstanceId,
      outcome: value.outcome,
      latencyMs: ordinal,
      failureClass: value.failureClass,
    }).record;
    assert.equal(result.outcome, value.outcome);
  }

  const denied = store.admit(admission({
    sourceInvocationId: "denied-1",
    policyDecision: "deny",
    policyCode: "MCP_TOOL_BLOCKED_BY_POLICY",
  }));
  assert.equal(denied.terminal?.outcome, "denied");

  const approval = store.admit(admission({
    sourceSystem: "governed_operation",
    sourceInvocationId: "approval-1",
    policyDecision: "approval_required",
    policyCode: "MCP_APPROVAL_REQUIRED",
    governedOperationId: ids.governedOperationId,
  }));
  assert.equal(approval.terminal?.outcome, "approval_required");
  assert.equal(approval.terminal?.governedOperationId, ids.governedOperationId);

  const serialized = JSON.stringify(store.listTerminal("tenant-a"));
  for (const forbidden of ["arguments", "results", "hidden reasoning", "signed-url-secret"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("missing completion evidence becomes an honest unconfirmed terminal", () => {
  let now = new Date("2026-08-12T10:00:00.000Z");
  const store = new InMemoryToolAuditStore(() => new Date(now));
  const pending = store.admit(admission({ sourceInvocationId: "lost-callback" })).admission;
  now = new Date("2026-08-12T10:15:00.000Z");
  assert.equal(store.reconcileUnconfirmed(new Date("2026-08-12T10:05:00.000Z")), 1);
  const terminal = store.getTerminal("tenant-a", pending.invocationId);
  assert.equal(terminal?.outcome, "unconfirmed");
  assert.equal(terminal?.failureClass, "TOOL_AUDIT_TERMINAL_EVIDENCE_MISSING");
  assert.equal(terminal?.latencyMs, 15 * 60 * 1_000);
  assert.equal(store.reconcileUnconfirmed(new Date("2026-08-12T10:05:00.000Z")), 0);
  assert.equal(toolAuditTerminalRecordSchema.safeParse(terminal).success, true);
});
