import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformOperatorPrincipal, PlatformSupportElevation } from "@lemmacomputer/contracts";
import { MemoryWorkspaceStore, type PlatformOperatorSession, type SessionPrincipal } from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "platform-api-proxy-token-at-least-24-characters";
const customerPrincipal = {
  userId: "tenant-administrator",
  tenantId: "11111111-1111-4111-8111-111111111111",
  organizationId: "11111111-1111-4111-8111-111111111111",
  membershipId: "tenant-admin-membership",
  membershipStatus: "active",
  role: "admin",
  email: "tenant.admin@example.test",
  displayName: "Tenant Administrator",
  tenantDisplayName: "Tenant",
  roles: ["employee", "administrator"],
  identity: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    subjectId: "tenant-administrator",
    audience: "lemmacomputer-control",
  },
} as SessionPrincipal;

const operatorPrincipal = {
  realm: "platform-operator",
  operatorSessionId: "22222222-2222-4222-8222-222222222222",
  operatorId: "33333333-3333-4333-8333-333333333333",
  identity: {
    provider: "workforce-entra",
    issuer: "https://login.microsoftonline.com/workforce/v2.0",
    subject: "operator-object-id",
  },
  assurance: { level: "aal2", factors: ["federated", "totp"] },
  authenticatedAt: "2026-08-09T03:00:00.000Z",
  recentStepUpAt: "2026-08-09T03:05:00.000Z",
} as const satisfies PlatformOperatorPrincipal;

const operatorSession: PlatformOperatorSession = {
  principal: operatorPrincipal,
  roles: ["support-operator"],
};
const auditorSession: PlatformOperatorSession = {
  principal: {
    ...operatorPrincipal,
    operatorSessionId: "66666666-6666-4666-8666-666666666666",
    operatorId: "77777777-7777-4777-8777-777777777777",
    identity: { ...operatorPrincipal.identity, subject: "auditor-object-id" },
  },
  roles: ["security-auditor"],
};
const administratorSession: PlatformOperatorSession = {
  principal: {
    ...operatorPrincipal,
    operatorSessionId: "88888888-8888-4888-8888-888888888888",
    operatorId: "99999999-9999-4999-8999-999999999999",
    identity: { ...operatorPrincipal.identity, subject: "administrator-object-id" },
  },
  roles: ["platform-administrator"],
};

const customerAuthentication = {
  begin: async () => ({ location: "https://customer.example.test", cookie: "customer-state=opaque" }),
  complete: async () => { throw new Error("unused"); },
  authenticate: async (cookie: string | undefined) => cookie?.includes("customer_session=valid") ? customerPrincipal : null,
  logout: async () => "customer_session=; Max-Age=0",
};

test("hosted platform routes use only the operator cookie and customer-managed registers no operator routes", async () => {
  const calls: Array<{ method: string; input?: unknown }> = [];
  const operatorAuthentication = {
    begin: async (returnPath?: string) => {
      calls.push({ method: "begin", input: returnPath });
      return {
        location: "https://login.microsoftonline.com/workforce/oauth2/v2.0/authorize",
        cookie: "oc_platform_oidc_state=opaque; Path=/api/v1/platform/auth/callback; HttpOnly; SameSite=Lax",
      };
    },
    complete: async (input: unknown) => {
      calls.push({ method: "complete", input });
      return {
        session: operatorSession,
        returnPath: "/platform",
        cookie: "oc_platform_session=valid; Path=/v1/platform; HttpOnly; SameSite=Strict",
        clearStateCookie: "oc_platform_oidc_state=; Max-Age=0",
      };
    },
    beginStepUp: async (cookie: string | undefined, returnPath?: string) => {
      calls.push({ method: "beginStepUp", input: { cookie, returnPath } });
      return { location: "https://login.microsoftonline.com/workforce/oauth2/v2.0/authorize", cookie: "oc_platform_step_up_state=opaque" };
    },
    completeStepUp: async (input: unknown) => {
      calls.push({ method: "completeStepUp", input });
      return { session: operatorSession, returnPath: "/api/v1/platform/ui", clearStateCookie: "oc_platform_step_up_state=; Max-Age=0" };
    },
    authenticate: async (cookie: string | undefined) => cookie?.includes("oc_platform_session=auditor")
      ? auditorSession
      : cookie?.includes("oc_platform_session=administrator") ? administratorSession
      : cookie?.includes("oc_platform_session=valid") ? operatorSession : null,
    logout: async (cookie: string | undefined, correlationId: string) => {
      calls.push({ method: "logout", input: { cookie, correlationId } });
      return "oc_platform_session=; Path=/v1/platform; Max-Age=0";
    },
  };
  const elevation: PlatformSupportElevation = {
    id: "44444444-4444-4444-8444-444444444444",
    operatorId: operatorPrincipal.operatorId,
    operatorSessionId: operatorPrincipal.operatorSessionId,
    targetOrganizationId: "example",
    reason: "Investigate tenant-requested incident INC-1042",
    scopes: ["support.diagnostics.read"],
    kind: "support",
    approvalRequired: false,
    approvedByOperatorId: null,
    createdAt: "2026-08-09T03:10:00.000Z",
    expiresAt: "2026-08-09T03:30:00.000Z",
    revokedAt: null,
  };
  const operatorStore = {
    requestElevation: async (session: PlatformOperatorSession, input: unknown, options: unknown) => {
      calls.push({ method: "requestElevation", input: { session, input, options } });
      return elevation;
    },
    listElevations: async () => [{ ...elevation, approvedAt: null, status: "active" }],
    approveElevation: async () => elevation,
    revokeElevation: async () => ({ ...elevation, revokedAt: "2026-08-09T03:11:00.000Z" }),
    readTenantDiagnostics: async (_session: PlatformOperatorSession, input: unknown) => {
      calls.push({ method: "readTenantDiagnostics", input });
      return { tenantId: "example", displayName: "Tenant", lifecycleState: "active", activeUsers: 2, workspaces: 1 };
    },
    listSecurityAlerts: async () => [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "retry", attemptCount: 1 }],
    listTenantCleanupJobs: async () => [],
    listAuditEvents: async () => [],
    listTenantLifecycle: async () => [{ id: elevation.targetOrganizationId, displayName: "Tenant", lifecycleState: "active" }],
    updateTenantLifecycle: async (_session: PlatformOperatorSession, input: unknown) => {
      calls.push({ method: "updateTenantLifecycle", input });
      return { id: elevation.targetOrganizationId, displayName: "Tenant", lifecycleState: "suspended" };
    },
    getServiceHealth: async () => ({ status: "available", checkedAt: "2026-08-09T03:10:00.000Z" }),
    listIncidents: async () => [],
    createIncident: async (_session: PlatformOperatorSession, input: unknown) => {
      calls.push({ method: "createIncident", input });
      return { id: "INC-1042", title: "Tenant login incident", severity: "high", status: "open" };
    },
    updateIncident: async () => ({ id: "INC-1042", title: "Tenant login incident", severity: "high", status: "resolved" }),
    listPlatformConfiguration: async () => [],
    setPlatformConfiguration: async (_session: PlatformOperatorSession, input: unknown) => {
      calls.push({ method: "setPlatformConfiguration", input });
      return { key: "support.defaultApprovalRequired", value: true };
    },
    listWorkspaceNodes: async () => [{ id: "workspace-node-a", state: "active" }],
    registerWorkspaceNode: async (_session: PlatformOperatorSession, input: unknown) => {
      calls.push({ method: "registerWorkspaceNode", input });
      return { id: "workspace-node-b", state: "active" };
    },
    updateWorkspaceNodeState: async (_session: PlatformOperatorSession, input: unknown) => {
      calls.push({ method: "updateWorkspaceNodeState", input });
      return { id: "workspace-node-a", state: "draining" };
    },
    listTenantWorkspaceNodeAssignments: async () => [],
    assignTenantWorkspaceNode: async (_session: PlatformOperatorSession, input: unknown) => {
      calls.push({ method: "assignTenantWorkspaceNode", input });
      return { assignment: { tenantId: elevation.targetOrganizationId, workspaceNodeId: "workspace-node-b" }, backfilledWorkspaces: 0 };
    },
  };
  const hosted = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    { installationKind: "hosted" },
    {
      authentication: customerAuthentication,
      platformOperatorAuthentication: operatorAuthentication,
      platformOperatorStore: operatorStore,
      platformSecurityAlertDispatcher: {
        status: () => ({
          state: "degraded" as const,
          lastAttemptAt: "2026-08-09T03:09:00.000Z",
          lastSuccessAt: null,
          lastError: "destination unavailable",
          escalatedAlerts: 1,
        }),
      },
      platformTenantCleanupDispatcher: {
        status: () => ({ state: "healthy" as const, lastAttemptAt: null, lastSuccessAt: null, lastError: null, escalatedJobs: 0 }),
      },
      agentBridgeSecret: "platform-api-agent-bridge-secret-at-least-32-characters",
    },
  );
  const customerManaged = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    { installationKind: "customer-managed" },
    {
      authentication: customerAuthentication,
      platformOperatorAuthentication: operatorAuthentication,
      platformOperatorStore: operatorStore,
      agentBridgeSecret: "platform-customer-agent-bridge-secret-at-least-32-characters",
    },
  );
  const baseHeaders = { "x-lemmacomputer-proxy-token": proxyToken };
  try {
    assert.equal(hosted.hasRoute({ method: "GET", url: "/v1/platform/auth/login" }), true);
    assert.equal(customerManaged.hasRoute({ method: "GET", url: "/v1/platform/auth/login" }), false);
    assert.equal(customerManaged.hasRoute({ method: "GET", url: "/v1/platform/ui" }), false);
    assert.equal(hosted.hasRoute({ method: "POST", url: `/v1/platform/support/elevations/${elevation.id}/use` }), false, "detached elevation-use oracle is absent");

    const started = await hosted.inject({ method: "GET", url: "/v1/platform/auth/login?return=%2Fplatform", headers: baseHeaders });
    assert.equal(started.statusCode, 302);
    assert.match(String(started.headers["set-cookie"]), /oc_platform_oidc_state/);
    assert.deepEqual(calls[0], { method: "begin", input: "/platform" });

    const callback = await hosted.inject({
      method: "GET",
      url: "/v1/platform/auth/callback?state=opaque&code=authorization-code",
      headers: { ...baseHeaders, cookie: "oc_platform_oidc_state=opaque" },
    });
    assert.equal(callback.statusCode, 303);
    assert.equal(callback.headers.location, "/platform");
    assert.match(String(callback.headers["set-cookie"]), /oc_platform_session=valid/);
    assert.equal(calls.some((call) => call.method === "complete"), true);

    const customerDenied = await hosted.inject({
      method: "GET",
      url: "/v1/platform/auth/session",
      headers: { ...baseHeaders, cookie: "customer_session=valid", "x-platform-role": "platform-administrator" },
    });
    assert.equal(customerDenied.statusCode, 401);

    const platformSession = await hosted.inject({
      method: "GET",
      url: "/v1/platform/auth/session",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(platformSession.statusCode, 200);
    assert.equal(platformSession.json().operator.realm, "platform-operator");
    assert.deepEqual(platformSession.json().roles, ["support-operator"]);
    const stepUp = await hosted.inject({
      method: "GET",
      url: "/v1/platform/auth/step-up?return=%2Fapi%2Fv1%2Fplatform%2Fui",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(stepUp.statusCode, 302);
    assert.match(String(stepUp.headers["set-cookie"]), /oc_platform_step_up_state/);
    assert.equal(calls.some((call) => call.method === "beginStepUp"), true);
    const stepUpCallback = await hosted.inject({
      method: "GET",
      url: "/v1/platform/auth/step-up/callback?state=opaque&code=authorization-code",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid; oc_platform_step_up_state=opaque" },
    });
    assert.equal(stepUpCallback.statusCode, 303);
    assert.equal(stepUpCallback.headers.location, "/api/v1/platform/ui");
    assert.equal(calls.some((call) => call.method === "completeStepUp"), true);
    const operatorUi = await hosted.inject({
      method: "GET",
      url: "/v1/platform/ui",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(operatorUi.statusCode, 200);
    assert.match(operatorUi.headers["content-type"] ?? "", /text\/html/);
    assert.match(operatorUi.body, /Platform operations/);
    assert.match(operatorUi.body, /Workforce operator realm/);
    assert.doesNotMatch(operatorUi.body, /customer_session=valid|tenant-administrator/);

    const roleDeniedApproval = await hosted.inject({
      method: "POST",
      url: `/v1/platform/support/elevations/${elevation.id}/approve`,
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(roleDeniedApproval.statusCode, 403);
    const roleDeniedAudit = await hosted.inject({
      method: "GET",
      url: "/v1/platform/audit",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(roleDeniedAudit.statusCode, 403);
    const auditorAudit = await hosted.inject({
      method: "GET",
      url: "/v1/platform/audit",
      headers: { ...baseHeaders, cookie: "oc_platform_session=auditor" },
    });
    assert.equal(auditorAudit.statusCode, 200);
    const securityAlerts = await hosted.inject({
      method: "GET",
      url: "/v1/platform/security-alerts?status=retry",
      headers: { ...baseHeaders, cookie: "oc_platform_session=auditor" },
    });
    assert.equal(securityAlerts.statusCode, 200);
    assert.equal(securityAlerts.json().alerts[0].status, "retry");
    const securityAlertDelivery = await hosted.inject({
      method: "GET",
      url: "/v1/platform/security-alert-delivery",
      headers: { ...baseHeaders, cookie: "oc_platform_session=auditor" },
    });
    assert.equal(securityAlertDelivery.statusCode, 200);
    assert.deepEqual(securityAlertDelivery.json().delivery, {
      state: "degraded",
      lastAttemptAt: "2026-08-09T03:09:00.000Z",
      lastSuccessAt: null,
      lastError: "destination unavailable",
      escalatedAlerts: 1,
    });
    const tenantCleanup = await hosted.inject({
      method: "GET",
      url: "/v1/platform/tenant-cleanup",
      headers: { ...baseHeaders, cookie: "oc_platform_session=auditor" },
    });
    assert.equal(tenantCleanup.statusCode, 200);
    assert.equal(tenantCleanup.json().delivery.state, "healthy");
    assert.deepEqual(tenantCleanup.json().jobs, []);

    const tenantLifecycle = await hosted.inject({
      method: "GET",
      url: "/v1/platform/tenants",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(tenantLifecycle.statusCode, 200);
    assert.equal(tenantLifecycle.json().tenants[0].lifecycleState, "active");
    const deniedLifecycleMutation = await hosted.inject({
      method: "PATCH",
      url: `/v1/platform/tenants/${elevation.targetOrganizationId}/lifecycle`,
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid", "content-type": "application/json" },
      payload: { lifecycleState: "suspended", reason: "Requested by customer security owner" },
    });
    assert.equal(deniedLifecycleMutation.statusCode, 403);
    const updatedLifecycle = await hosted.inject({
      method: "PATCH",
      url: `/v1/platform/tenants/${elevation.targetOrganizationId}/lifecycle`,
      headers: { ...baseHeaders, cookie: "oc_platform_session=administrator", "content-type": "application/json" },
      payload: { lifecycleState: "suspended", reason: "Requested by customer security owner" },
    });
    assert.equal(updatedLifecycle.statusCode, 200);
    assert.equal(calls.some((call) => call.method === "updateTenantLifecycle"), true);

    const deniedNodeList = await hosted.inject({
      method: "GET",
      url: "/v1/platform/workspace-nodes",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(deniedNodeList.statusCode, 403);
    const nodeList = await hosted.inject({
      method: "GET",
      url: "/v1/platform/workspace-nodes",
      headers: { ...baseHeaders, cookie: "oc_platform_session=auditor" },
    });
    assert.equal(nodeList.statusCode, 200);
    assert.equal(nodeList.json().nodes[0].id, "workspace-node-a");
    const registerNode = await hosted.inject({
      method: "POST",
      url: "/v1/platform/workspace-nodes",
      headers: { ...baseHeaders, cookie: "oc_platform_session=administrator", "content-type": "application/json" },
      payload: {
        id: "workspace-node-b",
        endpointUrl: "https://workspace-node-b.nodes.internal:4101",
        tlsServerName: "workspace-node-b.nodes.internal",
        reason: "Register a second private workspace node",
      },
    });
    assert.equal(registerNode.statusCode, 201);
    const assignment = await hosted.inject({
      method: "PUT",
      url: `/v1/platform/tenants/${elevation.targetOrganizationId}/workspace-node`,
      headers: { ...baseHeaders, cookie: "oc_platform_session=administrator", "content-type": "application/json" },
      payload: {
        workspaceNodeId: "workspace-node-b",
        reason: "Place future tenant workspaces on node B",
        backfillUnplacedWorkspaces: false,
      },
    });
    assert.equal(assignment.statusCode, 200);
    assert.equal(calls.some((call) => call.method === "registerWorkspaceNode"), true);
    assert.equal(calls.some((call) => call.method === "assignTenantWorkspaceNode"), true);

    const serviceHealth = await hosted.inject({
      method: "GET",
      url: "/v1/platform/service-health",
      headers: { ...baseHeaders, cookie: "oc_platform_session=auditor" },
    });
    assert.equal(serviceHealth.statusCode, 200);
    assert.equal(serviceHealth.json().health.status, "available");

    const incident = await hosted.inject({
      method: "POST",
      url: "/v1/platform/incidents",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid", "content-type": "application/json" },
      payload: { title: "Tenant login incident", severity: "high", summary: "Authentication callbacks are degraded for one tenant." },
    });
    assert.equal(incident.statusCode, 201);
    assert.equal(calls.some((call) => call.method === "createIncident"), true);

    const deniedConfigurationMutation = await hosted.inject({
      method: "PUT",
      url: "/v1/platform/configuration/support.defaultApprovalRequired",
      headers: { ...baseHeaders, cookie: "oc_platform_session=auditor", "content-type": "application/json" },
      payload: { value: true, reason: "Keep tenant support approvals enabled" },
    });
    assert.equal(deniedConfigurationMutation.statusCode, 403);
    const configurationMutation = await hosted.inject({
      method: "PUT",
      url: "/v1/platform/configuration/support.defaultApprovalRequired",
      headers: { ...baseHeaders, cookie: "oc_platform_session=administrator", "content-type": "application/json" },
      payload: { value: true, reason: "Keep tenant support approvals enabled" },
    });
    assert.equal(configurationMutation.statusCode, 200);
    assert.equal(calls.some((call) => call.method === "setPlatformConfiguration"), true);

    const diagnostics = await hosted.inject({
      method: "GET",
      url: `/v1/platform/tenants/example/diagnostics?elevationId=${elevation.id}`,
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(diagnostics.statusCode, 200);
    assert.equal(diagnostics.json().diagnostics.tenantId, "example");
    assert.equal(calls.some((call) => call.method === "readTenantDiagnostics"), true);

    const requested = await hosted.inject({
      method: "POST",
      url: "/v1/platform/support/elevations",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid", "content-type": "application/json" },
      payload: {
        targetOrganizationId: elevation.targetOrganizationId,
        reason: elevation.reason,
        scopes: elevation.scopes,
        durationMinutes: 20,
        kind: "support",
        approvalRequired: false,
      },
    });
    assert.equal(requested.statusCode, 400, "caller cannot supply approval policy");
    const validRequest = await hosted.inject({
      method: "POST",
      url: "/v1/platform/support/elevations",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid", "content-type": "application/json" },
      payload: {
        targetOrganizationId: elevation.targetOrganizationId,
        reason: elevation.reason,
        scopes: elevation.scopes,
        durationMinutes: 20,
        kind: "support",
      },
    });
    assert.equal(validRequest.statusCode, 201);
    const requestCall = calls.find((call) => call.method === "requestElevation");
    assert.ok(requestCall);
    assert.equal((requestCall.input as { options: { correlationId: string } }).options.correlationId.length > 0, true);

    const listed = await hosted.inject({
      method: "GET",
      url: "/v1/platform/support/elevations?status=active",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().elevations[0].id, elevation.id);
    assert.equal(listed.json().elevations[0].status, "active");

    const operatorRejectedAsCustomer = await hosted.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(operatorRejectedAsCustomer.statusCode, 401);

    const loggedOut = await hosted.inject({
      method: "POST",
      url: "/v1/platform/auth/logout",
      headers: { ...baseHeaders, cookie: "oc_platform_session=valid" },
    });
    assert.equal(loggedOut.statusCode, 204);
    assert.match(String(loggedOut.headers["set-cookie"]), /oc_platform_session=;/);
    assert.equal(calls.some((call) => call.method === "logout"), true);

    const absent = await customerManaged.inject({ method: "GET", url: "/v1/platform/auth/login", headers: baseHeaders });
    assert.equal(absent.statusCode, 404);
    assert.equal(calls.filter((call) => call.method === "begin").length, 1);
  } finally {
    await Promise.all([hosted.close(), customerManaged.close()]);
  }
});
