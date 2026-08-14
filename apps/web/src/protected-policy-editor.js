export const protectedPolicyAssignableProfileIds = new Set(["claude-desktop-standard-v1", "disposable-open-v1"]);
export const protectedPolicyAssignableServiceClasses = new Set(["lite", "balanced", "pro"]);

export const protectedPolicyAllowed = (constraint) => constraint.allow.filter((value) => !constraint.deny.includes(value));

export const protectedPolicyEffectiveValues = (catalog, organizationPolicy) => {
  const available = protectedPolicyAllowed(catalog);
  const selected = organizationPolicy?.allow
    ? available.filter((value) => organizationPolicy.allow.includes(value))
    : available;
  return selected.filter((value) => !organizationPolicy?.deny?.includes(value));
};

const resourceConstraint = (catalogConstraint, selected) => {
  const available = protectedPolicyAllowed(catalogConstraint);
  return { allow: selected, deny: available.filter((value) => !selected.includes(value)) };
};

export const protectedOrganizationConstraintsFromEditor = ({ catalog, existingPolicy, editor }) => ({
  ...existingPolicy,
  workspaceProfiles: resourceConstraint(catalog.workspaceProfiles, editor.workspaceProfiles),
  agents: resourceConstraint(catalog.agents, editor.agents),
  applications: resourceConstraint(catalog.applications, editor.applications),
  serviceClasses: resourceConstraint(catalog.serviceClasses, editor.serviceClasses),
  maximumReasoningEffort: editor.maximumReasoningEffort,
  maximumEgressMode: editor.maximumEgressMode,
  clipboard: {
    localToWorkspace: editor.clipboardLocalToWorkspace,
    workspaceToLocal: editor.clipboardWorkspaceToLocal,
    maxBytes: Math.min(catalog.clipboard.maxBytes, Math.max(1, editor.clipboardMaxKb) * 1024),
  },
});
