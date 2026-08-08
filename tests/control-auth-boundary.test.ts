import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { m365ToolCatalog, type EgressSecurityGroupVersion, type IdentityContext, type McpToolPolicyDecision, type RuntimePolicy } from "@lemmacomputer/contracts";
import type { GatewayClient } from "@lemmacomputer/litellm-adapter";
import { MemoryConnectorRegistryStore, MemoryWorkspaceStore, type EffectivePolicy, type IdentityPolicyStore, type SessionPrincipal } from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "proxy-test-token-at-least-24-characters";
const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "lemmacomputer-control" };
const beta: IdentityContext = { tenantId: "acme", subjectId: "beta", audience: "lemmacomputer-control" };
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
  authenticate: async (cookie: string | undefined) => cookie === "lemmacomputer_session=valid" ? authenticated : null,
  logout: async () => "lemmacomputer_session=; Max-Age=0",
});

test("the authenticated MCP policy route accepts bounded upload-sized authorization envelopes", async () => {
  const mcpPolicyToken = "mcp-policy-token-at-least-24-characters";
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    {},
    {
      testIdentityMode: true,
      identityPolicyStore: {} as IdentityPolicyStore,
      mcpPolicyToken,
    },
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/mcp/authorize",
      headers: {
        "content-type": "application/json",
        "x-lemmacomputer-mcp-policy-token": mcpPolicyToken,
      },
      payload: { invalidPadding: "x".repeat(40 * 1024) },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_REQUEST");
  } finally {
    await app.close();
  }
});

test("only the dedicated gateway credential can ask Control to authorize MCP egress", async () => {
  const mcpEgressProxyToken = "mcp-egress-proxy-token-at-least-32-characters";
  const gateway = {
    beginUserOAuthConnection: async () => ({ location: "http://provider/authorize", cookies: [] }),
    completeUserOAuthConnection: async () => ({ state: "disconnected" as const, connectedAt: null, expiresAt: null, account: null }),
    disconnectUserOAuthConnection: async () => ({ state: "disconnected" as const, connectedAt: null, expiresAt: null, account: null }),
    userOAuthConnectionStatus: async () => ({ state: "disconnected" as const, connectedAt: null, expiresAt: null, account: null }),
    userOAuthConnectionTools: async () => [],
  } as unknown as GatewayClient;
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    gateway,
    undefined,
    {},
    {
      testIdentityMode: true,
      connectorRegistryStore: new MemoryConnectorRegistryStore(),
      agentBridgeSecret: "control-auth-egress-agent-bridge-secret-at-least-32-characters",
      mcpEgressProxyToken,
    },
  );
  try {
    const rejected = await app.inject({
      method: "POST",
      url: "/internal/v1/mcp-egress/authorize",
      headers: { "content-type": "application/json", authorization: "Bearer incorrect" },
      payload: { protocol: "https", host: "mcp.notion.com", port: 443 },
    });
    assert.equal(rejected.statusCode, 401);

    const queryRejected = await app.inject({
      method: "POST",
      url: "/internal/v1/mcp-egress/authorize?probe=1",
      headers: { "content-type": "application/json", authorization: "Bearer incorrect" },
      payload: { protocol: "https", host: "mcp.notion.com", port: 443 },
    });
    assert.equal(queryRejected.statusCode, 401);

    const allowed = await app.inject({
      method: "POST",
      url: "/internal/v1/mcp-egress/authorize",
      headers: { "content-type": "application/json", authorization: `Bearer ${mcpEgressProxyToken}` },
      payload: { protocol: "https", host: "mcp.notion.com", port: 443 },
    });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), { allowed: true });

    const malformed = await app.inject({
      method: "POST",
      url: "/internal/v1/mcp-egress/authorize",
      headers: { "content-type": "application/json", authorization: `Bearer ${mcpEgressProxyToken}` },
      payload: { protocol: "http", host: "mcp.notion.com", port: 443 },
    });
    assert.equal(malformed.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("runtime identity comes only from the authenticated server session", async () => {
  const store = new MemoryWorkspaceStore();
  const owned = await store.createOrGet(alpha, "personal", "identity-boundary-workspace");
  await store.update(owned.id, { state: "ready" });
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    authentication: authentication(principal),
    agentBridgeSecret: "control-auth-test-agent-bridge-secret-at-least-32-characters",
  });
  try {
    const spoofedOnly = await app.inject({
      method: "GET",
      url: "/v1/workspaces/current",
      headers: {
        "x-lemmacomputer-proxy-token": proxyToken,
        "x-lemmacomputer-tenant-id": "acme",
        "x-lemmacomputer-subject-id": "alpha",
        "x-lemmacomputer-role": "administrator",
      },
    });
    assert.equal(spoofedOnly.statusCode, 401);

    const authenticated = await app.inject({
      method: "GET",
      url: "/v1/workspaces/current",
      headers: {
        "x-lemmacomputer-proxy-token": proxyToken,
        cookie: "lemmacomputer_session=valid",
        "x-lemmacomputer-tenant-id": "other",
        "x-lemmacomputer-subject-id": "attacker",
        "x-lemmacomputer-role": "administrator",
      },
    });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(authenticated.json().id, owned.id);

    const admin = await app.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid", "x-lemmacomputer-role": "administrator" },
    });
    assert.equal(admin.statusCode, 403);

    const employeePolicyRead = await app.inject({
      method: "GET",
      url: "/v1/admin/mcp-policy",
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid" },
    });
    assert.equal(employeePolicyRead.statusCode, 403);

    const employeePolicyWrite = await app.inject({
      method: "PUT",
      url: "/v1/admin/mcp-policy",
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid", "content-type": "application/json" },
      payload: { tools: {} },
    });
    assert.equal(employeePolicyWrite.statusCode, 403);

    const employeeSuspend = await app.inject({
      method: "PATCH",
      url: "/v1/admin/users/another-user/status",
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid", "content-type": "application/json" },
      payload: { status: "disabled" },
    });
    assert.equal(employeeSuspend.statusCode, 403);
    const employeeMemberships = await app.inject({
      method: "GET",
      url: "/v1/admin/memberships",
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid" },
    });
    assert.equal(employeeMemberships.statusCode, 403);
    const employeeRoleChange = await app.inject({
      method: "PATCH",
      url: "/v1/admin/memberships/another-user",
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid", "content-type": "application/json" },
      payload: { role: "admin" },
    });
    assert.equal(employeeRoleChange.statusCode, 403);
    const employeeInvitations = await app.inject({
      method: "GET",
      url: "/v1/admin/invitations",
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid" },
    });
    assert.equal(employeeInvitations.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("External ID routes allow hosted and explicit worktree qualification while preserving one generic public failure", async () => {
  const calls: Array<{ method: "begin" | "complete"; input?: unknown }> = [];
  const externalIdAuthentication = {
    begin: async (returnPath?: string, invitation?: string) => {
      calls.push({ method: "begin", input: { returnPath, invitation } });
      if (invitation === "rejected-invitation-token-value") throw new Error("invited@example.test is not eligible");
      return { location: "https://external-tenant.ciamlogin.com/tenant/oauth2/v2.0/authorize", cookie: "oc_external_id_state=opaque" };
    },
    complete: async () => {
      calls.push({ method: "complete" });
      throw new Error("wrong issuer for invited@example.test");
    },
    authenticate: async () => null,
    logout: async () => "",
  };
  const workforceAuthentication = authentication(null);
  const hosted = createControlServer(new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, undefined, undefined, {
    installationKind: "hosted",
  }, {
    authentication: workforceAuthentication,
    externalIdAuthentication,
    agentBridgeSecret: "hosted-auth-agent-bridge-secret-at-least-32-characters",
  });
  const customerManaged = createControlServer(new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, undefined, undefined, {
    installationKind: "customer-managed",
  }, {
    authentication: workforceAuthentication,
    externalIdAuthentication,
    agentBridgeSecret: "customer-auth-agent-bridge-secret-at-least-32-characters",
  });
  const worktree = createControlServer(new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, undefined, undefined, {
    installationKind: "worktree",
  }, {
    authentication: workforceAuthentication,
    externalIdAuthentication,
    agentBridgeSecret: "worktree-auth-agent-bridge-secret-at-least-32-characters",
  });
  const headers = { "x-lemmacomputer-proxy-token": proxyToken };
  try {
    const workforceHosted = await hosted.inject({ method: "GET", url: "/v1/auth/login", headers });
    assert.equal(workforceHosted.statusCode, 302);
    assert.deepEqual(calls[0], { method: "begin", input: { returnPath: undefined, invitation: undefined } });

    const started = await hosted.inject({
      method: "POST",
      url: "/v1/auth/external-id/invitation",
      headers,
      payload: { invitation: "accepted-invitation-token-value", return: "/?view=people" },
    });
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().location, "https://external-tenant.ciamlogin.com/tenant/oauth2/v2.0/authorize");
    assert.deepEqual(calls[1], {
      method: "begin",
      input: { returnPath: "/?view=people", invitation: "accepted-invitation-token-value" },
    });

    for (const payload of [{}, { invitation: "rejected-invitation-token-value" }]) {
      const rejected = await hosted.inject({ method: "POST", url: "/v1/auth/external-id/invitation", headers, payload });
      assert.equal(rejected.statusCode, 403);
      assert.equal(rejected.json().error.code, "EXTERNAL_ID_SIGNIN_FAILED");
      assert.doesNotMatch(rejected.body, /invited@example\.test|wrong issuer|not eligible/);
    }
    const callbackRejected = await hosted.inject({ method: "GET", url: "/v1/auth/external-id/callback?state=opaque&code=wrong-issuer-code", headers });
    assert.equal(callbackRejected.statusCode, 303);
    assert.equal(callbackRejected.headers.location, "/?signin=error&reason=EXTERNAL_ID_SIGNIN_FAILED");
    assert.doesNotMatch(callbackRejected.body, /invited@example\.test|wrong issuer|not eligible/);

    const externalIdCustomerManaged = await customerManaged.inject({
      method: "POST",
      url: "/v1/auth/external-id/invitation",
      headers,
      payload: { invitation: "accepted-invitation-token-value" },
    });
    assert.equal(externalIdCustomerManaged.statusCode, 404);
    const customerBody = externalIdCustomerManaged.json();
    assert.equal(customerBody.error.code, "AUTH_PROVIDER_NOT_AVAILABLE");
    const externalIdWorktree = await worktree.inject({
      method: "POST",
      url: "/v1/auth/external-id/invitation",
      headers,
      payload: { invitation: "accepted-invitation-token-value", return: "/?view=people" },
    });
    assert.equal(externalIdWorktree.statusCode, 200);
    assert.equal(calls.filter((call) => call.method === "begin").length, 4);
  } finally {
    await Promise.all([hosted.close(), customerManaged.close(), worktree.close()]);
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
    vendorUserId: "oc-user-test", document: { schemaVersion: 1 },
  };
  let assigned = true;
  let revoked = false;
  let betaStatus: "active" | "disabled" = "active";
  let betaMembershipRole: "owner" | "admin" | "member" = "member";
  let betaMembershipStatus: "active" | "suspended" | "revoked" = "active";
  let membershipChange: Record<string, unknown> | null = null;
  const invitationId = "11111111-1111-4111-8111-111111111111";
  let invitationInput: Record<string, unknown> | null = null;
  let invitation = {
    invitationId,
    organizationId: "acme",
    email: "new.user@example.test",
    role: "admin" as const,
    status: "pending" as "pending" | "accepted" | "expired" | "revoked",
    deliveryGeneration: 1,
    expiresAt: "2026-08-14T00:00:00.000Z",
    acceptedMembershipId: null,
    createdBy: "alpha",
    updatedBy: "alpha",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
  let revokedSessionCount = 0;
  let assignedWorkspaceSubject = "";
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
    workspaceProfiles: ["claude-desktop-standard-v1", "disposable-open-v1"],
    agentProfile: "claude-desktop-managed-v1",
    modelAliases: ["lemmacomputer-claude"],
    networkProfile: "controlled-egress-v1",
    mcp: {
      servers: {
        lemmacomputer_ms365: {
          tools: Object.keys(m365ToolCatalog),
          toolPolicies: Object.fromEntries(Object.entries(m365ToolCatalog).map(([name, tool]) => [name, tool.decision])),
        },
      },
    },
  };
  const workspaceStore = new MemoryWorkspaceStore();
  const activeWorkspace = await workspaceStore.createOrGet(alpha, "personal", "active-policy-refresh-workspace");
  const openWorkspace = await workspaceStore.createOrGet(alpha, "workspace-open-research", "open-firewall-workspace");
  const savedSandboxSettings = new Map<string, {
    tenantId: string;
    subjectId: string;
    grantId: string;
    profileId: "disposable-open-v1";
    applicationIds: ["firefox"];
    modelAlias: "lemmacomputer-claude";
    agentIds: ["claude-desktop"];
    updatedAt: Date;
  }>();
  Object.assign(workspaceStore, {
    getSandboxSettings: async (targetIdentity: IdentityContext, grantId: string) => savedSandboxSettings.get(`${targetIdentity.subjectId}:${grantId}`) ?? (grantId === openWorkspace.grantId ? {
      tenantId: "acme",
      subjectId: "alpha",
      grantId,
      profileId: "disposable-open-v1" as const,
      applicationIds: ["firefox"] as const,
      modelAlias: "lemmacomputer-claude" as const,
      agentIds: ["claude-desktop"] as const,
      updatedAt: new Date(),
    } : null),
    saveSandboxSettings: async (targetIdentity: IdentityContext, input: {
      grantId: string;
      profileId: "disposable-open-v1";
      applicationIds: ["firefox"];
      modelAlias: "lemmacomputer-claude";
      agentIds: ["claude-desktop"];
    }) => {
      const saved = { tenantId: targetIdentity.tenantId, subjectId: targetIdentity.subjectId, ...input, updatedAt: new Date() };
      savedSandboxSettings.set(`${targetIdentity.subjectId}:${input.grantId}`, saved);
      return saved;
    },
  });
  await workspaceStore.update(activeWorkspace.id, { state: "ready" });
  await workspaceStore.update(openWorkspace.id, { state: "ready" });
  const identityPolicyStore = {
    listUsers: async (tenantId) => tenantId === "acme" ? [
      { userId: "alpha", email: principal.email, displayName: principal.displayName, status: "active" as const, roles: principal.roles, effectivePolicy: revoked ? null : effectivePolicy },
      { userId: "beta", email: "beta@metech.dev", displayName: "Beta User", status: betaStatus, roles: ["employee"] as const, effectivePolicy },
    ] : [],
    getPrincipal: async (userId: string) => userId === "alpha" ? administrator : null,
    listOrganizationMemberships: async (organizationId: string) => organizationId === "acme" ? [{
      membershipId: "membership-beta",
      organizationId,
      accountUserId: "account-beta",
      userId: "beta",
      email: "beta@metech.dev",
      displayName: "Beta User",
      status: betaMembershipStatus,
      role: betaMembershipRole,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }] : [],
    changeOrganizationMembership: async (input: {
      organizationId: string;
      targetUserId: string;
      role?: "owner" | "admin" | "member";
      status?: "active" | "suspended" | "revoked";
      updatedBy: string;
    }) => {
      membershipChange = input;
      betaMembershipRole = input.role ?? betaMembershipRole;
      betaMembershipStatus = input.status ?? betaMembershipStatus;
      return {
        membership: {
          membershipId: "membership-beta",
          organizationId: input.organizationId,
          accountUserId: "account-beta",
          userId: input.targetUserId,
          email: "beta@metech.dev",
          displayName: "Beta User",
          status: betaMembershipStatus,
          role: betaMembershipRole,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-07T00:00:00.000Z",
        },
        revokedSessions: input.status === "suspended" || input.status === "revoked" ? 2 : 0,
      };
    },
    listOrganizationInvitations: async (organizationId: string) => organizationId === "acme" && invitationInput ? [invitation] : [],
    createOrganizationInvitation: async (input: Record<string, unknown>) => {
      invitationInput = input;
      invitation = {
        ...invitation,
        organizationId: String(input.organizationId),
        email: String(input.email),
        role: input.role as "admin",
        expiresAt: (input.expiresAt as Date).toISOString(),
      };
      return { invitation, replayed: false };
    },
    resendOrganizationInvitation: async (input: Record<string, unknown>) => {
      invitationInput = input;
      invitation = {
        ...invitation,
        deliveryGeneration: invitation.deliveryGeneration + 1,
        expiresAt: (input.expiresAt as Date).toISOString(),
        updatedAt: (input.now as Date).toISOString(),
      };
      return { invitation, replayed: false };
    },
    revokeOrganizationInvitation: async (input: Record<string, unknown>) => {
      invitationInput = input;
      invitation = { ...invitation, status: "revoked", updatedAt: (input.now as Date).toISOString() };
      return { invitation, replayed: false };
    },
    setUserStatus: async ({ status }: { status: "active" | "disabled" }) => {
      betaStatus = status;
      return { status, revokedSessions: status === "disabled" ? 2 : 0 };
    },
    revokeUserSessions: async () => {
      revokedSessionCount += 1;
      return 2;
    },
    assignMvpPolicy: async () => { assigned = true; revoked = false; return effectivePolicy; },
    getEffectivePolicy: async () => assigned && !revoked ? effectivePolicy : null,
    revokeMvpPolicy: async () => { revoked = true; return true; },
    updateMvpToolPolicy: async ({ tools }: { tools: Record<string, McpToolPolicyDecision> }) => {
      savedToolPolicy = tools;
      effectivePolicy.policyVersionId = "version-2";
      effectivePolicy.version = 2;
      effectivePolicy.documentHash = "b".repeat(64);
      const document = effectivePolicy.document as {
        mcp: { servers: { lemmacomputer_ms365: { toolPolicies: Record<string, McpToolPolicyDecision> } } };
      };
      document.mcp.servers.lemmacomputer_ms365.toolPolicies = tools;
      return { id: "version-2", version: 2, documentHash: "b".repeat(64) };
    },
    listEgressSecurityGroups: async () => [firewallVersion],
    saveEgressSecurityGroup: async (input: { name: string; description: string; rules: EgressSecurityGroupVersion["rules"] }) => {
      firewallVersion = { ...firewallVersion, version: 2, id: "egv_acme_updates_v2", name: input.name, description: input.description, rules: input.rules, documentHash: "f".repeat(64) };
      return firewallVersion;
    },
    getWorkspaceEgressSecurityGroup: async ({ grantId }: { grantId: string }) => grantId === openWorkspace.grantId
      ? { ...firewallVersion, defaultAction: "allow-public-http-https" as const }
      : firewallVersion,
    assignWorkspaceEgressSecurityGroup: async ({ subjectId, securityGroupVersionId }: { subjectId: string; securityGroupVersionId: string }) => {
      assignedWorkspaceSubject = subjectId;
      firewallVersion = { ...firewallVersion, id: securityGroupVersionId };
      return firewallVersion;
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
    beginUserOAuthConnection: async () => ({ location: "http://provider/authorize", cookies: [] }),
    completeUserOAuthConnection: async () => ({
      state: "connected" as const,
      connectedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-28T01:00:00.000Z",
      account: null,
    }),
    disconnectUserOAuthConnection: async () => ({ state: "disconnected" as const, connectedAt: null, expiresAt: null, account: null }),
    ensureOAuthMcpServers: async () => undefined,
    userOAuthConnectionStatus: async (_identity: IdentityContext, serverName: string) => serverName === "lemmacomputer_linear"
      ? {
          state: "connected" as const,
          connectedAt: "2026-07-28T00:00:00.000Z",
          expiresAt: "2026-07-28T01:00:00.000Z",
          account: null,
        }
      : { state: "disconnected" as const, connectedAt: null, expiresAt: null, account: null },
    userOAuthConnectionTools: async (_identity: IdentityContext, serverName: string) => serverName === "lemmacomputer_linear"
      ? [{ name: "create_issue", definitionHash: "a".repeat(64) }]
      : [],
  } as unknown as GatewayClient;
  const connectorRegistry = new MemoryConnectorRegistryStore();
  const app = createControlServer(workspaceStore, {} as ControllerClient, proxyToken, gateway, undefined, {}, {
    authentication: authentication(administrator), identityPolicyStore, connectorRegistryStore: connectorRegistry,
    agentBridgeSecret: "control-auth-policy-agent-bridge-secret-at-least-32-characters",
  });
  const headers = { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=valid" };
  try {
    const adminUsers = await app.inject({ method: "GET", url: "/v1/admin/users", headers });
    assert.equal(adminUsers.statusCode, 200);
    const openFirewall = adminUsers.json().users[0].workspaces.find((workspace: { id: string }) => workspace.id === openWorkspace.id);
    assert.equal(openFirewall.executionMode, "disposable-open");
    assert.equal(openFirewall.egress.mode, "full-web");
    assert.equal(openFirewall.egress.defaultAction, "allow-public-http-https");

    const memberships = await app.inject({ method: "GET", url: "/v1/admin/memberships", headers });
    assert.equal(memberships.statusCode, 200);
    assert.equal(memberships.json().memberships[0].organizationId, "acme");
    const roleChanged = await app.inject({
      method: "PATCH",
      url: "/v1/admin/memberships/beta",
      headers: { ...headers, "content-type": "application/json" },
      payload: { role: "admin" },
    });
    assert.equal(roleChanged.statusCode, 200);
    assert.equal(roleChanged.json().membership.role, "admin");
    assert.deepEqual(membershipChange, {
      organizationId: "acme",
      targetUserId: "beta",
      role: "admin",
      status: undefined,
      updatedBy: "alpha",
    });
    const ownershipDenied = await app.inject({
      method: "PATCH",
      url: "/v1/admin/memberships/beta",
      headers: { ...headers, "content-type": "application/json" },
      payload: { role: "owner" },
    });
    assert.equal(ownershipDenied.statusCode, 403);
    const selfMembershipSuspend = await app.inject({
      method: "PATCH",
      url: "/v1/admin/memberships/alpha",
      headers: { ...headers, "content-type": "application/json" },
      payload: { status: "suspended" },
    });
    assert.equal(selfMembershipSuspend.statusCode, 409);
    const betaPendingWorkspace = await workspaceStore.createOrGet(beta, "pending-access-revocation", "beta-pending-access-revocation");
    const betaPendingOperation = await workspaceStore.createGovernedOperation({
      id: randomUUID(), identity: beta, workspaceId: betaPendingWorkspace.id,
      capabilityId: "m365-write-protected", serverName: "lemmacomputer_ms365", toolName: "send-mail",
      schemaId: "lemmacomputer.m365.send-mail.v1", arguments: { draftId: "redacted" },
      operationDigest: "9".repeat(64), nonce: randomUUID(), safeSummary: "Send a prepared email",
      resourceName: "Prepared email", resourceLocation: "Outlook Mail", correlationId: "membership-suspend",
      idempotencyKey: "membership-suspend-operation", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(betaPendingOperation);
    const membershipSuspended = await app.inject({
      method: "PATCH",
      url: "/v1/admin/memberships/beta",
      headers: { ...headers, "content-type": "application/json" },
      payload: { status: "suspended" },
    });
    assert.equal(membershipSuspended.statusCode, 200);
    assert.equal(membershipSuspended.json().membership.status, "suspended");
    assert.equal(membershipSuspended.json().revokedSessions, 2);
    assert.equal(membershipSuspended.json().revokedPendingOperations, 1);
    assert.equal((await workspaceStore.getOwnedOperation(beta, betaPendingOperation.id))?.state, "failed");
    assert.equal((await workspaceStore.getOwnedOperation(beta, betaPendingOperation.id))?.failureCode, "MEMBERSHIP_ACCESS_REVOKED");
    await workspaceStore.remove(beta, betaPendingWorkspace.id);
    revokedKeys.length = 0;

    const emptyInvitations = await app.inject({ method: "GET", url: "/v1/admin/invitations", headers });
    assert.equal(emptyInvitations.statusCode, 200);
    assert.deepEqual(emptyInvitations.json().invitations, []);
    const invited = await app.inject({
      method: "POST",
      url: "/v1/admin/invitations",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "invite-new-user-0001" },
      payload: { email: "New.User@Example.Test", role: "admin" },
    });
    assert.equal(invited.statusCode, 201);
    assert.equal(invited.json().invitation.email, "new.user@example.test");
    assert.match(invited.json().acceptancePath, /^\/invite\?token=oci_/);
    assert.equal(invitationInput?.organizationId, "acme");
    assert.equal(invitationInput?.createdBy, "alpha");
    assert.match(String(invitationInput?.tokenHash), /^[a-f0-9]{64}$/);
    assert.doesNotMatch(String(invitationInput?.tokenHash), /oci_/);
    const ownerInviteDenied = await app.inject({
      method: "POST",
      url: "/v1/admin/invitations",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "invite-owner-user-0001" },
      payload: { email: "owner@example.test", role: "owner" },
    });
    assert.equal(ownerInviteDenied.statusCode, 403);
    const resentInvitation = await app.inject({
      method: "POST",
      url: `/v1/admin/invitations/${invitationId}/resend`,
      headers: { ...headers, "idempotency-key": "resend-new-user-0001" },
    });
    assert.equal(resentInvitation.statusCode, 200);
    assert.equal(resentInvitation.json().invitation.deliveryGeneration, 2);
    assert.match(resentInvitation.json().acceptancePath, /^\/invite\?token=oci_/);
    const revokedInvitation = await app.inject({
      method: "DELETE",
      url: `/v1/admin/invitations/${invitationId}`,
      headers,
    });
    assert.equal(revokedInvitation.statusCode, 200);
    assert.equal(revokedInvitation.json().invitation.status, "revoked");

    const connectorCatalog = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(connectorCatalog.statusCode, 200);
    await connectorRegistry.saveConnectionState({
      tenantId: alpha.tenantId,
      subjectId: alpha.subjectId,
      connectorId: "linear",
      state: "connected",
      connectedAt: new Date("2026-07-28T00:00:00.000Z"),
      expiresAt: new Date("2026-07-28T01:00:00.000Z"),
    });
    await connectorRegistry.updateToolPolicies(alpha.tenantId, "linear", {
      toolPolicies: { create_issue: "allow" },
      toolDefinitionHashes: { create_issue: "a".repeat(64) },
    });
    assert.equal(refreshedPolicies.length, 0, "a no-marker catalog entry must not refresh workspace grants");

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
    assert.deepEqual(savedPolicy.json().workspaceGrants, { refreshed: 2, failed: 0 });
    assert.equal(savedToolPolicy?.["list-calendars"], "deny");
    assert.equal(refreshedPolicies.length, 2);
    assert.deepEqual(refreshedPolicies.map((runtime) => runtime.agentProfile).sort(), [
      "claude-desktop-managed-v1",
      "claude-desktop-managed-v1",
    ]);
    assert.equal(new Set(refreshedPolicies.map((runtime) => runtime.agentId)).size, 1);
    assert.ok(refreshedPolicies.every((runtime) => runtime.policyVersionId === "version-2"));
    assert.ok(refreshedPolicies.every((runtime) => runtime.toolPolicies["list-calendars"] === "deny"));

    for (const runtime of refreshedPolicies) {
      assert.ok(runtime.mcpServers?.includes("lemmacomputer_linear"));
      assert.deepEqual(runtime.mcpToolPermissions?.lemmacomputer_linear, ["create_issue"]);
    }
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
      url: "/v1/admin/workspaces/personal/egress-security-group",
      headers: { ...headers, "content-type": "application/json" },
      payload: { securityGroupVersionId: "egv_acme_updates_v2" },
    });
    assert.equal(attachedFirewall.statusCode, 200);
    assert.equal(attachedFirewall.json().id, "egv_acme_updates_v2");

    const selfSuspend = await app.inject({
      method: "PATCH",
      url: "/v1/admin/users/alpha/status",
      headers: { ...headers, "content-type": "application/json" },
      payload: { status: "disabled" },
    });
    assert.equal(selfSuspend.statusCode, 409);

    const suspended = await app.inject({
      method: "PATCH",
      url: "/v1/admin/users/beta/status",
      headers: { ...headers, "content-type": "application/json" },
      payload: { status: "disabled" },
    });
    assert.equal(suspended.statusCode, 200);
    assert.equal(suspended.json().status, "disabled");
    const reactivated = await app.inject({
      method: "PATCH",
      url: "/v1/admin/users/beta/status",
      headers: { ...headers, "content-type": "application/json" },
      payload: { status: "active" },
    });
    assert.equal(reactivated.statusCode, 200);
    const signedOut = await app.inject({
      method: "POST",
      url: "/v1/admin/users/beta/sessions/revoke",
      headers,
    });
    assert.equal(signedOut.statusCode, 200);
    assert.equal(signedOut.json().revokedSessions, 2);
    assert.equal(revokedSessionCount, 1);

    const betaWorkspace = await workspaceStore.createOrGet(beta, "personal", "beta-admin-managed-workspace");
    const betaSettings = await app.inject({
      method: "GET",
      url: "/v1/admin/users/beta/sandbox-settings?grantId=personal",
      headers,
    });
    assert.equal(betaSettings.statusCode, 200);
    assert.equal(betaSettings.json().grantId, "personal");
    const savedBetaSettings = await app.inject({
      method: "PUT",
      url: "/v1/admin/users/beta/sandbox-settings",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        grantId: "personal",
        profileId: "disposable-open-v1",
        applicationIds: ["firefox"],
        modelAlias: "lemmacomputer-claude",
        agentIds: ["claude-desktop"],
      },
    });
    assert.equal(savedBetaSettings.statusCode, 200);
    assert.equal(savedBetaSettings.json().profileId, "disposable-open-v1");
    const betaFirewall = await app.inject({
      method: "POST",
      url: "/v1/admin/users/beta/workspaces/personal/egress-security-group",
      headers: { ...headers, "content-type": "application/json" },
      payload: { securityGroupVersionId: "egv_acme_updates_v2" },
    });
    assert.equal(betaFirewall.statusCode, 200);
    assert.equal(assignedWorkspaceSubject, "beta");
    assert.equal(betaWorkspace.subjectId, "beta");

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
      `${activeWorkspace.id}:agent-1:claude-desktop`,
      `${openWorkspace.id}:agent-1:claude-desktop`,
    ].sort());
  } finally {
    await app.close();
  }
});
