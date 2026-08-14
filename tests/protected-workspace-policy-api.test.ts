import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext } from "@lemmacomputer/contracts";
import {
  MemoryWorkspaceStore,
  type OrganizationWorkspacePolicyVersionRecord,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import {
  organizationWorkspacePolicyCatalog,
  type ProtectedWorkspacePolicyAdministrationBoundary,
} from "../apps/control-api/src/protected-workspace-policy.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

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
  begin: async () => ({ location: "https://login.invalid", cookie: "state=opaque" }),
  complete: async () => { throw new Error("not used"); },
  authenticate: async (cookie: string | undefined) => cookie === "lemmacomputer_session=valid" ? authenticated : null,
  logout: async () => "",
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

const appFor = (actor: SessionPrincipal, calls: Array<{ method: string; input: unknown }>) => {
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
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    {},
    {
      authentication: authentication(actor),
      protectedWorkspacePolicy,
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
      "claude-desktop", "claude-cli", "codex-cli", "hermes-desktop", "hermes-claw",
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
