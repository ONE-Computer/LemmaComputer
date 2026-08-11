import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { LemmaComputerError } from "@lemmacomputer/contracts";
import { PostgresIdentityPolicyStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.ORGANIZATION_RBAC_TEST_DATABASE_URL;

test("tenant SSO projections are tenant-scoped, permissioned, and fail closed through enforcement", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresIdentityPolicyStore(pool);
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `sso-${suffix}`;
  const otherOrganizationId = `sso-other-${suffix}`;
  const ownerId = `sso-owner-${suffix}`;
  const adminId = `sso-admin-${suffix}`;
  const memberId = `sso-member-${suffix}`;
  const otherOwnerId = `sso-other-owner-${suffix}`;
  const ownerAccount = randomUUID();
  const adminAccount = randomUUID();
  const memberAccount = randomUUID();
  const otherOwnerAccount = randomUUID();
  try {
    await pool.query(
      "INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'SSO'),($3,$4,'Other SSO')",
      [organizationId, `directory-${organizationId}`, otherOrganizationId, `directory-${otherOrganizationId}`],
    );
    await pool.query(
      "INSERT INTO organizations (id,display_name) VALUES ($1,'SSO'),($2,'Other SSO')",
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      "INSERT INTO account_users (id,status) VALUES ($1,'active'),($2,'active'),($3,'active'),($4,'active')",
      [ownerAccount, adminAccount, memberAccount, otherOwnerAccount],
    );
    await pool.query(
      `INSERT INTO users (id,tenant_id,email,display_name,account_user_id) VALUES
        ($1,$5,$1 || '@example.test','Owner',$7),
        ($2,$5,$2 || '@example.test','Admin',$8),
        ($3,$5,$3 || '@example.test','Member',$9),
        ($4,$6,$4 || '@example.test','Other owner',$10)`,
      [ownerId, adminId, memberId, otherOwnerId, organizationId, otherOrganizationId,
        ownerAccount, adminAccount, memberAccount, otherOwnerAccount],
    );
    await pool.query(
      `INSERT INTO organization_memberships (
        organization_id,account_user_id,subject_user_id,status,role,created_by,updated_by
      ) VALUES
        ($1,$3,$7,'active','owner',$7,$7),
        ($1,$4,$8,'active','admin',$7,$7),
        ($1,$5,$9,'active','member',$7,$7),
        ($2,$6,$10,'active','owner',$10,$10)`,
      [organizationId, otherOrganizationId, ownerAccount, adminAccount, memberAccount, otherOwnerAccount,
        ownerId, adminId, memberId, otherOwnerId],
    );

    await assert.rejects(() => store.createOrganizationSsoConnection!({
      organizationId,
      authenticationProviderId: `sso_${suffix}_denied`,
      protocol: "oidc",
      domain: `denied-${suffix}.example.test`,
      issuer: "https://idp.example.test/denied",
      createdBy: memberId,
    }), { code: "SSO_ACTOR_INVALID" });

    const connection = await store.createOrganizationSsoConnection!({
      organizationId,
      authenticationProviderId: `sso_${suffix}`,
      protocol: "oidc",
      domain: `${suffix}.example.test`,
      issuer: "https://idp.example.test",
      createdBy: adminId,
    });
    assert.equal(connection.state, "pending");
    assert.equal(connection.organizationId, organizationId);
    assert.equal(connection.domainVerifiedAt, null);
    assert.equal(connection.lastTestedAt, null);
    assert.equal(connection.recoveryConfirmedAt, null);

    await assert.rejects(() => store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "test_succeeded",
      actorUserId: adminId,
    }), { code: "SSO_DOMAIN_NOT_VERIFIED" });
    const denial = async (connectionId: string) => {
      try {
        await store.transitionOrganizationSsoConnection!({
          organizationId: otherOrganizationId,
          connectionId,
          action: "domain_verified",
          actorUserId: otherOwnerId,
        });
        assert.fail("SSO connection transition should be denied");
      } catch (error) {
        assert.ok(error instanceof LemmaComputerError);
        return { code: error.code, message: error.message, statusCode: error.statusCode, retryable: error.retryable };
      }
    };
    assert.deepEqual(
      await denial(connection.id),
      await denial(randomUUID()),
      "a foreign SSO connection must be indistinguishable from a nonexistent connection",
    );

    const domainVerified = await store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "domain_verified",
      actorUserId: adminId,
    });
    assert.ok(domainVerified.domainVerifiedAt);
    assert.equal(domainVerified.state, "pending");

    const tested = await store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "test_succeeded",
      actorUserId: adminId,
    });
    assert.equal(tested.state, "active");
    assert.ok(tested.lastTestedAt);
    assert.equal(await store.findEnforcedOrganizationSsoConnectionByDomain!(`${suffix}.example.test`), null);

    await assert.rejects(() => store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "enforce",
      actorUserId: ownerId,
    }), { code: "SSO_RECOVERY_NOT_CONFIRMED" });
    await assert.rejects(() => store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "recovery_confirmed",
      actorUserId: adminId,
    }), { code: "SSO_OWNER_REQUIRED" });

    const recovery = await store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "recovery_confirmed",
      actorUserId: ownerId,
    });
    assert.ok(recovery.recoveryConfirmedAt);
    const enforced = await store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "enforce",
      actorUserId: ownerId,
    });
    assert.equal(enforced.state, "enforced");
    assert.equal(
      (await store.findEnforcedOrganizationSsoConnectionByDomain!(`${suffix.toUpperCase()}.EXAMPLE.TEST`))?.id,
      connection.id,
    );

    const rotation = await store.prepareOrganizationSsoConfigurationChange!({
      organizationId,
      connectionId: connection.id,
      change: "credentials_rotated",
      actorUserId: adminId,
    });
    assert.equal(rotation.state, "pending");
    assert.equal(rotation.configVersion, 2);
    assert.ok(rotation.domainVerifiedAt, "an unchanged email domain remains verified");
    assert.equal(rotation.lastTestedAt, null);
    assert.equal(rotation.recoveryConfirmedAt, null);
    assert.equal(rotation.enforcedAt, null);
    assert.equal(await store.findEnforcedOrganizationSsoConnectionByDomain!(`${suffix}.example.test`), null);

    const rotationTested = await store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "test_succeeded",
      actorUserId: adminId,
    });
    assert.equal(rotationTested.state, "active");

    const metadataRefresh = await store.prepareOrganizationSsoConfigurationChange!({
      organizationId,
      connectionId: connection.id,
      change: "metadata_refreshed",
      actorUserId: ownerId,
    });
    assert.equal(metadataRefresh.state, "pending");
    assert.equal(metadataRefresh.configVersion, 3);
    assert.equal(metadataRefresh.lastTestedAt, null);
    assert.equal(await store.findEnforcedOrganizationSsoConnectionByDomain!(`${suffix}.example.test`), null);
    const metadataTested = await store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "test_succeeded",
      actorUserId: ownerId,
    });
    assert.equal(metadataTested.state, "active");

    const suspended = await store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "suspend",
      actorUserId: adminId,
    });
    assert.equal(suspended.state, "suspended");
    assert.equal(await store.findEnforcedOrganizationSsoConnectionByDomain!(`${suffix}.example.test`), null);
    const rolledBack = await store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "rollback",
      actorUserId: ownerId,
    });
    assert.equal(rolledBack.state, "active");
    const disconnected = await store.transitionOrganizationSsoConnection!({
      organizationId,
      connectionId: connection.id,
      action: "disconnect",
      actorUserId: ownerId,
    });
    assert.equal(disconnected.state, "disconnected");

    assert.deepEqual(await store.listOrganizationSsoConnections!(otherOrganizationId), []);
    assert.equal((await store.listOrganizationSsoConnections!(organizationId))[0]?.state, "disconnected");
    const audit = await pool.query(
      `SELECT event_type,details FROM organization_sso_audit_events
       WHERE organization_id=$1 ORDER BY occurred_at,id`,
      [organizationId],
    );
    assert.deepEqual(audit.rows.map((row) => row.event_type), [
      "sso.created", "sso.domain_verified", "sso.test_succeeded", "sso.recovery_confirmed",
      "sso.enforced", "sso.rotated", "sso.test_succeeded", "sso.metadata_refreshed",
      "sso.test_succeeded", "sso.suspended", "sso.rolled_back", "sso.disconnected",
    ]);
    assert.doesNotMatch(JSON.stringify(audit.rows), /client.?secret|private.?key|assertion|token/i);
  } finally {
    await pool.query("DELETE FROM organizations WHERE id IN ($1,$2)", [organizationId, otherOrganizationId]).catch(() => undefined);
    await pool.query("DELETE FROM account_users WHERE id=ANY($1::uuid[])", [[ownerAccount, adminAccount, memberAccount, otherOwnerAccount]]).catch(() => undefined);
    await pool.end();
  }
});
