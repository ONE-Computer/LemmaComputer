import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresIdentityPolicyStore, PostgresPlatformOperatorStore, PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.PLATFORM_OPERATOR_TEST_DATABASE_URL;
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

test("platform operator sessions and support elevations are isolated, scoped, approved, and audited", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresPlatformOperatorStore(pool);
  const suffix = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const now = new Date("2026-08-09T03:10:00.000Z");
  try {
    await pool.query(
      "INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Tenant A'),($3,$4,'Tenant B')",
      [tenantA, `operator-a-${suffix}`, tenantB, `operator-b-${suffix}`],
    );
    const support = await store.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `support-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `support-${suffix}@example.test`,
      displayName: "Support Operator",
      roles: ["support-operator"],
    });
    const auditor = await store.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `auditor-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `auditor-${suffix}@example.test`,
      displayName: "Security Auditor",
      roles: ["security-auditor"],
    });
    const otherSupport = await store.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `other-support-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `other-support-${suffix}@example.test`,
      displayName: "Other Support Operator",
      roles: ["support-operator"],
    });
    const localAdministrator = await store.provisionOperator({
      issuer: "urn:lemmacomputer:platform-better-auth",
      subject: `local-administrator-${suffix}`,
      workforceTenantId: "lemmacomputer-platform",
      email: `local-administrator-${suffix}@worktree.invalid`,
      displayName: "Local Platform Administrator",
      roles: ["platform-administrator"],
    });
    assert.deepEqual(await store.resolveWorkforceOperator({
      issuer: support.issuer,
      subject: support.subject,
      workforceTenantId: support.workforceTenantId,
    }), {
      operatorId: support.id,
      issuer: support.issuer,
      subject: support.subject,
      roles: ["support-operator"],
    });
    assert.equal(await store.resolveWorkforceOperator({
      issuer: support.issuer,
      subject: support.subject,
      workforceTenantId: "another-workforce-directory",
    }), null, "a matching subject in another workforce tenant grants no authority");

    const oidcStateHash = tokenHash(`oidc-state-${suffix}`);
    await store.createOperatorLoginAttempt({
      stateHash: oidcStateHash,
      verifierCiphertext: `ciphertext-${suffix}`,
      nonce: `nonce-${suffix}`,
      returnPath: "/platform/incidents",
      expiresAt: new Date("2026-08-09T03:15:00.000Z"),
      createdAt: now,
    });
    assert.deepEqual(await store.consumeOperatorLoginAttempt(oidcStateHash, now), {
      verifierCiphertext: `ciphertext-${suffix}`,
      nonce: `nonce-${suffix}`,
      returnPath: "/platform/incidents",
      expiresAt: new Date("2026-08-09T03:15:00.000Z"),
      createdAt: now,
      purpose: "login",
      operatorSessionId: null,
    });
    assert.equal(await store.consumeOperatorLoginAttempt(oidcStateHash, now), null, "OIDC state is single use");

    const expiredStateHash = tokenHash(`expired-oidc-state-${suffix}`);
    await store.createOperatorLoginAttempt({
      stateHash: expiredStateHash,
      verifierCiphertext: `expired-ciphertext-${suffix}`,
      nonce: `expired-nonce-${suffix}`,
      returnPath: "/platform",
      expiresAt: new Date("2026-08-09T03:09:59.000Z"),
      createdAt: new Date("2026-08-09T03:04:59.000Z"),
    });
    assert.equal(await store.consumeOperatorLoginAttempt(expiredStateHash, now), null, "expired OIDC state is denied and consumed");
    const supportSession = await store.createSession({
      operatorId: support.id,
      tokenHash: tokenHash(`support-${suffix}`),
      assurance: { level: "aal2", factors: ["federated", "totp"] },
      authenticatedAt: new Date("2026-08-09T03:00:00.000Z"),
      recentStepUpAt: new Date("2026-08-09T03:05:00.000Z"),
      expiresAt: new Date("2026-08-09T15:00:00.000Z"),
      correlationId: `login-support-${suffix}`,
    });
    const auditorSession = await store.createSession({
      operatorId: auditor.id,
      tokenHash: tokenHash(`auditor-${suffix}`),
      assurance: { level: "aal2", factors: ["federated", "totp"] },
      authenticatedAt: new Date("2026-08-09T03:00:00.000Z"),
      recentStepUpAt: new Date("2026-08-09T03:06:00.000Z"),
      expiresAt: new Date("2026-08-09T15:00:00.000Z"),
      correlationId: `login-auditor-${suffix}`,
    });
    const otherSupportSession = await store.createSession({
      operatorId: otherSupport.id,
      tokenHash: tokenHash(`other-support-${suffix}`),
      assurance: { level: "aal2", factors: ["federated"] },
      authenticatedAt: new Date("2026-08-09T03:00:00.000Z"),
      recentStepUpAt: new Date("2026-08-09T03:06:00.000Z"),
      expiresAt: new Date("2026-08-09T15:00:00.000Z"),
      correlationId: `login-other-support-${suffix}`,
    });
    const localAdministratorSession = await store.createSession({
      operatorId: localAdministrator.id,
      tokenHash: tokenHash(`local-administrator-${suffix}`),
      assurance: { level: "aal2", factors: ["passkey"] },
      authenticatedAt: new Date("2026-08-09T03:00:00.000Z"),
      recentStepUpAt: new Date("2026-08-09T03:00:00.000Z"),
      expiresAt: new Date("2026-08-09T11:00:00.000Z"),
      correlationId: `login-local-administrator-${suffix}`,
    });
    assert.equal(localAdministratorSession.principal.identity.provider, "better-auth");
    assert.deepEqual(localAdministratorSession.principal.assurance, { level: "aal2", factors: ["passkey"] });
    assert.deepEqual(supportSession.roles, ["support-operator"]);
    assert.equal((await store.getSession(tokenHash(`support-${suffix}`), now))?.principal.realm, "platform-operator");
    assert.equal(await store.getSession(tokenHash(`missing-${suffix}`), now), null);

    const diagnostics = await store.requestElevation(
      supportSession,
      {
        targetOrganizationId: tenantA,
        reason: "Investigate tenant-requested incident INC-1042",
        scopes: ["support.diagnostics.read"],
        durationMinutes: 20,
        kind: "support",
      },
      { approvalConfigured: false, correlationId: `request-diagnostics-${suffix}`, now },
    );
    assert.equal(diagnostics.approvalRequired, false);
    assert.equal((await store.readTenantDiagnostics(supportSession, {
      elevationId: diagnostics.id,
      targetOrganizationId: tenantA,
      correlationId: `use-diagnostics-${suffix}`,
      now,
    }))?.tenantId, tenantA);
    assert.equal(await store.readTenantDiagnostics(supportSession, {
      elevationId: diagnostics.id,
      targetOrganizationId: tenantB,
      correlationId: `wrong-tenant-${suffix}`,
      now,
    }), null);
    assert.equal((await store.listElevations(supportSession, { status: "active" }, now)).some((candidate) => candidate.id === diagnostics.id), true);

    const content = await store.requestElevation(
      supportSession,
      {
        targetOrganizationId: tenantA,
        reason: "Tenant approved content inspection for incident INC-1042",
        scopes: ["support.customer-content.read"],
        durationMinutes: 20,
        kind: "support",
      },
      { approvalConfigured: false, correlationId: `request-content-${suffix}`, now },
    );
    assert.equal(content.approvalRequired, true, "customer content always requires approval");
    assert.equal((await store.listElevations(auditorSession, { status: "pending" }, now)).some((candidate) => candidate.id === content.id), true);
    await assert.rejects(
      () => store.approveElevation(supportSession, content.id, `self-approval-${suffix}`, now),
      { code: "PLATFORM_OPERATOR_FORBIDDEN" },
    );
    const approved = await store.approveElevation(auditorSession, content.id, `approval-${suffix}`, now);
    assert.equal(approved.approvedByOperatorId, auditor.id);
    assert.equal((await store.listElevations(auditorSession, { status: "active" }, now)).some((candidate) => candidate.id === content.id), true);
    const otherElevation = await store.requestElevation(otherSupportSession, {
      targetOrganizationId: tenantB,
      reason: "Investigate a second customer diagnostics incident",
      scopes: ["support.diagnostics.read"],
      durationMinutes: 10,
      kind: "support",
    }, { approvalConfigured: false, correlationId: `other-request-${suffix}`, now });
    await assert.rejects(
      () => store.revokeElevation(supportSession, otherElevation.id, `other-revoke-denied-${suffix}`, now),
      { code: "PLATFORM_ELEVATION_REVOKE_DENIED" },
    );
    assert.equal((await store.listElevations(supportSession, {}, now)).some((candidate) => candidate.id === otherElevation.id), false);

    await store.revokeElevation(supportSession, diagnostics.id, `revoke-${suffix}`, now);
    assert.equal(await store.readTenantDiagnostics(supportSession, {
      elevationId: diagnostics.id,
      targetOrganizationId: tenantA,
      correlationId: `use-revoked-${suffix}`,
      now,
    }), null);
    assert.equal((await store.listElevations(supportSession, { status: "revoked" }, now)).some((candidate) => candidate.id === diagnostics.id), true);

    const events = await store.listAuditEvents();
    for (const correlationId of [
      `request-diagnostics-${suffix}`,
      `use-diagnostics-${suffix}`,
      `wrong-tenant-${suffix}`,
      `request-content-${suffix}`,
      `approval-${suffix}`,
      `revoke-${suffix}`,
      `use-revoked-${suffix}`,
    ]) assert.ok(events.some((event) => event.correlationId === correlationId), correlationId);
    assert.ok(events.some((event) => event.eventType === "support_operation.denied"));
  } finally {
    await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]).catch(() => undefined);
    await store.close();
  }
});

test("break-glass requires platform administrator authority and emits an immediate reviewable alert", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresPlatformOperatorStore(pool);
  const suffix = randomUUID();
  const tenantId = randomUUID();
  const now = new Date("2026-08-09T04:00:00.000Z");
  try {
    await pool.query("INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Break Glass Tenant')", [tenantId, `break-glass-${suffix}`]);
    const administrator = await store.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `admin-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `admin-${suffix}@example.test`,
      displayName: "Platform Administrator",
      roles: ["platform-administrator"],
    });
    const session = await store.createSession({
      operatorId: administrator.id,
      tokenHash: tokenHash(`admin-${suffix}`),
      assurance: { level: "aal2", factors: ["federated", "totp"] },
      authenticatedAt: new Date("2026-08-09T03:55:00.000Z"),
      recentStepUpAt: new Date("2026-08-09T03:59:00.000Z"),
      expiresAt: new Date("2026-08-09T12:00:00.000Z"),
      correlationId: `login-admin-${suffix}`,
    });
    const elevation = await store.requestElevation(session, {
      targetOrganizationId: tenantId,
      reason: "Emergency containment for active incident INC-9999",
      scopes: ["support.diagnostics.read"],
      durationMinutes: 15,
      kind: "break-glass",
    }, { approvalConfigured: false, correlationId: `break-glass-${suffix}`, now });
    assert.equal(elevation.kind, "break-glass");
    let alerts = await store.listSecurityAlerts({ elevationId: elevation.id });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.status, "pending");
    assert.equal(alerts[0]?.attemptCount, 0);
    let claimed = await store.claimSecurityAlerts({ limit: 10, now });
    const alertDelivery = claimed.find((candidate) => candidate.elevationId === elevation.id);
    assert.ok(alertDelivery);
    assert.equal(alertDelivery.status, "delivering");
    assert.equal(alertDelivery.attemptCount, 1);
    const retryAt = new Date("2026-08-09T04:01:00.000Z");
    await store.failSecurityAlert(alertDelivery.id, alertDelivery.leaseToken, {
      error: "Postmark temporarily unavailable",
      failedAt: now,
      retryAt,
    });
    alerts = await store.listSecurityAlerts({ elevationId: elevation.id });
    assert.equal(alerts[0]?.status, "retry");
    assert.equal((await store.claimSecurityAlerts({ limit: 10, now: new Date("2026-08-09T04:00:59.000Z") })).some((candidate) => candidate.id === alertDelivery.id), false);
    claimed = await store.claimSecurityAlerts({ limit: 10, now: retryAt });
    assert.equal(claimed.find((candidate) => candidate.id === alertDelivery.id)?.attemptCount, 2);
    const secondClaim = claimed.find((candidate) => candidate.id === alertDelivery.id);
    assert.ok(secondClaim);
    await store.failSecurityAlert(alertDelivery.id, secondClaim.leaseToken, {
      error: "Postmark still unavailable",
      failedAt: retryAt,
      retryAt: new Date("2026-08-09T04:02:00.000Z"),
    });
    claimed = await store.claimSecurityAlerts({ limit: 10, now: new Date("2026-08-09T04:02:00.000Z") });
    const crashedFinalClaim = claimed.find((candidate) => candidate.id === alertDelivery.id);
    assert.equal(crashedFinalClaim?.attemptCount, 3);
    assert.ok(crashedFinalClaim?.leaseToken);
    assert.equal((await store.claimSecurityAlerts({ limit: 10, now: new Date("2026-08-09T04:07:01.000Z") })).some((candidate) => candidate.id === alertDelivery.id), false);
    alerts = await store.listSecurityAlerts({ elevationId: elevation.id });
    assert.equal(alerts[0]?.status, "escalated");
    assert.equal(alerts[0]?.lastError, "Delivery lease expired after final attempt");
    const deliveredElevation = await store.requestElevation(session, {
      targetOrganizationId: tenantId,
      reason: "Emergency verification for active incident INC-9999",
      scopes: ["support.diagnostics.read"],
      durationMinutes: 10,
      kind: "break-glass",
    }, { approvalConfigured: false, correlationId: `break-glass-delivery-${suffix}`, now: new Date("2026-08-09T04:04:00.000Z") });
    claimed = await store.claimSecurityAlerts({ limit: 10, now: new Date("2026-08-09T04:04:00.000Z") });
    const deliveredAlert = claimed.find((candidate) => candidate.elevationId === deliveredElevation.id);
    assert.ok(deliveredAlert);
    const reClaimed = await store.claimSecurityAlerts({ limit: 10, now: new Date("2026-08-09T04:09:01.000Z") });
    const newLease = reClaimed.find((candidate) => candidate.id === deliveredAlert.id);
    assert.ok(newLease);
    assert.notEqual(newLease.leaseToken, deliveredAlert.leaseToken);
    await assert.rejects(
      () => store.completeSecurityAlert(deliveredAlert.id, deliveredAlert.leaseToken, new Date("2026-08-09T04:09:02.000Z")),
      { code: "PLATFORM_SECURITY_ALERT_LEASE_LOST" },
    );
    await store.completeSecurityAlert(newLease.id, newLease.leaseToken, new Date("2026-08-09T04:09:03.000Z"));
    assert.equal((await store.listSecurityAlerts({ elevationId: deliveredElevation.id }))[0]?.status, "delivered");
    const approvalCase = await store.requestElevation(session, {
      targetOrganizationId: tenantId,
      reason: "Emergency identity recovery requested in incident INC-9999",
      scopes: ["support.identity-recovery.manage"],
      durationMinutes: 10,
      kind: "support",
    }, { approvalConfigured: false, correlationId: `self-approval-request-${suffix}`, now });
    await assert.rejects(
      () => store.approveElevation(session, approvalCase.id, `self-approval-${suffix}`, now),
      { code: "PLATFORM_ELEVATION_SELF_APPROVAL_DENIED" },
    );
    assert.equal((await store.readTenantDiagnostics(session, {
      elevationId: elevation.id,
      targetOrganizationId: tenantId,
      correlationId: `break-glass-use-${suffix}`,
      now,
    }))?.tenantId, tenantId);
    const events = await store.listAuditEvents({ targetOrganizationId: tenantId });
    const alert = events.find((event) => event.eventType === "break_glass.security_alert" && event.correlationId === `break-glass-${suffix}`);
    assert.equal(alert?.correlationId, `break-glass-${suffix}`);
    assert.equal(alert?.reviewRequired, true);
    const review = events.find((event) => event.eventType === "break_glass.review_required");
    assert.equal(review?.correlationId, `break-glass-use-${suffix}`);
    assert.equal(review?.reviewRequired, true);
    assert.ok(events.some((event) => event.eventType === "break_glass.alert_escalated"));
  } finally {
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]).catch(() => undefined);
    await store.close();
  }
});

test("platform operations enforce role boundaries and audit lifecycle, incident, and configuration changes", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresPlatformOperatorStore(pool);
  const suffix = randomUUID();
  const tenantId = randomUUID();
  const now = new Date("2026-08-09T05:00:00.000Z");
  const configurationKey = `support.test${suffix.replaceAll("-", "")}`;
  const deniedConfigurationKey = `support.denied${suffix.replaceAll("-", "")}`;
  try {
    await pool.query("INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Operations Tenant')", [tenantId, `operations-${suffix}`]);
    const administrator = await store.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `operations-admin-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `operations-admin-${suffix}@example.test`,
      displayName: "Operations Administrator",
      roles: ["platform-administrator"],
    });
    const support = await store.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `operations-support-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `operations-support-${suffix}@example.test`,
      displayName: "Operations Support",
      roles: ["support-operator"],
    });
    const auditor = await store.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `operations-auditor-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `operations-auditor-${suffix}@example.test`,
      displayName: "Operations Auditor",
      roles: ["security-auditor"],
    });
    const makeSession = (operatorId: string, label: string) => store.createSession({
      operatorId,
      tokenHash: tokenHash(`${label}-${suffix}`),
      assurance: { level: "aal2", factors: ["federated", "totp"] },
      authenticatedAt: new Date("2026-08-09T04:55:00.000Z"),
      recentStepUpAt: new Date("2026-08-09T04:59:00.000Z"),
      expiresAt: new Date("2026-08-09T12:00:00.000Z"),
      correlationId: `login-${label}-${suffix}`,
    });
    const [administratorSession, supportSession, auditorSession] = await Promise.all([
      makeSession(administrator.id, "operations-admin"),
      makeSession(support.id, "operations-support"),
      makeSession(auditor.id, "operations-auditor"),
    ]);

    assert.ok((await store.listTenantLifecycle(supportSession)).some((tenant) => tenant.id === tenantId && tenant.lifecycleState === "active"));
    await assert.rejects(() => store.updateTenantLifecycle(supportSession, {
      tenantId,
      lifecycleState: "suspended",
      reason: "Customer security owner requested suspension",
      correlationId: `tenant-denied-${suffix}`,
      now,
    }), { code: "PLATFORM_OPERATOR_FORBIDDEN" });
    const suspended = await store.updateTenantLifecycle(administratorSession, {
      tenantId,
      lifecycleState: "suspended",
      reason: "Customer security owner requested suspension",
      correlationId: `tenant-updated-${suffix}`,
      now,
    });
    assert.equal(suspended.lifecycleState, "suspended");

    assert.equal((await store.getServiceHealth(auditorSession)).status, "available");
    const incident = await store.createIncident(supportSession, {
      title: "Tenant authentication degraded",
      summary: "Authentication callbacks are failing for the affected tenant.",
      severity: "critical",
      correlationId: `incident-created-${suffix}`,
      now,
    });
    assert.equal((await store.getServiceHealth(auditorSession)).status, "degraded");
    assert.ok((await store.listIncidents(auditorSession)).some((candidate) => candidate.id === incident.id));
    const resolved = await store.updateIncident(supportSession, {
      incidentId: incident.id,
      status: "resolved",
      correlationId: `incident-resolved-${suffix}`,
      now: new Date("2026-08-09T05:05:00.000Z"),
    });
    assert.equal(resolved.status, "resolved");
    assert.equal((await store.getServiceHealth(auditorSession)).status, "available");

    await assert.rejects(() => store.setPlatformConfiguration(auditorSession, {
      key: configurationKey,
      value: true,
      reason: "Security auditor must not mutate configuration",
      correlationId: `configuration-denied-${suffix}`,
      now,
    }), { code: "PLATFORM_OPERATOR_FORBIDDEN" });
    const configuration = await store.setPlatformConfiguration(administratorSession, {
      key: configurationKey,
      value: { approvalRequired: true },
      reason: "Keep approval required for tenant support",
      correlationId: `configuration-updated-${suffix}`,
      now,
    });
    assert.deepEqual(configuration.value, { approvalRequired: true });
    assert.ok((await store.listPlatformConfiguration(auditorSession)).some((entry) => entry.key === configurationKey));

    const events = await store.listAuditEvents({ targetOrganizationId: tenantId });
    assert.ok(events.some((event) => event.correlationId === `tenant-updated-${suffix}`));
    const operatorEvents = await store.listAuditEvents({ operatorId: support.id });
    assert.ok(operatorEvents.some((event) => event.correlationId === `incident-created-${suffix}`));
    assert.ok(operatorEvents.some((event) => event.correlationId === `incident-resolved-${suffix}`));

    await store.provisionOperator({
      issuer: administrator.issuer,
      subject: administrator.subject,
      workforceTenantId: administrator.workforceTenantId,
      email: administrator.email,
      displayName: administrator.displayName,
      roles: ["billing-operator"],
    });
    await assert.rejects(() => store.updateTenantLifecycle(administratorSession, {
      tenantId,
      lifecycleState: "active",
      reason: "A stale administrator session must not reactivate a tenant",
      correlationId: `tenant-after-demotion-${suffix}`,
      now,
    }), { code: "PLATFORM_OPERATOR_FORBIDDEN" });
    await assert.rejects(() => store.createIncident(administratorSession, {
      title: "Stale privileged session",
      summary: "This incident must not be created after operator demotion.",
      severity: "low",
      correlationId: `incident-create-after-demotion-${suffix}`,
      now,
    }), { code: "PLATFORM_OPERATOR_FORBIDDEN" });
    await assert.rejects(() => store.updateIncident(administratorSession, {
      incidentId: incident.id,
      status: "monitoring",
      correlationId: `incident-update-after-demotion-${suffix}`,
      now,
    }), { code: "PLATFORM_OPERATOR_FORBIDDEN" });
    await assert.rejects(() => store.setPlatformConfiguration(administratorSession, {
      key: deniedConfigurationKey,
      value: true,
      reason: "A stale administrator session must not update configuration",
      correlationId: `configuration-after-demotion-${suffix}`,
      now,
    }), { code: "PLATFORM_OPERATOR_FORBIDDEN" });
    assert.equal((await pool.query("SELECT 1 FROM platform_configuration WHERE key=$1", [deniedConfigurationKey])).rowCount, 0);
  } finally {
    await pool.query("DELETE FROM platform_configuration WHERE key=ANY($1)", [[configurationKey, deniedConfigurationKey]]).catch(() => undefined);
    await store.close();
  }
});

test("tenant diagnostics consume elevation atomically, accept text tenant IDs, and fail after operator demotion", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresPlatformOperatorStore(pool);
  const suffix = randomUUID();
  const tenantId = `example-${suffix}`;
  const missingTenantId = `missing-${suffix}`;
  const now = new Date("2026-08-09T06:00:00.000Z");
  try {
    await pool.query("INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Text Tenant')", [tenantId, `external-${suffix}`]);
    const support = await store.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `diagnostics-support-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `diagnostics-support-${suffix}@example.test`,
      displayName: "Diagnostics Support",
      roles: ["support-operator"],
    });
    const sessionToken = `diagnostics-${suffix}`;
    const session = await store.createSession({
      operatorId: support.id,
      tokenHash: tokenHash(sessionToken),
      assurance: { level: "aal2", factors: ["federated", "totp"] },
      authenticatedAt: new Date("2026-08-09T05:55:00.000Z"),
      recentStepUpAt: new Date("2026-08-09T05:59:00.000Z"),
      expiresAt: new Date("2026-08-09T12:00:00.000Z"),
      correlationId: `diagnostics-login-${suffix}`,
    });
    const elevation = await store.requestElevation(session, {
      targetOrganizationId: tenantId,
      reason: "Investigate tenant-requested diagnostics incident",
      scopes: ["support.diagnostics.read"],
      durationMinutes: 15,
      kind: "support",
    }, { approvalConfigured: false, correlationId: `diagnostics-request-${suffix}`, now });

    const diagnostics = await store.readTenantDiagnostics(session, {
      elevationId: elevation.id,
      targetOrganizationId: tenantId,
      correlationId: `diagnostics-read-${suffix}`,
      now,
    });
    assert.equal(diagnostics?.tenantId, tenantId);
    assert.equal(diagnostics?.displayName, "Text Tenant");
    let events = await store.listAuditEvents({ targetOrganizationId: tenantId });
    assert.ok(events.some((event) => event.eventType === "support_operation.diagnostics_read" && event.correlationId === `diagnostics-read-${suffix}`));

    assert.equal(await store.readTenantDiagnostics(session, {
      elevationId: elevation.id,
      targetOrganizationId: missingTenantId,
      correlationId: `diagnostics-missing-${suffix}`,
      now,
    }), null);
    events = await store.listAuditEvents({ operatorId: support.id });
    const denied = events.find((event) => event.correlationId === `diagnostics-missing-${suffix}`);
    assert.equal(denied?.targetOrganizationId, null);
    assert.equal(denied?.details.attemptedTargetOrganizationId, missingTenantId);

    await store.provisionOperator({
      issuer: support.issuer,
      subject: support.subject,
      workforceTenantId: support.workforceTenantId,
      email: support.email,
      displayName: support.displayName,
      roles: ["billing-operator"],
    });
    assert.equal(await store.getSession(tokenHash(sessionToken), now), null, "role changes revoke existing operator sessions");
    await assert.rejects(() => store.readTenantDiagnostics(session, {
      elevationId: elevation.id,
      targetOrganizationId: tenantId,
      correlationId: `diagnostics-after-demotion-${suffix}`,
      now,
    }), { code: "PLATFORM_OPERATOR_FORBIDDEN" });
  } finally {
    await store.close();
  }
});

test("suspended and closed tenants revoke customer sessions and invalidate active workspaces", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const store = new PostgresPlatformOperatorStore(pool);
  const identity = new PostgresIdentityPolicyStore(pool);
  const workspaces = new PostgresWorkspaceStore(pool);
  const suffix = randomUUID();
  const tenantId = `lifecycle-${suffix}`;
  const userId = `lifecycle-user-${suffix}`;
  const sessionToken = `customer-session-${suffix}`;
  const now = new Date("2026-08-09T07:00:00.000Z");
  try {
    await pool.query("INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Lifecycle Tenant')", [tenantId, `lifecycle-external-${suffix}`]);
    await pool.query("INSERT INTO organizations (id,display_name) VALUES ($1,'Lifecycle Tenant')", [tenantId]);
    const account = await pool.query("INSERT INTO account_users (status) VALUES ('active') RETURNING id");
    await pool.query(
      "INSERT INTO users (id,tenant_id,account_user_id,email,display_name) VALUES ($1,$2,$3,$4,'Lifecycle User')",
      [userId, tenantId, account.rows[0].id, `lifecycle-${suffix}@example.test`],
    );
    const membership = await pool.query(
      `INSERT INTO organization_memberships (
         organization_id,account_user_id,subject_user_id,status,role,created_by,updated_by
       ) VALUES ($1,$2,$3,'active','owner',$3,$3) RETURNING id`,
      [tenantId, account.rows[0].id, userId],
    );
    await pool.query(
      `INSERT INTO browser_sessions (id,token_hash,user_id,membership_id,expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), tokenHash(sessionToken), userId, membership.rows[0].id, new Date("2026-08-10T07:00:00.000Z")],
    );
    const workspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id,tenant_id,subject_id,grant_id,state,provider_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'open','runtime-1',$5,$5)`,
      [workspaceId, tenantId, userId, `grant-${suffix}`, now],
    );
    const administrator = await store.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `lifecycle-admin-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `lifecycle-admin-${suffix}@example.test`,
      displayName: "Lifecycle Administrator",
      roles: ["platform-administrator"],
    });
    const administratorSession = await store.createSession({
      operatorId: administrator.id,
      tokenHash: tokenHash(`lifecycle-admin-${suffix}`),
      assurance: { level: "aal2", factors: ["federated", "totp"] },
      authenticatedAt: new Date("2026-08-09T06:55:00.000Z"),
      recentStepUpAt: new Date("2026-08-09T06:59:00.000Z"),
      expiresAt: new Date("2026-08-09T12:00:00.000Z"),
      correlationId: `lifecycle-login-${suffix}`,
    });

    assert.equal((await identity.getSession(tokenHash(sessionToken), now))?.tenantId, tenantId);
    assert.equal(await workspaces.authorizeWorkspaceAccess({ tenantId, subjectId: userId, audience: "lemmacomputer-control", workspaceId, accessGeneration: 1 }), true);
    const [raceCreate, raceSuspend] = await Promise.allSettled([
      workspaces.createOrGet(
        { tenantId, subjectId: userId, audience: "lemmacomputer-control" },
        `race-${suffix}`,
        `race-idempotency-${suffix}`,
      ),
      store.updateTenantLifecycle(administratorSession, {
        tenantId,
        lifecycleState: "suspended",
        reason: "Security response requires immediate tenant suspension",
        correlationId: `lifecycle-suspend-${suffix}`,
        now,
      }),
    ]);
    assert.equal(raceSuspend.status, "fulfilled");
    if (raceCreate.status === "fulfilled") {
      const racedWorkspace = await pool.query("SELECT state,access_generation FROM workspaces WHERE id=$1", [raceCreate.value.id]);
      assert.deepEqual(racedWorkspace.rows[0], { state: "stopping", access_generation: 2 }, "a creation that wins the row lock is still fenced and queued");
    } else {
      assert.equal((raceCreate.reason as { code?: string }).code, "TENANT_WORKSPACE_ACCESS_REVOKED");
    }
    assert.equal(await identity.getSession(tokenHash(sessionToken), now), null);
    assert.equal(await identity.getPrincipal(userId), null);
    await assert.rejects(() => identity.createSession({
      tokenHash: tokenHash(`replacement-${suffix}`),
      userId,
      membershipId: membership.rows[0].id,
      expiresAt: new Date("2026-08-10T07:00:00.000Z"),
    }), { code: "MEMBERSHIP_NOT_ACTIVE" });
    let workspace = await pool.query("SELECT state,failure_code,operation_token,access_generation FROM workspaces WHERE id=$1", [workspaceId]);
    assert.deepEqual(workspace.rows[0], {
      state: "stopping",
      failure_code: "TENANT_SUSPENDED",
      operation_token: null,
      access_generation: 2,
    });
    assert.equal(await workspaces.authorizeWorkspaceAccess({ tenantId, subjectId: userId, audience: "lemmacomputer-control", workspaceId, accessGeneration: 1 }), false, "old generation is fenced immediately");
    assert.equal(await workspaces.authorizeWorkspaceAccess({ tenantId, subjectId: userId, audience: "lemmacomputer-control", workspaceId, accessGeneration: 2 }), false, "stopping workspaces cannot issue access");
    const initialCleanup = (await store.listTenantCleanupJobs()).filter((job) => job.tenantId === tenantId && job.workspaceId === workspaceId);
    assert.equal(initialCleanup.length, 1);
    assert.equal(initialCleanup[0]!.action, "suspend");
    await store.updateTenantLifecycle(administratorSession, {
      tenantId,
      lifecycleState: "suspended",
      reason: "Repeated suspension request must coalesce with pending cleanup",
      correlationId: `lifecycle-suspend-repeat-${suffix}`,
      now: new Date("2026-08-09T07:00:01.000Z"),
    });
    workspace = await pool.query("SELECT state,access_generation FROM workspaces WHERE id=$1", [workspaceId]);
    assert.deepEqual(workspace.rows[0], { state: "stopping", access_generation: 2 }, "repeat suspend does not advance the cleanup generation");
    const repeatedCleanup = (await store.listTenantCleanupJobs()).filter((job) => job.tenantId === tenantId && job.workspaceId === workspaceId);
    assert.equal(repeatedCleanup.length, 1, "repeat suspend does not create an orphan cleanup job");
    assert.equal(repeatedCleanup[0]!.id, initialCleanup[0]!.id);
    await store.updateTenantLifecycle(administratorSession, {
      tenantId,
      lifecycleState: "closed",
      reason: "Offboarding supersedes the pending suspension cleanup",
      correlationId: `lifecycle-close-pending-suspend-${suffix}`,
      now: new Date("2026-08-09T07:00:02.000Z"),
    });
    workspace = await pool.query("SELECT state,failure_code,access_generation FROM workspaces WHERE id=$1", [workspaceId]);
    assert.deepEqual(workspace.rows[0], { state: "stopping", failure_code: "TENANT_CLOSED", access_generation: 2 }, "suspend to close reuses the fenced generation");
    const supersededCleanup = (await store.listTenantCleanupJobs()).filter((job) => job.tenantId === tenantId && job.workspaceId === workspaceId);
    assert.equal(supersededCleanup.length, 1);
    assert.equal(supersededCleanup[0]!.id, initialCleanup[0]!.id);
    assert.equal(supersededCleanup[0]!.action, "close");
    await assert.rejects(() => store.updateTenantLifecycle(administratorSession, {
      tenantId,
      lifecycleState: "active",
      reason: "Reactivation must wait for every superseded cleanup stage",
      correlationId: `lifecycle-reactivate-pending-${suffix}`,
      now: new Date("2026-08-09T07:00:03.000Z"),
    }), { code: "PLATFORM_TENANT_CLEANUP_PENDING" });
    const suspendCleanup = (await store.claimTenantCleanupJobs({ limit: 100, now: new Date("2026-08-09T07:00:02.000Z") })).filter((job) => job.tenantId === tenantId);
    assert.ok(suspendCleanup.length >= 1);
    for (const job of suspendCleanup) {
      assert.equal(job.action, "close");
      await store.recordTenantCleanupProgress(job.id, job.leaseToken, "controller", now);
      await store.recordTenantCleanupProgress(job.id, job.leaseToken, "gateway", now);
      await store.recordTenantCleanupProgress(job.id, job.leaseToken, "storage", now);
      await store.completeTenantCleanupJob(job.id, job.leaseToken, now);
    }

    await store.updateTenantLifecycle(administratorSession, {
      tenantId,
      lifecycleState: "active",
      reason: "Security response completed and tenant access restored",
      correlationId: `lifecycle-reactivate-${suffix}`,
      now: new Date("2026-08-09T07:05:00.000Z"),
    });
    await identity.createSession({
      tokenHash: tokenHash(`replacement-${suffix}`),
      userId,
      membershipId: membership.rows[0].id,
      expiresAt: new Date("2026-08-10T07:00:00.000Z"),
    });
    assert.equal((await identity.getSession(tokenHash(`replacement-${suffix}`), new Date("2026-08-09T07:06:00.000Z")))?.tenantId, tenantId);
    workspace = await pool.query("SELECT state,access_generation FROM workspaces WHERE id=$1", [workspaceId]);
    assert.equal(workspace.rows[0].state, "stopped", "reactivation never restarts customer compute implicitly");
    assert.equal(workspace.rows[0].access_generation, 2);
    const casWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id,tenant_id,subject_id,grant_id,state,access_generation,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'stopped',2,$5,$5)`,
      [casWorkspaceId, tenantId, userId, `cas-${suffix}`, now],
    );
    await pool.query("UPDATE workspaces SET state='open',failure_code=NULL WHERE id=$1", [workspaceId]);
    assert.equal(await workspaces.authorizeWorkspaceAccess({ tenantId, subjectId: userId, audience: "lemmacomputer-control", workspaceId, accessGeneration: 2 }), true);
    await store.updateTenantLifecycle(administratorSession, {
      tenantId,
      lifecycleState: "offboarding",
      reason: "Customer offboarding is underway before final closure",
      correlationId: `lifecycle-offboarding-${suffix}`,
      now: new Date("2026-08-09T07:08:00.000Z"),
    });
    workspace = await pool.query("SELECT state,access_generation FROM workspaces WHERE id=$1", [workspaceId]);
    assert.deepEqual(workspace.rows[0], { state: "open", access_generation: 2 }, "offboarding alone does not destroy customer compute");
    await store.updateTenantLifecycle(administratorSession, {
      tenantId,
      lifecycleState: "closed",
      reason: "Customer offboarding completed and tenant is now closed",
      correlationId: `lifecycle-close-${suffix}`,
      now: new Date("2026-08-09T07:09:00.000Z"),
    });
    assert.equal(await identity.getSession(tokenHash(`replacement-${suffix}`), new Date("2026-08-09T07:09:30.000Z")), null);
    workspace = await pool.query("SELECT state,failure_code,access_generation FROM workspaces WHERE id=$1", [workspaceId]);
    assert.deepEqual(workspace.rows[0], { state: "stopping", failure_code: "TENANT_CLOSED", access_generation: 3 });
    const closeClaims = (await store.claimTenantCleanupJobs({ limit: 100, now: new Date("2026-08-09T07:09:00.000Z") })).filter((job) => job.tenantId === tenantId);
    const firstCloseClaim = closeClaims.find((job) => job.workspaceId === workspaceId);
    for (const job of closeClaims.filter((candidate) => candidate.id !== firstCloseClaim?.id)) {
      await store.recordTenantCleanupProgress(job.id, job.leaseToken, "controller", new Date("2026-08-09T07:09:01.000Z"));
      await store.recordTenantCleanupProgress(job.id, job.leaseToken, "gateway", new Date("2026-08-09T07:09:02.000Z"));
      await store.recordTenantCleanupProgress(job.id, job.leaseToken, "storage", new Date("2026-08-09T07:09:03.000Z"));
      if (job.workspaceId === casWorkspaceId) {
        await pool.query("UPDATE workspaces SET access_generation=access_generation+1 WHERE id=$1", [casWorkspaceId]);
        await assert.rejects(
          () => store.completeTenantCleanupJob(job.id, job.leaseToken, new Date("2026-08-09T07:09:04.000Z")),
          { code: "PLATFORM_TENANT_CLEANUP_GENERATION_LOST" },
        );
        await pool.query("UPDATE workspaces SET access_generation=access_generation-1 WHERE id=$1", [casWorkspaceId]);
      }
      await store.completeTenantCleanupJob(job.id, job.leaseToken, new Date("2026-08-09T07:09:04.000Z"));
    }
    await store.recordTenantCleanupProgress(firstCloseClaim!.id, firstCloseClaim!.leaseToken, "controller", new Date("2026-08-09T07:09:01.000Z"));
    const reclaimedClose = (await store.claimTenantCleanupJobs({ limit: 100, now: new Date("2026-08-09T07:14:01.000Z") })).find((job) => job.id === firstCloseClaim!.id);
    assert.notEqual(reclaimedClose!.leaseToken, firstCloseClaim!.leaseToken);
    await assert.rejects(
      () => store.recordTenantCleanupProgress(firstCloseClaim!.id, firstCloseClaim!.leaseToken, "gateway", new Date("2026-08-09T07:14:02.000Z")),
      { code: "PLATFORM_TENANT_CLEANUP_LEASE_LOST" },
    );
    await store.recordTenantCleanupProgress(reclaimedClose!.id, reclaimedClose!.leaseToken, "gateway", new Date("2026-08-09T07:14:02.000Z"));
    await store.recordTenantCleanupProgress(reclaimedClose!.id, reclaimedClose!.leaseToken, "storage", new Date("2026-08-09T07:14:03.000Z"));
    await store.completeTenantCleanupJob(reclaimedClose!.id, reclaimedClose!.leaseToken, new Date("2026-08-09T07:14:04.000Z"));
    workspace = await pool.query("SELECT state,failure_code,access_generation FROM workspaces WHERE id=$1", [workspaceId]);
    assert.deepEqual(workspace.rows[0], { state: "stopped", failure_code: "TENANT_CLOSED", access_generation: 3 });
    assert.equal(await workspaces.authorizeWorkspaceAccess({ tenantId, subjectId: userId, audience: "lemmacomputer-control", workspaceId, accessGeneration: 2 }), false);
  } finally {
    await pool.end();
  }
});
