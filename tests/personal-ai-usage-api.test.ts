import assert from "node:assert/strict";
import test from "node:test";
import type { ControllerClient } from "../apps/control-api/src/service.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import {
  buildSpendReport,
  MemoryWorkspaceStore,
  type IdentityPolicyStore,
  type SessionPrincipal,
  type SpendEventRow,
  type SpendObservabilityStore,
  type SpendRange,
} from "@lemmacomputer/workspace-store";

const proxyToken = "personal-ai-usage-proxy-token-at-least-24-characters";
const headers = { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid" };
const member: SessionPrincipal = {
  userId: "member-a",
  tenantId: "acme",
  email: "member@example.test",
  displayName: "Member A",
  tenantDisplayName: "Acme",
  roles: ["employee", "cost-analyst"],
  identity: { tenantId: "acme", subjectId: "member-a", audience: "lemmacomputer-control" },
};
const otherTenantMember: SessionPrincipal = {
  ...member,
  tenantId: "other",
  userId: "member-b",
  identity: { tenantId: "other", subjectId: "member-b", audience: "lemmacomputer-control" },
};

const event = (id: string, overrides: Partial<SpendEventRow> = {}): SpendEventRow => ({
  eventId: `event-${id}`,
  admissionId: `attempt-${id}`,
  eventType: "usage",
  correctsEventId: null,
  occurredAt: "2026-08-10T10:00:00.000Z",
  receivedAt: "2026-08-10T10:00:01.000Z",
  outcome: "success",
  latencyMs: 100,
  priceStatus: "priced",
  costStatus: "estimated",
  currency: "USD",
  providerCost: "2",
  providerConfirmedCost: null,
  rateCardId: "rate-1",
  rateCardSource: "pinned_catalogue",
  rateCardSourceVersion: "2026-08",
  rateCardSourceHash: "a".repeat(64),
  rateCardEffectiveFrom: "2026-08-01T00:00:00.000Z",
  subjectId: "member-a",
  subjectDisplayName: "Member A",
  teamId: "11111111-1111-4111-8111-111111111111",
  teamDisplayName: "Operations",
  costCenterCode: "OPS-1",
  workspaceId: "workspace-a",
  agentId: "agent-a",
  sessionId: "session-a",
  taskId: id,
  turnId: `turn-${id}`,
  taskBindingProvenance: "explicit_signed",
  requestedAlias: "balanced",
  requestedServiceClass: "balanced",
  selectedServiceClass: "balanced",
  attemptKind: "inference",
  parentAttemptId: null,
  resolvedProvider: "openai",
  resolvedModel: "terra",
  resolvedDeploymentId: "terra-sg",
  admittedAt: "2026-08-10T09:59:59.000Z",
  conversationHistoryCount: 0,
  attachmentCount: 0,
  retrievalCount: 0,
  systemPolicyContextCount: 0,
  toolResultContextCount: 0,
  routingOverheadCount: 0,
  units: [{ unit: "input_uncached_token", quantity: "100", bucketCost: "2", diagnostic: false }],
  ...overrides,
});

class SubjectScopedSpendStore implements SpendObservabilityStore {
  rows: SpendEventRow[] = [];
  previousRows: SpendEventRow[] = [];
  calls: Array<{ tenantId: string; range: SpendRange }> = [];

  async report(tenantId: string, range: SpendRange) {
    this.calls.push({ tenantId, range });
    const scoped = tenantId === "acme" ? this.rows.filter((row) => row.subjectId === range.userId) : [];
    const previous = tenantId === "acme" ? this.previousRows.filter((row) => row.subjectId === range.userId) : [];
    return buildSpendReport(scoped, range, scoped.length ? 1 : 0, previous);
  }

  async task() { return null; }
  async acknowledgeUnpricedUsage() { throw new Error("not used"); }
}

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
    customerProductAuthentication: {
      resolve: async (headers: Headers) => headers.get("cookie") === "lemmacomputer_session=valid"
        ? { status: "authorized" as const, principal: actor }
        : { status: "anonymous" as const },
    },
    identityPolicyStore: identityPolicies,
    spendObservabilityStore,
    agentBridgeSecret: "personal-ai-usage-agent-bridge-secret-at-least-32-characters",
  },
);

test("personal AI usage fixes tenant and subject to the authenticated membership and reconciles with the administrator report", async () => {
  const store = new SubjectScopedSpendStore();
  store.rows = [
    event("owned"),
    event("other-person", { subjectId: "another-member", subjectDisplayName: "Another Member", workspaceId: "workspace-secret", agentId: "agent-secret", providerCost: "99" }),
  ];
  store.previousRows = [event("previous", { occurredAt: "2026-07-10T10:00:00.000Z", providerCost: "1" })];
  const app = appFor(member, store);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/me/ai-usage?from=2026-08-01T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z&asOf=2026-09-01T00%3A00%3A00.000Z",
      headers,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(store.calls[0]?.tenantId, "acme");
    assert.equal(store.calls[0]?.range.userId, "member-a");

    const body = response.json().report;
    const administratorReport = buildSpendReport(
      [store.rows[0]!],
      store.calls[0]!.range,
      1,
      store.previousRows,
    );
    assert.deepEqual(body.totals.costs, administratorReport.totals.costs);
    assert.deepEqual(body.totals.usage, administratorReport.totals.usage);
    assert.equal(body.totals.attemptCount, administratorReport.totals.attemptCount);
    assert.equal(body.breakdowns.workspaces[0].workspaceId, "workspace-a");
    assert.equal(JSON.stringify(body).includes("workspace-secret"), false);
    assert.equal("teams" in body, false);
    assert.equal("users" in body, false);
    assert.equal("tasks" in body, false);
    assert.deepEqual(body.privacy, {
      scope: "authenticated_member",
      description: "Only AI usage attributed to your active organization membership is included.",
      contentExcluded: true,
    });
  } finally {
    await app.close();
  }
});

test("personal AI usage rejects caller-supplied identity selectors and cross-tenant sessions reveal no usage", async () => {
  const store = new SubjectScopedSpendStore();
  store.rows = [event("owned")];
  const memberApp = appFor(member, store);
  const otherApp = appFor(otherTenantMember, store);
  try {
    const unauthenticated = await memberApp.inject({
      method: "GET",
      url: "/v1/me/ai-usage",
      headers: { "x-lemmacomputer-proxy-token": proxyToken },
    });
    assert.equal(unauthenticated.statusCode, 401);

    for (const selector of ["userId=member-a", "teamId=11111111-1111-4111-8111-111111111111", "workspaceId=workspace-a", "agentId=agent-a"]) {
      const denied = await memberApp.inject({ method: "GET", url: `/v1/me/ai-usage?${selector}`, headers });
      assert.equal(denied.statusCode, 400);
    }
    assert.equal(store.calls.length, 0);

    const crossTenant = await otherApp.inject({ method: "GET", url: "/v1/me/ai-usage", headers });
    assert.equal(crossTenant.statusCode, 200);
    assert.equal(crossTenant.json().report.state, "empty");
    assert.deepEqual(crossTenant.json().report.breakdowns, { workspaces: [], agents: [] });
    assert.equal(store.calls[0]?.tenantId, "other");
    assert.equal(store.calls[0]?.range.userId, "member-b");
  } finally {
    await Promise.all([memberApp.close(), otherApp.close()]);
  }
});

test("personal workspace and agent groups count one corrected admission once and keep its historical IDs", async () => {
  const store = new SubjectScopedSpendStore();
  store.rows = [
    event("corrected", { providerCost: "4" }),
    event("corrected-amendment", {
      eventId: "event-corrected-amendment",
      admissionId: "attempt-corrected",
      eventType: "correction",
      correctsEventId: "event-corrected",
      providerCost: "-1",
      units: [{ unit: "input_uncached_token", quantity: "-20", bucketCost: "-1", diagnostic: false }],
      workspaceId: "workspace-historical",
      agentId: "agent-historical",
    }),
  ];
  store.rows[0]!.workspaceId = "workspace-historical";
  store.rows[0]!.agentId = "agent-historical";
  const app = appFor(member, store);
  try {
    const response = await app.inject({ method: "GET", url: "/v1/me/ai-usage", headers });
    const report = response.json().report;
    assert.equal(report.totals.attemptCount, 1);
    assert.equal(report.totals.eventCount, 2);
    assert.equal(report.totals.correctedEventCount, 1);
    assert.deepEqual(report.totals.costs, [{ currency: "USD", amount: "3" }]);
    assert.equal(report.breakdowns.workspaces[0].workspaceId, "workspace-historical");
    assert.equal(report.breakdowns.workspaces[0].attemptCount, 1);
    assert.equal(report.breakdowns.agents[0].agentId, "agent-historical");
    assert.equal(report.breakdowns.agents[0].attemptCount, 1);
  } finally {
    await app.close();
  }
});
