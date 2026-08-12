import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveEffectiveConnectorPolicy,
  type EffectiveConnectorPolicyInput,
} from "../apps/control-api/src/connector-policy-administration.js";

const hash = (character: string) => character.repeat(64);

const input = (overrides: Partial<EffectiveConnectorPolicyInput> = {}): EffectiveConnectorPolicyInput => ({
  baseline: {
    templateVersionId: "pbtv_office_worker_claude_1",
    version: 1,
    documentHash: hash("a"),
    connectors: {
      allow: ["reports"],
      deny: [],
      toolPolicies: { reports: { read_report: "allow", export_report: "approval_required" } },
    },
  },
  organizationPolicy: null,
  connector: {
    id: "reports",
    name: "Reports",
    enabled: true,
    membersCanManage: true,
    accessPolicyVersion: 3,
    accessPolicyUpdatedAt: "2026-08-12T00:00:00.000Z",
    configuredToolPolicies: { read_report: "allow", export_report: "allow" },
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

test("the protected baseline denies an enabled connector and member connection management", () => {
  const resolved = resolveEffectiveConnectorPolicy(input({
    connector: { ...input().connector, id: "unapproved", name: "Unapproved" },
  }));
  assert.equal(resolved.access.configuredEnabled, true);
  assert.equal(resolved.access.effectiveDecision, "deny");
  assert.equal(resolved.access.membersCanManage, false);
  assert.equal(resolved.access.reason, "protected_baseline_denied");
  assert.equal(resolved.access.controllingSource.kind, "protected_baseline");
  assert.equal(resolved.runtimeProjection.state, "excluded");
});

test("the effective tool decision is the strictest baseline, organization, and connector decision", () => {
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
    ["protected_baseline", "allow"],
    ["organization_policy", "approval_required"],
    ["connector_policy", "allow"],
  ]);
  assert.equal(exportReport.effectiveDecision, "approval_required",
    "a connector allow cannot weaken the protected approval requirement");
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
    baseline: {
      ...input().baseline,
      connectors: {
        allow: ["search"],
        deny: [],
        toolPolicies: { search: { search_web: "allow" } },
      },
    },
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
