import assert from "node:assert/strict";
import test from "node:test";
import { runtimePolicyFor, withOpenWorkspaceProfile, type EffectivePolicy } from "@lemmacomputer/workspace-store";

test("legacy managed policy upgrades add open access without changing agent selection", () => {
  const legacy = {
    schemaVersion: 1,
    workspaceProfile: "claude-desktop-standard-v1",
    workspaceProfiles: ["claude-desktop-standard-v1"],
    agents: ["hermes-claw"],
    defaultAgents: ["hermes-claw"],
  };
  const upgraded = withOpenWorkspaceProfile(legacy);

  assert.deepEqual(upgraded, {
    ...legacy,
    workspaceProfiles: ["claude-desktop-standard-v1", "disposable-open-v1"],
  });
  assert.deepEqual(legacy.workspaceProfiles, ["claude-desktop-standard-v1"]);
  assert.equal(withOpenWorkspaceProfile(upgraded!), null);
});

test("a user policy projects into an approved workspace runtime", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-1",
    policyBundleId: "bundle-1",
    policyVersionId: "version-1",
    version: 1,
    documentHash: "c".repeat(64),
    assignedBy: "admin-1",
    assignedAt: "2026-07-20T00:00:00.000Z",
    agentId: "agent-1",
    vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "kasm-persistent-standard",
      agentProfile: "lemmacomputer-default-agent",
      modelAliases: ["lemmacomputer-assistant"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { lemmacomputer_ms365: { tools: ["list-mail-folders", "list-calendars", "list-drives", "search-onedrive-files", "get-drive-item", "delete-onedrive-file"] } } },
    },
  };
  assert.deepEqual(runtimePolicyFor(effective), {
    schemaVersion: 1,
    policyVersionId: "version-1",
    policyVersion: 1,
    policyHash: "c".repeat(64),
    workspaceProfile: "kasm-persistent-standard",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "agent-1",
    agentProfile: "lemmacomputer-default-agent",
    applications: ["firefox"],
    networkProfile: "controlled-egress-v1",
    clipboard: {
      enabled: true,
      localToWorkspace: true,
      workspaceToLocal: true,
      maxBytes: 65_536,
    },
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    requestedServiceClass: "auto",
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

test("disposable-open projects explicit open execution and full-web egress without weakening managed mode", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-open", policyBundleId: "bundle-1", policyVersionId: "version-open", version: 5,
    documentHash: "1".repeat(64), assignedBy: "admin-1", assignedAt: "2026-07-26T00:00:00.000Z",
    agentId: "agent-open", vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "claude-desktop-standard-v1",
      workspaceProfiles: ["claude-desktop-standard-v1", "disposable-open-v1"],
      agentProfile: "hermes-claw-managed-v1",
      agents: ["hermes-claw"],
      modelAliases: ["lemmacomputer-openai"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { lemmacomputer_ms365: { tools: ["list-mail-folders"] } } },
    },
  };

  const managed = runtimePolicyFor(effective, undefined, "claude-desktop-standard-v1");
  const open = runtimePolicyFor(effective, undefined, "disposable-open-v1");

  assert.equal(managed.executionMode, "managed");
  assert.equal(managed.egressMode, "restricted");
  assert.equal(managed.egress, undefined);
  assert.equal(open.executionMode, "disposable-open");
  assert.equal(open.egressMode, "full-web");
  assert.equal(open.egress?.mode, "full-web");
  assert.equal(open.egress?.defaultAction, "allow-public-http-https");
  assert.deepEqual(open.egress?.rules, []);
});

test("disposable-open projects attached deny rules as full-web exceptions", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-open-deny", policyBundleId: "bundle-1", policyVersionId: "version-open-deny", version: 6,
    documentHash: "2".repeat(64), assignedBy: "admin-1", assignedAt: "2026-07-26T00:00:00.000Z",
    agentId: "agent-open", vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfiles: ["claude-desktop-standard-v1", "disposable-open-v1"],
      agents: ["hermes-claw"],
      modelAliases: ["lemmacomputer-openai"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { lemmacomputer_ms365: { tools: ["list-mail-folders"] } } },
    },
    egressSecurityGroup: {
      schemaVersion: 1,
      id: "egv_open_exceptions_v1",
      securityGroupId: "esg_open_exceptions",
      tenantId: "acme",
      version: 1,
      name: "Open workspace exceptions",
      description: "Blocks reviewed destinations from open workspaces.",
      defaultAction: "allow-public-http-https",
      rules: [
        {
          id: "approved-updates",
          action: "allow",
          protocol: "https",
          host: "updates.example.com",
          includeSubdomains: false,
          port: 443,
          purpose: "Managed workspace updates",
        },
        {
          id: "blocked-downloads",
          action: "deny",
          protocol: "https",
          host: "downloads.example.com",
          includeSubdomains: true,
          port: 443,
          purpose: "Untrusted downloads",
        },
      ],
      documentHash: "3".repeat(64),
      createdBy: "admin-1",
      createdAt: "2026-07-26T00:00:00.000Z",
    },
  };

  const open = runtimePolicyFor(effective, undefined, "disposable-open-v1");
  assert.equal(open.egress?.mode, "full-web");
  assert.equal(open.egress?.id, "egv_open_exceptions_v1");
  assert.deepEqual(open.egress?.rules.map((rule) => [rule.id, rule.action]), [
    ["blocked-downloads", "deny"],
  ]);
});

test("managed profile narrows an attached full-web security group instead of changing execution mode", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-managed-full-web", policyBundleId: "bundle-1", policyVersionId: "version-managed-full-web", version: 7,
    documentHash: "4".repeat(64), assignedBy: "admin-1", assignedAt: "2026-07-26T00:00:00.000Z",
    agentId: "agent-managed", vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfiles: ["claude-desktop-standard-v1", "disposable-open-v1"],
      agents: ["hermes-claw"],
      modelAliases: ["lemmacomputer-openai"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { lemmacomputer_ms365: { tools: ["list-mail-folders"] } } },
    },
    egressSecurityGroup: {
      schemaVersion: 1,
      id: "egv_managed_full_web_v1",
      securityGroupId: "esg_managed_full_web",
      tenantId: "acme",
      version: 1,
      name: "Default public web",
      description: "Public web with an explicitly approved managed destination.",
      defaultAction: "allow-public-http-https",
      rules: [
        {
          id: "approved-updates",
          action: "allow",
          protocol: "https",
          host: "updates.example.com",
          includeSubdomains: false,
          port: 443,
          purpose: "Managed workspace updates",
        },
        {
          id: "blocked-downloads",
          action: "deny",
          protocol: "https",
          host: "downloads.example.com",
          includeSubdomains: true,
          port: 443,
          purpose: "Untrusted downloads",
        },
      ],
      documentHash: "5".repeat(64),
      createdBy: "admin-1",
      createdAt: "2026-07-26T00:00:00.000Z",
    },
  };

  const managed = runtimePolicyFor(effective, undefined, "claude-desktop-standard-v1");

  assert.equal(managed.executionMode, "managed");
  assert.equal(managed.egressMode, "restricted");
  assert.equal(managed.egress?.mode, "restricted");
  assert.equal(managed.egress?.defaultAction, "deny");
  assert.deepEqual(managed.egress?.rules.map((rule) => [rule.id, rule.action]), [
    ["approved-updates", "allow"],
  ]);
  assert.notEqual(managed.egress?.documentHash, effective.egressSecurityGroup?.documentHash);
});

test("an assigned sandbox selection can narrow a multi-model policy but cannot broaden it", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-2", policyBundleId: "bundle-1", policyVersionId: "version-2", version: 2,
    documentHash: "d".repeat(64), assignedBy: "admin-1", assignedAt: "2026-07-21T00:00:00.000Z",
    agentId: "agent-1", vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "claude-desktop-standard-v1",
      workspaceProfiles: ["claude-desktop-standard-v1"],
      agentProfile: "claude-desktop-managed-v1",
      modelAliases: ["lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-glm"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { lemmacomputer_ms365: { tools: ["list-mail-folders"] } } },
    },
  };
  const selected = runtimePolicyFor(effective, "lemmacomputer-glm", "claude-desktop-standard-v1");
  assert.equal(selected.modelAlias, "lemmacomputer-glm");
  assert.equal(selected.workspaceProfile, "claude-desktop-standard-v1");
  assert.throws(() => runtimePolicyFor(effective, "unassigned-model", "claude-desktop-standard-v1"), /not assigned/);
  assert.throws(() => runtimePolicyFor(effective, "lemmacomputer-auto", "claude-desktop-standard-v1"), /not assigned/);
  const governed = runtimePolicyFor(
    effective,
    "lemmacomputer-auto",
    "claude-desktop-standard-v1",
    undefined,
    undefined,
    undefined,
    ["lemmacomputer-auto"],
  );
  assert.equal(governed.modelAlias, "lemmacomputer-auto");
});

test("policy-selected Claude and Hermes clients receive distinct governed identities", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-3", policyBundleId: "bundle-1", policyVersionId: "version-3", version: 3,
    documentHash: "e".repeat(64), assignedBy: "admin-1", assignedAt: "2026-07-23T00:00:00.000Z",
    agentId: "agent-1", vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "claude-desktop-standard-v1",
      workspaceProfiles: ["claude-desktop-standard-v1"],
      agentProfile: "claude-desktop-managed-v1",
      agents: ["claude-desktop", "hermes-claw"],
      modelAliases: ["lemmacomputer-claude"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { lemmacomputer_ms365: { tools: ["list-mail-folders"] } } },
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

test("Codex CLI remains schema-compatible but cannot be selected before qualification", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-codex", policyBundleId: "bundle-1", policyVersionId: "version-codex", version: 1,
    documentHash: "9".repeat(64), assignedBy: "admin-1", assignedAt: "2026-08-15T00:00:00.000Z",
    agentId: "agent-1", vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "claude-desktop-standard-v1",
      workspaceProfiles: ["claude-desktop-standard-v1"],
      agents: ["claude-cli", "codex-cli"],
      defaultAgents: ["codex-cli"],
      modelAliases: ["lemmacomputer-claude"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { lemmacomputer_ms365: { tools: ["list-mail-folders"] } } },
    },
  };

  assert.deepEqual(runtimePolicyFor(effective).agents?.map((agent) => agent.catalogId), ["claude-cli"]);
  assert.throws(
    () => runtimePolicyFor(effective, undefined, undefined, ["codex-cli"]),
    /not assigned/,
  );
});

test("optional Chrome, Claude CLI, and Hermes Agent Desktop stay off until selected", () => {
  const effective: EffectivePolicy = {
    assignmentId: "assignment-4", policyBundleId: "bundle-1", policyVersionId: "version-4", version: 4,
    documentHash: "f".repeat(64), assignedBy: "admin-1", assignedAt: "2026-07-24T00:00:00.000Z",
    agentId: "agent-1", vendorUserId: "oc-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "claude-desktop-standard-v1",
      workspaceProfiles: ["claude-desktop-standard-v1"],
      agentProfile: "claude-desktop-managed-v1",
      agents: ["claude-desktop", "claude-cli", "hermes-desktop", "hermes-claw"],
      defaultAgents: ["claude-desktop", "hermes-claw"],
      applications: ["firefox", "google-chrome"],
      defaultApplications: ["firefox"],
      modelAliases: ["lemmacomputer-claude"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { lemmacomputer_ms365: { tools: ["list-mail-folders"] } } },
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
