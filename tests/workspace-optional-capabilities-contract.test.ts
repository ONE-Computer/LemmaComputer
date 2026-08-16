import assert from "node:assert/strict";
import test from "node:test";
import {
  protectedPolicySelectionSchema,
  runtimePolicySchema,
  saveSandboxSettingsSchema,
  sandboxConfigurationSchema,
  workspaceManifestSchema,
} from "@lemmacomputer/contracts";

const baseSelection = {
  grantId: "personal",
  profileId: "claude-desktop-standard-v1" as const,
  applicationIds: [],
  agentIds: [],
  modelAlias: null,
  requestedServiceClass: "balanced" as const,
};

test("the workspace configuration contract derives a base workspace from empty selections", () => {
  assert.deepEqual(saveSandboxSettingsSchema.parse(baseSelection), baseSelection);
  assert.deepEqual(sandboxConfigurationSchema.parse({
    schemaVersion: 1,
    profileId: baseSelection.profileId,
    applicationIds: [],
    agentIds: [],
    modelAlias: null,
    egress: null,
  }).agentIds, []);

  assert.throws(() => saveSandboxSettingsSchema.parse({
    ...baseSelection,
    modelAlias: "lemmacomputer-claude",
  }), /model route is required exactly when/i);
  assert.throws(() => saveSandboxSettingsSchema.parse({
    ...baseSelection,
    agentIds: ["claude-cli"],
  }), /model route is required exactly when/i);
  assert.throws(() => saveSandboxSettingsSchema.parse({
    ...baseSelection,
    applicationIds: ["firefox", "firefox"],
  }), /must not contain duplicates/i);
});

test("signed runtime and manifest contracts preserve the absence of AI capabilities", () => {
  const runtime = runtimePolicySchema.parse({
    schemaVersion: 1,
    policyVersionId: "policy-version-base",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    agentId: "legacy-policy-subject",
    agentProfile: "claude-desktop-managed-v1",
    agents: [],
    applications: [],
    networkProfile: "controlled-egress-v1",
    modelAlias: null,
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-folders"],
    toolPolicies: { "list-mail-folders": "allow" },
  });
  assert.equal(runtime.modelAlias, null);

  const manifest = workspaceManifestSchema.parse({
    schemaVersion: 2,
    sandbox: {
      schemaVersion: 1,
      profileId: "claude-desktop-standard-v1",
      executionMode: "managed",
      egressMode: "restricted",
      applicationIds: [],
      agentIds: [],
      modelAlias: null,
      requestedServiceClass: "balanced",
      egress: null,
    },
    channels: [],
  });
  assert.deepEqual(manifest.sandbox.agentIds, []);

  assert.throws(() => workspaceManifestSchema.parse({
    ...manifest,
    channels: [{
      adapter: "telegram",
      credentialRef: "11111111-1111-4111-8111-111111111111",
      credentialVersion: 1,
      allowedSenderIds: ["123"],
      defaultAgentId: "claude-cli",
      allowAgentSwitch: false,
      inboundPolicy: "private-dm-only",
    }],
  }), /must use an AI agent selected/i);
});

test("protected policy selections use the same empty-selection semantics", () => {
  const selection = protectedPolicySelectionSchema.parse({
    workspaceProfile: "claude-desktop-standard-v1",
    agentIds: [],
    applicationIds: [],
    modelAlias: null,
    serviceClass: "balanced",
    reasoningEffort: "disabled",
    egressMode: "restricted",
    connectorIds: [],
  });
  assert.deepEqual(selection.agentIds, []);
  assert.equal(selection.modelAlias, null);
});
