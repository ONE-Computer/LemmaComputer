import assert from "node:assert/strict";
import test from "node:test";
import { buildSpendReport, buildSpendTaskDetail, spendReportCsv, type SpendEventRow, type SpendRange } from "@onecomputer/workspace-store";

const range: SpendRange = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-08-01T00:00:00.000Z"),
};

const event = (overrides: Partial<SpendEventRow> = {}): SpendEventRow => ({
  eventId: "event-1", admissionId: "attempt-1", eventType: "usage", correctsEventId: null,
  occurredAt: "2026-07-20T10:00:00.000Z", receivedAt: "2026-07-20T10:00:01.000Z",
  outcome: "success", latencyMs: 900, priceStatus: "priced", costStatus: "estimated",
  currency: "USD", providerCost: "10.000000000000", providerConfirmedCost: null,
  rateCardId: "rate-1", rateCardSource: "pinned_catalogue", rateCardSourceVersion: "2026-07",
  rateCardSourceHash: "a".repeat(64), rateCardEffectiveFrom: "2026-07-01T00:00:00.000Z",
  subjectId: "alex", subjectDisplayName: "Alex Morgan", teamId: "team-finance", teamDisplayName: "Finance",
  costCenterCode: "FIN-100", workspaceId: "workspace-1", agentId: "agent-1", sessionId: "session-1",
  taskId: "task-1", turnId: "turn-1", taskBindingProvenance: "explicit_signed",
  requestedAlias: "balanced", requestedServiceClass: "balanced", selectedServiceClass: "balanced",
  attemptKind: "inference", parentAttemptId: null, resolvedProvider: "openai", resolvedModel: "gpt-5.6-terra",
  resolvedDeploymentId: "terra-sg", admittedAt: "2026-07-20T09:59:59.000Z",
  conversationHistoryCount: 2, attachmentCount: 0, retrievalCount: 0, systemPolicyContextCount: 1,
  toolResultContextCount: 0, routingOverheadCount: 0,
  units: [
    { unit: "input_uncached_token", quantity: "100.000000", bucketCost: "1.000000000000", diagnostic: false },
    { unit: "cache_read_token", quantity: "20.000000", bucketCost: "0.100000000000", diagnostic: false },
    { unit: "cache_write_token", quantity: "5.000000", bucketCost: "0.050000000000", diagnostic: false },
    { unit: "output_token", quantity: "30.000000", bucketCost: "3.000000000000", diagnostic: false },
    { unit: "reasoning_token", quantity: "10.000000", bucketCost: "1.000000000000", diagnostic: false },
  ],
  ...overrides,
});

test("spend aggregation applies correction deltas once, keeps currencies separate, and never double counts memberships", () => {
  const report = buildSpendReport([
    event(),
    event({
      eventId: "correction-1", eventType: "correction", correctsEventId: "event-1", providerCost: "-2.000000000000",
      units: [{ unit: "input_uncached_token", quantity: "-10.000000", bucketCost: "-0.100000000000", diagnostic: false }],
    }),
    event({
      eventId: "event-2", admissionId: "attempt-2", taskId: "task-2", teamId: "team-research",
      teamDisplayName: "Research", costCenterCode: "RND-200", providerCost: "3.000000000000", providerConfirmedCost: "2.750000000000",
    }),
    event({ eventId: "event-3", admissionId: "attempt-3", taskId: "task-3", currency: "SGD", providerCost: "4.500000000000", attemptKind: "fallback" }),
  ], range);
  assert.deepEqual(report.totals.costs, [{ currency: "SGD", amount: "4.5" }, { currency: "USD", amount: "11" }]);
  assert.equal(report.totals.attemptCount, 3);
  assert.equal(report.totals.correctedEventCount, 1);
  assert.equal(report.totals.fallbackCount, 1);
  assert.equal(report.totals.usage.input_uncached_token, "290");
  assert.equal(report.teams.reduce((sum, team) => sum + team.attemptCount, 0), report.totals.attemptCount);
  assert.deepEqual(report.totals.providerConfirmedCosts, [{ currency: "USD", amount: "2.75" }]);
  assert.deepEqual(report.totals.latency, { sampleCount: 3, averageMs: 900, p95Ms: 900 });
  assert.deepEqual(report.breakdowns.requestedRoutes.map((item) => item.requestedRoute), ["balanced"]);
  assert.equal(report.breakdowns.resolvedModels[0]?.provider, "openai");
  assert.equal(report.breakdowns.workspaces[0]?.workspaceId, "workspace-1");
  assert.equal(report.breakdowns.agents[0]?.agentId, "agent-1");
  assert.equal(report.users.reduce((sum, user) => sum + user.attemptCount, 0), report.totals.attemptCount);
});

test("missing, incomplete, delayed, corrected, and price snapshots stay distinguishable from zero", () => {
  const report = buildSpendReport([
    event({
      eventId: "unknown", admissionId: "unknown-attempt", taskId: "unknown-task", priceStatus: "unknown", costStatus: "unpriced",
      currency: null, providerCost: null, rateCardId: null, rateCardSource: null, rateCardSourceVersion: null,
      rateCardSourceHash: null, rateCardEffectiveFrom: null,
    }),
    event({
      eventId: "incomplete", admissionId: "partial-attempt", taskId: "partial-task", priceStatus: "incomplete", costStatus: "unpriced",
      currency: null, providerCost: null, rateCardId: null, rateCardSource: null, rateCardSourceVersion: null,
      rateCardSourceHash: null, rateCardEffectiveFrom: null,
    }),
  ], range, 2);
  assert.equal(report.state, "partial");
  assert.equal(report.totals.unknownCostEventCount, 1);
  assert.equal(report.totals.incompleteCostEventCount, 1);
  assert.equal(report.totals.delayedAttemptCount, 2);
  assert.equal(report.tasks.find((task) => task.taskId === "unknown-task")?.priceState, "missing");
  assert.deepEqual(buildSpendTaskDetail([event()], range)?.attempts[0]?.priceBasis, {
    rateCardId: "rate-1", source: "pinned_catalogue", version: "2026-07",
    sourceHash: "a".repeat(64), effectiveFrom: "2026-07-01T00:00:00.000Z",
  });
});

test("composite task identity prevents reused task IDs from merging and trend compares an equal prior period", () => {
  const report = buildSpendReport([
    event(),
    event({ eventId: "other-user-event", admissionId: "other-user-attempt", subjectId: "sam", subjectDisplayName: "Sam", taskId: "task-1" }),
    event({ eventId: "other-turn-event", admissionId: "other-turn-attempt", turnId: "turn-2", taskId: "task-1" }),
  ], range, 0, [event({ eventId: "prior", admissionId: "prior-attempt", providerCost: "4" })]);
  assert.equal(report.tasks.length, 3);
  assert.deepEqual(report.trend, {
    previousRange: { from: "2026-05-31T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" },
    costs: [{ currency: "USD", amount: "4" }],
    providerConfirmedCosts: [],
    attemptCount: 1,
    attemptCountDelta: 2,
    costDeltas: [{ currency: "USD", amount: "26" }],
  });
});

test("high-cost task explanation is deterministic and contains only safe driver categories", () => {
  const detail = buildSpendTaskDetail([event({
    conversationHistoryCount: 5, attachmentCount: 400, retrievalCount: 40, systemPolicyContextCount: 2,
    toolResultContextCount: 15, routingOverheadCount: 1,
    units: [
      { unit: "output_token", quantity: "80.000000", bucketCost: "8.000000000000", diagnostic: false },
      { unit: "reasoning_token", quantity: "20.000000", bucketCost: "2.000000000000", diagnostic: false },
      { unit: "cache_read_token", quantity: "10.000000", bucketCost: "0.010000000000", diagnostic: false },
    ],
  })], range);
  assert.equal(detail?.drivers[0]?.code, "attachments");
  assert.deepEqual(detail?.drivers.map((driver) => driver.code), [
    "attachments", "output_reasoning", "retrieved_context", "tool_result_context", "cache_behavior",
    "conversation_history", "system_policy_context", "routing_overhead",
  ]);
  assert.equal(JSON.stringify(detail).includes("prompt"), false);
  assert.equal(JSON.stringify(detail).includes("reasoning text"), false);
});

test("CSV is stable, reconciles to the task view, and contains no raw-provider fields", () => {
  const csv = spendReportCsv(buildSpendReport([event({ providerConfirmedCost: "9.75" })], range), "acme");
  assert.match(csv, /^contract_version,tenant_id,range_from,range_to,as_of,team_id/);
  assert.match(csv, /1,acme,/);
  assert.match(csv, /task-1/);
  assert.match(csv, /USD,10/);
  assert.equal(csv.includes("source_system"), false);
  assert.equal(csv.includes("provider_account_id"), false);
  assert.equal(csv.includes("session-1"), false);
  assert.equal(csv.includes("raw_content"), false);
  assert.match(csv, /USD,10,9.75/);
});
