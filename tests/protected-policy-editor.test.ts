import assert from "node:assert/strict";
import test from "node:test";
import { organizationWorkspacePolicyConstraintsSchema } from "@lemmacomputer/contracts";
import {
  protectedOrganizationConstraintsFromEditor,
  protectedPolicyAssignableProfileIds,
  protectedPolicyAssignableServiceClasses,
  protectedPolicyEffectiveValues,
} from "../apps/web/src/protected-policy-editor.js";

const constraint = <T extends string>(allow: T[], deny: T[] = []) => ({ allow, deny });

test("the full supported catalog remains available when no organization policy exists", () => {
  const catalog = constraint(["claude-desktop", "claude-cli", "codex-cli", "hermes-desktop", "hermes-claw"]);
  assert.deepEqual(protectedPolicyEffectiveValues(catalog, undefined), catalog.allow);
  assert.deepEqual(protectedPolicyEffectiveValues(catalog, constraint(["codex-cli"])), ["codex-cli"]);
});

test("the organization editor uses the supported catalog while preserving routing and connector policy ownership", () => {
  assert.deepEqual([...protectedPolicyAssignableProfileIds], ["claude-desktop-standard-v1", "disposable-open-v1"]);
  assert.deepEqual([...protectedPolicyAssignableServiceClasses], ["lite", "balanced", "pro"]);

  const modelAliases = constraint(["lemmacomputer-auto" as const], ["lemmacomputer-openai" as const]);
  const connectors = {
    ...constraint(["microsoft-365" as const]),
    toolPolicies: { "microsoft-365": { "send-mail": "approval_required" as const } },
  };
  const output = protectedOrganizationConstraintsFromEditor({
    catalog: {
      workspaceProfiles: constraint(["claude-desktop-standard-v1", "disposable-open-v1"]),
      agents: constraint(["claude-desktop", "claude-cli", "codex-cli", "hermes-desktop", "hermes-claw"]),
      applications: constraint(["firefox", "google-chrome"]),
      modelAliases: constraint(["lemmacomputer-auto", "lemmacomputer-openai"]),
      serviceClasses: constraint(["lite", "balanced", "pro"]),
      maximumReasoningEffort: "max",
      maximumEgressMode: "full-web",
      clipboard: { localToWorkspace: true, workspaceToLocal: true, maxBytes: 1_048_576 },
      connectors: { ...constraint(["microsoft-365"]), toolPolicies: {} },
      capabilities: constraint(["ai-assistant"]),
    },
    existingPolicy: { modelAliases, connectors },
    editor: {
      workspaceProfiles: ["claude-desktop-standard-v1"],
      agents: ["claude-cli"],
      applications: ["firefox"],
      serviceClasses: ["lite", "balanced", "pro"],
      maximumReasoningEffort: "high",
      clipboardLocalToWorkspace: true,
      clipboardWorkspaceToLocal: false,
      clipboardMaxKb: 32,
    },
  });

  assert.deepEqual(output.modelAliases, modelAliases, "model routing constraints remain owned outside this editor");
  assert.deepEqual(output.connectors, connectors, "connector enablement and tool policy remain owned by Connectors");
  assert.deepEqual(output.workspaceProfiles, {
    allow: ["claude-desktop-standard-v1"],
    deny: ["disposable-open-v1"],
  });
  assert.deepEqual(output.serviceClasses, {
    allow: ["lite", "balanced", "pro"],
    deny: [],
  });
  assert.equal(output.maximumEgressMode, "restricted", "managed-only guardrails derive restricted egress from workspace type");
  assert.doesNotThrow(() => organizationWorkspacePolicyConstraintsSchema.parse(output));
});
