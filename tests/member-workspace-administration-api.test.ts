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
  document: {
    schemaVersion: 1,
    workspaceProfile: "kasm-persistent-standard",
    workspaceProfiles: ["kasm-persistent-standard"],
    applications: ["firefox"],
    agents: ["claude-desktop"],
    defaultAgents: ["claude-desktop"],
    modelAliases: ["lemmacomputer-claude"],
    networkProfile: "controlled-egress-v1",
    mcp: { servers: { lemmacomputer_ms365: { tools: ["list-mail-folders"], toolPolicies: { "list-mail-folders": "allow" } } } },
  },
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

const appFor = (
  principal: SessionPrincipal,
  store: MemoryWorkspaceStore,
  controller: ControllerClient = {} as ControllerClient,
  agentInstanceStore?: { endActiveForWorkspace(input: Record<string, unknown>): Promise<number> },
) => createControlServer(
  store,
  controller,
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
    ...(agentInstanceStore ? { agentInstanceStore: agentInstanceStore as never } : {}),
    agentBridgeSecret: "member-workspace-admin-agent-bridge-secret-at-least-32-characters",
  },
);

test("organization workspace managers receive a content-free member-first inventory", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(targetIdentity, "workspace-demo", "member-workspace-inventory-0001");
  await store.update(workspace.id, { state: "ready" });
  Object.assign(store, {
    getSandboxSettings: async (identity: typeof targetIdentity, grantId: string) => (
      identity.tenantId === targetIdentity.tenantId
        && identity.subjectId === targetIdentity.subjectId
        && grantId === workspace.grantId
        ? {
            tenantId: identity.tenantId,
            subjectId: identity.subjectId,
            grantId,
            profileId: "disposable-open-v1" as const,
            applicationIds: ["firefox" as const],
            modelAlias: "lemmacomputer-claude" as const,
            requestedServiceClass: "balanced" as const,
            agentIds: ["claude-desktop" as const],
            updatedAt: new Date("2026-08-14T00:00:00.000Z"),
          }
        : null
    ),
  });
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
      name: "Workspace Demo",
      state: "ready",
      health: { status: "healthy", reasonCode: null },
      profile: { id: "disposable-open-v1", executionMode: "disposable-open" },
      networkAccess: { mode: "full-web", securityGroup: null },
      policyAssignment: { authority: "runtime_policy", version: 7, hash: "a".repeat(64) },
      policyRuntime: { state: "action_required", reasonCode: "WORKSPACE_POLICY_SELECTION_REQUIRED" },
      lastActivityAt: null,
      lastTransitionAt: body.members[0].workspaces[0].lastTransitionAt,
      createdAt: body.members[0].workspaces[0].createdAt,
    });
    assert.equal(body.members[1].workspaceCount, 0);
    assert.deepEqual(body.members[1].workspaces, []);
    for (const forbidden of ["launch", "launchUrl", "providerId", "grantId", "egress", "files", "chats", "secrets"]) {
      assert.equal(JSON.stringify(body).includes(`\"${forbidden}\"`), false, `inventory must not disclose ${forbidden}`);
    }
    const settings = await app.inject({
      method: "GET",
      url: `/v1/admin/users/target-user/workspaces/${workspace.id}/sandbox-settings`,
      headers,
    });
    assert.equal(settings.statusCode, 200, settings.body);
    assert.equal(settings.headers["cache-control"], "no-store");
    assert.equal(settings.json().grantId, "workspace-demo");
    assert.equal(settings.json().profileId, "disposable-open-v1");
    assert.equal(settings.json().profile.displayName, "Internet workspace");
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
    const hiddenCommand = await app.inject({
      method: "POST",
      url: `/v1/admin/users/target-user/workspaces/${hidden.id}/runtime/stop`,
      headers: { ...headers, "idempotency-key": "scoped-hidden-workspace-command" },
    });
    assert.equal(hiddenCommand.statusCode, 404);
    assert.equal(hiddenCommand.json().error.code, "WORKSPACE_NOT_FOUND");
    const forgedOwner = await app.inject({
      method: "POST",
      url: `/v1/admin/users/empty-user/workspaces/${allowed.id}/runtime/stop`,
      headers: { ...headers, "idempotency-key": "scoped-forged-owner-command" },
    });
    assert.equal(forgedOwner.statusCode, 404);
    assert.equal(forgedOwner.json().error.code, "WORKSPACE_NOT_FOUND");
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

test("admin lifecycle commands are idempotent, attributed, and terminate only the runtime", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(targetIdentity, "personal", "member-workspace-admin-lifecycle");
  const calls = { creates: 0, destroys: 0, purges: 0 };
  const controller: ControllerClient = {
    create: async ({ workspaceId }) => {
      calls.creates += 1;
      return { providerId: `sandbox-${workspaceId}-${calls.creates}`, state: "ready", failureCode: null };
    },
    updateEgressPolicy: async () => undefined,
    status: async (_workspaceId, providerId) => ({ providerId, state: "ready", failureCode: null }),
    open: async () => ({ launchUrl: "https://workspace.test", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    destroyWorkspace: async () => { calls.destroys += 1; },
    purgeWorkspace: async (workspaceId, accessGeneration) => {
      calls.purges += 1;
      return { nodeId: "test-node", workspaceId, maximumPurgedGeneration: accessGeneration, completedAt: new Date().toISOString(), verified: true };
    },
  };
  const ended: Record<string, unknown>[] = [];
  const app = appFor(actor(), store, controller, {
    endActiveForWorkspace: async (input) => { ended.push(input); return 1; },
  });
  const command = (action: string, key: string) => app.inject({
    method: "POST",
    url: `/v1/admin/users/target-user/workspaces/${workspace.id}/runtime/${action}`,
    headers: { ...headers, "idempotency-key": key },
  });
  try {
    const started = await command("start", "workspace-admin-start-0001");
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().workspace.state, "ready");
    assert.equal(started.json().command.replayed, false);
    const startReplay = await command("start", "workspace-admin-start-0001");
    assert.equal(startReplay.statusCode, 200);
    assert.equal(startReplay.json().command.replayed, true);
    assert.equal(calls.creates, 1, "an exact retry cannot create another runtime");

    const reused = await command("stop", "workspace-admin-start-0001");
    assert.equal(reused.statusCode, 409);
    assert.equal(reused.json().error.code, "IDEMPOTENCY_KEY_REUSED");

    const restarted = await command("restart", "workspace-admin-restart-0001");
    assert.equal(restarted.statusCode, 200);
    assert.equal(restarted.json().workspace.state, "ready");
    assert.equal(calls.creates, 2);
    assert.equal(calls.destroys, 1);

    const stopped = await command("stop", "workspace-admin-stop-0001");
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.json().workspace.state, "stopped");
    assert.equal(calls.destroys, 2);

    const accessBeforeTerminate = (await store.getOwned(targetIdentity, workspace.id))!.accessGeneration;
    const terminated = await command("terminate_runtime", "workspace-admin-terminate-0001");
    assert.equal(terminated.statusCode, 200);
    assert.equal(terminated.json().workspace.state, "stopped");
    assert.equal(calls.purges, 0, "terminate runtime must preserve the persistent home");
    assert.ok((await store.getOwned(targetIdentity, workspace.id))!.accessGeneration > accessBeforeTerminate,
      "terminate runtime revokes every previously issued viewer session");
    assert.deepEqual(ended.map((event) => event.reason), ["workspace_restarted", "workspace_stopped", "workspace_terminated"]);

    const audit = await store.listWorkspaceAdministrationAuditEvents("acme", workspace.id);
    assert.equal(audit.length, 8);
    assert.deepEqual(audit.map((event) => `${event.action}:${event.outcome}`), [
      "start:requested", "start:succeeded",
      "restart:requested", "restart:succeeded",
      "stop:requested", "stop:succeeded",
      "terminate_runtime:requested", "terminate_runtime:succeeded",
    ]);
    assert.ok(audit.every((event) => event.actorUserId === "workspace-admin" && event.ownerSubjectId === "target-user"));
  } finally {
    await app.close();
  }
});
