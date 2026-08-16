import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresIdentityPolicyStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.ORGANIZATION_ONBOARDING_TEST_DATABASE_URL;

const creationInput = (overrides: Partial<Parameters<PostgresIdentityPolicyStore["createCustomerOrganization"]>[0]> = {}) => ({
  accountUserId: randomUUID(),
  authenticationSessionId: randomUUID(),
  email: "owner@example.test",
  userDisplayName: "Owner Example",
  organizationDisplayName: "Example Organization",
  tenantKind: "organization" as const,
  idempotencyKey: randomUUID(),
  installationKind: "hosted" as const,
  expiresAt: new Date("2026-08-09T03:00:00.000Z"),
  now: new Date("2026-08-09T02:00:00.000Z"),
  ...overrides,
});

test("organization onboarding is atomic, replay-safe, profile-aware, and creates a protected owner context", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 8 });
  const store = new PostgresIdentityPolicyStore(pool);
  try {
    const customerManagedAccount = randomUUID();
    await store.ensureCustomerAccount({ accountUserId: customerManagedAccount });
    const customerManaged = creationInput({
      accountUserId: customerManagedAccount,
      installationKind: "customer-managed",
      organizationDisplayName: "Customer Managed",
    });
    const first = await store.createCustomerOrganization(customerManaged);
    assert.equal(first.replayed, false);
    assert.equal(first.membership.role, "owner");
    assert.match(first.organization.slug, /^customer-managed-[a-f0-9]{32}$/);
    const createdOwner = await pool.query(
      "SELECT subject_user_id FROM organization_memberships WHERE id=$1",
      [first.membership.id],
    );
    const createdOwnerUserId = String(createdOwner.rows[0].subject_user_id);
    assert.ok(
      await store.getEffectivePolicy(createdOwnerUserId),
      "a self-service organization owner receives the organization default workspace policy",
    );
    const ownerWorkspaceFoundation = await pool.query(
      `SELECT agent.id AS agent_id,mapping.vendor_user_id
       FROM agent_identities agent
       JOIN vendor_identity_mappings mapping
         ON mapping.tenant_id=agent.tenant_id AND mapping.user_id=agent.owner_user_id
       WHERE agent.tenant_id=$1 AND agent.owner_user_id=$2
         AND agent.name='Default agent' AND mapping.vendor='litellm'
         AND mapping.mapping_kind='user'`,
      [first.organization.id, createdOwnerUserId],
    );
    assert.equal(ownerWorkspaceFoundation.rowCount, 1);
    const ownerDefaultTeam = await pool.query(
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
      [first.organization.id, createdOwnerUserId],
    );
    assert.deepEqual(ownerDefaultTeam.rows, [{
      display_name: "Everyone",
      user_id: createdOwnerUserId,
    }]);

    const replay = await store.createCustomerOrganization(customerManaged);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.organization, first.organization);
    assert.deepEqual(replay.membership, first.membership);
    await assert.rejects(() => store.createCustomerOrganization({
      ...customerManaged,
      organizationDisplayName: "Changed Replay",
    }), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(() => store.createCustomerOrganization({
      ...customerManaged,
      authenticationSessionId: randomUUID(),
      idempotencyKey: randomUUID(),
      organizationDisplayName: "Forbidden Second Organization",
    }), { code: "ORGANIZATION_LIMIT_REACHED" });

    const hostedAccount = randomUUID();
    await store.ensureCustomerAccount({ accountUserId: hostedAccount });
    const hostedInput = creationInput({ accountUserId: hostedAccount });
    const concurrent = await Promise.all([
      store.createCustomerOrganization(hostedInput),
      store.createCustomerOrganization(hostedInput),
    ]);
    assert.equal(new Set(concurrent.map((result) => result.organization.id)).size, 1);
    assert.deepEqual(concurrent.map((result) => result.replayed).sort(), [false, true]);

    const secondHosted = await store.createCustomerOrganization(creationInput({
      accountUserId: hostedAccount,
      authenticationSessionId: hostedInput.authenticationSessionId,
      organizationDisplayName: "Second Hosted Organization",
    }));
    assert.notEqual(secondHosted.organization.id, concurrent[0]!.organization.id);
    const explicitStepUpAt = new Date("2026-08-09T02:01:00.000Z");
    await store.recordCustomerOwnerStepUp({
      accountUserId: hostedAccount,
      authenticationSessionId: hostedInput.authenticationSessionId,
      authenticatedAt: explicitStepUpAt,
    });
    assert.equal((await store.getCustomerOwnerStepUp({
      accountUserId: hostedAccount,
      authenticationSessionId: hostedInput.authenticationSessionId,
    }))?.toISOString(), explicitStepUpAt.toISOString());
    assert.equal(await store.getCustomerOwnerStepUp({
      accountUserId: customerManagedAccount,
      authenticationSessionId: hostedInput.authenticationSessionId,
    }), null);
    await assert.rejects(() => store.recordCustomerOwnerStepUp({
      accountUserId: customerManagedAccount,
      authenticationSessionId: hostedInput.authenticationSessionId,
      authenticatedAt: new Date("2026-08-09T02:02:00.000Z"),
    }), { code: "OWNER_STEP_UP_RECORD_REJECTED" });
    for (const organizationDisplayName of ["Third Hosted Organization", "Fourth Hosted Organization", "Fifth Hosted Organization"]) {
      await store.createCustomerOrganization(creationInput({
        accountUserId: hostedAccount,
        authenticationSessionId: hostedInput.authenticationSessionId,
        organizationDisplayName,
      }));
    }
    await assert.rejects(() => store.createCustomerOrganization(creationInput({
      accountUserId: hostedAccount,
      authenticationSessionId: hostedInput.authenticationSessionId,
      organizationDisplayName: "Rate Limited Hosted Organization",
    })), { code: "ORGANIZATION_SIGNUP_RATE_LIMITED" });

    const stored = await pool.query(
      `SELECT organization.slug,settings.onboarding_state,membership.role,membership.status,
         subject.account_user_id,request.request_fingerprint,audit.event_type
       FROM organizations organization
       JOIN organization_settings settings ON settings.organization_id=organization.id
       JOIN organization_memberships membership ON membership.organization_id=organization.id
       JOIN users subject ON subject.id=membership.subject_user_id
       JOIN organization_onboarding_requests request ON request.organization_id=organization.id
       JOIN organization_lifecycle_audit_events audit ON audit.organization_id=organization.id
       WHERE organization.id=$1`,
      [first.organization.id],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].onboarding_state, "ready");
    assert.equal(stored.rows[0].role, "owner");
    assert.equal(stored.rows[0].status, "active");
    assert.equal(stored.rows[0].account_user_id, customerManagedAccount);
    assert.equal(stored.rows[0].event_type, "organization.created");
    assert.match(stored.rows[0].request_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal((await store.getCustomerProductSession({
      authenticationSessionId: customerManaged.authenticationSessionId,
      accountUserId: customerManagedAccount,
      now: customerManaged.now,
    }))?.membershipId, first.membership.id);

    const operatorId = randomUUID();
    const sharedNodeId = `shared-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await pool.query(
      `INSERT INTO platform_operators (
         id,workforce_issuer,workforce_subject,workforce_tenant_id,email,display_name
       ) VALUES ($1,'https://operator.example.test',$2,'workforce','operator@example.test','Placement Operator')`,
      [operatorId, `placement-${operatorId}`],
    );
    await pool.query(
      `INSERT INTO workspace_nodes (
         id,endpoint_url,tls_server_name,state,reason,
         created_by_operator_id,updated_by_operator_id,created_at,updated_at
       ) VALUES ($1,$2,$3,'active','Shared consumer workspace capacity',$4,$4,$5,$5)`,
      [sharedNodeId, `https://${sharedNodeId}.nodes.internal:4101`, `${sharedNodeId}.nodes.internal`, operatorId, customerManaged.now],
    );
    await pool.query(
      `INSERT INTO platform_configuration (key,value,reason,updated_by_operator_id,updated_at)
       VALUES ('workspace.defaultSharedNodeId',$1::jsonb,'Select shared consumer workspace capacity',$2,$3)`,
      [JSON.stringify(sharedNodeId), operatorId, customerManaged.now],
    );
    const personalAccount = randomUUID();
    await store.ensureCustomerAccount({ accountUserId: personalAccount });
    const personalInput = creationInput({
      accountUserId: personalAccount,
      organizationDisplayName: "Personal Owner's workspace",
      tenantKind: "personal",
    });
    const personal = await store.createCustomerOrganization(personalInput);
    const personalReplay = await store.createCustomerOrganization({
      ...personalInput,
      authenticationSessionId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    assert.equal(personal.organization.kind, "personal");
    assert.equal(personalReplay.replayed, true);
    assert.equal(personalReplay.organization.id, personal.organization.id);
    assert.deepEqual((await pool.query(
      `SELECT tenant.kind,tenant.personal_owner_account_user_id,assignment.workspace_node_id
       FROM tenants tenant
       JOIN tenant_workspace_node_assignments assignment ON assignment.tenant_id=tenant.id
       WHERE tenant.id=$1`,
      [personal.organization.id],
    )).rows, [{
      kind: "personal",
      personal_owner_account_user_id: personalAccount,
      workspace_node_id: sharedNodeId,
    }]);

    const renamed = await store.updateOrganizationDisplayName({
      organizationId: first.organization.id,
      updatedBy: createdOwnerUserId,
      displayName: "Renamed Customer Organization",
      now: new Date("2026-08-09T02:05:00.000Z"),
    });
    assert.deepEqual(renamed, {
      id: first.organization.id,
      displayName: "Renamed Customer Organization",
    });
    const renamedProjection = await pool.query(
      `SELECT organization.display_name AS organization_display_name,
         tenant.display_name AS tenant_display_name,audit.detail
       FROM organizations organization
       JOIN tenants tenant ON tenant.id=organization.id
       JOIN organization_lifecycle_audit_events audit
         ON audit.organization_id=organization.id AND audit.event_type='organization.renamed'
       WHERE organization.id=$1`,
      [first.organization.id],
    );
    assert.deepEqual(renamedProjection.rows, [{
      organization_display_name: "Renamed Customer Organization",
      tenant_display_name: "Renamed Customer Organization",
      detail: {
        previousDisplayName: "Customer Managed",
        displayName: "Renamed Customer Organization",
      },
    }]);

    const firstOwner = await pool.query(
      "SELECT subject_user_id FROM organization_memberships WHERE id=$1",
      [first.membership.id],
    );
    const targetAccountUserId = randomUUID();
    const targetUserId = `transfer_target_${randomUUID().replaceAll("-", "")}`;
    const targetMembershipId = randomUUID();
    await store.ensureCustomerAccount({ accountUserId: targetAccountUserId });
    await pool.query(
      `INSERT INTO users (id,tenant_id,email,display_name,status,account_user_id)
       VALUES ($1,$2,'target@example.test','Target Owner','active',$3)`,
      [targetUserId, first.organization.id, targetAccountUserId],
    );
    await pool.query(
      "INSERT INTO user_roles (user_id,role,assigned_by) VALUES ($1,'employee',$2)",
      [targetUserId, firstOwner.rows[0].subject_user_id],
    );
    await pool.query(
      `INSERT INTO organization_memberships (
         id,organization_id,account_user_id,subject_user_id,status,role,created_by,updated_by
       ) VALUES ($1,$2,$3,$4,'active','member',$5,$5)`,
      [targetMembershipId, first.organization.id, targetAccountUserId, targetUserId, firstOwner.rows[0].subject_user_id],
    );
    await assert.rejects(() => store.updateOrganizationDisplayName({
      organizationId: first.organization.id,
      updatedBy: targetUserId,
      displayName: "Forbidden Member Rename",
      now: new Date("2026-08-09T02:06:00.000Z"),
    }), { code: "ORGANIZATION_OWNER_REQUIRED" });
    await assert.rejects(() => store.transferOrganizationOwnership({
      organizationId: first.organization.id,
      currentOwnerUserId: firstOwner.rows[0].subject_user_id,
      targetMembershipId,
      recentStepUpAt: new Date("2026-08-09T01:49:59.999Z"),
      now: customerManaged.now,
    }), { code: "OWNER_STEP_UP_REQUIRED" });
    const ssoConnectionId = randomUUID();
    await pool.query(
      `INSERT INTO organization_sso_connections (
         id,organization_id,authentication_provider_id,protocol,domain,issuer,state,created_by,updated_by
       ) VALUES ($1,$2,$3,'oidc',$4,'https://identity.example.test','active',$5,$5)`,
      [
        ssoConnectionId,
        first.organization.id,
        `provider_${randomUUID()}`,
        `${randomUUID()}.example.test`,
        firstOwner.rows[0].subject_user_id,
      ],
    );
    await assert.rejects(() => store.transferOrganizationOwnership({
      organizationId: first.organization.id,
      currentOwnerUserId: firstOwner.rows[0].subject_user_id,
      targetMembershipId,
      recentStepUpAt: new Date("2026-08-09T01:59:00.000Z"),
      now: customerManaged.now,
    }), { code: "OWNER_TRANSFER_REQUIRES_SSO_DISCONNECT" });
    await pool.query("DELETE FROM organization_sso_connections WHERE id=$1", [ssoConnectionId]);
    const transferred = await store.transferOrganizationOwnership({
      organizationId: first.organization.id,
      currentOwnerUserId: firstOwner.rows[0].subject_user_id,
      targetMembershipId,
      recentStepUpAt: new Date("2026-08-09T01:59:00.000Z"),
      now: customerManaged.now,
    });
    assert.equal(transferred.previousOwner.role, "admin");
    assert.equal(transferred.owner.membershipId, targetMembershipId);
    assert.equal(transferred.owner.role, "owner");
    const transferAudit = await pool.query(
      `SELECT event_type,detail FROM organization_lifecycle_audit_events
       WHERE organization_id=$1 AND event_type='organization.ownership_transferred'`,
      [first.organization.id],
    );
    assert.equal(transferAudit.rowCount, 1);
    assert.deepEqual(transferAudit.rows[0].detail, {
      previousOwnerMembershipId: first.membership.id,
      newOwnerMembershipId: targetMembershipId,
    });

    const closureInput = {
      organizationId: first.organization.id,
      requestedBy: targetUserId,
      reason: "The organization owner requested a controlled account closure",
      idempotencyKey: randomUUID(),
      recentStepUpAt: new Date("2026-08-09T01:59:00.000Z"),
      now: customerManaged.now,
    };
    const closure = await store.initiateOrganizationClosure(closureInput);
    assert.equal(closure.replayed, false);
    assert.equal(closure.request.status, "pending");
    assert.equal(closure.request.executeAfter, "2026-08-16T02:00:00.000Z");
    assert.equal((await store.initiateOrganizationClosure(closureInput)).replayed, true);
    await assert.rejects(() => store.initiateOrganizationClosure({
      ...closureInput,
      idempotencyKey: randomUUID(),
      reason: "A different closure request must not replace the pending request",
    }), { code: "ORGANIZATION_CLOSURE_ALREADY_PENDING" });

    const failureAccount = randomUUID();
    await store.ensureCustomerAccount({ accountUserId: failureAccount });
    const failureInput = creationInput({
      accountUserId: failureAccount,
      organizationDisplayName: "Failure Test Organization",
    });
    await store.createCustomerOrganization(failureInput);
    await pool.query(
      "UPDATE browser_sessions SET revoked_at=$2 WHERE authentication_session_id=$1",
      [failureInput.authenticationSessionId, failureInput.now],
    );
    const organizationsBeforeFailure = Number((await pool.query("SELECT count(*)::integer AS count FROM organizations")).rows[0].count);
    await assert.rejects(() => store.createCustomerOrganization(creationInput({
      accountUserId: failureAccount,
      authenticationSessionId: failureInput.authenticationSessionId,
      organizationDisplayName: "Must Roll Back",
    })), { code: "PRODUCT_SESSION_REVOKED" });
    const organizationsAfterFailure = Number((await pool.query("SELECT count(*)::integer AS count FROM organizations")).rows[0].count);
    assert.equal(organizationsAfterFailure, organizationsBeforeFailure, "a late product-session failure leaves no orphan organization");
  } finally {
    await store.close();
  }
});
