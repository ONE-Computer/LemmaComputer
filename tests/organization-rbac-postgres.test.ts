import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

    const unattachedBetterAuthUserId = randomUUID();
    assert.deepEqual(await store.ensureCustomerAccount({ accountUserId: unattachedBetterAuthUserId }), {
      accountUserId: unattachedBetterAuthUserId,
      status: "active",
    });
    assert.deepEqual(await store.listCustomerMemberships(unattachedBetterAuthUserId), [],
      "authentication alone grants no organization membership");

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
    assert.ok(alphaPrincipal.accountUserId);
    assert.deepEqual(
      (await store.listCustomerMemberships(alphaPrincipal.accountUserId)).map((membership) => membership.organizationId).sort(),
      [alphaOrganization, betaOrganization].sort(),
    );
    await store.createSession({
      tokenHash: `session-alpha-${suffix}`,
      userId: alphaOwner,
      membershipId: alphaPrincipal.membershipId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const betterAuthSessionId = randomUUID();
    const selectedBeta = await store.selectCustomerProductSession({
      authenticationSessionId: betterAuthSessionId,
      accountUserId: alphaPrincipal.accountUserId,
      membershipId: alphaInBeta.membershipId,
      expiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    assert.equal(selectedBeta.tenantId, betaOrganization);
    assert.equal((await store.getCustomerProductSession({
      authenticationSessionId: betterAuthSessionId,
      accountUserId: alphaPrincipal.accountUserId,
      now: new Date(),
    }))?.membershipId, alphaInBeta.membershipId);
    await assert.rejects(() => store.selectCustomerProductSession({
      authenticationSessionId: randomUUID(),
      accountUserId: unattachedBetterAuthUserId,
      membershipId: alphaInBeta.membershipId,
      expiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    }), { code: "MEMBERSHIP_NOT_ACTIVE" });
    const changed = await store.changeOrganizationMembership({
      organizationId: betaOrganization,
      targetUserId: alphaInBeta.userId,
      status: "suspended",
      updatedBy: betaOwner,
    });
    assert.equal(changed.revokedSessions, 1);
    assert.ok(await store.getSession(`session-alpha-${suffix}`, new Date()), "another organization session remains active");
    assert.equal(await store.getCustomerProductSession({
      authenticationSessionId: betterAuthSessionId,
      accountUserId: alphaPrincipal.accountUserId,
      now: new Date(),
    }), null);
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

test("hosted invitation acceptance is tenant-bound, one-time, and commits membership, session, and audit together", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresIdentityPolicyStore(pool);
  const suffix = randomUUID().slice(0, 8);
  const alphaOrganization = `invite-alpha-${suffix}`;
  const betaOrganization = `invite-beta-${suffix}`;
  const alphaOwner = `invite-alpha-owner-${suffix}`;
  const betaOwner = `invite-beta-owner-${suffix}`;
  const issuer = `https://external-${suffix}.ciamlogin.com/external-directory-${suffix}/v2.0`;
  const externalTenantId = `external-directory-${suffix}`;
  const now = new Date();
  const future = new Date(now.getTime() + 60 * 60_000);
  const past = new Date(now.getTime() - 60 * 60_000);
  const hash = (value: string) => createHash("sha256").update(`${suffix}:${value}`).digest("hex");

  const createOrganizationOwner = async (
    organizationId: string,
    ownerId: string,
    externalDirectoryId: string,
    displayName: string,
  ) => {
    const account = await pool.query("INSERT INTO account_users (status) VALUES ('active') RETURNING id");
    const accountUserId = String(account.rows[0].id);
    await pool.query(
      "INSERT INTO tenants (id,external_tenant_id,display_name,administrator_bootstrapped_at) VALUES ($1,$2,$3,now())",
      [organizationId, externalDirectoryId, displayName],
    );
    await pool.query(
      "INSERT INTO organizations (id,display_name) VALUES ($1,$2)",
      [organizationId, displayName],
    );
    await pool.query(
      `INSERT INTO users (id,tenant_id,account_user_id,email,display_name)
       VALUES ($1,$2,$3,$4,$5)`,
      [ownerId, organizationId, accountUserId, `${ownerId}@example.test`, `${displayName} Owner`],
    );
    await pool.query(
      `INSERT INTO organization_memberships (
         organization_id,account_user_id,subject_user_id,status,role,created_by,updated_by
       ) VALUES ($1,$2,$3,'active','owner',$3,$3)`,
      [organizationId, accountUserId, ownerId],
    );
    await pool.query(
      `INSERT INTO user_roles (user_id,role,assigned_by) VALUES
       ($1,'employee',$1),($1,'administrator',$1)`,
      [ownerId],
    );
  };

  const createInvitation = async (input: {
    organizationId?: string;
    ownerId?: string;
    email: string;
    role?: "owner" | "admin" | "member";
    rawToken: string;
    expiresAt?: Date;
  }) => store.createOrganizationInvitation({
    organizationId: input.organizationId ?? alphaOrganization,
    email: input.email,
    role: input.role ?? "member",
    tokenHash: hash(input.rawToken),
    idempotencyKeyHash: hash(`idempotency:${input.rawToken}`),
    expiresAt: input.expiresAt ?? future,
    createdBy: input.ownerId ?? alphaOwner,
    now,
  });

  const invitedIdentity = (input: {
    email: string;
    rawToken: string;
    subject: string;
    organizationId?: string;
    provider?: string;
    sessionTokenHash?: string;
  }) => ({
    provider: input.provider ?? "entra-external-id",
    issuer,
    subject: input.subject,
    providerObjectId: `object-${input.subject}`,
    externalTenantId,
    email: input.email,
    displayName: input.email.split("@")[0]!,
    organizationId: input.organizationId ?? alphaOrganization,
    organizationDisplayName: input.organizationId === betaOrganization ? "Invitation Beta" : "Invitation Alpha",
    userId: `user-${input.subject}`,
    bootstrapOwner: false,
    membershipAdmissionMode: "existing-membership-only" as const,
    gatewayUserId: `gateway-${input.subject}`,
    invitationTokenHash: hash(input.rawToken),
    browserSession: {
      tokenHash: input.sessionTokenHash ?? hash(`session:${input.subject}`),
      expiresAt: future,
    },
  });

  const assertGenericInvitationFailure = async (operation: () => Promise<unknown>) => {
    await assert.rejects(operation, (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "INVITATION_SIGNIN_FAILED");
      assert.equal((error as { message?: unknown }).message, "This invitation cannot be used to sign in");
      return true;
    });
  };

  try {
    await createOrganizationOwner(alphaOrganization, alphaOwner, `product-alpha-${suffix}`, "Invitation Alpha");
    await createOrganizationOwner(betaOrganization, betaOwner, `product-beta-${suffix}`, "Invitation Beta");

    const acceptedEmail = `accepted-${suffix}@example.test`;
    const acceptedRawToken = `oci_${randomUUID()}_accepted`;
    const accepted = await createInvitation({
      email: acceptedEmail,
      role: "admin",
      rawToken: acceptedRawToken,
    });
    const acceptedSubject = `accepted-subject-${suffix}`;
    const acceptedSessionHash = hash("accepted-session");

    // Force the final access-audit insert to violate its provider constraint.
    // Every earlier invitation, membership, identity, and session write must roll
    // back with that failure so the exact same invitation remains retryable.
    await assert.rejects(
      () => store.resolveAuthenticatedIdentity(invitedIdentity({
        email: acceptedEmail,
        rawToken: acceptedRawToken,
        subject: acceptedSubject,
        provider: "unsupported-provider",
        sessionTokenHash: hash("rolled-back-session"),
      })),
      /organization_access_audit_events_provider_check/,
    );
    const rolledBackInvitation = await pool.query(
      "SELECT status,accepted_membership_id FROM organization_invitations WHERE id=$1",
      [accepted.invitation.invitationId],
    );
    assert.deepEqual(rolledBackInvitation.rows[0], { status: "pending", accepted_membership_id: null });
    assert.equal((await pool.query(
      "SELECT 1 FROM external_identities WHERE issuer=$1 AND external_subject=$2",
      [issuer, acceptedSubject],
    )).rowCount, 0);
    assert.equal((await pool.query(
      "SELECT 1 FROM browser_sessions WHERE token_hash=$1",
      [hash("rolled-back-session")],
    )).rowCount, 0);
    assert.equal((await pool.query(
      "SELECT 1 FROM organization_access_audit_events WHERE invitation_id=$1",
      [accepted.invitation.invitationId],
    )).rowCount, 0);

    const principal = await store.resolveAuthenticatedIdentity(invitedIdentity({
      email: acceptedEmail,
      rawToken: acceptedRawToken,
      subject: acceptedSubject,
      sessionTokenHash: acceptedSessionHash,
    }));
    assert.equal(principal.organizationId, alphaOrganization);
    assert.equal(principal.role, "admin", "the invitation, not provider claims or defaults, selects the role");
    assert.equal(principal.roles.includes("administrator"), true);

    const committed = await pool.query(
      `SELECT invitation.status,invitation.accepted_membership_id,
         membership.role,membership.subject_user_id,
         session.token_hash,access.event_type,access.provider
       FROM organization_invitations invitation
       JOIN organization_memberships membership
         ON membership.organization_id=invitation.organization_id
        AND membership.id=invitation.accepted_membership_id
       JOIN browser_sessions session ON session.membership_id=membership.id
       JOIN organization_access_audit_events access
         ON access.organization_id=invitation.organization_id
        AND access.membership_id=membership.id
        AND access.invitation_id=invitation.id
       WHERE invitation.id=$1 AND session.token_hash=$2`,
      [accepted.invitation.invitationId, acceptedSessionHash],
    );
    assert.equal(committed.rowCount, 1);
    assert.deepEqual(committed.rows[0], {
      status: "accepted",
      accepted_membership_id: principal.membershipId,
      role: "admin",
      subject_user_id: principal.userId,
      token_hash: acceptedSessionHash,
      event_type: "authentication.login_succeeded",
      provider: "entra-external-id",
    });

    const rejectionCases: ReadonlyArray<{
      name: string;
      email: string;
      authenticatedEmail: string;
      rawToken: string;
      subject: string;
      expiresAt?: Date;
      revoke?: boolean;
      organizationId?: string;
      expectedStatus: "pending" | "revoked";
    }> = [
      {
        name: "wrong email",
        email: `wrong-email-invite-${suffix}@example.test`,
        authenticatedEmail: `different-authenticated-${suffix}@example.test`,
        rawToken: `oci_${randomUUID()}_wrong_email`,
        subject: `wrong-email-${suffix}`,
        expectedStatus: "pending",
      },
      {
        name: "expired",
        email: `expired-${suffix}@example.test`,
        authenticatedEmail: `expired-${suffix}@example.test`,
        rawToken: `oci_${randomUUID()}_expired`,
        subject: `expired-${suffix}`,
        expiresAt: past,
        expectedStatus: "pending",
      },
      {
        name: "revoked",
        email: `revoked-${suffix}@example.test`,
        authenticatedEmail: `revoked-${suffix}@example.test`,
        rawToken: `oci_${randomUUID()}_revoked`,
        subject: `revoked-${suffix}`,
        revoke: true,
        expectedStatus: "revoked",
      },
      {
        name: "cross organization",
        email: `cross-org-${suffix}@example.test`,
        authenticatedEmail: `cross-org-${suffix}@example.test`,
        rawToken: `oci_${randomUUID()}_cross_org`,
        subject: `cross-org-${suffix}`,
        organizationId: betaOrganization,
        expectedStatus: "pending",
      },
    ];

    for (const rejection of rejectionCases) {
      const invitation = await createInvitation({
        email: rejection.email,
        rawToken: rejection.rawToken,
        ...(rejection.expiresAt ? { expiresAt: rejection.expiresAt } : {}),
      });
      if (rejection.revoke) {
        await store.revokeOrganizationInvitation({
          organizationId: alphaOrganization,
          invitationId: invitation.invitation.invitationId,
          revokedBy: alphaOwner,
          now,
        });
      }
      await assertGenericInvitationFailure(() => store.resolveAuthenticatedIdentity(invitedIdentity({
        email: rejection.authenticatedEmail,
        rawToken: rejection.rawToken,
        subject: rejection.subject,
        ...(rejection.organizationId ? { organizationId: rejection.organizationId } : {}),
      })));
      const unchanged = await pool.query(
        "SELECT status,accepted_membership_id FROM organization_invitations WHERE id=$1",
        [invitation.invitation.invitationId],
      );
      assert.deepEqual(
        unchanged.rows[0],
        { status: rejection.expectedStatus, accepted_membership_id: null },
        `${rejection.name} must not mutate invitation acceptance`,
      );
      assert.equal((await pool.query(
        "SELECT 1 FROM external_identities WHERE issuer=$1 AND external_subject=$2",
        [issuer, rejection.subject],
      )).rowCount, 0, `${rejection.name} must not persist an external identity`);
    }

    const concurrentEmail = `concurrent-${suffix}@example.test`;
    const concurrentRawToken = `oci_${randomUUID()}_concurrent`;
    const concurrentInvitation = await createInvitation({
      email: concurrentEmail,
      rawToken: concurrentRawToken,
    });
    const concurrentSubjects = [`concurrent-a-${suffix}`, `concurrent-b-${suffix}`];
    const concurrentSessionHashes = [hash("concurrent-session-a"), hash("concurrent-session-b")];
    const concurrentResults = await Promise.allSettled(concurrentSubjects.map((subject, index) => (
      store.resolveAuthenticatedIdentity(invitedIdentity({
        email: concurrentEmail,
        rawToken: concurrentRawToken,
        subject,
        sessionTokenHash: concurrentSessionHashes[index]!,
      }))
    )));
    const concurrentSuccesses = concurrentResults.filter((result) => result.status === "fulfilled");
    const concurrentFailures = concurrentResults.filter((result) => result.status === "rejected");
    assert.equal(concurrentSuccesses.length, 1, "one immutable identity wins concurrent invitation acceptance");
    assert.equal(concurrentFailures.length, 1, "the other concurrent identity is denied");
    assert.equal((concurrentFailures[0] as PromiseRejectedResult).reason?.code, "INVITATION_SIGNIN_FAILED");
    assert.equal(
      (concurrentFailures[0] as PromiseRejectedResult).reason?.message,
      "This invitation cannot be used to sign in",
    );
    const concurrentCommitted = await pool.query(
      `SELECT invitation.status,invitation.accepted_membership_id,
         count(DISTINCT session.id)::integer AS sessions,
         count(DISTINCT access.id)::integer AS login_events
       FROM organization_invitations invitation
       LEFT JOIN browser_sessions session
         ON session.membership_id=invitation.accepted_membership_id
       LEFT JOIN organization_access_audit_events access
         ON access.invitation_id=invitation.id
        AND access.event_type='authentication.login_succeeded'
       WHERE invitation.id=$1
       GROUP BY invitation.status,invitation.accepted_membership_id`,
      [concurrentInvitation.invitation.invitationId],
    );
    assert.deepEqual(concurrentCommitted.rows[0], {
      status: "accepted",
      accepted_membership_id: (concurrentSuccesses[0] as PromiseFulfilledResult<{ membershipId?: string }>).value.membershipId,
      sessions: 1,
      login_events: 1,
    });
    assert.equal((await pool.query(
      `SELECT count(*)::integer AS count FROM external_identities
       WHERE issuer=$1 AND external_subject=ANY($2::text[])`,
      [issuer, concurrentSubjects],
    )).rows[0].count, 1, "the losing concurrent identity leaves no mapping");

    const replaySessionHash = hash("replay-session");
    await assertGenericInvitationFailure(() => store.resolveAuthenticatedIdentity(invitedIdentity({
      email: acceptedEmail,
      rawToken: acceptedRawToken,
      subject: acceptedSubject,
      sessionTokenHash: replaySessionHash,
    })));
    assert.equal((await pool.query(
      "SELECT 1 FROM browser_sessions WHERE token_hash=$1",
      [replaySessionHash],
    )).rowCount, 0, "an accepted invitation cannot mint another session");
    assert.equal((await pool.query(
      `SELECT count(*)::integer AS count FROM organization_access_audit_events
       WHERE invitation_id=$1 AND event_type='authentication.login_succeeded'`,
      [accepted.invitation.invitationId],
    )).rows[0].count, 1, "invitation replay cannot append another successful login event");

    const accessAuditColumns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='organization_access_audit_events'
       ORDER BY column_name`,
    );
    assert.deepEqual(accessAuditColumns.rows.map((row) => row.column_name), [
      "actor_user_id",
      "event_type",
      "id",
      "invitation_id",
      "membership_id",
      "occurred_at",
      "organization_id",
      "provider",
      "reason_code",
    ]);
    const accessAuditPayload = await pool.query(
      "SELECT row_to_json(event)::text AS payload FROM organization_access_audit_events event WHERE invitation_id=$1",
      [accepted.invitation.invitationId],
    );
    const serializedAudit = accessAuditPayload.rows.map((row) => row.payload).join("\n");
    for (const secret of [
      acceptedRawToken,
      "provider-authorization-code-must-not-be-stored",
      "provider-access-or-id-token-must-not-be-stored",
    ]) assert.doesNotMatch(serializedAudit, new RegExp(secret));
  } finally {
    await store.close();
  }
});
