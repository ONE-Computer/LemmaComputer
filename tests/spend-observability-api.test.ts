import assert from "node:assert/strict";
import test from "node:test";
import type { ControllerClient } from "../apps/control-api/src/service.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import {
  buildSpendReport,
  buildSpendTaskDetail,
  decodeSpendTaskKey,
  MemoryWorkspaceStore,
  type IdentityPolicyStore,
  type CostCoverageAcknowledgement,
  type SessionPrincipal,
  type SpendEventRow,
  type SpendObservabilityStore,
  type SpendRange,
} from "@onecomputer/workspace-store";

const proxyToken = "spend-api-proxy-token-at-least-24-characters";
const administrator: SessionPrincipal = {
  userId: "spend-admin",
  tenantId: "acme",
  email: "admin@example.test",
  displayName: "Spend Administrator",
  tenantDisplayName: "Acme",
  roles: ["employee", "administrator"],
  identity: { tenantId: "acme", subjectId: "spend-admin", audience: "onecomputer-control" },
};
const employee: SessionPrincipal = {
  ...administrator,
  userId: "employee",
  roles: ["employee"],
  identity: { tenantId: "acme", subjectId: "employee", audience: "onecomputer-control" },
};
const otherAdministrator: SessionPrincipal = {
  ...administrator,
  userId: "other-admin",
  tenantId: "other",
  identity: { tenantId: "other", subjectId: "other-admin", audience: "onecomputer-control" },
};
const headers = { "x-onecomputer-proxy-token": proxyToken, cookie: "onecomputer_session=valid" };

const event = (task: string, cost: string, receivedAt: string, overrides: Partial<SpendEventRow> = {}): SpendEventRow => ({
  eventId: `event-${task}`,
  admissionId: `attempt-${task}`,
  eventType: "usage",
  correctsEventId: null,
  occurredAt: "2026-07-20T10:00:00.000Z",
  receivedAt,
  outcome: "success",
  latencyMs: 100,
  priceStatus: "priced",
  costStatus: "estimated",
  currency: "USD",
  providerCost: cost,
  providerConfirmedCost: null,
  rateCardId: "rate-1",
  rateCardSource: "pinned_catalogue",
  rateCardSourceVersion: "2026-07",
  rateCardSourceHash: "a".repeat(64),
  rateCardEffectiveFrom: "2026-07-01T00:00:00.000Z",
  subjectId: "alex",
  subjectDisplayName: "Alex Morgan",
  teamId: "11111111-1111-4111-8111-111111111111",
  teamDisplayName: "Finance",
  costCenterCode: "FIN-100",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  sessionId: "session-1",
  taskId: task,
  turnId: `turn-${task}`,
  taskBindingProvenance: "explicit_signed",
  requestedAlias: "balanced",
  requestedServiceClass: "balanced",
  selectedServiceClass: "balanced",
  attemptKind: "inference",
  parentAttemptId: null,
  resolvedProvider: "openai",
  resolvedModel: "terra",
  resolvedDeploymentId: "terra-sg",
  admittedAt: "2026-07-20T09:59:59.000Z",
  conversationHistoryCount: 1,
  attachmentCount: 0,
  retrievalCount: 0,
  systemPolicyContextCount: 1,
  toolResultContextCount: 0,
  routingOverheadCount: 0,
  units: [{ unit: "input_uncached_token", quantity: "10", bucketCost: "1", diagnostic: false }],
  ...overrides,
});

class FakeSpendStore implements SpendObservabilityStore {
  rows = [
    event("one", "9", "2026-07-20T10:00:01.000Z"),
    event("two", "7", "2026-07-20T10:00:01.000Z"),
    event("three", "5", "2026-07-20T10:00:01.000Z"),
  ];
  acknowledgements = new Map<string, CostCoverageAcknowledgement>();
  calls: Array<{ method: string; tenantId: string; range: SpendRange }> = [];

  async report(tenantId: string, range: SpendRange) {
    this.calls.push({ method: "report", tenantId, range });
    const cutoff = range.receivedBefore?.getTime() ?? Number.POSITIVE_INFINITY;
    const rows = tenantId === "acme"
      ? this.rows.filter((row) => new Date(row.receivedAt).getTime() <= cutoff)
      : [];
    return buildSpendReport(rows, range, 0, undefined, this.acknowledgements.get(tenantId) ?? null);
  }

  async acknowledgeUnpricedUsage(input: { tenantId: string; receivedBefore: Date; acknowledgedBy: string }) {
    const acknowledgement: CostCoverageAcknowledgement = {
      receivedBefore: input.receivedBefore.toISOString(),
      acknowledgedAt: "2026-08-01T12:00:00.000Z",
      acknowledgedBy: input.acknowledgedBy,
      reason: "historical_usage_before_pricing",
    };
    this.acknowledgements.set(input.tenantId, acknowledgement);
    return acknowledgement;
  }

  async task(tenantId: string, taskKey: string, range: SpendRange) {
    this.calls.push({ method: "task", tenantId, range });
    if (tenantId !== "acme") return null;
    const identity = decodeSpendTaskKey(taskKey);
    if (!identity) return null;
    return buildSpendTaskDetail(this.rows.filter((row) => (
      row.teamId === identity.teamId
      && row.subjectId === identity.userId
      && row.workspaceId === identity.workspaceId
      && row.agentId === identity.agentId
      && row.sessionId === identity.sessionId
      && row.taskId === identity.taskId
      && row.turnId === identity.turnId
    )), { ...range, ...identity });
  }
}

const authentication = (actor: SessionPrincipal) => ({
  begin: async () => ({ location: "https://login.example.test", cookie: "state=opaque" }),
  complete: async () => { throw new Error("not used"); },
  authenticate: async () => actor,
  logout: async () => "onecomputer_session=; Max-Age=0",
});
const identityPolicies = {
  getEffectivePolicy: async () => null,
  listUsers: async () => [],
} as unknown as IdentityPolicyStore;
const appFor = (actor: SessionPrincipal, spendObservabilityStore: SpendObservabilityStore) => createControlServer(
  new MemoryWorkspaceStore(),
  {} as ControllerClient,
  proxyToken,
  undefined,
  undefined,
  {},
  {
    authentication: authentication(actor),
    identityPolicyStore: identityPolicies,
    spendObservabilityStore,
    agentBridgeSecret: "spend-observability-agent-bridge-secret-at-least-32-characters",
  },
);

test("spend API derives tenant, validates ranges, and makes role/cross-tenant denials indistinguishable", async () => {
  const store = new FakeSpendStore();
  const adminApp = appFor(administrator, store);
  const employeeApp = appFor(employee, store);
  const otherApp = appFor(otherAdministrator, store);
  try {
    const invalid = await adminApp.inject({
      method: "GET",
      url: "/v1/admin/spend?from=2025-01-01T00%3A00%3A00.000Z&to=2026-07-20T00%3A00%3A00.000Z",
      headers,
    });
    assert.equal(invalid.statusCode, 400);

    const first = await adminApp.inject({
      method: "GET",
      url: "/v1/admin/spend?from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z&limit=1",
      headers,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["cache-control"], "no-store");
    assert.equal(store.calls[0]?.tenantId, "acme");
    const taskKey = first.json().report.tasks[0].taskKey;

    const employeeDenied = await employeeApp.inject({ method: "GET", url: `/v1/admin/spend/tasks/${taskKey}`, headers });
    const otherDenied = await otherApp.inject({ method: "GET", url: `/v1/admin/spend/tasks/${taskKey}`, headers });
    assert.equal(employeeDenied.statusCode, 404);
    assert.equal(otherDenied.statusCode, 404);
    assert.deepEqual(employeeDenied.json().error, otherDenied.json().error);
  } finally {
    await Promise.all([adminApp.close(), employeeApp.close(), otherApp.close()]);
  }
});

test("administrator can acknowledge historical unpriced usage without deleting ledger facts", async () => {
  const store = new FakeSpendStore();
  store.rows[0] = event("one", "9", "2026-07-20T10:00:01.000Z", {
    priceStatus: "unknown",
    costStatus: "unpriced",
    currency: null,
    providerCost: null,
    rateCardId: null,
    rateCardSource: null,
    rateCardSourceVersion: null,
    rateCardSourceHash: null,
    rateCardEffectiveFrom: null,
  });
  const adminApp = appFor(administrator, store);
  const employeeApp = appFor(employee, store);
  const reportUrl = "/v1/admin/spend?from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z&asOf=2026-07-31T00%3A00%3A00.000Z";
  try {
    const before = await adminApp.inject({ method: "GET", url: reportUrl, headers });
    assert.equal(before.json().report.costCoverage.unpricedUsage.activeEventCount, 1);

    const denied = await employeeApp.inject({
      method: "POST",
      url: "/v1/admin/spend/cost-coverage/acknowledgements",
      headers,
      payload: { receivedBefore: "2026-07-31T00:00:00.000Z" },
    });
    assert.equal(denied.statusCode, 404);

    const acknowledged = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/spend/cost-coverage/acknowledgements",
      headers,
      payload: { receivedBefore: "2026-07-31T00:00:00.000Z" },
    });
    assert.equal(acknowledged.statusCode, 201);
    assert.equal(acknowledged.headers["cache-control"], "no-store");
    assert.equal(acknowledged.json().acknowledgement.acknowledgedBy, administrator.userId);

    const after = await adminApp.inject({ method: "GET", url: reportUrl, headers });
    assert.equal(after.json().report.costCoverage.unpricedUsage.activeEventCount, 0);
    assert.equal(after.json().report.costCoverage.unpricedUsage.acknowledgedEventCount, 1);
    assert.equal(after.json().report.costCoverage.status, "acknowledged_history");
    assert.equal(after.json().report.totals.unknownCostEventCount, 1);
  } finally {
    await Promise.all([adminApp.close(), employeeApp.close()]);
  }
});

test("cursor freezes late corrections and CSV/JSON export reconciles to the same snapshot", async () => {
  const store = new FakeSpendStore();
  const app = appFor(administrator, store);
  try {
    const first = await app.inject({
      method: "GET",
      url: "/v1/admin/spend?from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z&limit=1",
      headers,
    });
    const page = first.json();
    assert.equal(page.report.totals.costs[0].amount, "21");
    assert.ok(page.page.nextCursor);
    const asOf = page.report.asOf;
    store.rows.push(event("one", "-4", new Date(new Date(asOf).getTime() + 1000).toISOString(), {
      eventId: "late-correction",
      eventType: "correction",
      correctsEventId: "event-one",
    }));

    const second = await app.inject({
      method: "GET",
      url: `/v1/admin/spend?limit=1&cursor=${encodeURIComponent(page.page.nextCursor)}`,
      headers,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().report.asOf, asOf);
    assert.equal(second.json().report.totals.costs[0].amount, "21");
    assert.notEqual(second.json().report.tasks[0].taskKey, page.report.tasks[0].taskKey);

    const exportQuery = new URLSearchParams({
      from: page.report.range.from,
      to: page.report.range.to,
      asOf,
      format: "csv",
    });
    const csv = await app.inject({ method: "GET", url: `/v1/admin/spend/export?${exportQuery}`, headers });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.headers["content-type"], /^text\/csv/);
    assert.equal((csv.body.match(/USD/g) ?? []).length, 3);
    assert.match(csv.body, /1,acme,/);
    assert.equal(csv.body.includes("late-correction"), false);

    exportQuery.set("format", "json");
    const json = await app.inject({ method: "GET", url: `/v1/admin/spend/export?${exportQuery}`, headers });
    assert.equal(json.statusCode, 200);
    assert.equal(json.json().report.totals.costs[0].amount, "21");
    assert.equal(json.json().tenantId, "acme");
  } finally {
    await app.close();
  }
});

test("opaque task keys keep identical task coordinates under different Team snapshots separate", async () => {
  const store = new FakeSpendStore();
  store.rows = [
    event("shared", "9", "2026-07-20T10:00:01.000Z"),
    event("shared", "4", "2026-07-20T10:00:01.000Z", {
      eventId: "event-shared-research",
      admissionId: "attempt-shared-research",
      teamId: "22222222-2222-4222-8222-222222222222",
      teamDisplayName: "Research",
      costCenterCode: "RND-200",
    }),
  ];
  const app = appFor(administrator, store);
  try {
    const reportResponse = await app.inject({
      method: "GET",
      url: "/v1/admin/spend?from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z",
      headers,
    });
    assert.equal(reportResponse.statusCode, 200);
    const report = reportResponse.json().report;
    assert.equal(report.tasks.length, 2);
    assert.notEqual(report.tasks[0].taskKey, report.tasks[1].taskKey);

    for (const task of report.tasks) {
      const detailResponse = await app.inject({
        method: "GET",
        url: `/v1/admin/spend/tasks/${encodeURIComponent(task.taskKey)}?from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z`,
        headers,
      });
      assert.equal(detailResponse.statusCode, 200);
      const detail = detailResponse.json().task;
      assert.equal(detail.task.teamId, task.teamId);
      assert.deepEqual(detail.task.costs, task.costs);
      assert.equal(detail.attempts.length, 1);
    }
  } finally {
    await app.close();
  }
});
