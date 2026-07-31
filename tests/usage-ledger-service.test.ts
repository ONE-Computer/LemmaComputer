import assert from "node:assert/strict";
import test from "node:test";
import type { MinimalSpendingTeam } from "@onecomputer/contracts";
import { MemoryWorkspaceStore, type AttemptAdmissionInput, type PostgresUsageLedgerStore, type TeamStore, type UsageAttemptAdmissionHook, type UsageEventInput } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";
import { UsageLedgerService, UsageTaskBindingAuthority, internalUsageAdmissionSchema, type InternalUsageAdmission } from "../apps/control-api/src/usage-ledger.js";

const taskSecret = "usage-task-binding-test-secret-with-at-least-32-characters";
const internalToken = "usage-internal-test-token-with-at-least-32-characters";
const team: MinimalSpendingTeam = {
  id: "52a914bf-b0ee-4c77-8440-e7e2541d5889",
  displayName: "Research",
  costCenterCode: "RND-01",
};

class FakeTeams {
  calls: Array<{ tenantId: string; userId: string }> = [];
  async resolveDefaultSpendingTeam(input: { tenantId: string; userId: string }) {
    this.calls.push(input);
    return team;
  }
}

class FakeLedger {
  admissions: AttemptAdmissionInput[] = [];
  events: UsageEventInput[] = [];
  hookTransactions: unknown[] = [];
  async admitAttempt(input: AttemptAdmissionInput, hook: UsageAttemptAdmissionHook) {
    this.admissions.push(input);
    const transaction = { transaction: true };
    this.hookTransactions.push(transaction);
    const decision = await hook.admit(input, transaction as never);
    return decision.decision === "deny"
      ? { status: "denied" as const, admissionId: null, denialCode: decision.code }
      : { status: "created" as const, admissionId: `00000000-0000-4000-8000-${String(this.admissions.length).padStart(12, "0")}` };
  }
  async appendUsageEvent(input: UsageEventInput) {
    this.events.push(input);
    return { status: "created" as const, eventId: "00000000-0000-4000-8000-100000000001", priceStatus: "unknown" as const, providerCost: null, currency: null };
  }
}

const admission = (overrides: Partial<InternalUsageAdmission> = {}) => internalUsageAdmissionSchema.parse({
  schemaVersion: 1, sourceSystem: "litellm", sourceAttemptId: "call-1",
  tenantId: "acme", subjectId: "alex", workspaceId: "workspace-1", agentId: "agent-1",
  policyVersionId: "policy-1", policyHash: "a".repeat(64), requestedAlias: "balanced",
  requestedServiceClass: "balanced", selectedServiceClass: "balanced", routeMappingVersion: "routes-1",
  attemptKind: "inference", resolvedProvider: "openai", providerAccountId: "credential-1",
  resolvedModel: "gpt-test", resolvedDeploymentId: "deployment-1", providerServiceTier: "standard",
  admittedAt: "2026-07-31T10:00:00.000Z", ...overrides,
});

test("simultaneous signed task contexts remain explicit and independent", async () => {
  const ledger = new FakeLedger();
  const teams = new FakeTeams();
  const bindings = new UsageTaskBindingAuthority(taskSecret, () => new Date("2026-07-31T10:00:00.000Z"));
  const service = new UsageLedgerService(ledger as unknown as PostgresUsageLedgerStore, teams as unknown as TeamStore, bindings);
  const firstBinding = bindings.issue({ tenantId: "acme", subjectId: "alex", workspaceId: "workspace-1", agentId: "agent-1", contextKind: "chat", taskId: "message-1", sessionId: "session-1", turnId: "turn-1" });
  const secondBinding = bindings.issue({ tenantId: "acme", subjectId: "alex", workspaceId: "workspace-1", agentId: "agent-1", contextKind: "schedule", taskId: "schedule:run-2", sessionId: "session-2", turnId: "turn-2" });

  await Promise.all([
    service.admit(admission({ sourceAttemptId: "call-1", taskBinding: firstBinding })),
    service.admit(admission({ sourceAttemptId: "call-2", taskBinding: secondBinding })),
  ]);

  assert.deepEqual(ledger.admissions.map(({ contextKind, taskId, sessionId, turnId, team: snapshot }) => ({ contextKind, taskId, sessionId, turnId, snapshot })), [
    { contextKind: "chat", taskId: "message-1", sessionId: "session-1", turnId: "turn-1", snapshot: team },
    { contextKind: "schedule", taskId: "schedule:run-2", sessionId: "session-2", turnId: "turn-2", snapshot: team },
  ]);
  assert.equal(teams.calls.length, 2);
  assert.equal(ledger.hookTransactions.length, 2);
});

test("binding identity mismatches fail before Team resolution or admission", async () => {
  const ledger = new FakeLedger();
  const teams = new FakeTeams();
  const bindings = new UsageTaskBindingAuthority(taskSecret, () => new Date("2026-07-31T10:00:00.000Z"));
  const service = new UsageLedgerService(ledger as unknown as PostgresUsageLedgerStore, teams as unknown as TeamStore, bindings);
  const token = bindings.issue({ tenantId: "other", subjectId: "alex", workspaceId: "workspace-1", agentId: "agent-1", contextKind: "chat", taskId: "message-1" });
  await assert.rejects(() => service.admit(admission({ taskBinding: token })), /does not match/);
  assert.equal(teams.calls.length, 0);
  assert.equal(ledger.admissions.length, 0);
});

test("internal usage endpoints require their dedicated token and reject raw payload fields", async () => {
  const ledger = new FakeLedger();
  const teams = new FakeTeams();
  const app = createControlServer(
    new MemoryWorkspaceStore(), {} as ControllerClient,
    "proxy-token-with-at-least-24-characters", undefined, undefined, {},
    {
      testIdentityMode: true,
      teamStore: teams as unknown as TeamStore,
      usageLedgerStore: ledger as unknown as PostgresUsageLedgerStore,
      usageInternalToken: internalToken,
      usageTaskBindingSecret: taskSecret,
    },
  );
  try {
    const unauthenticated = await app.inject({ method: "POST", url: "/internal/v1/ai-usage/attempts/admit", payload: admission() });
    assert.equal(unauthenticated.statusCode, 401);

    const rawContent = await app.inject({
      method: "POST", url: "/internal/v1/ai-usage/attempts/admit",
      headers: { "x-onecomputer-ai-usage-token": internalToken },
      payload: { ...admission(), rawPrompt: "must never enter the ledger" },
    });
    assert.equal(rawContent.statusCode, 400);
    assert.equal(ledger.admissions.length, 0);

    const accepted = await app.inject({
      method: "POST", url: "/internal/v1/ai-usage/attempts/admit",
      headers: { "x-onecomputer-ai-usage-token": internalToken }, payload: admission(),
    });
    assert.equal(accepted.statusCode, 201);
    assert.equal(ledger.admissions[0]?.contextKind, "background");
    assert.equal(ledger.admissions[0]?.taskBindingProvenance, "unbound_generated");
    assert.match(ledger.admissions[0]?.taskId ?? "", /^unbound:/);
  } finally {
    await app.close();
  }
});
