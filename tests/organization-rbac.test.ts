import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeOrganization,
  hasOrganizationPermission,
  organizationPermissions,
  organizationPermissionCatalog,
  organizationPermissionCatalogV1,
  permissionsByOrganizationRole,
  permissionsForOrganizationRoles,
  resolveEffectiveOrganizationPermissions,
  canDelegateOrganizationGrants,
  definePermissionCatalogSnapshot,
} from "@lemmacomputer/workspace-store";

test("built-in organization roles have a fail-closed permission hierarchy", () => {
  assert.deepEqual(permissionsForOrganizationRoles(["member"]), [
    "organization.read",
    "workspace.use",
    "workspace.create",
    "workspace.manage_own",
  ]);
  assert.equal(permissionsByOrganizationRole.admin.includes("organization.manage_members"), true);
  assert.equal(permissionsByOrganizationRole.admin.includes("organization.transfer_ownership"), false);
  assert.deepEqual(permissionsByOrganizationRole.owner, organizationPermissions);
  assert.deepEqual(permissionsForOrganizationRoles(["not-a-role" as never]), []);

  const owner = {
    tenantId: "acme",
    organizationId: "acme",
    membershipStatus: "active" as const,
    role: "owner" as const,
    roles: ["owner"] as const,
  };
  const admin = { ...owner, role: "admin" as const, roles: ["admin"] as const };
  assert.equal(authorizeOrganization(owner, "acme", "organization.transfer_ownership").allowed, true);
  assert.equal(authorizeOrganization(admin, "acme", "organization.transfer_ownership").allowed, false);
  assert.equal(authorizeOrganization({ ...owner, role: "member", roles: ["member"] }, "acme", "workspace.create").allowed, true);
  assert.equal(authorizeOrganization({ ...owner, role: "member", roles: ["member"] }, "acme", "workspace.manage_own").allowed, true);
  assert.equal(authorizeOrganization({ ...owner, role: "member", roles: ["member"] }, "acme", "workspace.manage").allowed, false);
  assert.equal(authorizeOrganization(owner, "acme", "unknown.permission" as never).allowed, false);
});

test("authorization binds permission decisions to one active organization membership", () => {
  const member = {
    tenantId: "acme",
    organizationId: "acme",
    membershipStatus: "active" as const,
    role: "member" as const,
    roles: ["member"] as const,
  };
  assert.deepEqual(authorizeOrganization(member, "acme", "workspace.use"), { allowed: true, reason: "allowed" });
  assert.deepEqual(authorizeOrganization(member, "acme", "organization.manage_members"), {
    allowed: false,
    reason: "permission_denied",
  });
  assert.equal(hasOrganizationPermission({
    ...member,
    permissions: ["organization.manage_members"],
  }, "organization.manage_members"), false, "caller-supplied permission projections are not authority");
  assert.deepEqual(authorizeOrganization(member, "other", "workspace.use"), {
    allowed: false,
    reason: "wrong_organization",
  });
  assert.deepEqual(authorizeOrganization({ ...member, membershipStatus: "suspended" }, "acme", "workspace.use"), {
    allowed: false,
    reason: "inactive_membership",
  });
});

test("legacy roles remain readable during expand/migrate rollout without changing the new role model", () => {
  assert.equal(hasOrganizationPermission({ tenantId: "acme", roles: ["administrator"] }, "organization.manage_settings"), true);
  assert.equal(hasOrganizationPermission({ tenantId: "acme", roles: ["employee"] }, "organization.manage_settings"), false);
});

test("custom role grants form a scoped union and unknown authority fails closed", () => {
  const resolved = resolveEffectiveOrganizationPermissions({
    catalogVersion: 1,
    builtInRoles: ["member"],
    customRoleVersions: [{
      roleId: "role-reviewer",
      version: 3,
      catalogVersion: 1,
      status: "active",
      grants: [
        { permission: "audit.read", scope: { type: "workspace", resourceId: "workspace-a" } },
        { permission: "workspace.use", scope: { type: "workspace", resourceId: "workspace-a" } },
      ],
    }],
  });
  assert.equal(resolved.valid, true);
  assert.equal(resolved.allows("workspace.use", { type: "organization" }), true);
  assert.equal(resolved.allows("audit.read", { type: "workspace", resourceId: "workspace-a" }), true);
  assert.equal(resolved.allows("audit.read", { type: "workspace", resourceId: "workspace-b" }), false);
  assert.equal(resolved.allows("provider.manage", { type: "provider", resourceId: "microsoft-365" }), false);

  for (const invalid of [
    resolveEffectiveOrganizationPermissions({ catalogVersion: 99, builtInRoles: ["member"], customRoleVersions: [] }),
    resolveEffectiveOrganizationPermissions({
      catalogVersion: 1,
      builtInRoles: ["member"],
      customRoleVersions: [{ roleId: "missing", version: 1, catalogVersion: 1, status: "unknown" as never, grants: [] }],
    }),
    resolveEffectiveOrganizationPermissions({
      catalogVersion: 1,
      builtInRoles: ["member"],
      customRoleVersions: [{
        roleId: "forged",
        version: 1,
        catalogVersion: 1,
        status: "active",
        grants: [{ permission: "root.everything" as never, scope: { type: "organization" } }],
      }],
    }),
    resolveEffectiveOrganizationPermissions({
      catalogVersion: 1,
      builtInRoles: ["member"],
      customRoleVersions: [{
        roleId: "bad-scope",
        version: 1,
        catalogVersion: 1,
        status: "active",
        grants: [{ permission: "organization.read", scope: { type: "workspace", resourceId: "workspace-a" } }],
      }],
    }),
  ]) {
    assert.equal(invalid.valid, false);
    assert.equal(invalid.allows("organization.read", { type: "organization" }), false);
  }
  assert.deepEqual(organizationPermissionCatalog["workspace.use"].scopeTypes, ["organization", "workspace"]);
});

test("historical role catalogs resolve independently without inheriting later permissions", () => {
  const catalogV1 = definePermissionCatalogSnapshot({
    ...organizationPermissionCatalogV1,
  });
  const catalogV2 = definePermissionCatalogSnapshot({
    ...organizationPermissionCatalog,
    "workspace.export": { description: "Export workspace data", scopeTypes: ["organization", "workspace"] as const },
  });
  const catalogSnapshots = { 1: catalogV1, 2: catalogV2 };
  assert.equal(Object.hasOwn(catalogV1, "workspace.export"), false,
    "a later permission is representable without retroactively changing the historical snapshot");
  const mixed = resolveEffectiveOrganizationPermissions({
    catalogVersion: 2,
    catalogSnapshots,
    builtInRoles: ["member"],
    customRoleVersions: [
      {
        roleId: "historical-reviewer",
        version: 4,
        catalogVersion: 1,
        status: "active",
        grants: [{ permission: "audit.read", scope: { type: "workspace", resourceId: "workspace-a" } }],
      },
      {
        roleId: "current-exporter",
        version: 1,
        catalogVersion: 2,
        status: "active",
        grants: [{ permission: "workspace.export" as never, scope: { type: "workspace", resourceId: "workspace-a" } }],
      },
    ],
  });
  assert.equal(mixed.valid, true);
  assert.equal(mixed.allows("audit.read", { type: "workspace", resourceId: "workspace-a" }), true);
  assert.equal(mixed.allows("workspace.export" as never, { type: "workspace", resourceId: "workspace-a" }), true);

  const historicalOnly = resolveEffectiveOrganizationPermissions({
    catalogVersion: 2,
    catalogSnapshots,
    builtInRoles: ["member"],
    customRoleVersions: [{
      roleId: "historical-reviewer",
      version: 4,
      catalogVersion: 1,
      status: "active",
      grants: [{ permission: "audit.read", scope: { type: "workspace", resourceId: "workspace-a" } }],
    }],
  });
  assert.equal(historicalOnly.valid, true);
  assert.equal(historicalOnly.allows("workspace.export" as never, { type: "workspace", resourceId: "workspace-a" }), false,
    "the current catalog does not add its new permission to a historical role document");

  const unknownSnapshot = resolveEffectiveOrganizationPermissions({
    catalogVersion: 2,
    catalogSnapshots,
    builtInRoles: ["member"],
    customRoleVersions: [{ roleId: "unknown", version: 1, catalogVersion: 3, status: "active", grants: [] }],
  });
  assert.equal(unknownSnapshot.valid, false);
  assert.equal(unknownSnapshot.allows("organization.read", { type: "organization" }), false);
});

test("delegation is a subset of the actor's resolved permission and resource scopes", () => {
  const actor = resolveEffectiveOrganizationPermissions({
    catalogVersion: 1,
    builtInRoles: ["member"],
    customRoleVersions: [{
      roleId: "workspace-manager",
      version: 1,
      catalogVersion: 1,
      status: "active",
      grants: [{ permission: "workspace.manage", scope: { type: "workspace", resourceId: "workspace-a" } }],
    }],
  });
  assert.equal(canDelegateOrganizationGrants(actor, [
    { permission: "workspace.manage", scope: { type: "workspace", resourceId: "workspace-a" } },
  ]), true);
  assert.equal(canDelegateOrganizationGrants(actor, [
    { permission: "workspace.manage", scope: { type: "workspace", resourceId: "workspace-b" } },
  ]), false);
  assert.equal(canDelegateOrganizationGrants(actor, [
    { permission: "workspace.manage", scope: { type: "organization" } },
  ]), false);
});
