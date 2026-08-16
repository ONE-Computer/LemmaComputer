import { z } from "zod";

export const authenticationRealms = ["customer", "platform-operator"] as const;
export const authenticationRealmSchema = z.enum(authenticationRealms);
export type AuthenticationRealm = z.infer<typeof authenticationRealmSchema>;

export const authenticationMethods = [
  "email-password",
  "passkey",
  "google-oauth",
  "microsoft-oauth",
  "saml",
  "oidc",
  "workforce-oidc",
] as const;
export const authenticationMethodSchema = z.enum(authenticationMethods);
export type AuthenticationMethod = z.infer<typeof authenticationMethodSchema>;

export const authenticationFactors = ["password", "totp", "passkey", "federated"] as const;
export const authenticationFactorSchema = z.enum(authenticationFactors);
export type AuthenticationFactor = z.infer<typeof authenticationFactorSchema>;

export const authenticationAssuranceLevels = ["aal1", "aal2"] as const;
export const authenticationAssuranceLevelSchema = z.enum(authenticationAssuranceLevels);
export type AuthenticationAssuranceLevel = z.infer<typeof authenticationAssuranceLevelSchema>;

export const authenticationAssuranceSchema = z.strictObject({
  level: authenticationAssuranceLevelSchema,
  factors: z.array(authenticationFactorSchema).min(1).max(authenticationFactors.length),
}).superRefine((value, context) => {
  if (new Set(value.factors).size !== value.factors.length) {
    context.addIssue({ code: "custom", path: ["factors"], message: "Authentication factors must be unique" });
  }
});
export type AuthenticationAssurance = z.infer<typeof authenticationAssuranceSchema>;

export const authenticationProviderIdentitySchema = z.strictObject({
  provider: z.enum(["better-auth", "entra-external-id", "workforce-entra"]),
  issuer: z.url(),
  subject: z.string().trim().min(1).max(512),
});
export type AuthenticationProviderIdentity = z.infer<typeof authenticationProviderIdentitySchema>;

const opaqueSessionIdSchema = z.string().trim().min(8).max(512);

export const customerAuthenticatedPrincipalSchema = z.strictObject({
  realm: z.literal("customer"),
  authenticationSessionId: opaqueSessionIdSchema,
  accountUserId: z.uuid(),
  identity: authenticationProviderIdentitySchema,
  method: z.enum(authenticationMethods.filter((method) => method !== "workforce-oidc") as [
    Exclude<AuthenticationMethod, "workforce-oidc">,
    ...Exclude<AuthenticationMethod, "workforce-oidc">[],
  ]),
  assurance: authenticationAssuranceSchema,
  emailVerified: z.boolean(),
  authenticatedAt: z.iso.datetime(),
  recentStepUpAt: z.iso.datetime().nullable(),
}).superRefine((value, context) => {
  if (value.identity.provider === "workforce-entra") {
    context.addIssue({ code: "custom", path: ["identity", "provider"], message: "Workforce identity cannot authenticate a customer principal" });
  }
});
export type CustomerAuthenticatedPrincipal = z.infer<typeof customerAuthenticatedPrincipalSchema>;

export const platformOperatorPrincipalSchema = z.strictObject({
  realm: z.literal("platform-operator"),
  operatorSessionId: opaqueSessionIdSchema,
  operatorId: z.uuid(),
  identity: authenticationProviderIdentitySchema,
  assurance: authenticationAssuranceSchema,
  authenticatedAt: z.iso.datetime(),
  recentStepUpAt: z.iso.datetime().nullable(),
}).superRefine((value, context) => {
  if (!["workforce-entra", "better-auth"].includes(value.identity.provider)) {
    context.addIssue({ code: "custom", path: ["identity", "provider"], message: "Platform operators require a dedicated workforce or platform authentication realm" });
  }
});
export type PlatformOperatorPrincipal = z.infer<typeof platformOperatorPrincipalSchema>;

export const platformRoles = [
  "platform-administrator",
  "support-operator",
  "security-auditor",
  "billing-operator",
] as const;
export const platformRoleSchema = z.enum(platformRoles);
export type PlatformRole = z.infer<typeof platformRoleSchema>;

export const platformActions = [
  "tenant.lifecycle.read",
  "tenant.lifecycle.manage",
  "service.health.read",
  "incident.read",
  "incident.manage",
  "platform.config.read",
  "platform.config.manage",
  "platform.audit.read",
  "billing.read",
  "billing.manage",
  "support.elevation.request",
  "support.elevation.read",
  "support.elevation.approve",
  "support.elevation.revoke",
  "support.elevation.use",
] as const;
export const platformActionSchema = z.enum(platformActions);
export type PlatformAction = z.infer<typeof platformActionSchema>;

const platformActionSet = (actions: readonly PlatformAction[]) => new Set<PlatformAction>(actions);

const platformRoleActions: Readonly<Record<PlatformRole, ReadonlySet<PlatformAction>>> = Object.freeze({
  "platform-administrator": platformActionSet([
    "tenant.lifecycle.read",
    "tenant.lifecycle.manage",
    "service.health.read",
    "incident.read",
    "incident.manage",
    "platform.config.read",
    "platform.config.manage",
    "platform.audit.read",
    "support.elevation.request",
    "support.elevation.read",
    "support.elevation.approve",
    "support.elevation.revoke",
    "support.elevation.use",
  ]),
  "support-operator": platformActionSet([
    "tenant.lifecycle.read",
    "service.health.read",
    "incident.read",
    "incident.manage",
    "support.elevation.request",
    "support.elevation.read",
    "support.elevation.revoke",
    "support.elevation.use",
  ]),
  "security-auditor": platformActionSet([
    "service.health.read",
    "incident.read",
    "platform.config.read",
    "platform.audit.read",
    "support.elevation.read",
    "support.elevation.approve",
    "support.elevation.revoke",
  ]),
  "billing-operator": platformActionSet([
    "tenant.lifecycle.read",
    "billing.read",
    "billing.manage",
  ]),
});

export const platformRoleAllowsAction = (roles: readonly unknown[], action: unknown): boolean => {
  const parsedAction = platformActionSchema.safeParse(action);
  if (!parsedAction.success) return false;
  return roles.some((role) => {
    const parsedRole = platformRoleSchema.safeParse(role);
    return parsedRole.success && platformRoleActions[parsedRole.data].has(parsedAction.data);
  });
};

export const platformSupportScopes = [
  "support.diagnostics.read",
  "support.configuration.read",
  "support.customer-content.read",
  "support.identity-recovery.manage",
] as const;
export const platformSupportScopeSchema = z.enum(platformSupportScopes);
export type PlatformSupportScope = z.infer<typeof platformSupportScopeSchema>;

export const approvalRequiredPlatformSupportScopes = Object.freeze([
  "support.customer-content.read",
  "support.identity-recovery.manage",
] satisfies readonly PlatformSupportScope[]);

export const tenantIdentifierSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Tenant identifier contains unsupported characters");

export const platformSupportElevationRequestSchema = z.strictObject({
  targetOrganizationId: tenantIdentifierSchema,
  reason: z.string().trim().min(12).max(1_000),
  scopes: z.array(platformSupportScopeSchema).min(1).max(platformSupportScopes.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, "Elevation scopes must be unique"),
  durationMinutes: z.number().int().min(1).max(30),
  kind: z.enum(["support", "break-glass"]),
}).superRefine((value, context) => {
  if (value.kind === "break-glass" && value.durationMinutes > 15) {
    context.addIssue({
      code: "custom",
      path: ["durationMinutes"],
      message: "Break-glass elevation cannot exceed 15 minutes",
    });
  }
});
export type PlatformSupportElevationRequest = z.infer<typeof platformSupportElevationRequestSchema>;

export const platformSupportElevationSchema = z.strictObject({
  id: z.uuid(),
  operatorId: z.uuid(),
  operatorSessionId: opaqueSessionIdSchema,
  targetOrganizationId: tenantIdentifierSchema,
  reason: z.string().trim().min(12).max(1_000),
  scopes: z.array(platformSupportScopeSchema).min(1).max(platformSupportScopes.length),
  kind: z.enum(["support", "break-glass"]),
  approvalRequired: z.boolean(),
  approvedByOperatorId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type PlatformSupportElevation = z.infer<typeof platformSupportElevationSchema>;

export const platformSupportElevationAllows = (
  elevation: unknown,
  request: {
    operatorId: string;
    operatorSessionId: string;
    targetOrganizationId: string;
    scope: unknown;
  },
  now = new Date(),
): boolean => {
  const parsed = platformSupportElevationSchema.safeParse(elevation);
  const scope = platformSupportScopeSchema.safeParse(request.scope);
  if (!parsed.success || !scope.success) return false;
  const value = parsed.data;
  return value.operatorId === request.operatorId
    && value.operatorSessionId === request.operatorSessionId
    && value.targetOrganizationId === request.targetOrganizationId
    && value.scopes.includes(scope.data)
    && value.revokedAt === null
    && new Date(value.createdAt).getTime() <= now.getTime()
    && now.getTime() < new Date(value.expiresAt).getTime()
    && (!value.approvalRequired || value.approvedByOperatorId !== null);
};

export const authenticationCapabilities = [
  "email-verification",
  "password-reset",
  "totp",
  "backup-codes",
  "passkeys",
  "social-oauth",
  "enterprise-sso",
  "session-revocation",
  "explicit-account-linking",
] as const;
export const authenticationCapabilitySchema = z.enum(authenticationCapabilities);
export type AuthenticationCapability = z.infer<typeof authenticationCapabilitySchema>;

export const authenticationProviderContractSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  realm: authenticationRealmSchema,
  methods: z.array(authenticationMethodSchema).min(1).max(authenticationMethods.length),
  capabilities: z.array(authenticationCapabilitySchema).min(1).max(authenticationCapabilities.length),
  implicitEmailLinking: z.literal(false),
  productAuthorizationClaims: z.literal("ignored"),
}).superRefine((value, context) => {
  if (new Set(value.methods).size !== value.methods.length) {
    context.addIssue({ code: "custom", path: ["methods"], message: "Authentication methods must be unique" });
  }
  if (new Set(value.capabilities).size !== value.capabilities.length) {
    context.addIssue({ code: "custom", path: ["capabilities"], message: "Authentication capabilities must be unique" });
  }
  if (value.realm === "customer" && value.methods.includes("workforce-oidc")) {
    context.addIssue({ code: "custom", path: ["methods"], message: "Customer providers cannot expose the workforce operator method" });
  }
  if (value.realm === "platform-operator" && value.methods.some((method) => method !== "workforce-oidc")) {
    context.addIssue({ code: "custom", path: ["methods"], message: "Platform operator providers cannot expose customer authentication methods" });
  }
});
export type AuthenticationProviderContract = z.infer<typeof authenticationProviderContractSchema>;

// This is an active, server-resolved product authorization context. Historical
// or revoked records use a persistence-specific shape and cannot be accepted by
// this schema as current authority.
export const productAuthorizationContextSchema = z.strictObject({
  authenticationSessionId: opaqueSessionIdSchema,
  accountUserId: z.uuid(),
  organizationId: z.uuid(),
  organizationMembershipId: z.uuid(),
  membershipStatus: z.literal("active"),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  recentStepUpAt: z.iso.datetime().nullable(),
  revokedAt: z.null(),
});
export type ProductAuthorizationContext = z.infer<typeof productAuthorizationContextSchema>;

export const isProductAuthorizationContextForPrincipal = (principal: unknown, context: unknown): boolean => {
  const parsedPrincipal = customerAuthenticatedPrincipalSchema.safeParse(principal);
  const parsedContext = productAuthorizationContextSchema.safeParse(context);
  return parsedPrincipal.success
    && parsedContext.success
    && parsedPrincipal.data.authenticationSessionId === parsedContext.data.authenticationSessionId
    && parsedPrincipal.data.accountUserId === parsedContext.data.accountUserId;
};

export const recentAuthenticationStepUpWindowMs = 10 * 60 * 1_000;

export const hasRecentAuthenticationStepUp = (principal: unknown, now = new Date()): boolean => {
  const parsed = customerAuthenticatedPrincipalSchema.safeParse(principal);
  if (!parsed.success || parsed.data.assurance.level !== "aal2" || parsed.data.recentStepUpAt === null) return false;
  const ageMs = now.getTime() - new Date(parsed.data.recentStepUpAt).getTime();
  return ageMs >= 0 && ageMs <= recentAuthenticationStepUpWindowMs;
};

export const hasRecentPlatformOperatorStepUp = (principal: unknown, now = new Date()): boolean => {
  const parsed = platformOperatorPrincipalSchema.safeParse(principal);
  if (!parsed.success || parsed.data.assurance.level !== "aal2" || parsed.data.recentStepUpAt === null) return false;
  const ageMs = now.getTime() - new Date(parsed.data.recentStepUpAt).getTime();
  return ageMs >= 0 && ageMs <= recentAuthenticationStepUpWindowMs;
};

export const identityLinkingAuthorizationSchema = z.discriminatedUnion("mechanism", [
  z.strictObject({
    mechanism: z.literal("dual-authenticated-proof"),
    sourceAuthenticationSessionId: opaqueSessionIdSchema,
    targetAuthenticationSessionId: opaqueSessionIdSchema,
    approvedAt: z.iso.datetime(),
  }).refine(
    (value) => value.sourceAuthenticationSessionId !== value.targetAuthenticationSessionId,
    { path: ["targetAuthenticationSessionId"], message: "Identity linking requires proof from two distinct sessions" },
  ),
  z.strictObject({
    mechanism: z.literal("audited-recovery"),
    recoveryCaseId: z.string().trim().min(1).max(256),
    approvedByOperatorId: z.uuid(),
    approvedAt: z.iso.datetime(),
  }),
]);
export type IdentityLinkingAuthorization = z.infer<typeof identityLinkingAuthorizationSchema>;
