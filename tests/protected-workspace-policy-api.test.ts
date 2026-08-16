import assert from "node:assert/strict";
import test from "node:test";
import { LemmaComputerError, type IdentityContext } from "@lemmacomputer/contracts";
import {
  MemoryWorkspaceStore,
  mvpPolicyDocument,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type OrganizationWorkspacePolicyVersionRecord,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import {
  organizationWorkspacePolicyCatalog,
  type ProtectedWorkspacePolicyAdministrationBoundary,
} from "../apps/control-api/src/protected-workspace-policy.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";
import type { GatewayClient } from "@lemmacomputer/litellm-adapter";

const tenantId = "protected-policy-api-tenant";
const proxyToken = "protected-policy-api-proxy-token-at-least-32-characters";
const identity = (subjectId: string): IdentityContext => ({
  tenantId,
  subjectId,
  audience: "lemmacomputer-control",
});
const principal = (role: "administrator" | "employee"): SessionPrincipal => ({
  userId: role,
  tenantId,
  email: `${role}@test.invalid`,
  displayName: role,
  tenantDisplayName: "Protected policy API",
  roles: [role],
  identity: identity(role),
});
const authentication = (authenticated: SessionPrincipal) => ({
  resolve: async (headers: Headers) => headers.get("cookie") === "lemmacomputer_session=valid"
    ? { status: "authorized" as const, principal: authenticated }
    : { status: "anonymous" as const },
});
const organizationVersion: OrganizationWorkspacePolicyVersionRecord = {
  tenantId,
  policyVersionId: "11111111-1111-4111-8111-111111111111",
  version: 1,
  previousPolicyVersionId: null,
  documentHash: "a".repeat(64),
  constraints: { agents: { allow: ["claude-cli"], deny: [] } },
  revisionNote: "Claude CLI only",
  createdBy: "administrator",
  createdAt: new Date("2026-08-12T06:00:00.000Z"),
};
const overview = {
  catalog: organizationWorkspacePolicyCatalog,
  organizationPolicyVersions: [organizationVersion],
};
const effectivePolicy: EffectivePolicy = {
  assignmentId: "assignment-protected-policy",
  policyBundleId: "bundle-protected-policy",
  policyVersionId: "member-policy-protected-policy",
  version: 1,
  documentHash: "b".repeat(64),
  assignedBy: "administrator",
  assignedAt: "2026-08-12T05:00:00.000Z",
  agentId: "agent-protected-policy",
  vendorUserId: "administrator",
  document: mvpPolicyDocument(),
};
const identityPolicies = {
  listUsers: async (inputTenantId: string) => inputTenantId === tenantId ? [{
    userId: "administrator",
    email: "administrator@test.invalid",
    displayName: "administrator",
    status: "active" as const,
    membershipStatus: "active" as const,
    roles: ["administrator"],
    effectivePolicy,
  }] : [],
  getPrincipal: async (userId: string) => userId === "administrator" ? principal("administrator") : null,
} as unknown as IdentityPolicyStore;

const appFor = (
  actor: SessionPrincipal,
  calls: Array<{ method: string; input: unknown }>,
  store = new MemoryWorkspaceStore(),
  controller = {} as ControllerClient,
  gateway?: GatewayClient,
  identityPolicyStore?: IdentityPolicyStore,
) => {
  const protectedWorkspacePolicy: ProtectedWorkspacePolicyAdministrationBoundary = {
    overview: async (inputTenantId) => {
      calls.push({ method: "overview", input: inputTenantId });
      return overview;
    },
    createOrganizationPolicyVersion: async (input) => {
      calls.push({ method: "createOrganizationPolicyVersion", input });
      return organizationVersion;
    },
    listOrganizationPolicyVersions: async (inputTenantId) => {
      calls.push({ method: "listOrganizationPolicyVersions", input: inputTenantId });
      return [organizationVersion];
    },
    currentOrganizationPolicy: async (inputTenantId) => inputTenantId === tenantId ? organizationVersion : null,
  };
  return createControlServer(
    store,
    controller,
    proxyToken,
    gateway,
    undefined,
    {},
    {
      customerProductAuthentication: authentication(actor),
      protectedWorkspacePolicy,
      ...(identityPolicyStore ? { identityPolicyStore } : {}),
      agentBridgeSecret: "protected-policy-api-agent-bridge-secret-at-least-32-characters",
    },
  );
};

test("organization policy administration exposes the full catalog and append-only versions", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const app = appFor(principal("administrator"), calls);
  const headers = { cookie: "lemmacomputer_session=valid", "x-lemmacomputer-proxy-token": proxyToken };
  try {
    const current = await app.inject({ method: "GET", url: "/v1/admin/protected-workspace-policy", headers });
    assert.equal(current.statusCode, 200);
    assert.deepEqual(current.json().catalog, organizationWorkspacePolicyCatalog);
    assert.deepEqual(current.json().catalog.constraints.agents.allow, [
      "claude-desktop", "claude-cli", "hermes-desktop", "hermes-claw",
    ]);
    assert.deepEqual(current.json().catalog.constraints.workspaceProfiles.allow, ["claude-desktop-standard-v1", "disposable-open-v1"]);
    assert.deepEqual(current.json().catalog.constraints.serviceClasses.allow, ["lite", "balanced", "pro"]);

    const createdOverlay = await app.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers,
      payload: { constraints: { agents: { allow: ["claude-cli"], deny: [] } }, revisionNote: "Claude CLI only" },
    });
    assert.equal(createdOverlay.statusCode, 201);
    assert.equal(createdOverlay.json().version.version, 1);

    const unqualifiedAgent = await app.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers,
      payload: { constraints: { agents: { allow: ["codex-cli"], deny: [] } }, revisionNote: "Attempt Codex CLI" },
    });
    assert.equal(unqualifiedAgent.statusCode, 400);
    assert.equal(unqualifiedAgent.json().error.code, "WORKSPACE_AGENT_NOT_SELECTABLE");

    const overlayHistory = await app.inject({
      method: "GET",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers,
    });
    assert.equal(overlayHistory.statusCode, 200);
    assert.equal(overlayHistory.json().versions.length, 1);

    const retiredMemberAssignment = await app.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/members/member/assignment-versions",
      headers,
      payload: {},
    });
    assert.equal(retiredMemberAssignment.statusCode, 404);
    assert.deepEqual(calls, [
      { method: "overview", input: tenantId },
      { method: "createOrganizationPolicyVersion", input: {
        tenantId,
        constraints: { agents: { allow: ["claude-cli"], deny: [] } },
        revisionNote: "Claude CLI only",
        createdBy: "administrator",
      } },
      { method: "listOrganizationPolicyVersions", input: tenantId },
    ]);
  } finally {
    await app.close();
  }
});

test("publishing guardrails revokes and recreates active compatible workspaces under the new version", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const store = new MemoryWorkspaceStore();
  const created = await store.createOrGet(identity("administrator"), "personal", "policy-transition-workspace");
  await store.update(created.id, { state: "ready", providerId: "sandbox-policy-transition" });
  let destroys = 0;
  let creates = 0;
  let workspaceRevocations = 0;
  const app = appFor(principal("administrator"), calls, store, {
    destroyWorkspace: async () => { destroys += 1; },
    create: async () => {
      creates += 1;
      return { state: "ready", providerId: "sandbox-policy-transition-v2" };
    },
  } as unknown as ControllerClient, {
    revokeWorkspace: async () => { workspaceRevocations += 1; },
    ensureGrant: async (input) => {
      assert.ok(input.policy.agentId);
      assert.ok(input.policy.policyHash);
      return ({
      baseUrl: "http://gateway",
      credential: "scoped-test-credential-000001",
      modelAlias: "lemmacomputer-assistant",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    },
    readiness: async () => ({ models: "ready", tools: "ready", modelRoute: "lemmacomputer-assistant" }),
  } as unknown as GatewayClient, identityPolicies);
  const headers = { cookie: "lemmacomputer_session=valid", "x-lemmacomputer-proxy-token": proxyToken };
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers,
      payload: { constraints: { agents: { allow: ["claude-cli"], deny: [] } }, revisionNote: "Stop before activation" },
    });

    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json().enforcement, {
      stopped: 1,
      alreadyStopped: 0,
      reconciled: 1,
      actionRequired: 0,
      restarted: 1,
      restartFailed: 0,
    });
    assert.equal(destroys, 1);
    assert.equal(creates, 1);
    assert.equal(workspaceRevocations, 1);
    const restarted = await store.getOwned(identity("administrator"), created.id);
    assert.equal(restarted?.state, "ready");
    assert.equal(restarted?.providerId, "sandbox-policy-transition-v2");
    assert.equal(restarted?.accessGeneration, 2);
    assert.equal(calls.at(-1)?.method, "createOrganizationPolicyVersion");
  } finally {
    await app.close();
  }
});

test("guardrail activation is refused when an existing runtime cannot be revoked", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const store = new MemoryWorkspaceStore();
  const created = await store.createOrGet(identity("administrator"), "personal", "policy-transition-failure");
  await store.update(created.id, { state: "ready", providerId: "sandbox-policy-transition-failure" });
  const app = appFor(principal("administrator"), calls, store, {
    destroyWorkspace: async () => { throw new LemmaComputerError("CONTROLLER_UNAVAILABLE", "controller unavailable", 503, true); },
  } as unknown as ControllerClient);
  const headers = { cookie: "lemmacomputer_session=valid", "x-lemmacomputer-proxy-token": proxyToken };
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers,
      payload: { constraints: { agents: { allow: ["claude-cli"], deny: [] } }, revisionNote: "Must fail closed" },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "WORKSPACE_POLICY_TRANSITION_FAILED");
    assert.equal(calls.some((call) => call.method === "createOrganizationPolicyVersion"), false);
  } finally {
    await app.close();
  }
});

test("an active workspace whose only selected agent becomes incompatible restarts as a base workspace", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const store = new MemoryWorkspaceStore();
  const created = await store.createOrGet(identity("administrator"), "personal", "policy-incompatible-workspace");
  Object.assign(store, {
    getSandboxSettings: async () => ({
      tenantId,
      subjectId: "administrator",
      grantId: "personal",
      profileId: "claude-desktop-standard-v1" as const,
      applicationIds: ["firefox" as const],
      modelAlias: "lemmacomputer-assistant" as const,
      requestedServiceClass: "balanced" as const,
      agentIds: ["hermes-claw" as const],
      updatedAt: new Date(),
    }),
  });
  await store.update(created.id, { state: "ready", providerId: "sandbox-policy-incompatible" });
  let creates = 0;
  const app = appFor(principal("administrator"), calls, store, {
    destroyWorkspace: async () => {},
    create: async () => {
      creates += 1;
      return { state: "ready", providerId: "base-workspace-runtime" };
    },
  } as unknown as ControllerClient, {
    revokeWorkspace: async () => {},
  } as unknown as GatewayClient, identityPolicies);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers: { cookie: "lemmacomputer_session=valid", "x-lemmacomputer-proxy-token": proxyToken },
      payload: { constraints: { agents: { allow: ["claude-cli"], deny: [] } }, revisionNote: "Remove incompatible Hermes selection" },
    });

    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json().enforcement, {
      stopped: 1,
      alreadyStopped: 0,
      reconciled: 1,
      actionRequired: 0,
      restarted: 1,
      restartFailed: 0,
    });
    assert.equal(creates, 1);
    const restarted = await store.getOwned(identity("administrator"), created.id);
    assert.equal(restarted?.state, "ready");
    assert.equal(restarted?.providerId, "base-workspace-runtime");
    assert.equal(restarted?.failureCode ?? null, null);
  } finally {
    await app.close();
  }
});

test("a replacement runtime failure is reported without rolling back the current guardrail version", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const store = new MemoryWorkspaceStore();
  const created = await store.createOrGet(identity("administrator"), "personal", "policy-restart-failure");
  await store.update(created.id, { state: "ready", providerId: "sandbox-before-restart-failure" });
  const app = appFor(principal("administrator"), calls, store, {
    destroyWorkspace: async () => {},
    create: async () => {
      throw new LemmaComputerError("CONTROLLER_UNAVAILABLE", "replacement unavailable", 503, true);
    },
  } as unknown as ControllerClient, {
    revokeWorkspace: async () => {},
    revoke: async () => {},
    ensureGrant: async () => ({
      baseUrl: "http://gateway",
      credential: "scoped-test-credential-000002",
      modelAlias: "lemmacomputer-assistant",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  } as unknown as GatewayClient, identityPolicies);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers: { cookie: "lemmacomputer_session=valid", "x-lemmacomputer-proxy-token": proxyToken },
      payload: { constraints: { agents: { allow: ["claude-cli"], deny: [] } }, revisionNote: "Exercise replacement failure" },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().enforcement.restarted, 0);
    assert.equal(response.json().enforcement.restartFailed, 1);
    assert.equal(calls.some((call) => call.method === "createOrganizationPolicyVersion"), true);
    const failed = await store.getOwned(identity("administrator"), created.id);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.failureCode, "CONTROLLER_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("member roles cannot reach organization policy administration and malformed constraints fail", async () => {
  const memberCalls: Array<{ method: string; input: unknown }> = [];
  const memberApp = appFor(principal("employee"), memberCalls);
  const adminCalls: Array<{ method: string; input: unknown }> = [];
  const adminApp = appFor(principal("administrator"), adminCalls);
  const headers = { cookie: "lemmacomputer_session=valid", "x-lemmacomputer-proxy-token": proxyToken };
  try {
    const denied = await memberApp.inject({ method: "GET", url: "/v1/admin/protected-workspace-policy", headers });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(memberCalls, []);

    const malformed = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers,
      payload: { constraints: { agents: { allow: ["hermes-claw"], deny: [] }, unknown: true }, revisionNote: "Unsafe expansion" },
    });
    assert.equal(malformed.statusCode, 400);
    const nonSelectableThinkingLevel = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers,
      payload: { constraints: { maximumReasoningEffort: "max" }, revisionNote: "Do not expose internal levels" },
    });
    assert.equal(nonSelectableThinkingLevel.statusCode, 400);
    assert.equal(nonSelectableThinkingLevel.json().error.code, "WORKSPACE_REASONING_LEVEL_NOT_SELECTABLE");
    assert.deepEqual(adminCalls, []);
  } finally {
    await memberApp.close();
    await adminApp.close();
  }
});
