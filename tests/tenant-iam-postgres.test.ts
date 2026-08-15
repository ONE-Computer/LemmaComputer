import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresIdentityPolicyStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.ORGANIZATION_RBAC_TEST_DATABASE_URL;

test("tenant IAM persists versioned roles, unions assignments, audits changes, and converges sessions", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresIdentityPolicyStore(pool);
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `iam-${suffix}`;
  const otherOrganizationId = `iam-other-${suffix}`;
  const ownerId = `iam-owner-${suffix}`;
  const adminId = `iam-admin-${suffix}`;
  const memberId = `iam-member-${suffix}`;
  const managerId = `iam-manager-${suffix}`;
  const otherOwnerId = `iam-other-owner-${suffix}`;
  const ownerAccount = randomUUID();
  const adminAccount = randomUUID();
  const memberAccount = randomUUID();
  const managerAccount = randomUUID();
  const otherAccount = randomUUID();
  const workspaceId = randomUUID();
  const secondWorkspaceId = randomUUID();
  const foreignWorkspaceId = randomUUID();
  const historicalRoleId = randomUUID();
  try {
    await pool.query(
      "INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'IAM'),($3,$4,'Other')",
      [organizationId, `directory-${organizationId}`, otherOrganizationId, `directory-${otherOrganizationId}`],
    );
    await pool.query("INSERT INTO organizations (id,display_name) VALUES ($1,'IAM'),($2,'Other')", [organizationId, otherOrganizationId]);
    await pool.query(
      "INSERT INTO account_users (id,status) VALUES ($1,'active'),($2,'active'),($3,'active'),($4,'active'),($5,'active')",
      [ownerAccount, adminAccount, memberAccount, managerAccount, otherAccount],
    );
    await pool.query(
      `INSERT INTO users (id,tenant_id,email,display_name,account_user_id) VALUES
         ($1,$5,$1 || '@example.test','Owner',$7),
         ($2,$5,$2 || '@example.test','Admin',$8),
         ($3,$5,$3 || '@example.test','Member',$9),
         ($4,$5,$4 || '@example.test','Scoped Manager',$10),
         ($11,$6,$11 || '@example.test','Other Owner',$12)`,
      [ownerId, adminId, memberId, managerId, organizationId, otherOrganizationId,
        ownerAccount, adminAccount, memberAccount, managerAccount, otherOwnerId, otherAccount],
    );
    await pool.query(
      `INSERT INTO organization_memberships (
         organization_id,account_user_id,subject_user_id,status,role,created_by,updated_by
       ) VALUES
         ($1,$3,$7,'active','owner',$7,$7),
         ($1,$4,$8,'active','admin',$7,$7),
         ($1,$5,$9,'active','member',$7,$7),
         ($1,$6,$10,'active','member',$7,$7),
         ($2,$11,$12,'active','owner',$12,$12)`,
      [organizationId, otherOrganizationId, ownerAccount, adminAccount, memberAccount, managerAccount,
        ownerId, adminId, memberId, managerId, otherAccount, otherOwnerId],
    );
    await pool.query(
      `INSERT INTO workspaces (id,tenant_id,subject_id,grant_id,state,created_at,updated_at) VALUES
         ($1,$3,$5,'iam-owned','ready',now(),now()),
         ($2,$3,$5,'iam-second','ready',now(),now()),
         ($7,$4,$6,'iam-foreign','ready',now(),now())`,
      [workspaceId, secondWorkspaceId, organizationId, otherOrganizationId, memberId, otherOwnerId, foreignWorkspaceId],
    );
    const memberships = await store.listOrganizationMemberships(organizationId);
    const member = memberships.find((item) => item.userId === memberId)!;
    const manager = memberships.find((item) => item.userId === managerId)!;
    const admin = memberships.find((item) => item.userId === adminId)!;
    await store.createSession({
      tokenHash: `iam-session-${suffix}`,
      userId: memberId,
      membershipId: member.membershipId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.createSession({
      tokenHash: `iam-admin-session-${suffix}`,
      userId: adminId,
      membershipId: admin.membershipId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const temporarySecurityGroup = await store.saveEgressSecurityGroup({
      tenantId: organizationId,
      updatedBy: ownerId,
      name: "Temporary external access",
      description: "A removable group used to verify archive-backed deletion.",
      defaultAction: "deny",
      rules: [{
        id: "approved-package-host",
        action: "allow",
        protocol: "https",
        host: "packages.example.com",
        includeSubdomains: false,
        port: 443,
        purpose: "Fetch approved packages",
      }],
    });
    await store.assignWorkspaceEgressSecurityGroup({
      tenantId: organizationId,
      subjectId: memberId,
      grantId: "iam-owned",
      assignedBy: ownerId,
      securityGroupVersionId: temporarySecurityGroup.id,
    });
    await assert.rejects(() => store.archiveEgressSecurityGroup({
      tenantId: organizationId,
      securityGroupId: temporarySecurityGroup.securityGroupId,
      archivedBy: ownerId,
    }), { code: "EGRESS_SECURITY_GROUP_IN_USE" });
    await store.clearWorkspaceEgressSecurityGroup({ tenantId: organizationId, subjectId: memberId, grantId: "iam-owned" });
    assert.equal(await store.archiveEgressSecurityGroup({
      tenantId: organizationId,
      securityGroupId: temporarySecurityGroup.securityGroupId,
      archivedBy: ownerId,
    }), true);
    assert.equal((await store.listEgressSecurityGroups(organizationId)).some((group) => group.securityGroupId === temporarySecurityGroup.securityGroupId), false);
    const replacementSecurityGroup = await store.saveEgressSecurityGroup({
      tenantId: organizationId,
      updatedBy: ownerId,
      name: temporarySecurityGroup.name,
      description: "A replacement may reuse the deleted group name.",
      defaultAction: "deny",
      rules: [],
    });
    assert.notEqual(replacementSecurityGroup.securityGroupId, temporarySecurityGroup.securityGroupId);
    const archivedHistory = await pool.query(
      "SELECT count(*) AS count FROM egress_security_group_versions WHERE security_group_id=$1",
      [temporarySecurityGroup.securityGroupId],
    );
    assert.equal(Number(archivedHistory.rows[0]?.count), 1, "deleting a group retains its immutable revision history");

    const reviewer = await store.createOrganizationRole({
      organizationId,
      name: "Workspace reviewer",
      description: "Reviews one workspace",
      grants: [
        { permission: "policy.manage", scope: { type: "workspace", resourceId: workspaceId } },
      ],
      createdBy: adminId,
    });
    assert.equal(reviewer.version, 1);
    assert.equal(reviewer.catalogVersion, 3);
    await assert.rejects(() => store.createOrganizationRole({
      organizationId,
      name: "Owner",
      description: "Must not imitate a protected role",
      grants: [{ permission: "organization.read", scope: { type: "organization" } }],
      createdBy: ownerId,
    }), { code: "ROLE_NAME_RESERVED" });
    const operator = await store.createOrganizationRole({
      organizationId,
      name: "Workspace operator",
      description: "Uses one workspace",
      grants: [
        { permission: "workspace.manage", scope: { type: "workspace", resourceId: workspaceId } },
      ],
      createdBy: adminId,
    });
    const delegator = await store.createOrganizationRole({
      organizationId,
      name: "Scoped role manager",
      description: "May delegate only one workspace",
      grants: [
        { permission: "organization.manage_members", scope: { type: "organization" } },
        { permission: "organization.manage_roles", scope: { type: "organization" } },
        { permission: "workspace.manage", scope: { type: "workspace", resourceId: workspaceId } },
      ],
      createdBy: ownerId,
    });
    await pool.query(
      `INSERT INTO organization_permission_catalog_versions (version,description)
       VALUES (2,'Test-only next catalog') ON CONFLICT (version) DO NOTHING;
       INSERT INTO organization_permissions (catalog_version,permission_key,description)
       SELECT 2,permission_key,description FROM organization_permissions WHERE catalog_version=1
       ON CONFLICT (catalog_version,permission_key) DO NOTHING;
       INSERT INTO organization_permissions (catalog_version,permission_key,description)
       VALUES (2,'workspace.export','Export workspace data') ON CONFLICT (catalog_version,permission_key) DO NOTHING`,
    );
    const historicalClient = await pool.connect();
    await historicalClient.query("BEGIN");
    try {
      await historicalClient.query(
        `INSERT INTO organization_custom_roles (
           id,organization_id,name,description,status,current_version,catalog_version,created_by,updated_by
         ) VALUES ($1,$2,'Historical usage reader','Pinned to catalog v1','active',1,1,$3,$3)`,
        [historicalRoleId, organizationId, ownerId],
      );
      await historicalClient.query(
        `INSERT INTO organization_custom_role_versions (
           organization_id,role_id,version,catalog_version,name,description,created_by
         ) VALUES ($1,$2,1,1,'Historical usage reader','Pinned to catalog v1',$3)`,
        [organizationId, historicalRoleId, ownerId],
      );
      await historicalClient.query(
        `INSERT INTO organization_custom_role_grants (
           organization_id,role_id,role_version,catalog_version,permission_key,scope_type,resource_id
         ) VALUES ($1,$2,1,1,'usage.read','workspace',$3)`,
        [organizationId, historicalRoleId, workspaceId],
      );
      await historicalClient.query("COMMIT");
    } catch (error) {
      await historicalClient.query("ROLLBACK");
      throw error;
    } finally {
      historicalClient.release();
    }
    const unchangedRole = await pool.query(
      `SELECT permission_key FROM organization_custom_role_grants
       WHERE organization_id=$1 AND role_id=$2 AND role_version=1 ORDER BY permission_key`,
      [organizationId, reviewer.id],
    );
    assert.deepEqual(unchangedRole.rows.map((row) => row.permission_key), ["policy.manage"],
      "a permission added to a later product catalog is not inherited by an existing role version");
    await store.assignOrganizationRole({
      organizationId,
      membershipId: member.membershipId,
      roleId: reviewer.id,
      assignedBy: adminId,
    });
    await store.assignOrganizationRole({
      organizationId,
      membershipId: member.membershipId,
      roleId: historicalRoleId,
      assignedBy: adminId,
    });
    const secondAssignment = await store.assignOrganizationRole({
      organizationId,
      membershipId: member.membershipId,
      roleId: operator.id,
      assignedBy: adminId,
    });
    await store.assignOrganizationRole({
      organizationId,
      membershipId: member.membershipId,
      roleId: delegator.id,
      assignedBy: ownerId,
    });
    await store.assignOrganizationRole({
      organizationId,
      membershipId: manager.membershipId,
      roleId: delegator.id,
      assignedBy: ownerId,
    });
    const delegatedInvitation = await store.createOrganizationInvitation({
      organizationId,
      email: `delegated-${suffix}@example.test`,
      role: "member",
      tokenHash: "d".repeat(64),
      idempotencyKeyHash: "e".repeat(64),
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      createdBy: memberId,
      now: new Date("2026-08-09T00:00:00.000Z"),
    });
    assert.equal(delegatedInvitation.invitation.role, "member",
      "a member with server-resolved manage_members authority can invite a member");
    const delegatedMembershipChange = await store.changeOrganizationMembership({
      organizationId,
      targetUserId: adminId,
      role: "member",
      updatedBy: memberId,
    });
    assert.equal(delegatedMembershipChange.membership.role, "member");
    assert.equal(delegatedMembershipChange.revokedSessions, 1,
      "a built-in role authority change revokes the affected membership session");
    assert.equal(await store.getSession(`iam-admin-session-${suffix}`, new Date()), null);
    const roleChangeRevocation = await pool.query(
      `SELECT reason_code FROM organization_access_audit_events
       WHERE organization_id=$1 AND membership_id=$2 AND event_type='session.revoked'
       ORDER BY occurred_at DESC,id DESC LIMIT 1`,
      [organizationId, admin.membershipId],
    );
    assert.equal(roleChangeRevocation.rows[0]?.reason_code, "ROLE_AUTHORITY_CHANGED");
    await assert.rejects(() => store.changeOrganizationMembership({
      organizationId,
      targetUserId: adminId,
      role: "admin",
      updatedBy: memberId,
    }), { code: "ROLE_DELEGATION_EXCEEDED" });
    await store.changeOrganizationMembership({
      organizationId,
      targetUserId: adminId,
      role: "admin",
      updatedBy: ownerId,
    });
    const delegated = await store.createOrganizationRole({
      organizationId,
      name: "Delegated workspace manager",
      description: "Within the actor's exact workspace scope",
      grants: [{ permission: "workspace.manage", scope: { type: "workspace", resourceId: workspaceId } }],
      createdBy: memberId,
    });
    assert.equal(delegated.version, 1);
    await assert.rejects(() => store.createOrganizationRole({
      organizationId,
      name: "Excessive workspace manager",
      description: "Outside the actor's scope",
      grants: [{ permission: "workspace.manage", scope: { type: "workspace", resourceId: secondWorkspaceId } }],
      createdBy: memberId,
    }), { code: "ROLE_DELEGATION_EXCEEDED" });
    assert.equal(secondAssignment.revokedSessions, 0, "the first assignment already revoked the active product session");
    assert.equal(await store.getSession(`iam-session-${suffix}`, new Date()), null);

    const authority = await store.resolveOrganizationAuthorization({
      organizationId,
      membershipId: member.membershipId,
    });
    assert.equal(authority.valid, true);
    assert.equal(authority.allows("workspace.use", { type: "organization" }), true, "the protected Member role remains assigned");
    assert.equal(authority.allows("workspace.create", { type: "organization" }), true,
      "the current protected Member role can create only subject-owned workspaces");
    assert.equal(authority.allows("policy.manage", { type: "workspace", resourceId: workspaceId }), true);
    assert.equal(authority.allows("usage.read", { type: "workspace", resourceId: workspaceId }), true,
      "catalog-v1 and catalog-v2 role assignments resolve in one authority union");
    assert.equal(authority.allows("workspace.manage", { type: "workspace", resourceId: workspaceId }), true);
    assert.equal(authority.allows("workspace.manage", { type: "workspace", resourceId: "workspace-b" }), false);

    const updated = await store.updateOrganizationRole({
      organizationId,
      roleId: reviewer.id,
      expectedVersion: 1,
      name: "Workspace policy manager",
      description: "Manages organization policy",
      grants: [{ permission: "policy.manage", scope: { type: "organization" } }],
      updatedBy: ownerId,
    });
    assert.equal(updated.version, 2);
    assert.equal((await store.resolveOrganizationAuthorization({ organizationId, membershipId: member.membershipId }))
      .allows("policy.manage", { type: "workspace", resourceId: "workspace-b" }), true);

    await assert.rejects(() => store.unassignOrganizationRole({
      organizationId,
      membershipId: member.membershipId,
      roleId: reviewer.id,
      unassignedBy: managerId,
    }), { code: "ROLE_DELEGATION_EXCEEDED" });
    await assert.rejects(() => store.archiveOrganizationRole({
      organizationId,
      roleId: reviewer.id,
      expectedVersion: updated.version,
      archivedBy: managerId,
    }), { code: "ROLE_DELEGATION_EXCEEDED" });
    await store.unassignOrganizationRole({
      organizationId,
      membershipId: member.membershipId,
      roleId: operator.id,
      unassignedBy: managerId,
    });
    const archivedDelegated = await store.archiveOrganizationRole({
      organizationId,
      roleId: delegated.id,
      expectedVersion: delegated.version,
      archivedBy: managerId,
    });
    assert.equal(archivedDelegated.role.status, "archived");
    assert.equal((await store.listOrganizationRoles(organizationId))
      .find((role) => role.id === reviewer.id)?.status, "active",
      "refused role mutations leave the stronger role and its assignment intact");

    await assert.rejects(() => store.assignOrganizationRole({
      organizationId: otherOrganizationId,
      membershipId: member.membershipId,
      roleId: reviewer.id,
      assignedBy: otherOwnerId,
    }), { code: "ROLE_ASSIGNMENT_INVALID" });
    await assert.rejects(() => store.createOrganizationRole({
      organizationId,
      name: "Owner delegate",
      description: "Must fail",
      grants: [{ permission: "organization.transfer_ownership", scope: { type: "organization" } }],
      createdBy: adminId,
    }), { code: "ROLE_DELEGATION_EXCEEDED" });
    await assert.rejects(() => store.createOrganizationRole({
      organizationId,
      name: "Foreign workspace",
      description: "Must fail",
      grants: [{ permission: "workspace.manage", scope: { type: "workspace", resourceId: foreignWorkspaceId } }],
      createdBy: adminId,
    }), { code: "ROLE_SCOPE_INVALID" });

    const events = await pool.query(
      `SELECT event_type FROM organization_role_audit_events
       WHERE organization_id=$1 ORDER BY occurred_at,id`,
      [organizationId],
    );
    const eventTypes = events.rows.map((row) => row.event_type);
    assert.equal(eventTypes.filter((event) => event === "role.created").length, 4);
    assert.equal(eventTypes.filter((event) => event === "role.assigned").length, 5);
    assert.equal(eventTypes.filter((event) => event === "role.updated").length, 1);
    assert.equal(eventTypes.filter((event) => event === "role.unassigned").length, 1);
    assert.equal(eventTypes.filter((event) => event === "role.archived").length, 1);
  } finally {
    await pool.end();
  }
});
