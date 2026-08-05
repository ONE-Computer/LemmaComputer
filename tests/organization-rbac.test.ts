import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeOrganization,
  hasOrganizationPermission,
  organizationPermissions,
  permissionsByOrganizationRole,
  permissionsForOrganizationRoles,
} from "@lemmacomputer/workspace-store";

test("built-in organization roles have a fail-closed permission hierarchy", () => {
  assert.deepEqual(permissionsForOrganizationRoles(["member"]), ["organization.read", "workspace.use"]);
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
