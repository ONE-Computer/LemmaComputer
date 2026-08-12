import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryConnectorRegistryStore,
  MemoryWorkspaceStore,
  resolveEffectiveOrganizationPermissions,
  type IdentityPolicyStore,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import type { GatewayClient, OAuthConnectionGateway } from "@lemmacomputer/litellm-adapter";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ProtectedWorkspacePolicyAdministrationBoundary } from "../apps/control-api/src/protected-workspace-policy.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "connector-effective-policy-api-proxy-token";
const headers = { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid" };
const definitionHash = (character: string) => character.repeat(64);

const owner: SessionPrincipal = {
  userId: "connector-owner",
  tenantId: "acme",
  organizationId: "acme",
  membershipId: "4d6c8783-3b5e-4595-ab79-7956e2834cda",
  membershipStatus: "active",
  role: "owner",
  permissions: [],
  email: "owner@example.test",
  displayName: "Owner",
  tenantDisplayName: "Acme",
  roles: ["owner", "administrator"],
  identity: { tenantId: "acme", subjectId: "connector-owner", audience: "lemmacomputer-control" },
};

const scopedAdministrator: SessionPrincipal = {
  ...owner,
  userId: "connector-scoped-administrator",
  role: "member",
  roles: ["member"],
  identity: { ...owner.identity, subjectId: "connector-scoped-administrator" },
  effectiveAuthorization: resolveEffectiveOrganizationPermissions({
    catalogVersion: 3,
    builtInRoles: ["member"],
    customRoleVersions: [{
      roleId: "reports-administrator",
      version: 1,
      catalogVersion: 3,
      status: "active",
      grants: [{ permission: "provider.manage", scope: { type: "provider", resourceId: "reports" } }],
    }],
  }),
};

const authentication = (actor: SessionPrincipal) => ({
  begin: async () => ({ location: "https://login.example.test", cookie: "state=opaque" }),
  complete: async () => { throw new Error("unused"); },
  authenticate: async () => actor,
  logout: async () => "",
});

const protectedWorkspacePolicy = {
  overview: async (tenantId: string) => ({
    baseline: {
      immutable: true as const,
      editableByOrganization: false as const,
      authority: "lemmacomputer_product_release" as const,
      templateId: "pbt_office_worker_claude",
      templateVersionId: "pbtv_office_worker_claude_1",
      version: 1,
      supersedesTemplateVersionId: null,
      documentHash: definitionHash("a"),
      envelopeDigest: definitionHash("b"),
      keyId: "prk_phase_0_5_20260812",
      release: { releaseId: "0.5-test", sourceCommit: definitionHash("c").slice(0, 40), publishedAt: "2026-08-12T00:00:00.000Z" },
      constraints: {
        connectors: {
          allow: ["reports"],
          deny: [],
          toolPolicies: { reports: { read_report: "allow", export_report: "approval_required" } },
        },
      },
      installedAt: "2026-08-12T00:00:00.000Z",
    },
    organizationPolicyVersions: [],
  }),
} as unknown as ProtectedWorkspacePolicyAdministrationBoundary;

const identityPolicyStore = {
  listUsers: async () => [],
  getEffectivePolicy: async () => null,
} as unknown as IdentityPolicyStore;

const connector = (tenantId: string, id: string) => ({
  tenantId,
  id,
  serverId: `server-${tenantId}-${id}`,
  serverName: `lemmacomputer_${tenantId}_${id}`,
  name: id === "reports" ? "Reports" : "Foreign reports",
  shortDescription: "Review reports",
  description: "Review approved reports.",
  category: "Productivity" as const,
  services: ["Reports"],
  endpointUrl: `https://mcp.${id}.example/mcp`,
  authorizationOrigins: [`https://auth.${id}.example`],
  scopes: ["reports.read"],
  toolPolicies: { read_report: "allow" as const, export_report: "allow" as const },
  toolDefinitionHashes: { read_report: definitionHash("d"), export_report: definitionHash("e") },
  brand: "generic",
  policySupport: "automatic" as const,
  source: "custom" as const,
  createdBy: "connector-owner",
});

const appFor = async (actor: SessionPrincipal) => {
  const registry = new MemoryConnectorRegistryStore();
  await registry.saveConnector(connector("acme", "reports"));
  await registry.saveConnector(connector("foreign", "foreign-reports"));
  await registry.saveConnectionState({
    tenantId: "acme",
    subjectId: actor.userId,
    connectorId: "reports",
    state: "connected",
    connectedAt: new Date("2026-08-12T00:00:00.000Z"),
    expiresAt: new Date("2026-08-12T01:00:00.000Z"),
  });
  const gateway = {
    beginUserOAuthConnection: async () => ({ location: "https://provider.example.test", cookies: [] }),
    completeUserOAuthConnection: async () => ({ state: "connected", connectedAt: null, expiresAt: null, account: null }),
    userOAuthConnectionStatus: async () => ({ state: "connected", connectedAt: null, expiresAt: null, account: null }),
    userOAuthConnectionTools: async () => [
      { name: "read_report", definitionHash: definitionHash("d") },
      { name: "export_report", definitionHash: definitionHash("f") },
    ],
    disconnectUserOAuthConnection: async () => ({ state: "disconnected", connectedAt: null, expiresAt: null, account: null }),
  } as unknown as GatewayClient & OAuthConnectionGateway;
  return createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    gateway,
    undefined,
    {},
    {
      authentication: authentication(actor),
      identityPolicyStore,
      protectedWorkspacePolicy,
      connectorRegistryStore: registry,
      agentBridgeSecret: "connector-effective-policy-agent-bridge-secret",
    },
  );
};

test("the provider-scoped endpoint returns only safe effective-policy metadata and fails changed tools closed", async () => {
  const app = await appFor(owner);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/connectors/reports/effective-policy",
      headers,
    });
    assert.equal(response.statusCode, 200);
    const policy = response.json().policy;
    assert.equal(policy.access.effectiveDecision, "allow");
    assert.deepEqual(policy.tools.map((tool: { name: string; reviewState: string; effectiveDecision: string }) => (
      [tool.name, tool.reviewState, tool.effectiveDecision]
    )), [
      ["export_report", "awaiting_review", "deny"],
      ["read_report", "current", "allow"],
    ]);
    assert.equal(policy.runtimeProjection.state, "partially_available");
    const serialized = JSON.stringify(policy);
    for (const forbidden of ["endpointUrl", "authorizationOrigins", "scopes", "definitionPreview", "description"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} must not cross the administration boundary`);
    }
  } finally {
    await app.close();
  }
});

test("connector effective-policy reads derive the tenant and enforce exact provider scope before lookup", async () => {
  const scopedApp = await appFor(scopedAdministrator);
  try {
    assert.equal((await scopedApp.inject({
      method: "GET", url: "/v1/admin/connectors/reports/effective-policy", headers,
    })).statusCode, 200);
    assert.equal((await scopedApp.inject({
      method: "GET", url: "/v1/admin/connectors/microsoft-365/effective-policy", headers,
    })).statusCode, 403);
  } finally {
    await scopedApp.close();
  }

  const ownerApp = await appFor(owner);
  try {
    const foreign = await ownerApp.inject({
      method: "GET", url: "/v1/admin/connectors/foreign-reports/effective-policy", headers,
    });
    assert.equal(foreign.statusCode, 404,
      "a connector stored for another tenant is not resolved from a caller-supplied id");
  } finally {
    await ownerApp.close();
  }
});
