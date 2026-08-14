export const protectedPolicyAssignableProfileIds = new Set(["claude-desktop-standard-v1", "disposable-open-v1"]);
export const protectedPolicyAssignableServiceClasses = new Set(["lite", "balanced", "pro"]);

export const protectedPolicyAllowed = (constraint) => constraint.allow.filter((value) => !constraint.deny.includes(value));

export const protectedPolicyEffectiveValues = (baseline, overlay) => {
  const ceiling = protectedPolicyAllowed(baseline);
  const selected = overlay?.allow ? ceiling.filter((value) => overlay.allow.includes(value)) : ceiling;
  return selected.filter((value) => !overlay?.deny?.includes(value));
};

const resourceConstraint = (baselineConstraint, selected) => {
  const ceiling = protectedPolicyAllowed(baselineConstraint);
  return { allow: selected, deny: ceiling.filter((value) => !selected.includes(value)) };
};

export const protectedOrganizationConstraintsFromEditor = ({ baseline, overlay, editor }) => ({
  ...overlay,
  workspaceProfiles: resourceConstraint(baseline.workspaceProfiles, editor.workspaceProfiles),
  agents: resourceConstraint(baseline.agents, editor.agents),
  applications: resourceConstraint(baseline.applications, editor.applications),
  serviceClasses: resourceConstraint(baseline.serviceClasses, editor.serviceClasses),
  maximumReasoningEffort: editor.maximumReasoningEffort,
  maximumEgressMode: editor.maximumEgressMode,
  clipboard: {
    localToWorkspace: editor.clipboardLocalToWorkspace,
    workspaceToLocal: editor.clipboardWorkspaceToLocal,
    maxBytes: Math.min(baseline.clipboard.maxBytes, Math.max(1, editor.clipboardMaxKb) * 1024),
  },
});
