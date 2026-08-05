export type ProductionDeploymentProfileId = "customer-managed" | "hosted";
export type DeploymentProfileId = ProductionDeploymentProfileId | "worktree";
export type SignInProviderId = "development-fixture" | "workforce-entra" | "external-id" | "enterprise-entra";
export type WorkspaceDriverId = "kasm-local" | "kasm";
export type HostedCapability = "externalIdentity" | "telemetry" | "billing" | "backgroundJobs" | "lemmaManagedControlPlane";

export interface DeploymentProfileCapabilities {
  readonly id: DeploymentProfileId;
  readonly production: boolean;
  readonly operator: "customer" | "lemmacomputer" | "developer";
  readonly organizationCardinality: "exactly-one" | "multiple" | "development";
  readonly maximumOrganizations: number | null;
  readonly allowedSignInProviders: readonly SignInProviderId[];
  readonly identityConfigurationCustody: "customer" | "lemmacomputer" | "developer";
  readonly secretCustody: "customer" | "lemmacomputer" | "developer";
  readonly allowedWorkspaceDrivers: readonly WorkspaceDriverId[];
  readonly connectorAdministration: "customer-operator" | "organization-admin" | "developer";
  readonly usageAccounting: "local" | "hosted" | "development";
  readonly hostedTelemetry: boolean;
  readonly hostedBilling: boolean;
  readonly hostedBackgroundJobs: boolean;
  readonly lemmaManagedControlPlane: "not-required" | "allowed" | "development-only";
}

export const productionDeploymentProfileIds: readonly ProductionDeploymentProfileId[];
export const deploymentProfileIds: readonly DeploymentProfileId[];
export const deploymentProfileCapabilityMatrix: Readonly<{
  schemaVersion: 1;
  profiles: Readonly<Record<DeploymentProfileId, DeploymentProfileCapabilities>>;
}>;

export function isDeploymentProfileId(value: unknown): value is DeploymentProfileId;
export function resolveDeploymentProfile(value: unknown, options?: { readonly allowDevelopment?: boolean }): DeploymentProfileCapabilities;
export function assertSignInProviderAllowed(profileId: DeploymentProfileId, providerId: SignInProviderId): DeploymentProfileCapabilities;
export function assertWorkspaceDriverAllowed(profileId: DeploymentProfileId, driverId: WorkspaceDriverId): DeploymentProfileCapabilities;
export function assertOrganizationCountAllowed(profileId: DeploymentProfileId, organizationCount: number): DeploymentProfileCapabilities;
export function assertHostedCapability(profileId: DeploymentProfileId, capability: HostedCapability): DeploymentProfileCapabilities;
