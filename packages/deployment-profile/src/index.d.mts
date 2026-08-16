export type ProductionDeploymentProfileId = "customer-managed" | "hosted";
export type DeploymentProfileId = ProductionDeploymentProfileId | "worktree";
export type SignInProviderId = "better-auth-customer";
export type CustomerAuthenticationMethod = "email-password" | "passkey" | "google-oauth" | "microsoft-oauth" | "saml" | "oidc";
export type WorkspaceNodeTopologyId = "colocated" | "remote";
export type WorkspaceExecutionBoundary = "local-operator-controlled" | "remote-isolated";
export type WorkspaceProviderQualification = "development-only" | "operator-approved" | "platform-qualified";
export type WorkspaceProviderRequiredControl = "tenant-context" | "signed-policy" | "governed-egress" | "lifecycle-audit" | "verified-purge";
export type HostedCapability = "externalIdentity" | "telemetry" | "billing" | "backgroundJobs" | "lemmaManagedControlPlane";

export interface WorkspaceNodeTopology {
  readonly id: WorkspaceNodeTopologyId;
  readonly executionBoundary: WorkspaceExecutionBoundary;
}

export interface WorkspaceProviderPolicy {
  readonly allowedExecutionBoundaries: readonly WorkspaceExecutionBoundary[];
  readonly minimumQualification: WorkspaceProviderQualification;
  readonly requiredControls: readonly WorkspaceProviderRequiredControl[];
}

export interface CustomerAuthenticationPolicy {
  readonly framework: "better-auth";
  readonly databaseScope: "installation-local" | "pooled-control-plane" | "development-isolated";
  readonly requiredLemmaHostedDependency: false;
  readonly allowedMethods: readonly CustomerAuthenticationMethod[];
}

export interface DeploymentProfileCapabilities {
  readonly id: DeploymentProfileId;
  readonly production: boolean;
  readonly operator: "customer" | "lemmacomputer" | "developer";
  readonly organizationCardinality: "exactly-one" | "multiple" | "development";
  readonly maximumOrganizations: number | null;
  readonly allowedSignInProviders: readonly SignInProviderId[];
  readonly customerAuthentication: CustomerAuthenticationPolicy;
  readonly platformOperatorRealm: "absent" | "separate-passkey";
  readonly identityConfigurationCustody: "customer" | "lemmacomputer" | "developer";
  readonly secretCustody: "customer" | "lemmacomputer" | "developer";
  readonly workspaceProviderPolicy: WorkspaceProviderPolicy;
  readonly connectorAdministration: "customer-operator" | "organization-admin" | "developer";
  readonly usageAccounting: "local" | "hosted" | "development";
  readonly hostedTelemetry: boolean;
  readonly hostedBilling: boolean;
  readonly hostedBackgroundJobs: boolean;
  readonly lemmaManagedControlPlane: "not-required" | "allowed" | "development-only";
}

export const productionDeploymentProfileIds: readonly ProductionDeploymentProfileId[];
export const deploymentProfileIds: readonly DeploymentProfileId[];
export const customerAuthenticationMethods: readonly CustomerAuthenticationMethod[];
export const workspaceNodeTopologies: Readonly<Record<WorkspaceNodeTopologyId, WorkspaceNodeTopology>>;
export const deploymentProfileCapabilityMatrix: Readonly<{
  schemaVersion: 4;
  profiles: Readonly<Record<DeploymentProfileId, DeploymentProfileCapabilities>>;
}>;

export function isDeploymentProfileId(value: unknown): value is DeploymentProfileId;
export function resolveDeploymentProfile(value: unknown, options?: { readonly allowDevelopment?: boolean }): DeploymentProfileCapabilities;
export function assertSignInProviderAllowed(profileId: DeploymentProfileId, providerId: SignInProviderId): DeploymentProfileCapabilities;
export function assertCustomerAuthenticationMethodAllowed(profileId: DeploymentProfileId, method: CustomerAuthenticationMethod): DeploymentProfileCapabilities;
export function assertWorkspaceProviderBoundaryAllowed(profileId: DeploymentProfileId, executionBoundary: WorkspaceExecutionBoundary): DeploymentProfileCapabilities;
export function assertWorkspaceNodeTopologyAllowed(profileId: DeploymentProfileId, topologyId: WorkspaceNodeTopologyId): DeploymentProfileCapabilities;
export function assertOrganizationCountAllowed(profileId: DeploymentProfileId, organizationCount: number): DeploymentProfileCapabilities;
export function assertHostedCapability(profileId: DeploymentProfileId, capability: HostedCapability): DeploymentProfileCapabilities;
