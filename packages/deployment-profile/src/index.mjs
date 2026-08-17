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

export const customerAuthenticationMethods = Object.freeze([
  "email-password",
  "passkey",
  "google-oauth",
  "microsoft-oauth",
  "saml",
  "oidc",
]);

export const workspaceNodeTopologies = Object.freeze({
  colocated: Object.freeze({
    id: "colocated",
    executionBoundary: "local-operator-controlled",
  }),
  remote: Object.freeze({
    id: "remote",
    executionBoundary: "remote-isolated",
  }),
});

const workspaceProviderPolicy = (value) => Object.freeze({
  ...value,
  allowedExecutionBoundaries: Object.freeze([...value.allowedExecutionBoundaries]),
  requiredControls: Object.freeze([...value.requiredControls]),
});

const profile = (value) => Object.freeze({
  ...value,
  allowedSignInProviders: Object.freeze([...value.allowedSignInProviders]),
  customerAuthentication: Object.freeze({
    ...value.customerAuthentication,
    allowedMethods: Object.freeze([...value.customerAuthentication.allowedMethods]),
  }),
  workspaceProviderPolicy: workspaceProviderPolicy(value.workspaceProviderPolicy),
});

/**
 * Checked-in machine-readable feature matrix. This is the only source for
 * deployment-profile capabilities; environment variables select a profile,
 * but do not redefine its security properties.
 */
export const deploymentProfileCapabilityMatrix = Object.freeze({
  schemaVersion: 4,
  profiles: Object.freeze({
    "customer-managed": profile({
      id: "customer-managed",
      production: true,
      operator: "customer",
      organizationCardinality: "exactly-one",
      maximumOrganizations: 1,
      allowedSignInProviders: ["better-auth-customer"],
      customerAuthentication: {
        framework: "better-auth",
        databaseScope: "installation-local",
        requiredLemmaHostedDependency: false,
        allowedMethods: customerAuthenticationMethods,
      },
      platformOperatorRealm: "absent",
      identityConfigurationCustody: "customer",
      secretCustody: "customer",
      workspaceProviderPolicy: {
        allowedExecutionBoundaries: ["local-operator-controlled", "remote-isolated"],
        minimumQualification: "operator-approved",
        requiredControls: ["tenant-context", "signed-policy", "governed-egress", "lifecycle-audit", "verified-purge"],
      },
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
      allowedSignInProviders: ["better-auth-customer"],
      customerAuthentication: {
        framework: "better-auth",
        databaseScope: "pooled-control-plane",
        requiredLemmaHostedDependency: false,
        allowedMethods: customerAuthenticationMethods,
      },
      platformOperatorRealm: "separate-passkey",
      identityConfigurationCustody: "lemmacomputer",
      secretCustody: "lemmacomputer",
      workspaceProviderPolicy: {
        allowedExecutionBoundaries: ["remote-isolated"],
        minimumQualification: "platform-qualified",
        requiredControls: ["tenant-context", "signed-policy", "governed-egress", "lifecycle-audit", "verified-purge"],
      },
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
      allowedSignInProviders: ["better-auth-customer"],
      customerAuthentication: {
        framework: "better-auth",
        databaseScope: "development-isolated",
        requiredLemmaHostedDependency: false,
        allowedMethods: customerAuthenticationMethods,
      },
      platformOperatorRealm: "separate-passkey",
      identityConfigurationCustody: "developer",
      secretCustody: "developer",
      workspaceProviderPolicy: {
        allowedExecutionBoundaries: ["local-operator-controlled", "remote-isolated"],
        minimumQualification: "development-only",
        requiredControls: [],
      },
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

export function assertCustomerAuthenticationMethodAllowed(profileId, method) {
  const resolved = resolveDeploymentProfile(profileId);
  if (!resolved.customerAuthentication.allowedMethods.includes(method)) {
    throw new Error(`${method} customer authentication is not allowed in the ${profileId} deployment profile`);
  }
  return resolved;
}

export function assertWorkspaceProviderBoundaryAllowed(profileId, executionBoundary) {
  const resolved = resolveDeploymentProfile(profileId);
  if (!resolved.workspaceProviderPolicy.allowedExecutionBoundaries.includes(executionBoundary)) {
    throw new Error(`${executionBoundary} workspace execution is not allowed in the ${profileId} deployment profile`);
  }
  return resolved;
}

/**
 * This is a topology gate, not provider qualification. Production providers
 * must separately prove every control and the minimum qualification level in
 * the resolved profile's workspaceProviderPolicy.
 */
export function assertWorkspaceNodeTopologyAllowed(profileId, topologyId) {
  const topology = workspaceNodeTopologies[topologyId];
  if (!topology) {
    throw new Error(`${topologyId} is not a registered workspace-node topology`);
  }
  return assertWorkspaceProviderBoundaryAllowed(profileId, topology.executionBoundary);
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
    externalIdentity: resolved.customerAuthentication.framework === "better-auth",
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
