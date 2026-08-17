import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticationProviderContractSchema,
  customerAuthenticatedPrincipalSchema,
  hasRecentAuthenticationStepUp,
  identityLinkingAuthorizationSchema,
  isProductAuthorizationContextForPrincipal,
  hasRecentPlatformOperatorStepUp,
  platformRoleAllowsAction,
  platformSupportElevationRequestSchema,
  platformSupportElevationAllows,
  platformOperatorPrincipalSchema,
  productAuthorizationContextSchema,
} from "@lemmacomputer/contracts";

const customerPrincipal = {
  realm: "customer",
  authenticationSessionId: "ba_session_01KZQ4N4MJM6B0QGQ5AJ2W6J5K",
  accountUserId: "11111111-1111-4111-8111-111111111111",
  identity: {
    provider: "better-auth",
    issuer: "https://app.lemmacomputer.example/api/v1/auth/customer",
    subject: "11111111-1111-4111-8111-111111111111",
  },
  method: "email-password",
  assurance: {
    level: "aal2",
    factors: ["password", "totp"],
  },
  emailVerified: true,
  authenticatedAt: "2026-08-09T03:00:00.000Z",
  recentStepUpAt: "2026-08-09T03:01:00.000Z",
} as const;

test("customer authentication remains provider-neutral and contains no product authority", () => {
  const parsed = customerAuthenticatedPrincipalSchema.parse(customerPrincipal);
  assert.equal(parsed.identity.subject, customerPrincipal.accountUserId);

  for (const method of ["email-password", "passkey", "google-oauth", "microsoft-oauth", "saml", "oidc"] as const) {
    assert.equal(customerAuthenticatedPrincipalSchema.parse({ ...customerPrincipal, method }).method, method);
  }

  for (const forbidden of [
    { organizationId: "22222222-2222-4222-8222-222222222222" },
    { membershipId: "33333333-3333-4333-8333-333333333333" },
    { roles: ["owner"] },
    { permissions: ["organization.manage_settings"] },
    { providerGroups: ["tenant-admins"] },
  ]) {
    assert.equal(customerAuthenticatedPrincipalSchema.safeParse({ ...customerPrincipal, ...forbidden }).success, false);
  }
});

test("unknown authentication methods, factors, assurance, and provider capabilities fail closed", () => {
  assert.equal(customerAuthenticatedPrincipalSchema.safeParse({ ...customerPrincipal, method: "magic-admin-link" }).success, false);
  assert.equal(customerAuthenticatedPrincipalSchema.safeParse({
    ...customerPrincipal,
    assurance: { level: "superuser", factors: ["provider-admin-claim"] },
  }).success, false);

  const provider = {
    id: "better-auth-customer",
    realm: "customer",
    methods: ["email-password", "passkey", "google-oauth", "microsoft-oauth", "saml", "oidc"],
    capabilities: [
      "email-verification",
      "password-reset",
      "totp",
      "backup-codes",
      "passkeys",
      "social-oauth",
      "enterprise-sso",
      "session-revocation",
      "explicit-account-linking",
    ],
    implicitEmailLinking: false,
    productAuthorizationClaims: "ignored",
  };
  assert.equal(authenticationProviderContractSchema.safeParse(provider).success, true);
  assert.equal(authenticationProviderContractSchema.safeParse({
    ...provider,
    capabilities: [...provider.capabilities, "grant-owner-from-domain"],
  }).success, false);
  assert.equal(authenticationProviderContractSchema.safeParse({ ...provider, implicitEmailLinking: true }).success, false);
});

test("product authorization is a separate membership-bound server context", () => {
  const context = {
    authenticationSessionId: customerPrincipal.authenticationSessionId,
    accountUserId: customerPrincipal.accountUserId,
    organizationId: "22222222-2222-4222-8222-222222222222",
    organizationMembershipId: "33333333-3333-4333-8333-333333333333",
    membershipStatus: "active",
    createdAt: "2026-08-09T03:00:00.000Z",
    lastSeenAt: "2026-08-09T03:02:00.000Z",
    recentStepUpAt: "2026-08-09T03:01:00.000Z",
    revokedAt: null,
  } as const;
  assert.deepEqual(productAuthorizationContextSchema.parse(context), context);

  assert.equal(productAuthorizationContextSchema.safeParse({ ...context, membershipStatus: "suspended" }).success, false);
  assert.equal(productAuthorizationContextSchema.safeParse({ ...context, revokedAt: "2026-08-09T03:02:30.000Z" }).success, false);
  assert.equal(productAuthorizationContextSchema.safeParse({ ...context, organizationMembershipId: undefined }).success, false);
  assert.equal(productAuthorizationContextSchema.safeParse({ ...context, providerRole: "Global Administrator" }).success, false);
});

test("customer and platform-operator realms cannot be substituted", () => {
  assert.equal(platformOperatorPrincipalSchema.safeParse(customerPrincipal).success, false);
  const operator = {
    realm: "platform-operator",
    operatorSessionId: "operator_session_01KZQ4N4MJM6B0QGQ5AJ2W6J5K",
    operatorId: "44444444-4444-4444-8444-444444444444",
    identity: {
      provider: "better-auth",
      issuer: "https://app.lemmacomputer.example/api/v1/platform/auth/better-auth",
      subject: "platform-operator-id",
    },
    assurance: { level: "aal2", factors: ["passkey"] },
    authenticatedAt: "2026-08-09T03:00:00.000Z",
    recentStepUpAt: "2026-08-09T03:01:00.000Z",
  } as const;
  assert.equal(platformOperatorPrincipalSchema.safeParse(operator).success, true);
  assert.equal(platformOperatorPrincipalSchema.safeParse(operator).success, true);
  assert.equal(customerAuthenticatedPrincipalSchema.safeParse(operator).success, false);
  assert.equal(productAuthorizationContextSchema.safeParse(operator).success, false);
});

test("account linking requires dual authenticated proof or audited recovery", () => {
  assert.equal(identityLinkingAuthorizationSchema.safeParse({
    mechanism: "dual-authenticated-proof",
    sourceAuthenticationSessionId: "ba_source_session",
    targetAuthenticationSessionId: "ba_target_session",
    approvedAt: "2026-08-09T03:01:00.000Z",
  }).success, true);
  assert.equal(identityLinkingAuthorizationSchema.safeParse({
    mechanism: "audited-recovery",
    recoveryCaseId: "recovery-case-123",
    approvedByOperatorId: "44444444-4444-4444-8444-444444444444",
    approvedAt: "2026-08-09T03:01:00.000Z",
  }).success, true);
  assert.equal(identityLinkingAuthorizationSchema.safeParse({
    mechanism: "matching-email",
    email: "same@example.test",
  }).success, false);
});

test("a product context is authoritative only for the exact authenticated account and session", () => {
  const context = {
    authenticationSessionId: customerPrincipal.authenticationSessionId,
    accountUserId: customerPrincipal.accountUserId,
    organizationId: "22222222-2222-4222-8222-222222222222",
    organizationMembershipId: "33333333-3333-4333-8333-333333333333",
    membershipStatus: "active",
    createdAt: "2026-08-09T03:00:00.000Z",
    lastSeenAt: "2026-08-09T03:02:00.000Z",
    recentStepUpAt: "2026-08-09T03:01:00.000Z",
    revokedAt: null,
  } as const;
  assert.equal(isProductAuthorizationContextForPrincipal(customerPrincipal, context), true);
  assert.equal(isProductAuthorizationContextForPrincipal(customerPrincipal, {
    ...context,
    authenticationSessionId: "another-authentication-session",
  }), false);
  assert.equal(isProductAuthorizationContextForPrincipal(customerPrincipal, {
    ...context,
    accountUserId: "55555555-5555-4555-8555-555555555555",
  }), false);
  assert.equal(isProductAuthorizationContextForPrincipal(customerPrincipal, {
    ...context,
    organizationMembershipId: undefined,
  }), false);
});

test("recent step-up requires aal2 and a non-future timestamp within the fixed window", () => {
  const now = new Date("2026-08-09T03:10:00.000Z");
  assert.equal(hasRecentAuthenticationStepUp(customerPrincipal, now), true);
  assert.equal(hasRecentAuthenticationStepUp({ ...customerPrincipal, assurance: { level: "aal1", factors: ["password"] } }, now), false);
  assert.equal(hasRecentAuthenticationStepUp({ ...customerPrincipal, recentStepUpAt: null }, now), false);
  assert.equal(hasRecentAuthenticationStepUp({ ...customerPrincipal, recentStepUpAt: "2026-08-09T02:59:59.999Z" }, now), false);
  assert.equal(hasRecentAuthenticationStepUp({ ...customerPrincipal, recentStepUpAt: "2026-08-09T03:10:00.001Z" }, now), false);
});

test("platform roles allow only their documented actions and unknown actions deny", () => {
  assert.equal(platformRoleAllowsAction(["platform-administrator"], "tenant.lifecycle.manage"), true);
  assert.equal(platformRoleAllowsAction(["support-operator"], "support.elevation.request"), true);
  assert.equal(platformRoleAllowsAction(["support-operator"], "tenant.lifecycle.manage"), false);
  assert.equal(platformRoleAllowsAction(["security-auditor"], "platform.audit.read"), true);
  assert.equal(platformRoleAllowsAction(["billing-operator"], "billing.manage"), true);
  assert.equal(platformRoleAllowsAction(["billing-operator"], "platform.config.manage"), false);
  assert.equal(platformRoleAllowsAction(["platform-administrator"], "undocumented.action"), false);
  assert.equal(platformRoleAllowsAction(["customer-owner"], "platform.audit.read"), false);
});

test("operator step-up requires a passkey principal with aal2 no more than ten minutes old", () => {
  const operator = {
    realm: "platform-operator",
    operatorSessionId: "operator_session_01KZQ4N4MJM6B0QGQ5AJ2W6J5K",
    operatorId: "44444444-4444-4444-8444-444444444444",
    identity: {
      provider: "better-auth",
      issuer: "https://app.lemmacomputer.example/api/v1/platform/auth/better-auth",
      subject: "platform-operator-id",
    },
    assurance: { level: "aal2", factors: ["passkey"] },
    authenticatedAt: "2026-08-09T03:00:00.000Z",
    recentStepUpAt: "2026-08-09T03:01:00.000Z",
  } as const;
  const now = new Date("2026-08-09T03:10:00.000Z");
  assert.equal(hasRecentPlatformOperatorStepUp(operator, now), true);
  assert.equal(hasRecentPlatformOperatorStepUp(customerPrincipal, now), false);
  assert.equal(hasRecentPlatformOperatorStepUp({ ...operator, assurance: { level: "aal1", factors: ["password"] } }, now), false);
  assert.equal(hasRecentPlatformOperatorStepUp({ ...operator, recentStepUpAt: "2026-08-09T02:59:59.999Z" }, now), false);
});

test("tenant support elevation is target-bound, scoped, short-lived, and approval-aware", () => {
  const request = platformSupportElevationRequestSchema.parse({
    targetOrganizationId: "22222222-2222-4222-8222-222222222222",
    reason: "Investigate incident INC-1042 after tenant request",
    scopes: ["support.diagnostics.read"],
    durationMinutes: 20,
    kind: "support",
  });
  assert.equal(request.durationMinutes, 20);
  assert.equal(platformSupportElevationRequestSchema.safeParse({ ...request, reason: "help" }).success, false);
  assert.equal(platformSupportElevationRequestSchema.safeParse({ ...request, durationMinutes: 31 }).success, false);
  assert.equal(platformSupportElevationRequestSchema.safeParse({ ...request, scopes: ["tenant.owner"] }).success, false);
  assert.equal(platformSupportElevationRequestSchema.safeParse({ ...request, kind: "break-glass", durationMinutes: 16 }).success, false);
  assert.equal(platformSupportElevationRequestSchema.safeParse({ ...request, targetOrganizationId: "example" }).success, true, "canonical tenant IDs are not restricted to UUIDs");

  const elevation = {
    id: "55555555-5555-4555-8555-555555555555",
    operatorId: "44444444-4444-4444-8444-444444444444",
    operatorSessionId: "operator_session_01KZQ4N4MJM6B0QGQ5AJ2W6J5K",
    targetOrganizationId: request.targetOrganizationId,
    reason: request.reason,
    scopes: request.scopes,
    kind: "support",
    approvalRequired: false,
    approvedByOperatorId: null,
    createdAt: "2026-08-09T03:00:00.000Z",
    expiresAt: "2026-08-09T03:20:00.000Z",
    revokedAt: null,
  } as const;
  const now = new Date("2026-08-09T03:10:00.000Z");
  assert.equal(platformSupportElevationAllows(elevation, {
    operatorId: elevation.operatorId,
    operatorSessionId: elevation.operatorSessionId,
    targetOrganizationId: elevation.targetOrganizationId,
    scope: "support.diagnostics.read",
  }, now), true);
  assert.equal(platformSupportElevationAllows(elevation, {
    operatorId: elevation.operatorId,
    operatorSessionId: elevation.operatorSessionId,
    targetOrganizationId: "66666666-6666-4666-8666-666666666666",
    scope: "support.diagnostics.read",
  }, now), false);
  assert.equal(platformSupportElevationAllows({ ...elevation, revokedAt: "2026-08-09T03:09:00.000Z" }, {
    operatorId: elevation.operatorId,
    operatorSessionId: elevation.operatorSessionId,
    targetOrganizationId: elevation.targetOrganizationId,
    scope: "support.diagnostics.read",
  }, now), false);
  assert.equal(platformSupportElevationAllows({ ...elevation, approvalRequired: true }, {
    operatorId: elevation.operatorId,
    operatorSessionId: elevation.operatorSessionId,
    targetOrganizationId: elevation.targetOrganizationId,
    scope: "support.diagnostics.read",
  }, now), false);
  assert.equal(platformSupportElevationAllows(elevation, {
    operatorId: elevation.operatorId,
    operatorSessionId: elevation.operatorSessionId,
    targetOrganizationId: elevation.targetOrganizationId,
    scope: "support.diagnostics.read",
  }, new Date(elevation.expiresAt)), false);
});
