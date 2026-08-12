import assert from "node:assert/strict";
import test from "node:test";
import { resolveProtectedBaselinePolicy } from "@lemmacomputer/policy-integrity";
import { mvpPolicyDocument, runtimePolicyFor, type EffectivePolicy } from "@lemmacomputer/workspace-store";
import { constrainEffectivePolicy } from "../apps/control-api/src/server.js";
import { loadProductPolicyRelease } from "../apps/control-api/src/protected-workspace-policy.js";

test("the signed baseline is a runtime ceiling while members retain allowed app choice", async () => {
  const release = await loadProductPolicyRelease(new Date("2026-08-12T08:00:00.000Z"));
  const protectedPolicy = resolveProtectedBaselinePolicy({
    baseline: release.verified,
    organizationPolicy: null,
    connectorPolicies: [{
      connectorId: "microsoft-365",
      version: 1,
      documentHash: release.verified.payload.documentHash,
      enabled: true,
      toolPolicies: release.verified.payload.document.constraints.connectors.toolPolicies["microsoft-365"],
    }],
    selection: {
      workspaceProfile: "kasm-persistent-standard",
      agentIds: ["claude-cli"],
      applicationIds: ["firefox"],
      modelAlias: "lemmacomputer-claude",
      serviceClass: "balanced",
      reasoningEffort: "medium",
      egressMode: "restricted",
      connectorIds: ["microsoft-365"],
    },
  });
  const legacy: EffectivePolicy = {
    assignmentId: "assignment",
    policyBundleId: "bundle",
    policyVersionId: "legacy-version",
    version: 7,
    documentHash: "a".repeat(64),
    assignedBy: "administrator",
    assignedAt: "2026-08-12T08:00:00.000Z",
    agentId: "agent",
    vendorUserId: "member",
    document: mvpPolicyDocument(),
  };
  const constrained = constrainEffectivePolicy(legacy, protectedPolicy);
  const document = constrained.document as Record<string, unknown>;
  assert.deepEqual(document.agents, ["claude-desktop", "claude-cli"]);
  assert.deepEqual(document.applications, ["firefox", "google-chrome"]);
  assert.deepEqual(document.defaultApplications, ["firefox"]);
  assert.deepEqual(document.workspaceProfiles, ["claude-desktop-standard-v1"]);
  assert.equal(document.protectedPolicyHash, protectedPolicy.effectiveHash);

  const firefox = runtimePolicyFor(constrained, "lemmacomputer-claude", "claude-desktop-standard-v1", ["claude-cli"], ["firefox"]);
  assert.deepEqual(firefox.applications, ["firefox"]);
  const chrome = runtimePolicyFor(constrained, "lemmacomputer-claude", "claude-desktop-standard-v1", ["claude-cli"], ["google-chrome"]);
  assert.deepEqual(chrome.applications, ["google-chrome"]);
  assert.throws(
    () => runtimePolicyFor(constrained, "lemmacomputer-claude", "claude-desktop-standard-v1", ["hermes-claw"], ["firefox"]),
    (error: unknown) => error instanceof Error && error.message.includes("not assigned"),
  );
  const microsoft365 = ((document.mcp as Record<string, unknown>).servers as Record<string, Record<string, unknown>>).lemmacomputer_ms365;
  assert.deepEqual(microsoft365.tools, [
    "list-mail-messages",
    "send-mail",
    "list-calendar-events",
    "create-calendar-event",
    "search-onedrive-files",
    "upload-file-content",
  ]);
  assert.equal((microsoft365.toolPolicies as Record<string, string>)["send-mail"], "approval_required");
  assert.equal((microsoft365.toolPolicies as Record<string, string>)["delete-mail-message"], undefined);
});
