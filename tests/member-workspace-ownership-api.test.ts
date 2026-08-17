import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryWorkspaceStore,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "member-workspace-proxy-token-at-least-24-characters";
const member: SessionPrincipal = {
  userId: "member-alex",
  tenantId: "acme",
  organizationId: "acme",
  membershipId: "85beab7d-a927-4c21-a80c-f5bb638e38e0",
  membershipStatus: "active",
  role: "member",
  permissions: [],
  email: "alex@acme.test",
  displayName: "Alex Member",
  tenantDisplayName: "Acme",
  roles: ["member"],
  identity: { tenantId: "acme", subjectId: "member-alex", audience: "lemmacomputer-control" },
};
const otherMember: SessionPrincipal = {
  ...member,
  userId: "member-blair",
  email: "blair@acme.test",
  identity: { ...member.identity, subjectId: "member-blair" },
};
const foreignMember: SessionPrincipal = {
  ...member,
  userId: "member-casey",
  tenantId: "other",
  organizationId: "other",
  membershipId: "905d31b1-28e9-4f98-97bb-45d34e272424",
  email: "casey@other.test",
  tenantDisplayName: "Other",
  identity: { tenantId: "other", subjectId: "member-casey", audience: "lemmacomputer-control" },
};
const headers = {
  "x-lemmacomputer-proxy-token": proxyToken,
  cookie: "lemmacomputer_session=valid",
  "idempotency-key": "member-workspace-create-0001",
};
const authentication = (actor: SessionPrincipal) => ({
  resolve: async () => ({ status: "authorized" as const, principal: actor }),
});
const controller: ControllerClient = {
  create: async ({ workspaceId }) => ({ providerId: `sandbox-${workspaceId}`, state: "ready", failureCode: null }),
  updateEgressPolicy: async () => undefined,
  status: async (_workspaceId, providerId) => ({ providerId, state: "ready", failureCode: null }),
  open: async () => ({ launchUrl: "http://gateway/workspace", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  destroyWorkspace: async () => undefined,
  purgeWorkspace: async (workspaceId, accessGeneration) => ({ nodeId: "test-node", workspaceId, maximumPurgedGeneration: accessGeneration, completedAt: new Date().toISOString(), verified: true }),
};

const appFor = (actor: SessionPrincipal, store: MemoryWorkspaceStore) => createControlServer(
  store,
  controller,
  proxyToken,
  undefined,
  undefined,
  {},
  { customerProductAuthentication: authentication(actor), agentBridgeSecret: "member-workspace-agent-bridge-secret-at-least-32-characters" },
);

test("a member-created workspace is bound to that member inside the organization", async () => {
  const store = new MemoryWorkspaceStore();
  const app = appFor(member, store);
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers,
      payload: { grantId: "personal" },
    });
    assert.equal(created.statusCode, 201);
    const workspaceId = created.json().id as string;
    assert.ok(await store.getOwned(member.identity, workspaceId));
    assert.equal(await store.getOwned(otherMember.identity, workspaceId), null,
      "another member in the same organization cannot acquire ownership by workspace ID");
  } finally {
    await app.close();
  }

  const otherApp = appFor(otherMember, store);
  try {
    const listed = await otherApp.inject({ method: "GET", url: "/v1/workspaces", headers });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().workspaces, []);
  } finally {
    await otherApp.close();
  }
});

const safeError = (response: { statusCode: number; json(): Record<string, unknown> }) => {
  const document = response.json();
  const error = document.error as Record<string, unknown>;
  return {
    statusCode: response.statusCode,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
};

test("a member owns the complete workspace lifecycle while foreign identifiers remain indistinguishable", async () => {
  const store = new MemoryWorkspaceStore();
  const ownerApp = appFor(member, store);
  const siblingApp = appFor(otherMember, store);
  const foreignApp = appFor(foreignMember, store);
  try {
    const created = await ownerApp.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers,
      payload: { grantId: "personal" },
    });
    assert.equal(created.statusCode, 201);
    const workspaceId = created.json().id as string;
    const nonexistentId = "00000000-0000-4000-8000-000000000000";

    for (const app of [siblingApp, foreignApp]) {
      const listed = await app.inject({ method: "GET", url: "/v1/workspaces", headers });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.json().workspaces, []);

      for (const operation of [
        { method: "GET" as const, suffix: "/deletion-impact" },
        { method: "POST" as const, suffix: "/open" },
        { method: "POST" as const, suffix: "/restart" },
        { method: "POST" as const, suffix: "/stop" },
        { method: "DELETE" as const, suffix: "" },
      ]) {
        const foreign = await app.inject({
          method: operation.method,
          url: `/v1/workspaces/${workspaceId}${operation.suffix}`,
          headers,
        });
        const missing = await app.inject({
          method: operation.method,
          url: `/v1/workspaces/${nonexistentId}${operation.suffix}`,
          headers,
        });
        assert.deepEqual(
          safeError(foreign),
          safeError(missing),
          `${operation.method} ${operation.suffix || "/"} must not disclose foreign workspace existence`,
        );
        assert.equal(foreign.statusCode, 404);
        assert.equal(foreign.json().error.code, "WORKSPACE_NOT_FOUND");
      }
    }

    const opened = await ownerApp.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/open`, headers });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().workspace.state, "open");

    const restarted = await ownerApp.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/restart`, headers });
    assert.equal(restarted.statusCode, 200);
    assert.equal(restarted.json().state, "ready");

    const stopped = await ownerApp.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/stop`, headers });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.json().state, "stopped");

    const resumed = await ownerApp.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/restart`, headers });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().state, "ready");

    const impact = await ownerApp.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/deletion-impact`, headers });
    assert.equal(impact.statusCode, 200);
    assert.deepEqual(impact.json(), {
      conversations: 0,
      artifacts: 0,
      protectedConversations: 0,
      protectedArtifacts: 0,
    });

    const deleted = await ownerApp.inject({
      method: "DELETE",
      url: `/v1/workspaces/${workspaceId}`,
      headers,
      payload: { contentDisposition: "delete" },
    });
    assert.equal(deleted.statusCode, 204);
    assert.equal(await store.getOwned(member.identity, workspaceId), null);

    const recreated = await ownerApp.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...headers, "idempotency-key": "member-workspace-recreate-0001" },
      payload: { grantId: "personal" },
    });
    assert.equal(recreated.statusCode, 201);
    assert.equal(recreated.json().id, workspaceId);
  } finally {
    await Promise.all([ownerApp.close(), siblingApp.close(), foreignApp.close()]);
  }
});
