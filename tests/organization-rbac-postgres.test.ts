import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  backfillOrganizationRbac,
  organizationPermissionCatalogVersion,
  organizationPermissions,
  permissionsByOrganizationRole,
  PostgresIdentityPolicyStore,
  PostgresWorkspaceStore,
} from "@lemmacomputer/workspace-store";

const connectionString = process.env.ORGANIZATION_RBAC_TEST_DATABASE_URL;

test("organization RBAC backfill, identity resolution, membership sessions, and owner protection", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresIdentityPolicyStore(pool);
  const suffix = randomUUID().slice(0, 8);
  const alphaOrganization = `rbac-alpha-${suffix}`;
  const betaOrganization = `rbac-beta-${suffix}`;
  const alphaOwner = `rbac-alpha-owner-${suffix}`;
  const betaOwner = `rbac-beta-owner-${suffix}`;
  const sharedEmail = `same-${suffix}@example.test`;
  const issuer = `https://issuer.example.test/${suffix}`;
  const alphaSubject = `subject-alpha-${suffix}`;
  const betaSubject = `subject-beta-${suffix}`;
  try {
    await pool.query(
      `INSERT INTO tenants (id,external_tenant_id,display_name) VALUES
       ($1,$2,$3),($4,$5,$6)`,
      [alphaOrganization, `directory-alpha-${suffix}`, "Alpha", betaOrganization, `directory-beta-${suffix}`, "Beta"],
    );
    await pool.query(
      `INSERT INTO users (id,tenant_id,email,display_name) VALUES
       ($1,$2,$3,'Alpha Owner'),($4,$5,$3,'Beta Owner')`,
      [alphaOwner, alphaOrganization, sharedEmail, betaOwner, betaOrganization],
    );
    await pool.query(
      `INSERT INTO user_roles (user_id,role,assigned_by) VALUES
       ($1,'employee',$1),($1,'administrator',$1),
       ($2,'employee',$2),($2,'administrator',$2)`,
      [alphaOwner, betaOwner],
    );
    await pool.query(
      `INSERT INTO external_identities (
         id,user_id,provider,issuer,external_subject,external_tenant_id,email,last_authenticated_at
       ) VALUES
       ($1,$2,'fake',$3,$4,$5,$6,now()),
       ($7,$8,'fake',$3,$9,$10,$6,now())`,
      [
        randomUUID(), alphaOwner, issuer, alphaSubject, `directory-alpha-${suffix}`, sharedEmail,
        randomUUID(), betaOwner, betaSubject, `directory-beta-${suffix}`,
      ],
    );
    await pool.query(
      `INSERT INTO browser_sessions (id,token_hash,user_id,expires_at) VALUES
       ($1,$2,$3,now()+interval '1 hour'),($4,$5,$6,now()+interval '1 hour')`,
      [randomUUID(), `legacy-alpha-${suffix}`, alphaOwner, randomUUID(), `legacy-beta-${suffix}`, betaOwner],
    );

    const firstBackfill = await backfillOrganizationRbac(pool, 1);
    assert.equal(firstBackfill.usersBackfilled, 2);
    assert.deepEqual(
      { users: firstBackfill.remainingUsers, identities: firstBackfill.remainingIdentities, sessions: firstBackfill.remainingSessions },
      { users: 0, identities: 0, sessions: 0 },
    );
    const secondBackfill = await backfillOrganizationRbac(pool, 1);
    assert.equal(secondBackfill.usersBackfilled, 0, "the explicit backfill is idempotent");

    const sameEmailAccounts = await pool.query(
      `SELECT count(DISTINCT identity.account_user_id)::integer AS count
       FROM external_identities identity
       WHERE identity.issuer=$1 AND identity.email=$2`,
      [issuer, sharedEmail],
    );
    assert.equal(sameEmailAccounts.rows[0].count, 2, "email does not link immutable identities");

    const alphaProviderObjectId = `provider-object-alpha-${suffix}`;
    await pool.query(
      `UPDATE external_identities SET provider_object_id=$2
       WHERE provider='fake' AND issuer=$1 AND external_subject=$3`,
      [issuer, alphaProviderObjectId, alphaSubject],
    );

    const catalog = await pool.query(
      `SELECT permission_key FROM organization_permissions
       WHERE catalog_version=$1 ORDER BY permission_key`,
      [organizationPermissionCatalogVersion],
    );
    assert.deepEqual(catalog.rows.map((row) => row.permission_key), [...organizationPermissions].sort());
    const roleCatalog = await pool.query(
      `SELECT role,permission_key FROM organization_role_permissions
       WHERE catalog_version=$1 ORDER BY role,permission_key`,
      [organizationPermissionCatalogVersion],
    );
    for (const role of ["owner", "admin", "member"] as const) {
      assert.deepEqual(
        roleCatalog.rows.filter((row) => row.role === role).map((row) => row.permission_key),
        [...permissionsByOrganizationRole[role]].sort(),
      );
    }

    await assert.rejects(
      () => store.resolveAuthenticatedIdentity({
        provider: "fake",
        issuer,
        subject: alphaSubject,
        providerObjectId: `different-object-${suffix}`,
        externalTenantId: `directory-alpha-${suffix}`,
        email: sharedEmail,
        displayName: "Alpha Owner",
        organizationId: betaOrganization,
        organizationDisplayName: "Beta",
        userId: `ignored-${suffix}`,
        bootstrapOwner: false,
        membershipAdmissionMode: "directory-jit",
        gatewayUserId: `gateway-identifier-mismatch-${suffix}`,
      }),
      { code: "IDENTITY_IDENTIFIER_MISMATCH" },
    );

    const alphaInBeta = await store.resolveAuthenticatedIdentity({
      provider: "fake",
      issuer,
      subject: alphaSubject,
      providerObjectId: alphaProviderObjectId,
      externalTenantId: `directory-alpha-${suffix}`,
      email: sharedEmail,
      displayName: "Alpha Owner",
      organizationId: betaOrganization,
      organizationDisplayName: "Beta",
      userId: `ignored-${suffix}`,
      bootstrapOwner: false,
      membershipAdmissionMode: "directory-jit",
      gatewayUserId: `gateway-alpha-beta-${suffix}`,
    });
    assert.equal(alphaInBeta.accountUserId, (await store.getPrincipal(alphaOwner))?.accountUserId);
    assert.notEqual(alphaInBeta.userId, alphaOwner, "each organization gets a local subject");
    assert.equal(alphaInBeta.role, "member");

    await assert.rejects(
      () => store.resolveAuthenticatedIdentity({
        provider: "fake",
        issuer,
        subject: `hosted-unknown-${suffix}`,
        externalTenantId: `directory-alpha-${suffix}`,
        email: `unknown-${suffix}@example.test`,
        displayName: "Unknown",
        organizationId: alphaOrganization,
        organizationDisplayName: "Alpha",
        userId: `unknown-${suffix}`,
        bootstrapOwner: false,
        membershipAdmissionMode: "existing-membership-only",
        gatewayUserId: `gateway-unknown-${suffix}`,
      }),
      { code: "MEMBERSHIP_REQUIRED" },
    );

    const alphaPrincipal = await store.getPrincipal(alphaOwner);
    assert.ok(alphaPrincipal?.membershipId);
    await store.createSession({
      tokenHash: `session-alpha-${suffix}`,
      userId: alphaOwner,
      membershipId: alphaPrincipal.membershipId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.createSession({
      tokenHash: `session-alpha-beta-${suffix}`,
      userId: alphaInBeta.userId,
      membershipId: alphaInBeta.membershipId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const changed = await store.changeOrganizationMembership({
      organizationId: betaOrganization,
      targetUserId: alphaInBeta.userId,
      status: "suspended",
      updatedBy: betaOwner,
    });
    assert.equal(changed.revokedSessions, 1);
    assert.ok(await store.getSession(`session-alpha-${suffix}`, new Date()), "another organization session remains active");
    assert.equal(await store.getSession(`session-alpha-beta-${suffix}`, new Date()), null);
    const suspendedLegacyUser = await pool.query("SELECT status FROM users WHERE id=$1", [alphaInBeta.userId]);
    assert.equal(suspendedLegacyUser.rows[0].status, "disabled");

    await store.changeOrganizationMembership({
      organizationId: betaOrganization,
      targetUserId: alphaInBeta.userId,
      role: "admin",
      status: "active",
      updatedBy: betaOwner,
    });
    const reactivatedLegacyUser = await pool.query("SELECT status FROM users WHERE id=$1", [alphaInBeta.userId]);
    assert.equal(reactivatedLegacyUser.rows[0].status, "active");
    const administratorProjection = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id=$1 AND role='administrator'",
      [alphaInBeta.userId],
    );
    assert.equal(administratorProjection.rowCount, 1);
    await store.changeOrganizationMembership({
      organizationId: betaOrganization,
      targetUserId: alphaInBeta.userId,
      role: "member",
      updatedBy: betaOwner,
    });
    const removedAdministratorProjection = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id=$1 AND role='administrator'",
      [alphaInBeta.userId],
    );
    assert.equal(removedAdministratorProjection.rowCount, 0);
    await store.changeOrganizationMembership({
      organizationId: betaOrganization,
      targetUserId: alphaInBeta.userId,
      role: "admin",
      updatedBy: betaOwner,
    });
    const membershipAudit = await pool.query(
      `SELECT old_status,new_status,old_role,new_role
       FROM organization_membership_audit_events
       WHERE organization_id=$1 AND membership_id=$2 AND event_type='membership.changed'
       ORDER BY occurred_at`,
      [betaOrganization, alphaInBeta.membershipId],
    );
    assert.ok(membershipAudit.rowCount && membershipAudit.rowCount >= 4);
    assert.ok(membershipAudit.rows.some((row) => row.old_status === "active" && row.new_status === "suspended"));
    assert.ok(membershipAudit.rows.some((row) => row.old_role === "admin" && row.new_role === "member"));

    const workspaceStore = new PostgresWorkspaceStore(pool);
    const betaMemberIdentity = {
      tenantId: betaOrganization,
      subjectId: alphaInBeta.userId,
      audience: "lemmacomputer-control" as const,
    };
    const governedWorkspace = await workspaceStore.createOrGet(betaMemberIdentity, "rbac-revocation", randomUUID());
    const governedNow = new Date();
    const pendingOperation = await workspaceStore.createGovernedOperation({
      id: randomUUID(), identity: betaMemberIdentity, workspaceId: governedWorkspace.id,
      capabilityId: "m365-write-protected", serverName: "lemmacomputer_ms365", toolName: "send-mail",
      schemaId: "lemmacomputer.m365.send-mail.v1", arguments: { draftId: "redacted" },
      operationDigest: "7".repeat(64), nonce: randomUUID(), safeSummary: "Send a prepared email",
      resourceName: "Prepared email", resourceLocation: "Outlook Mail", correlationId: "rbac-revocation-create",
      idempotencyKey: randomUUID(), createdAt: governedNow, expiresAt: new Date(governedNow.getTime() + 60_000),
    });
    assert.ok(pendingOperation);
    assert.equal(await workspaceStore.cancelPendingGovernedOperations(
      { ...betaMemberIdentity, subjectId: betaOwner }, governedNow, "rbac-revocation-other",
    ), 0, "pending-operation revocation is user scoped");
    assert.equal(await workspaceStore.cancelPendingGovernedOperations(
      betaMemberIdentity, governedNow, "rbac-revocation-target",
    ), 1);
    assert.equal((await workspaceStore.getOwnedOperation(betaMemberIdentity, pendingOperation.id))?.failureCode, "MEMBERSHIP_ACCESS_REVOKED");
    const revocationAudit = await pool.query(
      "SELECT event_type FROM governed_operation_events WHERE operation_id=$1 ORDER BY id DESC LIMIT 1",
      [pendingOperation.id],
    );
    assert.equal(revocationAudit.rows[0].event_type, "access_revoked");
    assert.equal(await workspaceStore.cancelPendingGovernedOperations(
      betaMemberIdentity, governedNow, "rbac-revocation-replay",
    ), 0, "pending-operation cancellation is replay safe");

    const invitationNow = new Date("2026-08-07T00:00:00.000Z");
    const invitationExpiry = new Date("2026-08-14T00:00:00.000Z");
    const invitationCreated = await store.createOrganizationInvitation({
      organizationId: betaOrganization,
      email: `Invited-${suffix}@Example.Test`,
      role: "member",
      tokenHash: "a".repeat(64),
      idempotencyKeyHash: "1".repeat(64),
      expiresAt: invitationExpiry,
      createdBy: alphaInBeta.userId,
      now: invitationNow,
    });
    assert.equal(invitationCreated.replayed, false);
    assert.equal(invitationCreated.invitation.email, `invited-${suffix}@example.test`);
    assert.equal(invitationCreated.invitation.status, "pending");
    const invitationReplay = await store.createOrganizationInvitation({
      organizationId: betaOrganization,
      email: `invited-${suffix}@example.test`,
      role: "member",
      tokenHash: "b".repeat(64),
      idempotencyKeyHash: "1".repeat(64),
      expiresAt: invitationExpiry,
      createdBy: alphaInBeta.userId,
      now: invitationNow,
    });
    assert.equal(invitationReplay.replayed, true);
    assert.equal(invitationReplay.invitation.invitationId, invitationCreated.invitation.invitationId);
    await assert.rejects(
      () => store.createOrganizationInvitation({
        organizationId: betaOrganization,
        email: `different-${suffix}@example.test`,
        role: "member",
        tokenHash: "c".repeat(64),
        idempotencyKeyHash: "1".repeat(64),
        expiresAt: invitationExpiry,
        createdBy: alphaInBeta.userId,
        now: invitationNow,
      }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    await assert.rejects(
      () => store.createOrganizationInvitation({
        organizationId: betaOrganization,
        email: `owner-invite-${suffix}@example.test`,
        role: "owner",
        tokenHash: "d".repeat(64),
        idempotencyKeyHash: "2".repeat(64),
        expiresAt: invitationExpiry,
        createdBy: alphaInBeta.userId,
        now: invitationNow,
      }),
      { code: "OWNER_CHANGE_FORBIDDEN" },
    );
    const invitationResent = await store.resendOrganizationInvitation({
      organizationId: betaOrganization,
      invitationId: invitationCreated.invitation.invitationId,
      tokenHash: "e".repeat(64),
      idempotencyKeyHash: "3".repeat(64),
      expiresAt: new Date("2026-08-15T00:00:00.000Z"),
      updatedBy: alphaInBeta.userId,
      now: new Date("2026-08-08T00:00:00.000Z"),
    });
    assert.equal(invitationResent.invitation.deliveryGeneration, 2);
    const resendReplay = await store.resendOrganizationInvitation({
      organizationId: betaOrganization,
      invitationId: invitationCreated.invitation.invitationId,
      tokenHash: "f".repeat(64),
      idempotencyKeyHash: "3".repeat(64),
      expiresAt: new Date("2026-08-16T00:00:00.000Z"),
      updatedBy: alphaInBeta.userId,
      now: new Date("2026-08-09T00:00:00.000Z"),
    });
    assert.equal(resendReplay.replayed, true);
    assert.equal(resendReplay.invitation.deliveryGeneration, 2);
    const expiredInvitations = await store.listOrganizationInvitations(
      betaOrganization,
      new Date("2026-08-16T00:00:00.000Z"),
    );
    assert.equal(expiredInvitations.find((item) => item.invitationId === invitationCreated.invitation.invitationId)?.status, "expired");
    const expiredResent = await store.resendOrganizationInvitation({
      organizationId: betaOrganization,
      invitationId: invitationCreated.invitation.invitationId,
      tokenHash: "0".repeat(64),
      idempotencyKeyHash: "4".repeat(64),
      expiresAt: new Date("2026-08-24T00:00:00.000Z"),
      updatedBy: alphaInBeta.userId,
      now: new Date("2026-08-17T00:00:00.000Z"),
    });
    assert.equal(expiredResent.invitation.status, "pending");
    assert.equal(expiredResent.invitation.deliveryGeneration, 3);
    const invitationRevoked = await store.revokeOrganizationInvitation({
      organizationId: betaOrganization,
      invitationId: invitationCreated.invitation.invitationId,
      revokedBy: alphaInBeta.userId,
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    assert.equal(invitationRevoked.invitation.status, "revoked");
    const revokeReplay = await store.revokeOrganizationInvitation({
      organizationId: betaOrganization,
      invitationId: invitationCreated.invitation.invitationId,
      revokedBy: alphaInBeta.userId,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    assert.equal(revokeReplay.replayed, true);
    const invitationAudit = await pool.query(
      `SELECT event_type,old_status,new_status,delivery_generation
       FROM organization_invitation_audit_events
       WHERE organization_id=$1 AND invitation_id=$2
       ORDER BY occurred_at,id`,
      [betaOrganization, invitationCreated.invitation.invitationId],
    );
    assert.deepEqual(invitationAudit.rows.map((row) => row.event_type), [
      "invitation.created",
      "invitation.resent",
      "invitation.resent",
      "invitation.revoked",
    ]);
    assert.equal(invitationAudit.rows[2].old_status, "expired");
    assert.equal(invitationAudit.rows[2].delivery_generation, 3);
    await store.createSession({
      tokenHash: `session-alpha-beta-compat-${suffix}`,
      userId: alphaInBeta.userId,
      membershipId: alphaInBeta.membershipId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await assert.rejects(
      () => store.setUserStatus({
        tenantId: betaOrganization,
        targetUserId: betaOwner,
        status: "disabled",
        updatedBy: alphaInBeta.userId,
      }),
      { code: "OWNER_CHANGE_FORBIDDEN" },
    );
    const compatibilityDisable = await store.setUserStatus({
      tenantId: betaOrganization,
      targetUserId: alphaInBeta.userId,
      status: "disabled",
      updatedBy: betaOwner,
    });
    assert.equal(compatibilityDisable.revokedSessions, 1);
    assert.equal(await store.getSession(`session-alpha-beta-compat-${suffix}`, new Date()), null);

    await assert.rejects(
      () => store.changeOrganizationMembership({
        organizationId: betaOrganization,
        targetUserId: betaOwner,
        status: "suspended",
        updatedBy: betaOwner,
      }),
      { code: "LAST_OWNER_REQUIRED" },
    );
    await assert.rejects(
      () => pool.query(
        "DELETE FROM organization_memberships WHERE organization_id=$1 AND subject_user_id=$2",
        [betaOrganization, betaOwner],
      ),
      /organization must retain at least one active owner/,
    );
  } finally {
    await store.close();
  }
});
