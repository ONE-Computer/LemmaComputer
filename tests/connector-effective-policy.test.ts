import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveConnectorPolicyApplication,
  resolveEffectiveConnectorPolicy,
  type EffectiveConnectorPolicyInput,
} from "../apps/control-api/src/connector-policy-administration.js";

const hash = (character: string) => character.repeat(64);

const input = (overrides: Partial<EffectiveConnectorPolicyInput> = {}): EffectiveConnectorPolicyInput => ({
  organizationPolicy: null,
  connector: {
    id: "reports",
    name: "Reports",
    enabled: true,
    membersCanManage: true,
    accessPolicyVersion: 3,
    accessPolicyUpdatedAt: "2026-08-12T00:00:00.000Z",
    configuredToolPolicies: { read_report: "allow", export_report: "allow" },
    toolDisplayNames: { read_report: "Read report", export_report: "Export report" },
    reviewedToolDefinitionHashes: { read_report: hash("b"), export_report: hash("c") },
    connectionState: "connected",
    reviewMode: "provider_definition_hash",
  },
  observedTools: [
    { name: "read_report", definitionHash: hash("b") },
    { name: "export_report", definitionHash: hash("c") },
  ],
  ...overrides,
});

test("connector configuration is authoritative when no organization policy exists", () => {
  const resolved = resolveEffectiveConnectorPolicy(input({
    connector: { ...input().connector, id: "unapproved", name: "Unapproved" },
  }));
  assert.equal(resolved.access.configuredEnabled, true);
  assert.equal(resolved.access.effectiveDecision, "allow");
  assert.equal(resolved.access.membersCanManage, true);
  assert.equal(resolved.access.reason, "allowed");
  assert.equal(resolved.access.controllingSource.kind, "connector_policy");
  assert.deepEqual(resolved.sources.map((source) => source.kind), ["connector_policy"]);
  assert.equal(resolved.runtimeProjection.state, "eligible");
});

test("legacy signed baseline input is ignored instead of becoming a hidden authority", () => {
  const resolved = resolveEffectiveConnectorPolicy(input({
    baseline: {
      templateVersionId: "legacy-signed-baseline",
      version: 99,
      documentHash: hash("f"),
      connectors: {
        allow: [],
        deny: ["reports"],
        toolPolicies: { reports: { read_report: "deny" } },
      },
    },
  }));
  assert.equal(resolved.access.effectiveDecision, "allow");
  assert.equal(resolved.tools.find((tool) => tool.name === "read_report")?.effectiveDecision, "allow");
  assert.deepEqual(resolved.sources.map((source) => source.kind), ["connector_policy"]);
});

test("an organization policy may restrict connector access for the whole organization", () => {
  const resolved = resolveEffectiveConnectorPolicy(input({
    organizationPolicy: {
      policyVersionId: "organization-v4",
      version: 4,
      documentHash: hash("d"),
      connectors: {
        allow: ["search"],
        deny: [],
        toolPolicies: {},
      },
    },
  }));
  assert.equal(resolved.access.effectiveDecision, "deny");
  assert.equal(resolved.access.membersCanManage, false);
  assert.equal(resolved.access.reason, "organization_policy_denied");
  assert.equal(resolved.access.controllingSource.kind, "organization_policy");
  assert.equal(resolved.runtimeProjection.state, "excluded");
});

test("the effective tool decision is the strictest organization and connector decision", () => {
  const resolved = resolveEffectiveConnectorPolicy(input({
    organizationPolicy: {
      policyVersionId: "organization-v4",
      version: 4,
      documentHash: hash("d"),
      connectors: {
        deny: [],
        toolPolicies: { reports: { read_report: "approval_required" } },
      },
    },
  }));
  const read = resolved.tools.find((tool) => tool.name === "read_report")!;
  const exportReport = resolved.tools.find((tool) => tool.name === "export_report")!;
  assert.equal(read.configuredDecision, "allow");
  assert.equal(read.effectiveDecision, "approval_required");
  assert.deepEqual(read.sources.map((source) => [source.kind, source.decision]), [
    ["organization_policy", "approval_required"],
    ["connector_policy", "allow"],
  ]);
  assert.equal(exportReport.effectiveDecision, "allow",
    "a missing organization tool decision must not invent a hidden restriction");
  assert.deepEqual(exportReport.sources.map((source) => source.kind), ["connector_policy"]);
});

test("definition drift blocks only the changed tool while a current reviewed tool remains eligible", () => {
  const resolved = resolveEffectiveConnectorPolicy(input({
    observedTools: [
      { name: "read_report", definitionHash: hash("b") },
      { name: "export_report", definitionHash: hash("e") },
    ],
  }));
  assert.deepEqual(resolved.tools.map((tool) => [tool.name, tool.reviewState, tool.effectiveDecision]), [
    ["export_report", "awaiting_review", "deny"],
    ["read_report", "current", "allow"],
  ]);
  assert.equal(resolved.runtimeProjection.state, "partially_available");
});

test("review drift in one connector does not affect an unrelated connector", () => {
  const unrelated = resolveEffectiveConnectorPolicy(input({
    connector: {
      ...input().connector,
      id: "search",
      name: "Search",
      configuredToolPolicies: { search_web: "allow" },
      reviewedToolDefinitionHashes: { search_web: hash("f") },
    },
    observedTools: [{ name: "search_web", definitionHash: hash("f") }],
  }));
  assert.equal(unrelated.access.effectiveDecision, "allow");
  assert.equal(unrelated.tools[0]?.effectiveDecision, "allow");
  assert.equal(unrelated.runtimeProjection.state, "eligible");
});

test("member policy application selects the unique newest version deterministically and reports remediation", () => {
  const application = resolveConnectorPolicyApplication([
    { userId: "z-user", status: "active", policy: { policyVersionId: "v2", version: 2, documentHash: hash("b") } },
    { userId: "a-user", status: "active", policy: { policyVersionId: "v4", version: 4, documentHash: hash("d") } },
    { userId: "unassigned", status: "active", policy: null },
    { userId: "disabled", status: "disabled", policy: { policyVersionId: "v9", version: 9, documentHash: hash("f") } },
  ]);
  assert.equal(application.state, "mixed");
  assert.deepEqual(application.currentVersion, { version: 4, documentHash: hash("d") });
  assert.deepEqual({
    active: application.activeMembers,
    current: application.currentMembers,
    remediation: application.remediationRequiredMembers,
    unassigned: application.unassignedMembers,
  }, { active: 3, current: 1, remediation: 2, unassigned: 1 });
  assert.deepEqual(application.versions.map((version) => [version.version, version.memberCount]), [[4, 1], [2, 1]]);
});

test("conflicting documents at the newest member policy version do not invent a current policy", () => {
  const application = resolveConnectorPolicyApplication([
    { userId: "a-user", status: "active", policy: { policyVersionId: "v4-a", version: 4, documentHash: hash("a") } },
    { userId: "b-user", status: "active", policy: { policyVersionId: "v4-b", version: 4, documentHash: hash("b") } },
  ]);
  assert.equal(application.state, "conflict");
  assert.equal(application.currentVersion, null);
  assert.equal(application.currentMembers, 0);
  assert.equal(application.remediationRequiredMembers, 2);
});

test("workspace coverage compares members with workspaces to the authoritative current version", () => {
  const application = resolveConnectorPolicyApplication([
    { userId: "workspace-owner", status: "active", policy: { policyVersionId: "v2", version: 2, documentHash: hash("b") } },
  ], {
    currentVersion: { version: 4, documentHash: hash("d") },
    conflict: false,
  });
  assert.equal(application.state, "mixed");
  assert.deepEqual(application.currentVersion, { version: 4, documentHash: hash("d") });
  assert.equal(application.currentMembers, 0);
  assert.equal(application.remediationRequiredMembers, 1);
});
