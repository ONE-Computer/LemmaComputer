import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryWorkspaceStore,
  resolveEffectiveOrganizationPermissions,
  type AdminUserSummary,
  type IdentityPolicyStore,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "member-workspace-admin-proxy-token-at-least-24-characters";
const headers = {
  "x-lemmacomputer-proxy-token": proxyToken,
  cookie: "lemmacomputer_session=valid",
};
const targetIdentity = { tenantId: "acme", subjectId: "target-user", audience: "lemmacomputer-control" } as const;
const assignedPolicy = {
  assignmentId: "assignment-target",
  policyBundleId: "bundle-target",
  policyVersionId: "version-target",
  version: 7,
  documentHash: "a".repeat(64),
  assignedBy: "policy-admin",
  assignedAt: "2026-08-12T00:00:00.000Z",
  agentId: "agent-target",
  vendorUserId: "target-user",
  document: { workspaceProfiles: ["persistent-office-v1"] },
};

const actor = (overrides: Partial<SessionPrincipal> = {}): SessionPrincipal => ({
  userId: "workspace-admin",
  tenantId: "acme",
  email: "workspace-admin@acme.test",
  displayName: "Workspace Admin",
  tenantDisplayName: "Acme",
  roles: ["administrator"],
  permissions: ["workspace.manage"],
  identity: { tenantId: "acme", subjectId: "workspace-admin", audience: "lemmacomputer-control" },
  ...overrides,
});

const users: AdminUserSummary[] = [
  {
    userId: "target-user",
    email: "target@acme.test",
    displayName: "Target User",
    status: "active",
    membershipStatus: "active",
    roles: ["member"],
    effectivePolicy: assignedPolicy,
  },
  {
    userId: "empty-user",
    email: "empty@acme.test",
    displayName: "Empty User",
    status: "active",
    membershipStatus: "active",
    roles: ["member"],
    effectivePolicy: null,
  },
];

const appFor = (principal: SessionPrincipal, store: MemoryWorkspaceStore) => createControlServer(
  store,
  {} as ControllerClient,
  proxyToken,
  undefined,
  undefined,
  {},
  {
    authentication: {
      begin: async () => ({ location: "https://login.example.test", cookie: "state=opaque" }),
      complete: async () => { throw new Error("unused"); },
      authenticate: async () => principal,
      logout: async () => "",
    },
    identityPolicyStore: { listUsers: async (tenantId: string) => tenantId === "acme" ? users : [] } as unknown as IdentityPolicyStore,
    agentBridgeSecret: "member-workspace-admin-agent-bridge-secret-at-least-32-characters",
  },
);

test("organization workspace managers receive a content-free member-first inventory", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(targetIdentity, "personal", "member-workspace-inventory-0001");
  await store.update(workspace.id, { state: "ready" });
  const app = appFor(actor(), store);
  try {
    const response = await app.inject({ method: "GET", url: "/v1/admin/member-workspaces", headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const body = response.json();
    assert.equal(body.members.length, 2);
    assert.equal(body.members[0].workspaceCount, 1);
    assert.deepEqual(body.members[0].workspaces[0], {
      id: workspace.id,
      name: "Personal workspace",
      state: "ready",
      health: { status: "healthy", reasonCode: null },
      profile: { id: "persistent-office-v1", executionMode: "managed" },
      policyAssignment: { version: 7, hash: "a".repeat(64) },
      lastActivityAt: body.members[0].workspaces[0].lastActivityAt,
      lastTransitionAt: body.members[0].workspaces[0].lastTransitionAt,
      createdAt: body.members[0].workspaces[0].createdAt,
    });
    assert.equal(body.members[1].workspaceCount, 0);
    assert.deepEqual(body.members[1].workspaces, []);
    for (const forbidden of ["launch", "launchUrl", "providerId", "grantId", "egress", "files", "chats", "secrets"]) {
      assert.equal(JSON.stringify(body).includes(`\"${forbidden}\"`), false, `inventory must not disclose ${forbidden}`);
    }
  } finally {
    await app.close();
  }
});

test("an exact workspace manager sees only the authorized workspace and its member", async () => {
  const store = new MemoryWorkspaceStore();
  const allowed = await store.createOrGet(targetIdentity, "personal", "member-workspace-inventory-allowed");
  const hidden = await store.createOrGet(targetIdentity, "finance", "member-workspace-inventory-hidden");
  const scoped = actor({
    roles: ["member"],
    permissions: [],
    effectiveAuthorization: resolveEffectiveOrganizationPermissions({
      catalogVersion: 3,
      builtInRoles: ["member"],
      customRoleVersions: [{
        roleId: "exact-workspace-manager",
        version: 1,
        catalogVersion: 3,
        status: "active",
        grants: [{ permission: "workspace.manage", scope: { type: "workspace", resourceId: allowed.id } }],
      }],
    }),
  });
  const app = appFor(scoped, store);
  try {
    const response = await app.inject({ method: "GET", url: "/v1/admin/member-workspaces", headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().members.map((member: { userId: string }) => member.userId), ["target-user"]);
    assert.deepEqual(response.json().members[0].workspaces.map((workspace: { id: string }) => workspace.id), [allowed.id]);
    assert.equal(JSON.stringify(response.json()).includes(hidden.id), false);
    assert.equal(JSON.stringify(response.json()).includes("empty@acme.test"), false);
  } finally {
    await app.close();
  }
});

test("member administration alone does not disclose workspace inventory", async () => {
  const store = new MemoryWorkspaceStore();
  await store.createOrGet(targetIdentity, "personal", "member-workspace-inventory-hidden-from-member-admin");
  const memberManager = actor({
    permissions: [],
    roles: ["member"],
    role: "member",
    effectiveAuthorization: resolveEffectiveOrganizationPermissions({
      catalogVersion: 3,
      builtInRoles: ["member"],
      customRoleVersions: [{
        roleId: "member-manager",
        version: 1,
        catalogVersion: 3,
        status: "active",
        grants: [{ permission: "organization.manage_members", scope: { type: "organization" } }],
      }],
    }),
  });
  const app = appFor(memberManager, store);
  try {
    const dedicated = await app.inject({ method: "GET", url: "/v1/admin/member-workspaces", headers });
    assert.equal(dedicated.statusCode, 403);
    const existing = await app.inject({ method: "GET", url: "/v1/admin/users", headers });
    assert.equal(existing.statusCode, 200);
    assert.deepEqual(existing.json().users.flatMap((user: { workspaces: unknown[] }) => user.workspaces), []);
  } finally {
    await app.close();
  }
});
