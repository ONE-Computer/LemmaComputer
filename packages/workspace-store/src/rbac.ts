export const organizationRoles = ["owner", "admin", "member"] as const;
export type OrganizationRole = typeof organizationRoles[number];

export const organizationPermissionCatalogVersion = 1 as const;

export const organizationMembershipStatuses = ["invited", "active", "suspended", "revoked"] as const;
export type OrganizationMembershipStatus = typeof organizationMembershipStatuses[number];

export const organizationPermissions = [
  "organization.read",
  "organization.manage_members",
  "organization.manage_roles",
  "organization.transfer_ownership",
  "organization.manage_settings",
  "workspace.use",
  "workspace.manage",
  "policy.manage",
  "provider.manage",
  "audit.read",
  "usage.read",
  "usage.manage",
] as const;
export type OrganizationPermission = typeof organizationPermissions[number];

const memberPermissions = [
  "organization.read",
  "workspace.use",
] as const satisfies readonly OrganizationPermission[];

const adminPermissions = [
  ...memberPermissions,
  "organization.manage_members",
  "organization.manage_roles",
  "organization.manage_settings",
  "workspace.manage",
  "policy.manage",
  "provider.manage",
  "audit.read",
  "usage.read",
  "usage.manage",
] as const satisfies readonly OrganizationPermission[];

export const permissionsByOrganizationRole = {
  owner: organizationPermissions,
  admin: adminPermissions,
  member: memberPermissions,
} as const satisfies Record<OrganizationRole, readonly OrganizationPermission[]>;

export type LegacyLemmaComputerRole = "employee" | "administrator";
export type LemmaComputerRole = OrganizationRole | LegacyLemmaComputerRole;

export type OrganizationAuthorizationSubject = {
  tenantId: string;
  organizationId?: string;
  membershipStatus?: OrganizationMembershipStatus;
  role?: OrganizationRole;
  roles: readonly LemmaComputerRole[];
  permissions?: readonly OrganizationPermission[];
};

export type OrganizationAuthorizationDecision = {
  allowed: boolean;
  reason: "allowed" | "wrong_organization" | "inactive_membership" | "permission_denied";
};

const normalizedRoles = (subject: OrganizationAuthorizationSubject): OrganizationRole[] => {
  if (subject.role) return [subject.role];
  return [...new Set(subject.roles.flatMap((role): OrganizationRole[] => {
    if (role === "owner" || role === "admin" || role === "member") return [role];
    if (role === "administrator") return ["admin"];
    if (role === "employee") return ["member"];
    return [];
  }))];
};

export const permissionsForOrganizationRoles = (
  roles: readonly LemmaComputerRole[],
): OrganizationPermission[] => [...new Set(roles.flatMap((role) => {
  if (role === "owner" || role === "admin" || role === "member") return permissionsByOrganizationRole[role];
  if (role === "administrator") return permissionsByOrganizationRole.admin;
  if (role === "employee") return permissionsByOrganizationRole.member;
  return [];
}))];

export const authorizeOrganization = (
  subject: OrganizationAuthorizationSubject,
  organizationId: string,
  permission: OrganizationPermission,
): OrganizationAuthorizationDecision => {
  if (subject.tenantId !== organizationId || (subject.organizationId && subject.organizationId !== organizationId)) {
    return { allowed: false, reason: "wrong_organization" };
  }
  if (subject.membershipStatus && subject.membershipStatus !== "active") {
    return { allowed: false, reason: "inactive_membership" };
  }
  const permissions = permissionsForOrganizationRoles(normalizedRoles(subject));
  return permissions.includes(permission)
    ? { allowed: true, reason: "allowed" }
    : { allowed: false, reason: "permission_denied" };
};

export const hasOrganizationPermission = (
  subject: OrganizationAuthorizationSubject,
  permission: OrganizationPermission,
) => authorizeOrganization(subject, subject.organizationId ?? subject.tenantId, permission).allowed;
