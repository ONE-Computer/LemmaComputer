import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { PostgresIdentityPolicyStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.BETTER_AUTH_INVITATION_TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("Better Auth invitation activation is generation-bound, exact-email, one-time, and atomic", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresIdentityPolicyStore(pool);
  const organizationId = randomUUID();
  const ownerId = `owner-${randomUUID()}`;
  const ownerAccountId = randomUUID();
  const now = new Date("2026-08-09T02:00:00.000Z");
  const invitationExpiry = new Date("2026-08-16T02:00:00.000Z");
  const sessionExpiry = new Date("2026-08-10T02:00:00.000Z");

  const createInvitation = async (email: string, rawToken: string) => store.createOrganizationInvitation({
    organizationId,
    email,
    role: "admin",
    tokenHash: hash(rawToken),
    idempotencyKeyHash: hash(`create:${rawToken}`),
    expiresAt: invitationExpiry,
    createdBy: ownerId,
    now,
  });
  const prepare = (rawToken: string, contextToken: string) => store.createCustomerInvitationContext({
    invitationTokenHash: hash(rawToken),
    contextTokenHash: hash(contextToken),
    expiresAt: new Date(now.getTime() + 20 * 60_000),
    now,
  });
  const accept = (input: { contextToken: string; accountUserId: string; email: string; sessionId?: string }) => (
    store.acceptCustomerInvitation({
      accountUserId: input.accountUserId,
      authenticationSessionId: input.sessionId ?? randomUUID(),
      contextTokenHash: hash(input.contextToken),
      email: input.email,
      userDisplayName: "Invited Administrator",
      expiresAt: sessionExpiry,
      now: new Date(now.getTime() + 60_000),
    })
  );
  const genericFailure = async (operation: () => Promise<unknown>) => assert.rejects(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "INVITATION_SIGNIN_FAILED");
    assert.equal((error as { message?: unknown }).message, "This invitation cannot be used to sign in");
    return true;
  });

  try {
    await pool.query(
      `INSERT INTO tenants (id,external_tenant_id,display_name,administrator_bootstrapped_at)
       VALUES ($1,$2,'Invitation Organization',now())`,
      [organizationId, `directory-${organizationId}`],
    );
    await pool.query(
      "INSERT INTO organizations (id,display_name,status) VALUES ($1,'Invitation Organization','active')",
      [organizationId],
    );
    await pool.query("INSERT INTO account_users (id,status) VALUES ($1,'active')", [ownerAccountId]);
    await pool.query(
      `INSERT INTO users (id,tenant_id,account_user_id,email,display_name)
       VALUES ($1,$2,$3,'owner@example.test','Owner')`,
      [ownerId, organizationId, ownerAccountId],
    );
    await pool.query(
      `INSERT INTO organization_memberships (
         organization_id,account_user_id,subject_user_id,status,role,created_by,updated_by
       ) VALUES ($1,$2,$3,'active','owner',$3,$3)`,
      [organizationId, ownerAccountId, ownerId],
    );

    const acceptedEmail = `accepted-${randomUUID()}@example.test`;
    const rawToken = `oci_${randomUUID().replaceAll("-", "")}`;
    const contextToken = `oic_${randomUUID().replaceAll("-", "")}`;
    const invitation = await createInvitation(acceptedEmail, rawToken);
    const context = await prepare(rawToken, contextToken);
    assert.equal(context.organizationDisplayName, "Invitation Organization");
    assert.equal(context.role, "admin");
    const restored = await store.getCustomerInvitationContext({ contextTokenHash: hash(contextToken), now });
    assert.deepEqual(restored, {
      organizationId,
      organizationDisplayName: "Invitation Organization",
      email: acceptedEmail,
      role: "admin",
      expiresAt: new Date(now.getTime() + 20 * 60_000),
    });

    const accountUserId = randomUUID();
    const authenticationSessionId = randomUUID();
    const principal = await accept({ contextToken, accountUserId, email: acceptedEmail, sessionId: authenticationSessionId });
    assert.equal(principal.organizationId, organizationId);
    assert.equal(principal.role, "admin");
    assert.equal(principal.accountUserId, accountUserId);
    const effectivePolicy = await store.getEffectivePolicy(principal.userId);
    assert.ok(effectivePolicy, "an accepted member receives the organization default workspace policy");
    const policyAssignment = await pool.query(
      "SELECT tenant_id,user_id FROM policy_assignments WHERE id=$1 AND revoked_at IS NULL",
      [effectivePolicy.assignmentId],
    );
    assert.deepEqual(policyAssignment.rows[0], { tenant_id: organizationId, user_id: principal.userId });
    const invitedDefaultTeam = await pool.query(
      `SELECT unit.display_name,membership.user_id
       FROM default_spending_team_assignments assignment
       JOIN allocation_units unit
         ON unit.tenant_id=assignment.tenant_id AND unit.id=assignment.allocation_unit_id
       JOIN allocation_memberships membership
         ON membership.tenant_id=assignment.tenant_id
        AND membership.allocation_unit_id=assignment.allocation_unit_id
        AND membership.user_id=assignment.user_id
        AND membership.effective_to IS NULL
       WHERE assignment.tenant_id=$1 AND assignment.user_id=$2
         AND assignment.effective_to IS NULL`,
      [organizationId, principal.userId],
    );
    assert.deepEqual(invitedDefaultTeam.rows, [{
      display_name: "Everyone",
      user_id: principal.userId,
    }]);
    const committed = await pool.query(
      `SELECT invitation.status,invitation.accepted_membership_id,
         membership.role,session.authentication_session_id,context.consumed_at IS NOT NULL AS consumed,
         count(audit.id)::integer AS login_events
       FROM organization_invitations invitation
       JOIN organization_memberships membership ON membership.id=invitation.accepted_membership_id
       JOIN browser_sessions session ON session.membership_id=membership.id
       JOIN organization_invitation_activation_contexts context ON context.invitation_id=invitation.id
       LEFT JOIN organization_access_audit_events audit
         ON audit.invitation_id=invitation.id AND audit.event_type='authentication.login_succeeded'
       WHERE invitation.id=$1
       GROUP BY invitation.status,invitation.accepted_membership_id,membership.role,
         session.authentication_session_id,context.consumed_at`,
      [invitation.invitation.invitationId],
    );
    assert.deepEqual(committed.rows[0], {
      status: "accepted",
      accepted_membership_id: principal.membershipId,
      role: "admin",
      authentication_session_id: authenticationSessionId,
      consumed: true,
      login_events: 1,
    });
    const serialized = JSON.stringify((await pool.query(
      `SELECT invitation.token_hash,context.context_token_hash,audit.*
       FROM organization_invitations invitation
       JOIN organization_invitation_activation_contexts context ON context.invitation_id=invitation.id
       JOIN organization_access_audit_events audit ON audit.invitation_id=invitation.id
       WHERE invitation.id=$1`,
      [invitation.invitation.invitationId],
    )).rows);
    assert.doesNotMatch(serialized, new RegExp(rawToken));
    assert.doesNotMatch(serialized, new RegExp(contextToken));
    await genericFailure(() => accept({ contextToken, accountUserId, email: acceptedEmail }));
    await genericFailure(() => store.getCustomerInvitationContext({ contextTokenHash: hash(contextToken), now }));

    const wrongEmail = `wrong-${randomUUID()}@example.test`;
    const wrongToken = `oci_${randomUUID().replaceAll("-", "")}`;
    const wrongContext = `oic_${randomUUID().replaceAll("-", "")}`;
    const wrongInvitation = await createInvitation(wrongEmail, wrongToken);
    await prepare(wrongToken, wrongContext);
    await genericFailure(() => accept({
      contextToken: wrongContext,
      accountUserId: randomUUID(),
      email: `different-${randomUUID()}@example.test`,
    }));
    assert.equal((await pool.query(
      "SELECT status FROM organization_invitations WHERE id=$1",
      [wrongInvitation.invitation.invitationId],
    )).rows[0].status, "pending");
    assert.equal((await pool.query(
      "SELECT attempt_count FROM organization_invitation_activation_contexts WHERE context_token_hash=$1",
      [hash(wrongContext)],
    )).rows[0].attempt_count, 1);

    const supersededEmail = `superseded-${randomUUID()}@example.test`;
    const oldToken = `oci_${randomUUID().replaceAll("-", "")}`;
    const oldContext = `oic_${randomUUID().replaceAll("-", "")}`;
    const superseded = await createInvitation(supersededEmail, oldToken);
    await prepare(oldToken, oldContext);
    const newToken = `oci_${randomUUID().replaceAll("-", "")}`;
    await store.resendOrganizationInvitation({
      organizationId,
      invitationId: superseded.invitation.invitationId,
      tokenHash: hash(newToken),
      idempotencyKeyHash: hash(`resend:${newToken}`),
      expiresAt: invitationExpiry,
      updatedBy: ownerId,
      now: new Date(now.getTime() + 30_000),
    });
    await genericFailure(() => store.getCustomerInvitationContext({ contextTokenHash: hash(oldContext), now }));
    await genericFailure(() => accept({
      contextToken: oldContext,
      accountUserId: randomUUID(),
      email: supersededEmail,
    }));
    const newContext = `oic_${randomUUID().replaceAll("-", "")}`;
    await prepare(newToken, newContext);
    assert.equal((await accept({
      contextToken: newContext,
      accountUserId: randomUUID(),
      email: supersededEmail,
    })).role, "admin");

    for (let index = 0; index < 16; index += 1) {
      const rateToken = `oci_${randomUUID().replaceAll("-", "")}`;
      await createInvitation(`rate-${index}-${randomUUID()}@example.test`, rateToken);
    }
    await assert.rejects(
      () => createInvitation(`rate-limited-${randomUUID()}@example.test`, `oci_${randomUUID().replaceAll("-", "")}`),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "INVITATION_RATE_LIMITED");
        assert.equal((error as { statusCode?: unknown }).statusCode, 429);
        return true;
      },
    );
  } finally {
    await store.close();
  }
});
