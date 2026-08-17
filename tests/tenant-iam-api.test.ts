import assert from "node:assert/strict";
import test from "node:test";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import {
  MemoryProviderSettingsStore,
  MemoryWorkspaceStore,
  resolveEffectiveOrganizationPermissions,
  type IdentityPolicyStore,
  type OrganizationCustomRoleSummary,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import type { GatewayClient, OAuthConnectionGateway, ProviderAdministrationGateway } from "@lemmacomputer/litellm-adapter";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "tenant-iam-api-proxy-token-at-least-24-characters";
const roleId = "48fe9082-07bc-4f1c-9466-b1f94ed10a43";
const membershipId = "ad16dc53-55d4-449d-b6ee-72acfc61faf2";
const foreignRoleId = "73f5e9f0-7738-4da2-bbff-f43240124177";
const owner: SessionPrincipal = {
  userId: "iam-owner",
  tenantId: "acme",
  organizationId: "acme",
  membershipId: "6f7c2e99-f059-40be-a08b-347731945d10",
  membershipStatus: "active",
  role: "owner",
  permissions: [],
  email: "owner@example.test",
  displayName: "Owner",
  tenantDisplayName: "Acme",
  roles: ["owner", "administrator"],
  identity: { tenantId: "acme", subjectId: "iam-owner", audience: "lemmacomputer-control" },
};
const forgedMember: SessionPrincipal = {
  ...owner,
  userId: "iam-member",
  role: "member",
  roles: ["member"],
  permissions: ["organization.manage_roles"],
  identity: { ...owner.identity, subjectId: "iam-member" },
};
const scopedAdministrator: SessionPrincipal = {
  ...forgedMember,
  userId: "iam-scoped-admin",
  permissions: ["organization.read", "workspace.use", "workspace.manage", "provider.manage", "usage.manage"],
  effectiveAuthorization: resolveEffectiveOrganizationPermissions({
    catalogVersion: 1,
    builtInRoles: ["member"],
    customRoleVersions: [{
      roleId: "scoped-administrator",
      version: 1,
      catalogVersion: 1,
      status: "active",
      grants: [
        { permission: "workspace.use", scope: { type: "workspace", resourceId: "workspace-a" } },
        { permission: "workspace.manage", scope: { type: "workspace", resourceId: "workspace-a" } },
        { permission: "provider.manage", scope: { type: "provider", resourceId: "openai" } },
        { permission: "provider.manage", scope: { type: "provider", resourceId: "linear" } },
        { permission: "usage.manage", scope: { type: "provider", resourceId: "openai" } },
        { permission: "audit.read", scope: { type: "organization" } },
      ],
    }],
  }),
  identity: { ...owner.identity, subjectId: "iam-scoped-admin" },
};
const settingsOnlyAdministrator: SessionPrincipal = {
  ...forgedMember,
  userId: "iam-settings-only",
  effectiveAuthorization: resolveEffectiveOrganizationPermissions({
    catalogVersion: 3,
    builtInRoles: ["member"],
    customRoleVersions: [{
      roleId: "settings-only",
      version: 1,
      catalogVersion: 2,
      status: "active",
      grants: [{ permission: "organization.manage_settings", scope: { type: "organization" } }],
    }],
  }),
  identity: { ...owner.identity, subjectId: "iam-settings-only" },
};
const scopedRoleDelegator: SessionPrincipal = {
  ...forgedMember,
  userId: "iam-role-delegator",
  effectiveAuthorization: resolveEffectiveOrganizationPermissions({
    catalogVersion: 3,
    builtInRoles: ["member"],
    customRoleVersions: [{
      roleId: "scoped-role-delegator",
      version: 1,
      catalogVersion: 2,
      status: "active",
      grants: [
        { permission: "organization.manage_roles", scope: { type: "organization" } },
        { permission: "workspace.manage", scope: { type: "workspace", resourceId: "workspace-a" } },
      ],
    }],
  }),
  identity: { ...owner.identity, subjectId: "iam-role-delegator" },
};
const memberManager: SessionPrincipal = {
  ...forgedMember,
  userId: "iam-member-manager",
  effectiveAuthorization: resolveEffectiveOrganizationPermissions({
    catalogVersion: 3,
    builtInRoles: ["member"],
    customRoleVersions: [{
      roleId: "member-manager",
      version: 1,
      catalogVersion: 2,
      status: "active",
      grants: [{ permission: "organization.manage_members", scope: { type: "organization" } }],
    }],
  }),
  identity: { ...owner.identity, subjectId: "iam-member-manager" },
};
const authentication = (actor: SessionPrincipal) => ({
  resolve: async () => ({ status: "authorized" as const, principal: actor }),
});
const headers = { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid" };

class FakeTenantIamStore {
  calls: Array<Record<string, unknown>> = [];
  role: OrganizationCustomRoleSummary = {
    id: roleId,
    organizationId: "acme",
    name: "Workspace reviewer",
    description: "Reviews one workspace",
    status: "active",
    version: 1,
    catalogVersion: 1,
    grants: [{ permission: "audit.read", scope: { type: "organization" } }],
    assignedMembershipCount: 0,
    assignedMembershipIds: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
  async getEffectivePolicy() { return null; }
  async listUsers() { return []; }
  async listOrganizationRoles(organizationId: string) { this.calls.push({ method: "list", organizationId }); return [this.role]; }
  async createOrganizationRole(input: Record<string, unknown>) { this.calls.push({ method: "create", ...input }); return this.role; }
  async updateOrganizationRole(input: Record<string, unknown>) { this.calls.push({ method: "update", ...input }); return { ...this.role, version: 2, revokedSessions: 1 }; }
  async archiveOrganizationRole(input: Record<string, unknown>) { this.calls.push({ method: "archive", ...input }); return { role: { ...this.role, status: "archived" }, revokedSessions: 1 }; }
  async assignOrganizationRole(input: Record<string, unknown>) {
    this.calls.push({ method: "assign", ...input });
    if (input.roleId === foreignRoleId) throw new LemmaComputerError("ROLE_ASSIGNMENT_INVALID", "The role is outside this organization", 404);
    return { revokedSessions: 1 };
  }
  async unassignOrganizationRole(input: Record<string, unknown>) { this.calls.push({ method: "unassign", ...input }); return { revokedSessions: 1 }; }
  async updateOrganizationDisplayName(input: Record<string, unknown>) {
    this.calls.push({ method: "rename", ...input });
    return { id: String(input.organizationId), displayName: String(input.displayName) };
  }
}

const appFor = (actor: SessionPrincipal, store: FakeTenantIamStore) => createControlServer(
  new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    customerProductAuthentication: authentication(actor),
    identityPolicyStore: store as unknown as IdentityPolicyStore,
    agentBridgeSecret: "tenant-iam-agent-bridge-secret-at-least-32-characters",
  },
);

test("tenant IAM API derives the tenant and actor, validates grants, and exposes versioned catalog metadata", async () => {
  const store = new FakeTenantIamStore();
  const app = appFor(owner, store);
  try {
    const listed = await app.inject({ method: "GET", url: "/v1/admin/roles", headers });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().catalog.version, 3);
    assert.equal(listed.json().catalog.permissions.find((item: { key: string }) => item.key === "workspace.use").scopeTypes.includes("workspace"), true);
    assert.equal(listed.json().roles[0].id, roleId);

    const created = await app.inject({
      method: "POST", url: "/v1/admin/roles", headers,
      payload: { name: "Workspace reviewer", description: "Reviews one workspace", grants: [
        { permission: "audit.read", scope: { type: "organization" } },
      ] },
    });
    assert.equal(created.statusCode, 201);
    const createCall = store.calls.find((call) => call.method === "create")!;
    assert.equal(createCall.organizationId, "acme");
    assert.equal(createCall.createdBy, "iam-owner");

    const invalid = await app.inject({
      method: "POST", url: "/v1/admin/roles", headers,
      payload: { name: "Forged", description: "", grants: [
        { permission: "root.everything", scope: { type: "organization" } },
      ] },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(store.calls.filter((call) => call.method === "create").length, 1);

    assert.equal((await app.inject({
      method: "PATCH", url: `/v1/admin/roles/${roleId}`, headers,
      payload: { expectedVersion: 1, name: "Auditor", description: "Reads audit", grants: [
        { permission: "audit.read", scope: { type: "organization" } },
      ] },
    })).statusCode, 200);
    assert.equal((await app.inject({
      method: "POST", url: `/v1/admin/memberships/${membershipId}/roles`, headers,
      payload: { roleId },
    })).statusCode, 200);
    const crossTenant = await app.inject({
      method: "POST", url: `/v1/admin/memberships/${membershipId}/roles`, headers,
      payload: { roleId: foreignRoleId },
    });
    assert.equal(crossTenant.statusCode, 404);
    assert.equal(store.calls.find((call) => call.roleId === foreignRoleId)?.organizationId, "acme",
      "the API never accepts a caller-supplied tenant even for a foreign role ID");
    assert.equal((await app.inject({
      method: "DELETE", url: `/v1/admin/memberships/${membershipId}/roles/${roleId}`, headers,
    })).statusCode, 200);
    assert.equal((await app.inject({
      method: "DELETE", url: `/v1/admin/roles/${roleId}`, headers,
      payload: { expectedVersion: 2 },
    })).statusCode, 200);
    assert.equal(store.calls.every((call) => call.organizationId === "acme"), true);
  } finally {
    await app.close();
  }
});

test("provider or caller supplied permission claims cannot reach tenant IAM writes", async () => {
  const store = new FakeTenantIamStore();
  const app = appFor(forgedMember, store);
  try {
    const denied = await app.inject({
      method: "POST", url: "/v1/admin/roles", headers,
      payload: { name: "Forged", description: "", grants: [
        { permission: "audit.read", scope: { type: "organization" } },
      ] },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(store.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("tenant IAM metadata exposes only authority the actor can delegate", async () => {
  const roleApp = appFor(scopedRoleDelegator, new FakeTenantIamStore());
  try {
    const response = await roleApp.inject({ method: "GET", url: "/v1/admin/roles", headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().delegableBuiltInRoles, ["member"]);
    const catalog = response.json().catalog.permissions as Array<{
      key: string;
      scopeTypes: string[];
      resourceIds?: Record<string, string[]>;
    }>;
    assert.deepEqual(catalog.map((permission) => permission.key), [
      "organization.read", "organization.manage_roles", "workspace.use", "workspace.create", "workspace.manage_own", "workspace.manage",
    ]);
    const workspaceManage = catalog.find((permission) => permission.key === "workspace.manage")!;
    assert.deepEqual(workspaceManage.scopeTypes, ["workspace"]);
    assert.deepEqual(workspaceManage.resourceIds, { workspace: ["workspace-a"] });
    assert.equal(catalog.some((permission) => permission.key === "audit.read"), false);
  } finally {
    await roleApp.close();
  }

  const memberApp = appFor(memberManager, new FakeTenantIamStore());
  try {
    const response = await memberApp.inject({ method: "GET", url: "/v1/admin/users", headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().delegableBuiltInRoles, ["member"]);
  } finally {
    await memberApp.close();
  }
});

test("organization settings authority is not a super-admin shortcut", async () => {
  const app = appFor(settingsOnlyAdministrator, new FakeTenantIamStore());
  try {
    const requests = [
      { method: "GET", url: "/v1/admin/teams" },
      { method: "GET", url: "/v1/admin/teams-audit" },
      { method: "GET", url: "/v1/admin/routing/mappings/latest" },
      { method: "POST", url: "/v1/admin/policy/versions", payload: { revisionNote: "settings only" } },
      { method: "GET", url: "/v1/admin/egress-security-groups" },
      { method: "GET", url: "/v1/admin/connectors" },
      { method: "GET", url: "/v1/admin/provider-settings" },
      { method: "GET", url: "/v1/admin/ai-usage/rate-cards" },
      { method: "POST", url: "/v1/workspaces", payload: { grantId: "personal" } },
    ] as const;
    for (const request of requests) {
      const response = await app.inject({ ...request, headers });
      assert.equal(response.statusCode, 403, `${request.method} ${request.url} must require its own permission`);
    }
  } finally {
    await app.close();
  }
});

test("only the active organization owner can rename the current organization", async () => {
  const store = new FakeTenantIamStore();
  const ownerApp = appFor(owner, store);
  try {
    const renamed = await ownerApp.inject({
      method: "PATCH",
      url: "/v1/admin/organization",
      headers,
      payload: { displayName: "  Northwind   Research  " },
    });
    assert.equal(renamed.statusCode, 200);
    assert.deepEqual(renamed.json(), {
      organization: { id: "acme", displayName: "Northwind Research" },
    });
    const renameCall = store.calls.find((call) => call.method === "rename")!;
    assert.equal(renameCall.organizationId, "acme");
    assert.equal(renameCall.updatedBy, "iam-owner");
    assert.equal(renameCall.displayName, "Northwind Research");
    assert.ok(renameCall.now instanceof Date);

    const invalid = await ownerApp.inject({
      method: "PATCH",
      url: "/v1/admin/organization",
      headers,
      payload: { displayName: "x" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(store.calls.filter((call) => call.method === "rename").length, 1);
  } finally {
    await ownerApp.close();
  }

  const delegatedStore = new FakeTenantIamStore();
  const delegatedApp = appFor(settingsOnlyAdministrator, delegatedStore);
  try {
    const denied = await delegatedApp.inject({
      method: "PATCH",
      url: "/v1/admin/organization",
      headers,
      payload: { displayName: "Forbidden Rename" },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, "ORGANIZATION_OWNER_REQUIRED");
    assert.equal(delegatedStore.calls.length, 0);
  } finally {
    await delegatedApp.close();
  }
});

test("workspace-scoped administration resolves the target workspace before authorizing", async () => {
  const workspaceStore = new MemoryWorkspaceStore();
  const targetIdentity = { tenantId: "acme", subjectId: "target-user", audience: "lemmacomputer-control" } as const;
  const workspace = await workspaceStore.createOrGet(targetIdentity, "personal", "tenant-iam-exact-workspace");
  const actor: SessionPrincipal = {
    ...forgedMember,
    userId: "iam-workspace-manager",
    effectiveAuthorization: resolveEffectiveOrganizationPermissions({
      catalogVersion: 3,
      builtInRoles: ["member"],
      customRoleVersions: [{
        roleId: "exact-workspace-manager",
        version: 1,
        catalogVersion: 2,
        status: "active",
        grants: [
          { permission: "workspace.manage", scope: { type: "workspace", resourceId: workspace.id } },
          { permission: "policy.manage", scope: { type: "workspace", resourceId: workspace.id } },
        ],
      }],
    }),
    identity: { ...owner.identity, subjectId: "iam-workspace-manager" },
  };
  const app = createControlServer(
    workspaceStore, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
      customerProductAuthentication: authentication(actor),
      identityPolicyStore: new FakeTenantIamStore() as unknown as IdentityPolicyStore,
      agentBridgeSecret: "tenant-iam-agent-bridge-secret-at-least-32-characters",
    },
  );
  try {
    const matchingSettings = await app.inject({
      method: "GET", url: "/v1/admin/users/target-user/sandbox-settings?grantId=personal", headers,
    });
    assert.equal(matchingSettings.statusCode, 404,
      "the exact workspace grant passes authorization and reaches target lookup");
    assert.equal(matchingSettings.json().error.code, "USER_NOT_FOUND");

    const otherSettings = await app.inject({
      method: "GET", url: "/v1/admin/users/other-user/sandbox-settings?grantId=personal", headers,
    });
    assert.equal(otherSettings.statusCode, 403);

    const matchingFirewall = await app.inject({
      method: "POST", url: "/v1/admin/users/target-user/workspaces/personal/egress-security-group", headers,
      payload: { securityGroupVersionId: "egv_tenant_iam_test" },
    });
    assert.equal(matchingFirewall.statusCode, 503,
      "the exact workspace grant passes authorization before the optional policy-store capability is checked");
    assert.equal(matchingFirewall.json().error.code, "POLICY_STORE_NOT_CONFIGURED");

    const otherFirewall = await app.inject({
      method: "POST", url: "/v1/admin/users/other-user/workspaces/personal/egress-security-group", headers,
      payload: { securityGroupVersionId: "egv_tenant_iam_test" },
    });
    assert.equal(otherFirewall.statusCode, 403,
      "an unauthorized workspace does not disclose optional service configuration");
  } finally {
    await app.close();
  }
});

test("resource-scoped API grants allow only the matching workspace and provider", async () => {
  const store = new FakeTenantIamStore();
  const providerSettingsStore = new MemoryProviderSettingsStore();
  const providerAdministration = {
    configureManagedProvider: async () => ({
      modelIds: ["acme-openai-gpt-5-6-terra"],
      deployments: [],
      credentialFingerprint: "fp_acme_openai",
      configuration: { modelIds: ["gpt-5.6-terra"] },
    }),
    testManagedProvider: async () => undefined,
    deleteManagedProvider: async () => undefined,
  } as unknown as ProviderAdministrationGateway;
  const connectorGateway = {
    beginUserOAuthConnection: async () => ({ location: "https://provider.example.test", cookies: [] }),
    completeUserOAuthConnection: async () => ({ state: "connected", connectedAt: null, expiresAt: null, account: null }),
    userOAuthConnectionStatus: async () => ({ state: "disconnected", connectedAt: null, expiresAt: null, account: null }),
    userOAuthConnectionTools: async () => [],
    disconnectUserOAuthConnection: async () => ({ state: "disconnected", connectedAt: null, expiresAt: null, account: null }),
  } as unknown as GatewayClient & OAuthConnectionGateway;
  const auditEvents = [
    { id: "audit-a", action: "workspace.reviewed", targetType: "team", targetId: "team-a", details: { workspaceId: "workspace-a" }, occurredAt: "2026-08-09T00:00:00.000Z" },
    { id: "audit-b", action: "workspace.reviewed", targetType: "team", targetId: "team-b", details: { workspaceId: "workspace-b" }, occurredAt: "2026-08-09T00:00:00.000Z" },
  ];
  const teamStore = { listAuditEvents: async () => auditEvents };
  const app = createControlServer(
    new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, connectorGateway, undefined, {}, {
      customerProductAuthentication: authentication(scopedAdministrator),
      identityPolicyStore: store as unknown as IdentityPolicyStore,
      providerSettingsStore,
      providerAdministration,
      teamStore: teamStore as never,
      agentBridgeSecret: "tenant-iam-agent-bridge-secret-at-least-32-characters",
    },
  );
  try {
    const matchingProvider = await app.inject({
      method: "POST", url: "/v1/admin/provider-settings/openai/test", headers,
    });
    assert.notEqual(matchingProvider.statusCode, 403,
      "the matching provider scope reaches the provider service boundary");
    const otherProvider = await app.inject({
      method: "POST", url: "/v1/admin/provider-settings/anthropic/test", headers,
    });
    assert.equal(otherProvider.statusCode, 403);

    const connectors = await app.inject({ method: "GET", url: "/v1/admin/connectors", headers });
    assert.equal(connectors.statusCode, 200);
    assert.deepEqual(connectors.json().connectors.map((connector: { id: string }) => connector.id), ["linear"],
      "a provider-scoped connector administrator sees only the exact granted connector");
    const matchingConnector = await app.inject({
      method: "GET", url: "/v1/admin/connectors/linear/tool-policy", headers,
    });
    assert.notEqual(matchingConnector.statusCode, 403,
      "the matching connector scope reaches the connector service boundary");
    const otherConnector = await app.inject({
      method: "GET", url: "/v1/admin/connectors/slack/tool-policy", headers,
    });
    assert.equal(otherConnector.statusCode, 403);

    const audit = await app.inject({ method: "GET", url: "/v1/admin/teams-audit", headers });
    assert.equal(audit.statusCode, 200);
    assert.deepEqual(audit.json().events.map((event: { id: string }) => event.id), ["audit-a", "audit-b"]);

    const matchingUsage = await app.inject({
      method: "POST", url: "/v1/admin/ai-usage/rate-cards", headers,
      payload: {
        provider: "openai", providerAccountId: "primary", baseModel: "gpt-5.6-terra",
        deploymentId: "openai-terra", currency: "USD", source: "conservative",
        sourceVersion: "2026-08-09", sourceHash: "a".repeat(64),
        effectiveFrom: "2026-08-09T00:00:00.000Z",
        rates: [{ unit: "input_uncached_token", amountPerUnit: "1", unitScale: "1000000" }],
      },
    });
    assert.notEqual(matchingUsage.statusCode, 403,
      "the matching usage provider scope reaches request validation or the usage service boundary");
    const otherUsage = await app.inject({
      method: "POST", url: "/v1/admin/ai-usage/rate-cards", headers,
      payload: {
        provider: "anthropic", providerAccountId: "primary", baseModel: "claude-sonnet",
        deploymentId: "anthropic-sonnet", currency: "USD", source: "conservative",
        sourceVersion: "2026-08-09", sourceHash: "b".repeat(64),
        effectiveFrom: "2026-08-09T00:00:00.000Z",
        rates: [{ unit: "input_uncached_token", amountPerUnit: "1", unitScale: "1000000" }],
      },
    });
    assert.equal(otherUsage.statusCode, 403);

    const matchingWorkspace = await app.inject({
      method: "POST", url: "/v1/workspaces/workspace-a/restart", headers,
    });
    assert.notEqual(matchingWorkspace.json().error?.code, "FORBIDDEN",
      "the matching workspace scope reaches the owned-workspace boundary");
    const otherWorkspace = await app.inject({
      method: "POST", url: "/v1/workspaces/workspace-b/restart", headers,
    });
    assert.equal(otherWorkspace.statusCode, 403);
    assert.equal(otherWorkspace.json().error.code, "FORBIDDEN");
  } finally {
    await app.close();
  }
});
