import assert from "node:assert/strict";
import test from "node:test";
import {
  mvpPolicyDocument,
  runtimePolicyFor,
  type EffectivePolicy,
  type OrganizationWorkspacePolicyVersionRecord,
} from "@lemmacomputer/workspace-store";
import { constrainEffectivePolicy } from "../apps/control-api/src/server.js";

const basePolicy = (): EffectivePolicy => ({
  assignmentId: "assignment",
  policyBundleId: "bundle",
  policyVersionId: "runtime-version",
  version: 7,
  documentHash: "a".repeat(64),
  assignedBy: "administrator",
  assignedAt: "2026-08-12T08:00:00.000Z",
  agentId: "agent",
  vendorUserId: "member",
  document: mvpPolicyDocument(),
});

test("without an organization policy the runtime keeps the full supported catalog", () => {
  const document = basePolicy().document as Record<string, unknown>;
  assert.deepEqual(document.agents, ["claude-desktop", "claude-cli", "codex-cli", "hermes-desktop", "hermes-claw"]);
  assert.deepEqual(document.applications, ["firefox", "google-chrome", "visual-studio-code", "obsidian"]);
  assert.deepEqual(document.workspaceProfiles, ["claude-desktop-standard-v1", "disposable-open-v1"]);
});

test("the latest organization policy constrains every member runtime", () => {
  const organizationPolicy: OrganizationWorkspacePolicyVersionRecord = {
    tenantId: "tenant",
    policyVersionId: "11111111-1111-4111-8111-111111111111",
    version: 1,
    previousPolicyVersionId: null,
    documentHash: "b".repeat(64),
    constraints: {
      workspaceProfiles: { allow: ["claude-desktop-standard-v1"], deny: [] },
      agents: { allow: ["claude-cli", "codex-cli"], deny: [] },
      applications: { allow: ["firefox", "google-chrome", "visual-studio-code", "obsidian"], deny: [] },
      serviceClasses: { allow: ["balanced", "pro"], deny: [] },
      maximumEgressMode: "restricted",
      connectors: {
        allow: ["microsoft-365"],
        deny: [],
        toolPolicies: { "microsoft-365": { "send-mail": "deny" } },
      },
    },
    revisionNote: "Restrict organization workspaces",
    createdBy: "administrator",
    createdAt: new Date("2026-08-12T08:00:00.000Z"),
  };
  const constrained = constrainEffectivePolicy(basePolicy(), organizationPolicy);
  const document = constrained.document as Record<string, unknown>;
  assert.deepEqual(document.agents, ["claude-cli", "codex-cli"]);
  assert.deepEqual(document.applications, ["firefox", "google-chrome", "visual-studio-code", "obsidian"]);
  assert.deepEqual(document.workspaceProfiles, ["claude-desktop-standard-v1"]);
  assert.deepEqual(document.serviceClasses, ["balanced", "pro"]);
  assert.equal(document.organizationPolicyHash, organizationPolicy.documentHash);
  assert.equal(document.maximumEgressMode, "restricted");

  const chrome = runtimePolicyFor(constrained, "lemmacomputer-claude", "claude-desktop-standard-v1", ["codex-cli"], ["google-chrome"]);
  assert.deepEqual(chrome.applications, ["google-chrome"]);
  assert.throws(
    () => runtimePolicyFor(constrained, "lemmacomputer-claude", "claude-desktop-standard-v1", ["hermes-claw"], ["firefox"]),
    (error: unknown) => error instanceof Error && error.message.includes("not assigned"),
  );
  const microsoft365 = ((document.mcp as Record<string, unknown>).servers as Record<string, Record<string, unknown>>).lemmacomputer_ms365;
  assert.equal((microsoft365.toolPolicies as Record<string, string>)["send-mail"], "deny");
});
