import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { MemoryWorkspaceStore, type EffectivePolicy, type IdentityPolicyStore, type SessionPrincipal } from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const identity = { tenantId: "recovery-tenant", subjectId: "owner", audience: "lemmacomputer-control" } as const;
const principal: SessionPrincipal = {
  userId: "owner", tenantId: identity.tenantId, email: "owner@example.test", displayName: "Owner",
  tenantDisplayName: "Recovery", roles: ["member"], permissions: ["workspace.use"], identity,
};
const effective: EffectivePolicy = {
  assignmentId: "assignment", policyBundleId: "bundle", policyVersionId: "version", version: 1,
  documentHash: "a".repeat(64), assignedBy: "admin", assignedAt: new Date().toISOString(), agentId: "agent-owner", vendorUserId: "owner",
  document: { schemaVersion: 1, workspaceProfile: "kasm-persistent-standard", workspaceProfiles: ["kasm-persistent-standard"],
    applications: ["firefox"], defaultApplications: ["firefox"], agentProfile: "hermes-claw-managed-v1", agents: ["hermes-claw"], defaultAgents: ["hermes-claw"], modelAliases: ["lemmacomputer-assistant"],
    networkProfile: "controlled-egress-v1", mcp: { servers: { lemmacomputer_fixture: { tools: ["search_files"], toolPolicies: { search_files: "allow" } } } } },
};

for (const scenario of ["allowed", "disabled", "foreign", "permission removed", "no policy"] as const) {
  test(`background recovery reauthorizes owner and policy without a browser session: ${scenario}`, async () => {
    const store = new MemoryWorkspaceStore();
    const created = await store.createOrGet(identity, "personal", "host-recovery");
    await store.update(created.id, { state: "ready", providerId: "old-provider" });
    let creates = 0;
    let resolved = false;
    const identityPolicyStore = {
      getPrincipal: async () => {
        resolved = true;
        if (scenario === "disabled") return null;
        if (scenario === "foreign") return { ...principal, tenantId: "foreign" };
        if (scenario === "permission removed") return { ...principal, roles: [], permissions: [] };
        return principal;
      },
      getEffectivePolicy: async () => scenario === "no policy" ? null : effective,
    } as unknown as IdentityPolicyStore;
    const controller = {
      status: async () => ({ providerId: "old-provider", state: "failed", failureCode: "WORKSPACE_HEALTHCHECK_FAILED" }),
      destroyWorkspace: async () => undefined,
      create: async () => { creates++; return { providerId: "new-provider", state: "ready", failureCode: null }; },
    } as unknown as ControllerClient;
    const app = createControlServer(store, controller, "recovery-proxy-token-at-least-24-characters", undefined, undefined, {}, {
      identityPolicyStore, workspaceRecovery: true, testIdentityMode: true,
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      for (let turn = 0; turn < 10; turn++) await setImmediate();
      assert.equal(resolved, true);
      assert.equal(creates, scenario === "allowed" ? 1 : 0);
      if (scenario === "allowed") assert.equal((await store.getOwned(identity, created.id))?.state, "ready");
    } finally { await app.close(); }
  });
}
