import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateTeam,
  MinimalSpendingTeam,
  TeamDetail,
  TeamMembership,
  TeamSummary,
  UpdateTeam,
} from "@onecomputer/contracts";
import {
  MemoryWorkspaceStore,
  type IdentityPolicyStore,
  type SessionPrincipal,
  type TeamAuditEvent,
  type TeamStore,
} from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "team-api-proxy-token-at-least-24-characters";
const administrator: SessionPrincipal = {
  userId: "team-admin",
  tenantId: "acme",
  email: "team-admin@example.test",
  displayName: "Team Administrator",
  tenantDisplayName: "Acme",
  roles: ["employee", "administrator"],
  identity: { tenantId: "acme", subjectId: "team-admin", audience: "onecomputer-control" },
};
const employee: SessionPrincipal = {
  ...administrator,
  userId: "team-member",
  email: "team-member@example.test",
  displayName: "Team Member",
  roles: ["employee"],
  identity: { tenantId: "acme", subjectId: "team-member", audience: "onecomputer-control" },
};
const teamId = "1b5f0aa2-e2e2-4ca4-86ca-8f1ea74a5b61";
const membershipId = "97d8fa9e-896f-4125-a104-bad838d0bc26";
const now = "2026-07-31T00:00:00.000Z";

class FakeTeamStore implements TeamStore {
  calls: Array<{ method: string; tenantId: string; [key: string]: unknown }> = [];
  team: TeamDetail = {
    id: teamId,
    displayName: "Finance",
    description: "Finance allocation",
    ownerUserId: administrator.userId,
    costCenterCode: "CC-100",
    status: "active",
    isRolloutFallback: false,
    activeMemberCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    memberships: [],
  };

  async listTeams(tenantId: string, includeArchived = false): Promise<TeamSummary[]> {
    this.calls.push({ method: "list", tenantId, includeArchived });
    return [this.team];
  }

  async getTeam(tenantId: string, requestedTeamId: string) {
    this.calls.push({ method: "get", tenantId, teamId: requestedTeamId });
    return requestedTeamId === teamId ? this.team : null;
  }

  async createTeam(input: CreateTeam & { tenantId: string; createdBy: string }) {
    this.calls.push({ method: "create", ...input });
    this.team = {
      ...this.team,
      displayName: input.displayName,
      description: input.description,
      ownerUserId: input.ownerUserId,
      costCenterCode: input.costCenterCode ?? null,
    };
    return this.team;
  }

  async updateTeam(input: UpdateTeam & { tenantId: string; teamId: string; updatedBy: string }) {
    this.calls.push({ method: "update", ...input });
    this.team = { ...this.team, ...input, id: teamId, memberships: this.team.memberships };
    return this.team;
  }

  async archiveTeam(input: { tenantId: string; teamId: string; archivedBy: string }) {
    this.calls.push({ method: "archive", ...input });
    this.team = { ...this.team, status: "archived", archivedAt: now };
    return this.team;
  }

  async assignMembership(input: {
    tenantId: string;
    teamId: string;
    userId: string;
    assignedBy: string;
    effectiveFrom?: Date;
    makeDefault?: boolean;
  }): Promise<TeamMembership> {
    this.calls.push({ method: "assignMembership", ...input });
    const membership = {
      id: membershipId,
      teamId,
      userId: input.userId,
      effectiveFrom: now,
      effectiveTo: null,
      isDefaultSpendingTeam: Boolean(input.makeDefault),
    };
    this.team = { ...this.team, activeMemberCount: 1, memberships: [membership] };
    return membership;
  }

  async removeMembership(input: {
    tenantId: string;
    teamId: string;
    userId: string;
    removedBy: string;
    effectiveTo?: Date;
  }) {
    this.calls.push({ method: "removeMembership", ...input });
    return true;
  }

  async setDefaultSpendingTeam(input: {
    tenantId: string;
    teamId: string;
    userId: string;
    assignedBy: string;
    effectiveFrom?: Date;
  }) {
    this.calls.push({ method: "setDefault", ...input });
    return this.minimal();
  }

  async getCurrentDefaultSpendingTeam(tenantId: string, userId: string) {
    this.calls.push({ method: "getCurrentDefault", tenantId, userId });
    return this.minimal();
  }

  async resolveDefaultSpendingTeam(input: {
    tenantId: string;
    userId: string;
    actorUserId: string;
  }) {
    this.calls.push({ method: "resolveDefault", ...input });
    return this.minimal();
  }

  async listAuditEvents(tenantId: string): Promise<TeamAuditEvent[]> {
    this.calls.push({ method: "audit", tenantId });
    return [{
      id: "f54c6a76-00d1-48a1-b11a-e2ba7088399a",
      action: "team.created",
      targetType: "team",
      targetId: teamId,
      details: { changedFields: ["displayName"] },
      occurredAt: now,
    }];
  }

  private minimal(): MinimalSpendingTeam {
    return {
      id: this.team.id,
      displayName: this.team.displayName,
      costCenterCode: this.team.costCenterCode,
      isRolloutFallback: this.team.isRolloutFallback,
    };
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

const appFor = (actor: SessionPrincipal, teamStore: TeamStore) => createControlServer(
  new MemoryWorkspaceStore(),
  {} as ControllerClient,
  proxyToken,
  undefined,
  undefined,
  {},
  { authentication: authentication(actor), identityPolicyStore: identityPolicies, teamStore },
);

const headers = {
  "x-onecomputer-proxy-token": proxyToken,
  cookie: "onecomputer_session=valid",
};

test("Team administration API validates writes, stays tenant-bound, and exposes only minimal member identity", async () => {
  const store = new FakeTeamStore();
  const adminApp = appFor(administrator, store);
  const employeeApp = appFor(employee, store);
  try {
    const forbidden = await employeeApp.inject({ method: "GET", url: "/v1/admin/teams", headers });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(store.calls.length, 0);

    const memberView = await employeeApp.inject({ method: "GET", url: "/v1/teams/default", headers });
    assert.equal(memberView.statusCode, 200);
    assert.equal(memberView.headers["cache-control"], "no-store");
    assert.deepEqual(memberView.json(), {
      team: { id: teamId, displayName: "Finance", costCenterCode: "CC-100", isRolloutFallback: false },
    });
    assert.deepEqual(store.calls.at(-1), {
      method: "getCurrentDefault",
      tenantId: "acme",
      userId: "team-member",
    });
    assert.equal(store.calls.some((call) => call.method === "resolveDefault"), false);

    const invalid = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/teams",
      headers: { ...headers, "content-type": "application/json" },
      payload: { displayName: "", ownerUserId: employee.userId },
    });
    assert.equal(invalid.statusCode, 400);

    const created = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/teams",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        displayName: "Customer Success",
        description: "Customer allocation",
        ownerUserId: employee.userId,
        costCenterCode: "CC-220",
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().team.displayName, "Customer Success");
    assert.equal(store.calls.at(-1)?.tenantId, "acme");
    assert.equal(store.calls.at(-1)?.createdBy, administrator.userId);

    const renamed = await adminApp.inject({
      method: "PATCH",
      url: `/v1/admin/teams/${teamId}`,
      headers: { ...headers, "content-type": "application/json" },
      payload: { displayName: "Customer Operations", ownerUserId: administrator.userId },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().team.displayName, "Customer Operations");

    const assigned = await adminApp.inject({
      method: "POST",
      url: `/v1/admin/teams/${teamId}/memberships`,
      headers: { ...headers, "content-type": "application/json" },
      payload: { userId: employee.userId, makeDefault: true },
    });
    assert.equal(assigned.statusCode, 201);
    assert.equal(assigned.json().membership.isDefaultSpendingTeam, true);

    const defaulted = await adminApp.inject({
      method: "PUT",
      url: `/v1/admin/teams/${teamId}/default`,
      headers: { ...headers, "content-type": "application/json" },
      payload: { userId: employee.userId },
    });
    assert.equal(defaulted.statusCode, 200);

    const stillForbidden = await employeeApp.inject({ method: "GET", url: "/v1/admin/teams", headers });
    assert.equal(stillForbidden.statusCode, 403);
    assert.equal(store.calls.some((call) => call.method === "list" && call.tenantId !== "acme"), false);

    const removed = await adminApp.inject({
      method: "DELETE",
      url: `/v1/admin/teams/${teamId}/memberships/${employee.userId}`,
      headers,
    });
    assert.equal(removed.statusCode, 204);

    const archived = await adminApp.inject({
      method: "POST",
      url: `/v1/admin/teams/${teamId}/archive`,
      headers,
    });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().team.status, "archived");

    const audit = await adminApp.inject({ method: "GET", url: "/v1/admin/teams-audit", headers });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().events[0].action, "team.created");
    assert.ok(store.calls.every((call) => call.tenantId === "acme"));
  } finally {
    await Promise.all([adminApp.close(), employeeApp.close()]);
  }
});
