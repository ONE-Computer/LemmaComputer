import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext } from "@lemmacomputer/contracts";
import {
  MemoryWorkspaceStore,
  type IdentityPolicyStore,
  type MemberWorkspacePolicyAssignment,
  type OrganizationWorkspacePolicyVersionRecord,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import type { ProtectedWorkspacePolicyAdministrationBoundary } from "../apps/control-api/src/protected-workspace-policy.js";
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
const assignmentVersion: MemberWorkspacePolicyAssignment = {
  id: "22222222-2222-4222-8222-222222222222",
  tenantId,
  subjectId: "member",
  assignmentVersion: 1,
  previousAssignmentId: null,
  state: "selected",
  protectedTemplateVersionId: "pbtv_office_worker_claude_1",
  organizationPolicyVersionId: organizationVersion.policyVersionId,
  selection: {
    workspaceProfile: "kasm-persistent-standard",
    agentIds: ["claude-cli"],
    applicationIds: ["firefox", "google-chrome"],
    modelAlias: "lemmacomputer-claude",
    serviceClass: "balanced",
    reasoningEffort: "medium",
    egressMode: "restricted",
    connectorIds: ["microsoft-365"],
  },
  selectionHash: "b".repeat(64),
  assignedBy: "administrator",
  createdAt: new Date("2026-08-12T06:01:00.000Z"),
};

const overview = {
  baseline: {
    immutable: true as const,
    editableByOrganization: false as const,
    authority: "lemmacomputer_product_release" as const,
    templateId: "pbt_office_worker_claude",
    templateVersionId: "pbtv_office_worker_claude_1",
    version: 1,
    supersedesTemplateVersionId: null,
    documentHash: "c".repeat(64),
    envelopeDigest: "d".repeat(64),
    keyId: "prk_phase_0_5_20260812",
    release: {
      releaseId: "0.5-policy-foundation-1",
      sourceCommit: "e".repeat(40),
      publishedAt: "2026-08-12T05:00:00.000Z",
    },
    constraints: {
      workspaceProfiles: { allow: ["kasm-persistent-standard" as const], deny: [] },
      agents: { allow: ["claude-cli" as const], deny: [] },
      applications: { allow: ["firefox" as const, "google-chrome" as const], deny: [] },
      modelAliases: { allow: ["lemmacomputer-claude" as const], deny: [] },
      serviceClasses: { allow: ["balanced" as const], deny: [] },
      maximumReasoningEffort: "medium" as const,
      maximumEgressMode: "restricted" as const,
      clipboard: { localToWorkspace: true, workspaceToLocal: true, maxBytes: 32_768 },
      connectors: { allow: ["microsoft-365"], deny: [], toolPolicies: { "microsoft-365": { "send-mail": "approval_required" as const } } },
      capabilities: { allow: ["ai-assistant" as const], deny: [] },
    },
    installedAt: "2026-08-12T05:00:01.000Z",
  },
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
    assignMember: async (input) => {
      calls.push({ method: "assignMember", input });
      return assignmentVersion;
    },
    listMemberAssignmentVersions: async (inputTenantId, subjectId) => {
      calls.push({ method: "listMemberAssignmentVersions", input: { tenantId: inputTenantId, subjectId } });
      return [assignmentVersion];
    },
  };
  const identityPolicyStore = {
    listUsers: async (inputTenantId: string) => inputTenantId === tenantId ? [{
      userId: "member",
      email: "member@test.invalid",
      displayName: "Member",
      status: "active" as const,
      roles: ["employee" as const],
      effectivePolicy: null,
    }] : [],
  } as unknown as IdentityPolicyStore;
  return createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    {},
    {
      authentication: authentication(actor),
      identityPolicyStore,
      protectedWorkspacePolicy,
      agentBridgeSecret: "protected-policy-api-agent-bridge-secret-at-least-32-characters",
    },
  );
};

test("protected policy administration exposes immutable product provenance and append-only versions", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const app = appFor(principal("administrator"), calls);
  const headers = { cookie: "lemmacomputer_session=valid", "x-lemmacomputer-proxy-token": proxyToken };
  try {
    const baseline = await app.inject({ method: "GET", url: "/v1/admin/protected-workspace-policy", headers });
    assert.equal(baseline.statusCode, 200);
    assert.deepEqual(baseline.json().baseline, overview.baseline);
    assert.equal(baseline.json().baseline.immutable, true);
    assert.equal(baseline.json().baseline.editableByOrganization, false);

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

    const createdAssignment = await app.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/members/member/assignment-versions",
      headers,
      payload: { selection: assignmentVersion.selection },
    });
    assert.equal(createdAssignment.statusCode, 201);
    assert.equal(createdAssignment.json().version.subjectId, "member");

    const assignmentHistory = await app.inject({
      method: "GET",
      url: "/v1/admin/protected-workspace-policy/members/member/assignment-versions",
      headers,
    });
    assert.equal(assignmentHistory.statusCode, 200);
    assert.equal(assignmentHistory.json().versions.length, 1);
    assert.deepEqual(calls, [
      { method: "overview", input: tenantId },
      { method: "createOrganizationPolicyVersion", input: {
        tenantId,
        constraints: { agents: { allow: ["claude-cli"], deny: [] } },
        revisionNote: "Claude CLI only",
        createdBy: "administrator",
      } },
      { method: "listOrganizationPolicyVersions", input: tenantId },
      { method: "assignMember", input: {
        tenantId,
        subjectId: "member",
        selection: assignmentVersion.selection,
        assignedBy: "administrator",
      } },
      { method: "listMemberAssignmentVersions", input: { tenantId, subjectId: "member" } },
    ]);
  } finally {
    await app.close();
  }
});

test("member roles and foreign or unknown targets cannot reach protected policy administration", async () => {
  const memberCalls: Array<{ method: string; input: unknown }> = [];
  const memberApp = appFor(principal("employee"), memberCalls);
  const adminCalls: Array<{ method: string; input: unknown }> = [];
  const adminApp = appFor(principal("administrator"), adminCalls);
  const headers = { cookie: "lemmacomputer_session=valid", "x-lemmacomputer-proxy-token": proxyToken };
  try {
    const denied = await memberApp.inject({ method: "GET", url: "/v1/admin/protected-workspace-policy", headers });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(memberCalls, []);

    const missing = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/members/other-tenant-user/assignment-versions",
      headers,
      payload: { selection: assignmentVersion.selection },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "USER_NOT_FOUND");
    assert.deepEqual(adminCalls, []);

    const malformed = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/protected-workspace-policy/organization-versions",
      headers,
      payload: { constraints: { agents: { allow: ["hermes-claw"], deny: [] }, unknown: true }, revisionNote: "Unsafe expansion" },
    });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(adminCalls, []);
  } finally {
    await memberApp.close();
    await adminApp.close();
  }
});
