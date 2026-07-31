import assert from "node:assert/strict";
import test from "node:test";
import type { MinimalSpendingTeam } from "@onecomputer/contracts";
import { MemoryWorkspaceStore, attemptAdmissionFingerprint, type AdmissionResult, type AttemptAdmissionInput, type AttemptAdmissionSemanticInput, type PostgresUsageLedgerStore, type TeamStore, type UsageAttemptAdmissionHook, type UsageEventInput } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";
import { UsageLedgerService, UsageTaskBindingAuthority, internalUsageAdmissionSchema, type InternalUsageAdmission } from "../apps/control-api/src/usage-ledger.js";

const taskSecret = "usage-task-binding-test-secret-with-at-least-32-characters";
const internalToken = "usage-internal-test-token-with-at-least-32-characters";
const team: MinimalSpendingTeam = {
  id: "52a914bf-b0ee-4c77-8440-e7e2541d5889",
  displayName: "Research",
  costCenterCode: "RND-01",
  isRolloutFallback: false,
};
const laterTeam: MinimalSpendingTeam = {
  id: "92e8c48d-f876-4dd4-b7d7-2a25094860b6",
  displayName: "Platform",
  costCenterCode: "PLT-02",
  isRolloutFallback: false,
};

class FakeTeams {
  calls: Array<{ tenantId: string; userId: string }> = [];
  current = team;
  async resolveDefaultSpendingTeam(input: { tenantId: string; userId: string }) {
    this.calls.push(input);
    return this.current;
  }
}

class FakeLedger {
  admissions: AttemptAdmissionInput[] = [];
  events: UsageEventInput[] = [];
  hookTransactions: unknown[] = [];
  private replay(input: AttemptAdmissionSemanticInput): AdmissionResult | null {
    const prior = this.admissions.find((item) => (
      item.tenantId === input.tenantId
      && item.sourceSystem === input.sourceSystem
      && item.sourceAttemptId === input.sourceAttemptId
    ));
    if (!prior) return null;
    return attemptAdmissionFingerprint(prior) === attemptAdmissionFingerprint(input)
      ? { status:"duplicate",admissionId:"00000000-0000-4000-8000-000000000001",team:{ id:prior.team.id,displayName:prior.team.displayName,costCenterCode:prior.team.costCenterCode } }
      : { status:"conflict",admissionId:null };
  }
  async replayAttempt(input: AttemptAdmissionSemanticInput) { return this.replay(input); }
  async admitAttempt(input: AttemptAdmissionInput, hook: UsageAttemptAdmissionHook) {
    const replay = this.replay(input);
    if (replay) return replay;
    this.admissions.push(input);
    const transaction = { transaction: true };
    this.hookTransactions.push(transaction);
    const decision = await hook.admit(input, transaction as never);
    return decision.decision === "deny"
      ? { status:"denied" as const,admissionId:null,denialCode:decision.code }
      : { status:"created" as const,admissionId:`00000000-0000-4000-8000-${String(this.admissions.length).padStart(12, "0")}`,team:{ id:input.team.id,displayName:input.team.displayName,costCenterCode:input.team.costCenterCode } };
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
  budgetBounds: { inputTokens:"128",maximumOutputTokens:"256",maximumReasoningTokens:"64",cacheStatus:"unknown",maxRetries:1,maxFallbacks:1,maxAgentSteps:2,reservationTtlSeconds:300,providerDeadlineAt:"2026-07-31T10:05:00.000Z" },
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

test("unbound task identity is deterministic across a lost admission response replay", async () => {
  const ledger = new FakeLedger();
  const teams = new FakeTeams();
  const bindings = new UsageTaskBindingAuthority(taskSecret);
  const service = new UsageLedgerService(ledger as unknown as PostgresUsageLedgerStore, teams as unknown as TeamStore, bindings);

  const first = await service.admit(admission());
  const replay = await service.admit(admission());
  await service.admit(admission({ sourceAttemptId: "call-2" }));

  assert.equal(first.status, "created");
  assert.equal(replay.status, "duplicate");
  assert.equal(ledger.admissions.length, 2);
  assert.match(ledger.admissions[0]?.taskId ?? "", /^unbound:[A-Za-z0-9_-]{43}$/);
  assert.equal(first.taskId, replay.taskId);
  assert.notEqual(ledger.admissions[0]?.taskId, ledger.admissions[1]?.taskId);
});

test("admission replay keeps the stored Team and ignores only volatile timing bounds", async () => {
  const ledger = new FakeLedger();
  const teams = new FakeTeams();
  let hookCalls = 0;
  const hook: UsageAttemptAdmissionHook = { admit: async () => { hookCalls += 1; return { decision:"allow" }; } };
  const service = new UsageLedgerService(ledger as unknown as PostgresUsageLedgerStore, teams as unknown as TeamStore, new UsageTaskBindingAuthority(taskSecret), hook);

  const first = await service.admit(admission());
  teams.current = laterTeam;
  const replay = await service.admit(admission({
    admittedAt:"2026-07-31T10:03:00.000Z",
    budgetBounds:{ ...admission().budgetBounds!,reservationTtlSeconds:900,providerDeadlineAt:"2026-07-31T10:18:00.000Z" },
  }));

  assert.equal(first.status,"created");
  assert.equal(replay.status,"duplicate");
  assert.deepEqual(replay.team,{ id:team.id,displayName:team.displayName,costCenterCode:team.costCenterCode });
  assert.equal(teams.calls.length,1);
  assert.equal(ledger.admissions.length,1);
  assert.equal(hookCalls,1);
  await assert.rejects(() => service.admit(admission({ resolvedDeploymentId:"deployment-2" })),/reused with different facts/);
  await assert.rejects(() => service.admit(admission({ budgetBounds:{ ...admission().budgetBounds!,maximumOutputTokens:"257" } })),/reused with different facts/);
  assert.equal(teams.calls.length,1);
  assert.equal(hookCalls,1);
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
