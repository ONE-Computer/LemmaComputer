import assert from "node:assert/strict";
import test from "node:test";
import { m365ToolCatalog, type EgressSecurityGroupVersion, type IdentityContext, type McpToolPolicyDecision, type RuntimePolicy } from "@onecomputer/contracts";
import type { GatewayClient } from "@onecomputer/litellm-adapter";
import { MemoryWorkspaceStore, type EffectivePolicy, type IdentityPolicyStore, type SessionPrincipal } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "proxy-test-token-at-least-24-characters";
const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "onecomputer-control" };
const principal: SessionPrincipal = {
  userId: "alpha",
  tenantId: "acme",
  email: "alpha@metech.dev",
  displayName: "Alpha User",
  tenantDisplayName: "ME TECH",
  roles: ["employee"],
  identity: alpha,
};

const authentication = (authenticated: SessionPrincipal | null) => ({
  begin: async () => ({ location: "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize", cookie: "state=opaque" }),
  complete: async () => { throw new Error("not used"); },
  authenticate: async (cookie: string | undefined) => cookie === "onecomputer_session=valid" ? authenticated : null,
  logout: async () => "onecomputer_session=; Max-Age=0",
});

test("runtime identity comes only from the authenticated server session", async () => {
  const store = new MemoryWorkspaceStore();
  const owned = await store.createOrGet(alpha, "personal", "identity-boundary-workspace");
  await store.update(owned.id, { state: "ready" });
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, { authentication: authentication(principal) });
  try {
    const spoofedOnly = await app.inject({
      method: "GET",
      url: "/v1/workspaces/current",
      headers: {
        "x-onecomputer-proxy-token": proxyToken,
        "x-onecomputer-tenant-id": "acme",
        "x-onecomputer-subject-id": "alpha",
        "x-onecomputer-role": "administrator",
      },
    });
    assert.equal(spoofedOnly.statusCode, 401);

    const authenticated = await app.inject({
      method: "GET",
      url: "/v1/workspaces/current",
      headers: {
        "x-onecomputer-proxy-token": proxyToken,
        cookie: "onecomputer_session=valid",
        "x-onecomputer-tenant-id": "other",
        "x-onecomputer-subject-id": "attacker",
        "x-onecomputer-role": "administrator",
      },
    });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(authenticated.json().id, owned.id);

    const admin = await app.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { "x-onecomputer-proxy-token": proxyToken, cookie: "onecomputer_session=valid", "x-onecomputer-role": "administrator" },
    });
    assert.equal(admin.statusCode, 403);

    const employeePolicyRead = await app.inject({
      method: "GET",
      url: "/v1/admin/mcp-policy",
      headers: { "x-onecomputer-proxy-token": proxyToken, cookie: "onecomputer_session=valid" },
    });
    assert.equal(employeePolicyRead.statusCode, 403);

    const employeePolicyWrite = await app.inject({
      method: "PUT",
      url: "/v1/admin/mcp-policy",
      headers: { "x-onecomputer-proxy-token": proxyToken, cookie: "onecomputer_session=valid", "content-type": "application/json" },
      payload: { tools: {} },
    });
    assert.equal(employeePolicyWrite.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("test identities require an explicit test-only server mode", async () => {
  assert.throws(
    () => createControlServer(new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken),
    /test identity mode must be enabled explicitly/,
  );
});

test("only an administrator can assign and revoke the tenant policy through Control", async () => {
  const administrator = { ...principal, roles: ["employee", "administrator"] as const } as SessionPrincipal;
  const effectivePolicy: EffectivePolicy = {
    assignmentId: "assignment-1", policyBundleId: "mvp-standard:acme", policyVersionId: "version-1", version: 1,
    documentHash: "a".repeat(64), assignedBy: "alpha", assignedAt: new Date().toISOString(), agentId: "agent-1",
    workspaceIdentityId: "workspace-identity-1", workspaceId: "11111111-1111-4111-8111-111111111111",
    vendorUserId: "oc-user-test", document: { schemaVersion: 1 },
  };
  let assigned = false;
  let revoked = false;
  let savedToolPolicy: Record<string, McpToolPolicyDecision> | null = null;
  let firewallVersion: EgressSecurityGroupVersion = {
    schemaVersion: 1,
    id: "egv_acme_updates_v1",
    securityGroupId: "esg_acme_updates",
    tenantId: "acme",
    version: 1,
    name: "Approved updates",
    description: "Only reviewed update destinations.",
    defaultAction: "deny",
    rules: [{ id: "claude-downloads", action: "allow", protocol: "https", host: "downloads.claude.ai", includeSubdomains: false, port: 443, purpose: "Download approved updates" }],
    documentHash: "e".repeat(64),
    createdBy: "alpha",
    createdAt: new Date().toISOString(),
  };
  effectivePolicy.egressSecurityGroup = firewallVersion;
  effectivePolicy.document = {
    schemaVersion: 1,
    workspaceProfile: "claude-desktop-standard-v1",
    workspaceProfiles: ["claude-desktop-standard-v1"],
    agentProfile: "claude-desktop-managed-v1",
    modelAliases: ["onecomputer-claude"],
    networkProfile: "controlled-egress-v1",
    mcp: {
      servers: {
        onecomputer_ms365: {
          tools: Object.keys(m365ToolCatalog),
          toolPolicies: Object.fromEntries(Object.entries(m365ToolCatalog).map(([name, tool]) => [name, tool.decision])),
        },
      },
    },
  };
  const workspaceStore = new MemoryWorkspaceStore();
  const activeWorkspace = await workspaceStore.createOrGet(alpha, "personal", "active-policy-refresh-workspace");
  await workspaceStore.update(activeWorkspace.id, { state: "ready" });
  effectivePolicy.workspaceId = activeWorkspace.id;
  const identityPolicyStore = {
    listUsers: async (tenantId) => tenantId === "acme" ? [{ userId: "alpha", email: principal.email, displayName: principal.displayName, roles: principal.roles, effectivePolicy: revoked ? null : effectivePolicy }] : [],
    assignMvpPolicy: async () => { assigned = true; revoked = false; return effectivePolicy; },
    getEffectivePolicy: async () => assigned && !revoked ? effectivePolicy : null,
    revokeMvpPolicy: async () => { revoked = true; return true; },
    updateMvpToolPolicy: async ({ tools }: { tools: Record<string, McpToolPolicyDecision> }) => {
      savedToolPolicy = tools;
      effectivePolicy.policyVersionId = "version-2";
      effectivePolicy.version = 2;
      effectivePolicy.documentHash = "b".repeat(64);
      const document = effectivePolicy.document as {
        mcp: { servers: { onecomputer_ms365: { toolPolicies: Record<string, McpToolPolicyDecision> } } };
      };
      document.mcp.servers.onecomputer_ms365.toolPolicies = tools;
      return { id: "version-2", version: 2, documentHash: "b".repeat(64) };
    },
    listEgressSecurityGroups: async () => [firewallVersion],
    saveEgressSecurityGroup: async (input: { name: string; description: string; rules: EgressSecurityGroupVersion["rules"] }) => {
      firewallVersion = { ...firewallVersion, version: 2, id: "egv_acme_updates_v2", name: input.name, description: input.description, rules: input.rules, documentHash: "f".repeat(64) };
      return firewallVersion;
    },
    assignEgressSecurityGroup: async ({ securityGroupVersionId }: { securityGroupVersionId: string }) => {
      effectivePolicy.egressSecurityGroup = { ...firewallVersion, id: securityGroupVersionId };
      return effectivePolicy;
    },
  } as unknown as IdentityPolicyStore;
  const revokedKeys: string[] = [];
  const refreshedPolicies: RuntimePolicy[] = [];
  const gateway = {
    ensureGrant: async ({ workspaceId, policy }: { workspaceId: string; policy?: RuntimePolicy }) => {
      if (policy) refreshedPolicies.push(policy);
      return { baseUrl: "http://litellm:4000", credential: `sk-${workspaceId}-at-least-24-characters`, modelAlias: "claude-sonnet-4-5", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    revoke: async (workspaceId, agentId) => { revokedKeys.push(`${workspaceId}:${agentId ?? "default"}`); },
  } as unknown as GatewayClient;
  const app = createControlServer(workspaceStore, {} as ControllerClient, proxyToken, gateway, undefined, {}, {
    authentication: authentication(administrator), identityPolicyStore,
  });
  const headers = { "x-onecomputer-proxy-token": proxyToken, cookie: "onecomputer_session=valid" };
  try {
    const policy = await app.inject({ method: "GET", url: "/v1/admin/mcp-policy", headers });
    assert.equal(policy.statusCode, 200);
    assert.equal(policy.json().tools.length, 38);

    const incompletePolicy = await app.inject({
      method: "PUT", url: "/v1/admin/mcp-policy", headers: { ...headers, "content-type": "application/json" }, payload: { tools: {} },
    });
    assert.equal(incompletePolicy.statusCode, 400);
    assert.equal(savedToolPolicy, null);

    const decisions = Object.fromEntries(Object.entries(m365ToolCatalog).map(([name, tool]) => [name, tool.decision])) as Record<string, McpToolPolicyDecision>;
    decisions["list-calendars"] = "deny";
    const savedPolicy = await app.inject({
      method: "PUT", url: "/v1/admin/mcp-policy", headers: { ...headers, "content-type": "application/json" }, payload: { tools: decisions },
    });
    assert.equal(savedPolicy.statusCode, 200);
    assert.equal(savedPolicy.json().version, 2);
    assert.deepEqual(savedPolicy.json().workspaceGrants, { refreshed: 1, failed: 0 });
    assert.equal(savedToolPolicy?.["list-calendars"], "deny");
    assert.equal(refreshedPolicies.length, 1);
    assert.deepEqual(refreshedPolicies.map((runtime) => runtime.agentProfile).sort(), [
      "claude-desktop-managed-v1",
    ]);
    assert.equal(new Set(refreshedPolicies.map((runtime) => runtime.agentId)).size, 1);
    assert.ok(refreshedPolicies.every((runtime) => runtime.policyVersionId === "version-2"));
    assert.ok(refreshedPolicies.every((runtime) => runtime.toolPolicies["list-calendars"] === "deny"));

    const firewalls = await app.inject({ method: "GET", url: "/v1/admin/egress-security-groups", headers });
    assert.equal(firewalls.statusCode, 200);
    assert.equal(firewalls.json().securityGroups[0].rules[0].host, "downloads.claude.ai");

    const savedFirewall = await app.inject({
      method: "POST",
      url: "/v1/admin/egress-security-groups",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        securityGroupId: "esg_acme_updates",
        name: "Approved updates",
        description: "Reviewed update and package destinations.",
        rules: [{ id: "claude-downloads", action: "allow", protocol: "https", host: "downloads.claude.ai", includeSubdomains: false, port: 443, purpose: "Download approved updates" }],
      },
    });
    assert.equal(savedFirewall.statusCode, 201);
    assert.equal(savedFirewall.json().version, 2);

    const attachedFirewall = await app.inject({
      method: "POST",
      url: "/v1/admin/users/alpha/egress-security-group",
      headers: { ...headers, "content-type": "application/json" },
      payload: { securityGroupVersionId: "egv_acme_updates_v2" },
    });
    assert.equal(attachedFirewall.statusCode, 409);
    await workspaceStore.update(activeWorkspace.id, { state: "stopped" });
    const attachedStoppedFirewall = await app.inject({
      method: "POST",
      url: "/v1/admin/users/alpha/egress-security-group",
      headers: { ...headers, "content-type": "application/json" },
      payload: { securityGroupVersionId: "egv_acme_updates_v2" },
    });
    assert.equal(attachedStoppedFirewall.statusCode, 200);
    assert.equal(attachedStoppedFirewall.json().egressSecurityGroup.id, "egv_acme_updates_v2");
    await workspaceStore.update(activeWorkspace.id, { state: "ready" });

    const assign = await app.inject({ method: "POST", url: "/v1/admin/users/alpha/policy", headers });
    assert.equal(assign.statusCode, 200);
    assert.equal(assign.json().version, 2);

    const crossTenantTarget = await app.inject({ method: "POST", url: "/v1/admin/users/outsider/policy", headers });
    assert.equal(crossTenantTarget.statusCode, 404);
    const crossTenantRevoke = await app.inject({ method: "DELETE", url: "/v1/admin/users/outsider/policy", headers });
    assert.equal(crossTenantRevoke.statusCode, 404);

    const revoke = await app.inject({ method: "DELETE", url: "/v1/admin/users/alpha/policy", headers });
    assert.equal(revoke.statusCode, 204);
    assert.deepEqual(revokedKeys.sort(), [
      `${activeWorkspace.id}:agent-1`,
      `${activeWorkspace.id}:default`,
    ]);
  } finally {
    await app.close();
  }
});
