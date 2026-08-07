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
