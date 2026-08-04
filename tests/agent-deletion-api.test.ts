import assert from "node:assert/strict";
import test from "node:test";
import {
  m365ToolCatalog,
  type IdentityContext,
} from "@lemmacomputer/contracts";
import {
  MemoryWorkspaceStore,
  runtimePolicyFor,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import { AgentBridgeAuthority } from "../apps/control-api/src/agent-bridge.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "agent-deletion-proxy-token-at-least-24-characters";
const agentBridgeSecret = "agent-deletion-bridge-secret-at-least-32-characters";
const identity: IdentityContext = {
  tenantId: "acme",
  subjectId: "alex",
  audience: "lemmacomputer-control",
};
const principal: SessionPrincipal = {
  userId: identity.subjectId,
  tenantId: identity.tenantId,
  email: "alex@acme.example",
  displayName: "Alex",
  tenantDisplayName: "Acme",
  roles: ["employee"],
  identity,
};
const effectivePolicy: EffectivePolicy = {
  assignmentId: "assignment-delete",
  policyBundleId: "bundle-delete",
  policyVersionId: "policy-delete",
  version: 1,
  documentHash: "a".repeat(64),
  assignedBy: "administrator",
  assignedAt: new Date().toISOString(),
  agentId: "agent-delete",
  vendorUserId: "vendor-alex",
  document: {
    schemaVersion: 1,
    workspaceProfile: "kasm-persistent-standard",
    workspaceProfiles: ["kasm-persistent-standard"],
    agentProfile: "hermes-claw-managed-v1",
    agents: ["hermes-claw"],
    defaultAgents: ["hermes-claw"],
    applications: ["firefox"],
    defaultApplications: ["firefox"],
    modelAliases: ["lemmacomputer-assistant"],
    networkProfile: "controlled-egress-v1",
    mcp: {
      servers: {
        lemmacomputer_ms365: {
          tools: ["delete-onedrive-file"],
          toolPolicies: {
            "delete-onedrive-file": m365ToolCatalog["delete-onedrive-file"].decision,
          },
        },
      },
    },
  },
};
const identityPolicies = {
  getPrincipal: async (userId: string) => userId === principal.userId ? principal : null,
  getEffectivePolicy: async (userId: string) => userId === principal.userId ? effectivePolicy : null,
} as unknown as IdentityPolicyStore;

test("agent deletion endpoint preserves a human-facing filename without forwarding it as a connector argument", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", "agent-delete-workspace");
  await store.update(workspace.id, { state: "ready" });
  const policy = runtimePolicyFor(effectivePolicy);
  const token = new AgentBridgeAuthority(agentBridgeSecret).issue(identity, workspace.id, policy, {
    workspaceGeneration: workspace.bridgeGrantGeneration,
  });
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: identityPolicies,
    agentBridgeSecret,
  });

  try {
    const created = await app.inject({
      method: "POST",
      url: "/internal/v1/agent/deletions",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        driveId: "drive-1",
        driveItemId: "opaque-item-1",
        resourceName: "Hermes-Production-Readiness-Test.pptx",
        "If-Match": "\"etag-1\"",
        idempotencyKey: "workspace-delete-human-facing-file-001",
      },
    });

    assert.equal(created.statusCode, 201);
    assert.equal(created.json().safeSummary, "Delete Hermes-Production-Readiness-Test.pptx from OneDrive");
    assert.equal(created.json().resourceName, "Hermes-Production-Readiness-Test.pptx");
    assert.deepEqual(
      (await store.getOwnedOperation(identity, created.json().id))?.arguments,
      {
        driveId: "drive-1",
        driveItemId: "opaque-item-1",
        "If-Match": "\"etag-1\"",
        confirm: true,
        excludeResponse: true,
      },
    );
  } finally {
    await app.close();
  }
});
