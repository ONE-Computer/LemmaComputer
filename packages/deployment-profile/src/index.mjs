/**
 * Deployment capabilities are product configuration, not authorization.
 * They describe which infrastructure choices an operator may make; callers
 * must still apply organization-scoped RBAC to each request.
 */

export const productionDeploymentProfileIds = Object.freeze([
  "customer-managed",
  "hosted",
]);

export const deploymentProfileIds = Object.freeze([
  ...productionDeploymentProfileIds,
  "worktree",
]);

const profile = (value) => Object.freeze({
  ...value,
  allowedSignInProviders: Object.freeze([...value.allowedSignInProviders]),
  allowedWorkspaceDrivers: Object.freeze([...value.allowedWorkspaceDrivers]),
});

/**
 * Checked-in machine-readable feature matrix. This is the only source for
 * deployment-profile capabilities; environment variables select a profile,
 * but do not redefine its security properties.
 */
export const deploymentProfileCapabilityMatrix = Object.freeze({
  schemaVersion: 1,
  profiles: Object.freeze({
    "customer-managed": profile({
      id: "customer-managed",
      production: true,
      operator: "customer",
      organizationCardinality: "exactly-one",
      maximumOrganizations: 1,
      allowedSignInProviders: ["workforce-entra"],
      identityConfigurationCustody: "customer",
      secretCustody: "customer",
      allowedWorkspaceDrivers: ["kasm-local", "kasm"],
      connectorAdministration: "customer-operator",
      usageAccounting: "local",
      hostedTelemetry: false,
      hostedBilling: false,
      hostedBackgroundJobs: false,
      lemmaManagedControlPlane: "not-required",
    }),
    hosted: profile({
      id: "hosted",
      production: true,
      operator: "lemmacomputer",
      organizationCardinality: "multiple",
      maximumOrganizations: null,
      allowedSignInProviders: ["external-id", "enterprise-entra"],
      identityConfigurationCustody: "lemmacomputer",
      secretCustody: "lemmacomputer",
      allowedWorkspaceDrivers: ["kasm"],
      connectorAdministration: "organization-admin",
      usageAccounting: "hosted",
      hostedTelemetry: true,
      hostedBilling: true,
      hostedBackgroundJobs: true,
      lemmaManagedControlPlane: "allowed",
    }),
    worktree: profile({
      id: "worktree",
      production: false,
      operator: "developer",
      organizationCardinality: "development",
      maximumOrganizations: null,
      allowedSignInProviders: ["development-fixture", "workforce-entra", "external-id", "enterprise-entra"],
      identityConfigurationCustody: "developer",
      secretCustody: "developer",
      allowedWorkspaceDrivers: ["kasm-local", "kasm"],
      connectorAdministration: "developer",
      usageAccounting: "development",
      hostedTelemetry: false,
      hostedBilling: false,
      hostedBackgroundJobs: false,
      lemmaManagedControlPlane: "development-only",
    }),
  }),
});

export function isDeploymentProfileId(value) {
  return typeof value === "string" && deploymentProfileIds.includes(value);
}

export function resolveDeploymentProfile(value, options = {}) {
  if (!isDeploymentProfileId(value)) {
    throw new Error("Deployment profile must be explicitly set to customer-managed, hosted, or worktree");
  }
  const resolved = deploymentProfileCapabilityMatrix.profiles[value];
  if (resolved.id === "worktree" && options.allowDevelopment === false) {
    throw new Error("worktree is development-only and cannot be used as a production deployment profile");
  }
  return resolved;
}

export function assertSignInProviderAllowed(profileId, providerId) {
  const resolved = resolveDeploymentProfile(profileId);
  if (!resolved.allowedSignInProviders.includes(providerId)) {
    throw new Error(`${providerId} sign-in is not allowed in the ${profileId} deployment profile`);
  }
  return resolved;
}

export function assertWorkspaceDriverAllowed(profileId, driverId) {
  const resolved = resolveDeploymentProfile(profileId);
  if (!resolved.allowedWorkspaceDrivers.includes(driverId)) {
    throw new Error(`${driverId} workspace execution is not allowed in the ${profileId} deployment profile`);
  }
  return resolved;
}

export function assertOrganizationCountAllowed(profileId, organizationCount) {
  const resolved = resolveDeploymentProfile(profileId);
  if (!Number.isSafeInteger(organizationCount) || organizationCount < 0) {
    throw new Error("Organization count must be a non-negative integer");
  }
  if (resolved.maximumOrganizations !== null && organizationCount > resolved.maximumOrganizations) {
    throw new Error(`${profileId} permits at most ${resolved.maximumOrganizations} organization`);
  }
  return resolved;
}

export function assertHostedCapability(profileId, capability) {
  const resolved = resolveDeploymentProfile(profileId);
  const allowed = {
    externalIdentity: resolved.allowedSignInProviders.includes("external-id"),
    telemetry: resolved.hostedTelemetry,
    billing: resolved.hostedBilling,
    backgroundJobs: resolved.hostedBackgroundJobs,
    lemmaManagedControlPlane: resolved.lemmaManagedControlPlane === "allowed",
  }[capability];
  if (allowed !== true) {
    throw new Error(`${capability} is a hosted-only capability and is not allowed in the ${profileId} deployment profile`);
  }
  return resolved;
}
