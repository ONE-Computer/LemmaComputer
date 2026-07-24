import assert from "node:assert/strict";
import test from "node:test";
import { runtimePolicyFor, type EffectivePolicy } from "@onecomputer/workspace-store";

test("effective policy projects to the one approved workspace runtime", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-1",
    policyBundleId: "bundle-1",
    policyVersionId: "version-1",
    version: 1,
    documentHash: "c".repeat(64),
    assignedBy: "admin-1",
    assignedAt: "2026-07-20T00:00:00.000Z",
    agentId: "agent-1",
    workspaceIdentityId: "workspace-identity-1",
    workspaceId: null,
    vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "kasm-persistent-standard",
      agentProfile: "onecomputer-default-agent",
      modelAliases: ["onecomputer-assistant"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { onecomputer_ms365: { tools: ["list-mail-folders", "list-calendars", "list-drives", "search-onedrive-files", "get-drive-item", "delete-onedrive-file"] } } },
    },
  };
  assert.deepEqual(runtimePolicyFor(effective), {
    schemaVersion: 1,
    policyVersionId: "version-1",
    policyVersion: 1,
    policyHash: "c".repeat(64),
    workspaceProfile: "kasm-persistent-standard",
    agentId: "agent-1",
    agentProfile: "onecomputer-default-agent",
    applications: ["firefox"],
    networkProfile: "controlled-egress-v1",
    clipboard: {
      enabled: true,
      localToWorkspace: true,
      workspaceToLocal: true,
      maxBytes: 65_536,
    },
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-folders", "list-calendars", "list-drives", "search-onedrive-files", "get-drive-item", "delete-onedrive-file"],
    toolPolicies: {
      "list-mail-folders": "allow",
      "list-calendars": "allow",
      "list-drives": "allow",
      "search-onedrive-files": "allow",
      "get-drive-item": "allow",
      "delete-onedrive-file": "approval_required",
    },
  });
});

test("an assigned sandbox selection can narrow a multi-model policy but cannot broaden it", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-2", policyBundleId: "bundle-1", policyVersionId: "version-2", version: 2,
    documentHash: "d".repeat(64), assignedBy: "admin-1", assignedAt: "2026-07-21T00:00:00.000Z",
    agentId: "agent-1", workspaceIdentityId: "workspace-identity-1", workspaceId: null, vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "claude-desktop-standard-v1",
      workspaceProfiles: ["claude-desktop-standard-v1"],
      agentProfile: "claude-desktop-managed-v1",
      modelAliases: ["onecomputer-claude", "onecomputer-openai", "onecomputer-glm"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { onecomputer_ms365: { tools: ["list-mail-folders"] } } },
    },
  };
  const selected = runtimePolicyFor(effective, "onecomputer-glm", "claude-desktop-standard-v1");
  assert.equal(selected.modelAlias, "onecomputer-glm");
  assert.equal(selected.workspaceProfile, "claude-desktop-standard-v1");
  assert.throws(() => runtimePolicyFor(effective, "unassigned-model", "claude-desktop-standard-v1"), /not assigned/);
});

test("policy-selected Claude and Hermes clients receive distinct governed identities", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-3", policyBundleId: "bundle-1", policyVersionId: "version-3", version: 3,
    documentHash: "e".repeat(64), assignedBy: "admin-1", assignedAt: "2026-07-23T00:00:00.000Z",
    agentId: "agent-1", workspaceIdentityId: "workspace-identity-1", workspaceId: null, vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "claude-desktop-standard-v1",
      workspaceProfiles: ["claude-desktop-standard-v1"],
      agentProfile: "claude-desktop-managed-v1",
      agents: ["claude-desktop", "hermes-claw"],
      modelAliases: ["onecomputer-claude"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { onecomputer_ms365: { tools: ["list-mail-folders"] } } },
    },
  };

  const both = runtimePolicyFor(effective);
  assert.deepEqual(both.agents?.map((agent) => [agent.catalogId, agent.agentId, agent.agentProfile]), [
    ["claude-desktop", "agent-1:claude-desktop", "claude-desktop-managed-v1"],
    ["hermes-claw", "agent-1:hermes-claw", "hermes-claw-managed-v1"],
  ]);
  assert.equal(new Set(both.agents?.map((agent) => agent.agentId)).size, 2);

  const hermesOnly = runtimePolicyFor(effective, undefined, undefined, ["hermes-claw"]);
  assert.equal(hermesOnly.agentId, "agent-1:hermes-claw");
  assert.equal(hermesOnly.agentProfile, "hermes-claw-managed-v1");
  assert.deepEqual(hermesOnly.agents?.map((agent) => agent.catalogId), ["hermes-claw"]);
  assert.throws(
    () => runtimePolicyFor(effective, undefined, undefined, ["hermes-claw", "hermes-claw"]),
    /unique workspace agent/,
  );
});

test("optional Chrome, Claude CLI, and Hermes Agent Desktop stay off until selected", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-4", policyBundleId: "bundle-1", policyVersionId: "version-4", version: 4,
    documentHash: "f".repeat(64), assignedBy: "admin-1", assignedAt: "2026-07-24T00:00:00.000Z",
    agentId: "agent-1", workspaceIdentityId: "workspace-identity-1", workspaceId: null, vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "claude-desktop-standard-v1",
      workspaceProfiles: ["claude-desktop-standard-v1"],
      agentProfile: "claude-desktop-managed-v1",
      agents: ["claude-desktop", "claude-cli", "hermes-desktop", "hermes-claw"],
      defaultAgents: ["claude-desktop", "hermes-claw"],
      applications: ["firefox", "google-chrome"],
      defaultApplications: ["firefox"],
      modelAliases: ["onecomputer-claude"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { onecomputer_ms365: { tools: ["list-mail-folders"] } } },
    },
  };

  const defaults = runtimePolicyFor(effective);
  assert.deepEqual(defaults.applications, ["firefox"]);
  assert.deepEqual(defaults.agents?.map((agent) => agent.catalogId), ["claude-desktop", "hermes-claw"]);

  const selected = runtimePolicyFor(
    effective,
    undefined,
    undefined,
    ["claude-desktop", "claude-cli", "hermes-desktop", "hermes-claw"],
    ["firefox", "google-chrome"],
  );
  assert.deepEqual(selected.applications, ["firefox", "google-chrome"]);
  assert.deepEqual(selected.agents?.map((agent) => agent.agentProfile), [
    "claude-desktop-managed-v1",
    "claude-cli-managed-v1",
    "hermes-desktop-managed-v1",
    "hermes-claw-managed-v1",
  ]);
  assert.equal(new Set(selected.agents?.map((agent) => agent.agentId)).size, 4);
});
