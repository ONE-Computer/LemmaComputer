import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { IdentityContext } from "@onecomputer/contracts";
import { MemoryWorkspaceStore, type IdentityPolicyStore } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "onevibe-reaper-api-proxy-token-at-least-24-characters";
const identity: IdentityContext = { tenantId: "acme", subjectId: "disabled-user", audience: "onecomputer-control" };

test("ephemeral reaper destroys disabled-user provider but retains task evidence", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, `cowork-ephemeral-${randomUUID()}`, randomUUID());
  const ready = await store.update(workspace.id, { state: "ready", providerId: "e2b-expired-1" });
  ready.createdAt = new Date(Date.now() - 10_000);
  const task = await store.createOneVibeTask(identity, ready.id);
  assert.ok(task);
  const event = await store.appendOneVibeTaskEvent(identity, {
    workspaceId: ready.id,
    taskId: task.id,
    kind: "system",
    payloadHash: "a".repeat(64),
  });
  assert.ok(event);

  let destroyed = 0;
  let purged = 0;
  const controller: ControllerClient = {
    async create() { throw new Error("not used"); },
    async updateEgressPolicy() { throw new Error("not used"); },
    async status(providerId) { return { providerId, state: "ready", failureCode: null }; },
    async open() { throw new Error("not used"); },
    async destroy(providerId) { assert.equal(providerId, "e2b-expired-1"); destroyed += 1; },
    async purgeWorkspace(workspaceId) { assert.equal(workspaceId, ready.id); purged += 1; },
  };
  const policyStore = {
    listUsers: async (tenantId: string) => tenantId === identity.tenantId ? [{
      userId: identity.subjectId,
      email: "disabled@example.test",
      displayName: "Disabled User",
      status: "disabled" as const,
      roles: [],
      effectivePolicy: null,
    }] : [],
    getEffectivePolicy: async () => null,
  } as unknown as IdentityPolicyStore;
  const app = createControlServer(store, controller, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore,
    ephemeralCoworkReaper: { tenantId: identity.tenantId, intervalMs: 5, ttlMs: 1 },
  });
  try {
    await app.ready();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(destroyed, 1);
    assert.equal(purged, 1);
    const retainedWorkspace = await store.getOwned(identity, ready.id);
    assert.equal(retainedWorkspace?.state, "stopped");
    assert.equal(retainedWorkspace?.failureCode, "EPHEMERAL_CLEANUP_COMPLETE");
    const retainedTask = await store.getOwnedOneVibeTask(identity, ready.id, task.id);
    assert.equal(retainedTask?.id, task.id);
    const events = await store.listOwnedOneVibeTaskEvents(identity, ready.id, task.id);
    assert.equal(events?.length, 1);
  } finally {
    await app.close();
  }
});
