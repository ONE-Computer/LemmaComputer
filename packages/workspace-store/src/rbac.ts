export const organizationRoles = ["owner", "admin", "member"] as const;
export type OrganizationRole = typeof organizationRoles[number];

export const organizationPermissionCatalogVersion = 3 as const;

export const organizationMembershipStatuses = ["invited", "active", "suspended", "revoked"] as const;
export type OrganizationMembershipStatus = typeof organizationMembershipStatuses[number];

export const organizationPermissions = [
  "organization.read",
  "organization.manage_members",
  "organization.manage_roles",
  "organization.transfer_ownership",
  "organization.manage_settings",
  "workspace.use",
  "workspace.create",
  "workspace.manage_own",
  "workspace.manage",
  "policy.manage",
  "provider.manage",
  "audit.read",
  "usage.read",
  "usage.manage",
] as const;
export type OrganizationPermission = typeof organizationPermissions[number];

export const organizationResourceScopeTypes = ["organization", "workspace", "provider"] as const;
export type OrganizationResourceScopeType = typeof organizationResourceScopeTypes[number];
export type OrganizationResourceScope = {
  type: OrganizationResourceScopeType;
  resourceId?: string;
};
export type OrganizationPermissionGrant = {
  permission: OrganizationPermission;
  scope: OrganizationResourceScope;
};

export type PermissionCatalogEntry = {
  description: string;
  scopeTypes: readonly OrganizationResourceScopeType[];
};
export type PermissionCatalogSnapshot = Readonly<Record<string, PermissionCatalogEntry>>;
export const definePermissionCatalogSnapshot = <const Snapshot extends PermissionCatalogSnapshot>(snapshot: Snapshot) => snapshot;

export const organizationPermissionCatalogV1 = definePermissionCatalogSnapshot({
  "organization.read": { description: "Read organization settings", scopeTypes: ["organization"] },
  "organization.manage_members": { description: "Manage organization members", scopeTypes: ["organization"] },
  "organization.manage_roles": { description: "Manage organization roles", scopeTypes: ["organization"] },
  "organization.transfer_ownership": { description: "Transfer protected organization ownership", scopeTypes: ["organization"] },
  "organization.manage_settings": { description: "Manage organization settings", scopeTypes: ["organization"] },
  "workspace.use": { description: "Use organization workspaces", scopeTypes: ["organization", "workspace"] },
  "workspace.manage": { description: "Manage organization workspaces", scopeTypes: ["organization", "workspace"] },
  "policy.manage": { description: "Manage organization policies", scopeTypes: ["organization", "workspace"] },
  "provider.manage": { description: "Manage organization providers", scopeTypes: ["organization", "provider"] },
  "audit.read": { description: "Read organization audit records", scopeTypes: ["organization", "workspace"] },
  "usage.read": { description: "Read organization usage and spend records", scopeTypes: ["organization", "workspace", "provider"] },
  "usage.manage": { description: "Manage quotas, budgets, and usage configuration", scopeTypes: ["organization", "workspace", "provider"] },
} as const);

// Catalog v2 establishes independently resolved custom-role snapshots. Keep it
// immutable so historical custom roles never inherit later permissions.
export const organizationPermissionCatalogV2 = definePermissionCatalogSnapshot({
  ...organizationPermissionCatalogV1,
  "audit.read": { description: "Read organization audit records", scopeTypes: ["organization"] },
} as const);

// Catalog v3 separates creating a subject-owned workspace from administering
// existing workspaces. A Member may create and use their own workspace without
// receiving restart, stop, delete, or configuration authority over others.
export const organizationPermissionCatalog = {
  ...organizationPermissionCatalogV2,
  "workspace.create": { description: "Create a member-owned organization workspace", scopeTypes: ["organization"] },
  "workspace.manage_own": { description: "Manage a workspace owned by the signed-in member", scopeTypes: ["organization", "workspace"] },
} as const satisfies Record<OrganizationPermission, PermissionCatalogEntry>;

// Keep every still-supported historical snapshot here when the current catalog
// advances. Custom role versions stay bound to their recorded snapshot and
// never inherit permissions added by a later catalog.
export const supportedOrganizationPermissionCatalogs = {
  1: organizationPermissionCatalogV1,
  2: organizationPermissionCatalogV2,
  3: organizationPermissionCatalog,
} as const satisfies Record<number, PermissionCatalogSnapshot>;

export type OrganizationCustomRoleVersion = {
  roleId: string;
  version: number;
  catalogVersion: number;
  status: "active" | "archived";
  grants: readonly OrganizationPermissionGrant[];
};

export type EffectiveOrganizationPermissions = {
  valid: boolean;
  reason?: "unknown_catalog_version" | "unknown_role" | "unknown_permission" | "invalid_scope";
  grants: readonly OrganizationPermissionGrant[];
  allows(permission: OrganizationPermission, scope: OrganizationResourceScope): boolean;
};

const validScope = (
  grant: OrganizationPermissionGrant,
  catalog: PermissionCatalogSnapshot = organizationPermissionCatalog,
) => {
  const entry = catalog[grant.permission];
  if (!entry || !entry.scopeTypes.includes(grant.scope.type)) return false;
  return grant.scope.type === "organization"
    ? grant.scope.resourceId === undefined
    : typeof grant.scope.resourceId === "string" && grant.scope.resourceId.length > 0;
};

const grantKey = (grant: OrganizationPermissionGrant) => (
  `${grant.permission}\0${grant.scope.type}\0${grant.scope.resourceId ?? ""}`
);

export const resolveEffectiveOrganizationPermissions = (input: {
  catalogVersion: number;
  catalogSnapshots?: Readonly<Record<number, PermissionCatalogSnapshot>>;
  builtInRoles: readonly LemmaComputerRole[];
  customRoleVersions: readonly OrganizationCustomRoleVersion[];
}): EffectiveOrganizationPermissions => {
  let invalidReason: EffectiveOrganizationPermissions["reason"];
  const catalogSnapshots: Readonly<Record<number, PermissionCatalogSnapshot>> =
    input.catalogSnapshots ?? supportedOrganizationPermissionCatalogs;
  const currentCatalog = catalogSnapshots[input.catalogVersion];
  if (!currentCatalog) invalidReason = "unknown_catalog_version";
  const grants: OrganizationPermissionGrant[] = [];
  const resolvedGrants: Array<{ grant: OrganizationPermissionGrant; catalog: PermissionCatalogSnapshot }> = [];
  for (const permission of permissionsForOrganizationRoles(input.builtInRoles, input.catalogVersion)) {
    const grant = { permission, scope: { type: "organization" as const } };
    grants.push(grant);
    if (currentCatalog) resolvedGrants.push({ grant, catalog: currentCatalog });
  }
  for (const role of input.customRoleVersions) {
    if (role.status !== "active") invalidReason ??= "unknown_role";
    const roleCatalog = catalogSnapshots[role.catalogVersion];
    if (!roleCatalog || !Number.isSafeInteger(role.version) || role.version < 1) invalidReason ??= "unknown_catalog_version";
    for (const grant of role.grants) {
      if (!roleCatalog || !Object.hasOwn(roleCatalog, grant.permission)) invalidReason ??= "unknown_permission";
      else if (!validScope(grant, roleCatalog)) invalidReason ??= "invalid_scope";
      else resolvedGrants.push({ grant, catalog: roleCatalog });
      grants.push(grant);
    }
  }
  const unique = [...new Map(grants.map((grant) => [grantKey(grant), grant])).values()];
  const valid = invalidReason === undefined;
  return {
    valid,
    ...(invalidReason ? { reason: invalidReason } : {}),
    grants: valid ? unique : [],
    allows(permission, scope) {
      if (!valid) return false;
      return resolvedGrants.some(({ grant, catalog }) => (
        grant.permission === permission
        && Object.hasOwn(catalog, permission)
        && validScope({ permission, scope }, catalog)
        && (grant.scope.type === "organization"
          || grant.scope.type === scope.type && grant.scope.resourceId === scope.resourceId)
      ));
    },
  };
};

export const canDelegateOrganizationGrants = (
  actor: EffectiveOrganizationPermissions,
  requested: readonly OrganizationPermissionGrant[],
) => actor.valid && requested.length > 0 && requested.every((grant) => (
  grant.permission !== "organization.transfer_ownership"
  && actor.allows(grant.permission, grant.scope)
));

const memberPermissions = [
  "organization.read",
  "workspace.use",
  "workspace.create",
  "workspace.manage_own",
] as const satisfies readonly OrganizationPermission[];

const historicalMemberPermissions = [
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
  effectiveAuthorization?: EffectiveOrganizationPermissions;
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
  catalogVersion: number = organizationPermissionCatalogVersion,
): OrganizationPermission[] => [...new Set(roles.flatMap((role) => {
  const catalog = supportedOrganizationPermissionCatalogs[catalogVersion as keyof typeof supportedOrganizationPermissionCatalogs];
  const owner = catalog ? Object.keys(catalog) as OrganizationPermission[] : [];
  const member = catalogVersion >= 3 ? permissionsByOrganizationRole.member : historicalMemberPermissions;
  const admin = catalogVersion >= 3
    ? permissionsByOrganizationRole.admin
    : permissionsByOrganizationRole.admin.filter((permission) => catalog && Object.hasOwn(catalog, permission));
  if (role === "owner") return owner;
  if (role === "admin") return admin;
  if (role === "member") return member;
  if (role === "administrator") return admin;
  if (role === "employee") return member;
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
  const allowed = subject.effectiveAuthorization
    ? subject.effectiveAuthorization.allows(permission, { type: "organization" })
    : permissionsForOrganizationRoles(normalizedRoles(subject)).includes(permission);
  return allowed
    ? { allowed: true, reason: "allowed" }
    : { allowed: false, reason: "permission_denied" };
};

export const hasOrganizationPermission = (
  subject: OrganizationAuthorizationSubject,
  permission: OrganizationPermission,
) => authorizeOrganization(subject, subject.organizationId ?? subject.tenantId, permission).allowed;
