import assert from "node:assert/strict";
import test from "node:test";
import { organizationWorkspacePolicyConstraintsSchema } from "@lemmacomputer/contracts";
import {
  protectedOrganizationConstraintsFromEditor,
  protectedPolicyAssignableProfileIds,
  protectedPolicyAssignableServiceClasses,
} from "../apps/web/src/protected-policy-editor.js";

const constraint = <T extends string>(allow: T[], deny: T[] = []) => ({ allow, deny });

test("the organization editor hides stale choices while preserving routing and connector policy ownership", () => {
  assert.deepEqual([...protectedPolicyAssignableProfileIds], ["claude-desktop-standard-v1", "disposable-open-v1"]);
  assert.deepEqual([...protectedPolicyAssignableServiceClasses], ["lite", "balanced", "pro"]);

  const modelAliases = constraint(["lemmacomputer-auto" as const], ["lemmacomputer-openai" as const]);
  const connectors = {
    ...constraint(["microsoft-365" as const]),
    toolPolicies: { "microsoft-365": { "send-mail": "approval_required" as const } },
  };
  const output = protectedOrganizationConstraintsFromEditor({
    baseline: {
      workspaceProfiles: constraint(["claude-desktop-standard-v1", "kasm-persistent-standard"]),
      agents: constraint(["claude-desktop", "claude-cli"]),
      applications: constraint(["firefox", "google-chrome"]),
      modelAliases: constraint(["lemmacomputer-auto", "lemmacomputer-openai"]),
      serviceClasses: constraint(["auto", "lite", "balanced", "pro"]),
      maximumReasoningEffort: "max",
      maximumEgressMode: "restricted",
      clipboard: { localToWorkspace: true, workspaceToLocal: true, maxBytes: 1_048_576 },
      connectors: { ...constraint(["microsoft-365"]), toolPolicies: {} },
      capabilities: constraint(["ai-assistant"]),
    },
    overlay: { modelAliases, connectors },
    editor: {
      workspaceProfiles: ["claude-desktop-standard-v1"],
      agents: ["claude-cli"],
      applications: ["firefox"],
      serviceClasses: ["lite", "balanced", "pro"],
      maximumReasoningEffort: "high",
      maximumEgressMode: "restricted",
      clipboardLocalToWorkspace: true,
      clipboardWorkspaceToLocal: false,
      clipboardMaxKb: 32,
    },
  });

  assert.deepEqual(output.modelAliases, modelAliases, "model routing constraints remain owned outside this editor");
  assert.deepEqual(output.connectors, connectors, "connector enablement and tool policy remain owned by Connectors");
  assert.deepEqual(output.workspaceProfiles, {
    allow: ["claude-desktop-standard-v1"],
    deny: ["kasm-persistent-standard"],
  });
  assert.deepEqual(output.serviceClasses, {
    allow: ["lite", "balanced", "pro"],
    deny: ["auto"],
  });
  assert.doesNotThrow(() => organizationWorkspacePolicyConstraintsSchema.parse(output));
});
