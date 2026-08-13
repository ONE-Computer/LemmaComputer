import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { defaultClipboardPolicy, egressSecurityGroupVersionSchema, LemmaComputerError, m365ToolCatalog, ownedAgentCatalog, recentAuthenticationStepUpWindowMs, runtimePolicySchema, sandboxApplicationIds, type AgentCatalogId, type AgentProfile, type EgressSecurityGroupVersion, type EgressSecurityGroupRule, type IdentityContext, type McpToolPolicyDecision, type OwnedJson, type RuntimePolicy, type SandboxApplicationId } from "@lemmacomputer/contracts";
import { compileEgressSecurityGroup } from "@lemmacomputer/egress-policy";
import {
  canDelegateOrganizationGrants,
  organizationPermissionCatalog,
  organizationPermissionCatalogVersion,
  permissionsByOrganizationRole,
  permissionsForOrganizationRoles,
  resolveEffectiveOrganizationPermissions,
  type EffectiveOrganizationPermissions,
  type LemmaComputerRole,
  type OrganizationMembershipStatus,
  type OrganizationPermission,
  type OrganizationPermissionGrant,
  type OrganizationRole,
} from "./rbac.js";

export type LemmaComputerUserStatus = "active" | "disabled";
export type MembershipAdmissionMode = "directory-jit" | "existing-membership-only";
export type { LemmaComputerRole, OrganizationMembershipStatus, OrganizationPermission, OrganizationRole } from "./rbac.js";

export const shouldAssignDefaultPolicyOnAuthentication = (
  hasExistingIdentityMapping: boolean,
  shouldBootstrapAdministrator: boolean,
) => !hasExistingIdentityMapping || shouldBootstrapAdministrator;

const isLastActiveOwnerViolation = (error: unknown) => (
  error instanceof Error
  && "code" in error
  && (error as Error & { code?: string }).code === "23514"
  && error.message.includes("organization must retain at least one active owner")
);

export type SessionPrincipal = {
  userId: string;
  accountUserId?: string;
  tenantId: string;
  organizationId?: string;
  membershipId?: string;
  membershipStatus?: OrganizationMembershipStatus;
  role?: OrganizationRole;
  permissions?: OrganizationPermission[];
  effectiveAuthorization?: EffectiveOrganizationPermissions;
  email: string;
  displayName: string;
  tenantDisplayName: string;
  roles: LemmaComputerRole[];
  identity: IdentityContext;
};

export type OidcLoginAttempt = {
  verifierCiphertext: string;
  nonce: string;
  returnPath: string;
};

export type EffectivePolicy = {
  assignmentId: string;
  policyBundleId: string;
  policyVersionId: string;
  version: number;
  documentHash: string;
  assignedBy: string;
  assignedAt: string;
  agentId: string;
  vendorUserId: string;
  document: OwnedJson;
  egressSecurityGroup?: EgressSecurityGroupVersion | null;
};

const agentProfileFor = (catalogId: AgentCatalogId): AgentProfile => ({
  "claude-desktop": "claude-desktop-managed-v1",
  "claude-cli": "claude-cli-managed-v1",
  "codex-cli": "codex-cli-managed-v1",
  "hermes-desktop": "hermes-desktop-managed-v1",
  "hermes-claw": "hermes-claw-managed-v1",
})[catalogId] as AgentProfile;

const agentCatalogIdFor = (profile: unknown): AgentCatalogId => ({
  "claude-desktop-managed-v1": "claude-desktop",
  "claude-cli-managed-v1": "claude-cli",
  "codex-cli-managed-v1": "codex-cli",
  "hermes-desktop-managed-v1": "hermes-desktop",
  "hermes-claw-managed-v1": "hermes-claw",
})[String(profile)] as AgentCatalogId | undefined ?? "claude-desktop";

export const runtimePolicyFor = (
  policy: EffectivePolicy,
  selectedModelAlias?: string,
  selectedWorkspaceProfile?: string,
  selectedAgentIds?: AgentCatalogId[],
  selectedApplicationIds?: SandboxApplicationId[],
  workspaceEgressSecurityGroup?: EgressSecurityGroupVersion | null,
  additionalAllowedModelAliases: readonly string[] = [],
): RuntimePolicy => {
  const document = policy.document as Record<string, unknown>;
  const mcp = document.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, unknown> | undefined;
  const entries = Object.entries(servers ?? {});
  if (entries.length !== 1) throw new LemmaComputerError("POLICY_INVALID", "The active workspace policy must assign exactly one MCP server", 500);
  const [mcpServer, serverPolicy] = entries[0]!;
  const tools = (serverPolicy as Record<string, unknown>)?.tools;
  const configuredToolPolicies = (serverPolicy as Record<string, unknown>)?.toolPolicies as Record<string, unknown> | undefined;
  const toolPolicies = Object.fromEntries((Array.isArray(tools) ? tools : []).map((tool) => {
    const name = String(tool) as keyof typeof m365ToolCatalog;
    return [name, configuredToolPolicies?.[name] ?? m365ToolCatalog[name]?.decision ?? "deny"];
  }));
  const modelAliases = document.modelAliases;
  const policyModelAliases = Array.isArray(modelAliases) ? modelAliases.filter((value): value is string => typeof value === "string") : [];
  const allowedModelAliases = [...new Set([...policyModelAliases, ...additionalAllowedModelAliases])];
  const workspaceProfiles = Array.isArray(document.workspaceProfiles)
    ? document.workspaceProfiles.filter((value): value is string => typeof value === "string")
    : typeof document.workspaceProfile === "string" ? [document.workspaceProfile] : [];
  const modelAlias = selectedModelAlias ?? allowedModelAliases[0];
  const workspaceProfile = selectedWorkspaceProfile ?? workspaceProfiles[0];
  const clipboard = document.clipboard && typeof document.clipboard === "object" && !Array.isArray(document.clipboard)
    ? document.clipboard as Record<string, unknown>
    : defaultClipboardPolicy;
  if (!modelAlias || !allowedModelAliases.includes(modelAlias)) throw new LemmaComputerError("MODEL_NOT_ASSIGNED", "The selected model route is not assigned by the active policy", 403);
  if (!workspaceProfile || !workspaceProfiles.includes(workspaceProfile)) throw new LemmaComputerError("PROFILE_NOT_ASSIGNED", "The selected sandbox profile is not assigned by the active policy", 403);
  const hasAgentCatalog = Array.isArray(document.agents) || selectedAgentIds !== undefined;
  const configuredAgentIds = Array.isArray(document.agents)
    ? document.agents.filter((value): value is AgentCatalogId => typeof value === "string" && ownedAgentCatalog.some((agent) => agent.id === value))
    : hasAgentCatalog
      ? ownedAgentCatalog.map((agent) => agent.id)
      : [agentCatalogIdFor(document.agentProfile)];
  const defaultAgentIds = Array.isArray(document.defaultAgents)
    ? document.defaultAgents.filter((value): value is AgentCatalogId => typeof value === "string" && configuredAgentIds.includes(value as AgentCatalogId))
    : configuredAgentIds;
  const agentIds = hasAgentCatalog ? selectedAgentIds ?? defaultAgentIds : configuredAgentIds;
  if (!agentIds.length || new Set(agentIds).size !== agentIds.length) {
    throw new LemmaComputerError("AGENT_SELECTION_INVALID", "At least one unique workspace agent must be selected", 400);
  }
  if (agentIds.some((id) => !configuredAgentIds.includes(id))) {
    throw new LemmaComputerError("AGENT_NOT_ASSIGNED", "A selected agent is not assigned by the active policy", 403);
  }
  const configuredApplicationIds = Array.isArray(document.applications)
    ? document.applications.filter((value): value is SandboxApplicationId => typeof value === "string" && sandboxApplicationIds.includes(value as SandboxApplicationId))
    : ["firefox"] as SandboxApplicationId[];
  const defaultApplicationIds = Array.isArray(document.defaultApplications)
    ? document.defaultApplications.filter((value): value is SandboxApplicationId => typeof value === "string" && configuredApplicationIds.includes(value as SandboxApplicationId))
    : configuredApplicationIds;
  const applicationIds = selectedApplicationIds ?? defaultApplicationIds;
  if (!applicationIds.length || new Set(applicationIds).size !== applicationIds.length) {
    throw new LemmaComputerError("APPLICATION_SELECTION_INVALID", "At least one unique sandbox application must be selected", 400);
  }
  if (applicationIds.some((id) => !configuredApplicationIds.includes(id))) {
    throw new LemmaComputerError("APPLICATION_NOT_ASSIGNED", "A selected application is not assigned by the active policy", 403);
  }
  const agents = hasAgentCatalog ? agentIds.map((catalogId) => {
    const catalog = ownedAgentCatalog.find((entry) => entry.id === catalogId);
    if (!catalog) throw new LemmaComputerError("AGENT_UNAVAILABLE", "A selected agent is unavailable in the owned catalog", 500);
    return {
      catalogId,
      agentId: `${policy.agentId}:${catalogId}`,
      agentProfile: agentProfileFor(catalogId),
      displayName: catalog.displayName,
      clientVersion: catalog.clientVersion,
      modelAlias,
      mcpServer,
      allowedTools: tools as string[],
      toolPolicies,
    };
  }) : undefined;
  const primaryAgent = agents?.[0];
  const executionMode = workspaceProfile === "disposable-open-v1" ? "disposable-open" as const : "managed" as const;
  const attachedEgress = workspaceEgressSecurityGroup === undefined
    ? policy.egressSecurityGroup
    : workspaceEgressSecurityGroup;
  const fullWebEgress = attachedEgress
    ? attachedEgress.defaultAction === "allow-public-http-https"
    : executionMode === "disposable-open";
  const egressMode = fullWebEgress ? "full-web" as const : "restricted" as const;
  const egress = fullWebEgress
    ? {
        schemaVersion: 2 as const,
        mode: "full-web" as const,
        id: attachedEgress?.id ?? `egv_full_web_${policy.documentHash.slice(0, 24)}`,
        securityGroupId: attachedEgress?.securityGroupId ?? "esg_disposable_open",
        version: attachedEgress?.version ?? policy.version,
        name: attachedEgress?.name ?? "Disposable open public web",
        description: attachedEgress?.description ?? "Public HTTP and HTTPS through the workspace egress proxy; private and reserved destinations remain blocked.",
        defaultAction: "allow-public-http-https" as const,
        rules: attachedEgress?.rules.filter((rule) => rule.action === "deny") ?? [],
        documentHash: createHash("sha256")
          .update(`lemmacomputer-full-web-v2\0${policy.documentHash}\0${attachedEgress?.documentHash ?? "no-explicit-rules"}`)
          .digest("hex"),
      }
    : attachedEgress ? {
        schemaVersion: 2 as const,
        mode: "restricted" as const,
        id: attachedEgress.id,
        securityGroupId: attachedEgress.securityGroupId,
        version: attachedEgress.version,
        name: attachedEgress.name,
        description: attachedEgress.description,
        defaultAction: attachedEgress.defaultAction,
        rules: attachedEgress.rules,
        documentHash: attachedEgress.documentHash,
      } : undefined;
  return runtimePolicySchema.parse({
    schemaVersion: 1,
    policyVersionId: policy.policyVersionId,
    policyVersion: policy.version,
    policyHash: policy.documentHash,
    workspaceProfile,
    executionMode,
    egressMode,
    agentId: primaryAgent?.agentId ?? policy.agentId,
    agentProfile: primaryAgent?.agentProfile ?? document.agentProfile,
    ...(agents ? { agents } : {}),
    applications: applicationIds,
    networkProfile: document.networkProfile,
    ...(egress ? { egress } : {}),
    clipboard: {
      enabled: clipboard.enabled ?? defaultClipboardPolicy.enabled,
      localToWorkspace: clipboard.localToWorkspace ?? defaultClipboardPolicy.localToWorkspace,
      workspaceToLocal: clipboard.workspaceToLocal ?? defaultClipboardPolicy.workspaceToLocal,
      maxBytes: clipboard.maxBytes ?? defaultClipboardPolicy.maxBytes,
    },
    modelAlias,
    mcpServer,
    ...(typeof document.maximumReasoningEffort === "string"
      ? { maximumReasoningEffort: document.maximumReasoningEffort }
      : {}),
    allowedTools: tools,
    toolPolicies,
  });
};

export type AdminUserSummary = {
  userId: string;
  membershipId?: string;
  organizationId?: string;
  membershipStatus?: OrganizationMembershipStatus;
  role?: OrganizationRole;
  email: string;
  displayName: string;
  status: LemmaComputerUserStatus;
  roles: LemmaComputerRole[];
  effectivePolicy: EffectivePolicy | null;
};

export type AuthenticatedIdentity = {
  provider: string;
  issuer: string;
  subject: string;
  providerObjectId?: string;
  externalTenantId: string;
  email: string;
  displayName: string;
  organizationId: string;
  organizationDisplayName: string;
  userId: string;
  bootstrapOwner: boolean;
  membershipAdmissionMode: MembershipAdmissionMode;
  /** Legacy caller hint; durable gateway identity is derived from the resolved organization and user. */
  gatewayUserId?: string;
  invitationTokenHash?: string;
  browserSession?: { tokenHash: string; expiresAt: Date };
};

export type OrganizationInvitationContext = {
  organizationId: string;
  organizationDisplayName: string;
  invitationId: string;
  status: "pending";
};

export type OrganizationMembershipSummary = {
  membershipId: string;
  organizationId: string;
  accountUserId: string;
  userId: string;
  email: string;
  displayName: string;
  status: OrganizationMembershipStatus;
  role: OrganizationRole;
  createdAt: string;
  updatedAt: string;
};

export type CustomerProductMembership = {
  membershipId: string;
  organizationId: string;
  organizationDisplayName: string;
  userId: string;
  status: OrganizationMembershipStatus;
  role: OrganizationRole;
};

export type CustomerOrganizationCreation = {
  replayed: boolean;
  organization: {
    id: string;
    slug: string;
    displayName: string;
  };
  membership: {
    id: string;
    status: "active";
    role: "owner";
  };
};

export interface CustomerProductSessionStore {
  ensureCustomerAccount(input: { accountUserId: string }): Promise<{
    accountUserId: string;
    status: LemmaComputerUserStatus;
  }>;
  listCustomerMemberships(accountUserId: string): Promise<CustomerProductMembership[]>;
  getCustomerProductSession(input: {
    authenticationSessionId: string;
    accountUserId: string;
    now: Date;
  }): Promise<SessionPrincipal | null>;
  selectCustomerProductSession(input: {
    authenticationSessionId: string;
    accountUserId: string;
    membershipId: string;
    expiresAt: Date;
    now: Date;
  }): Promise<SessionPrincipal>;
  createCustomerOrganization?(input: {
    accountUserId: string;
    authenticationSessionId: string;
    email: string;
    userDisplayName: string;
    organizationDisplayName: string;
    idempotencyKey: string;
    installationKind: "customer-managed" | "hosted" | "worktree";
    expiresAt: Date;
    now: Date;
  }): Promise<CustomerOrganizationCreation>;
  createCustomerInvitationContext?(input: {
    invitationTokenHash: string;
    contextTokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<{
    organizationId: string;
    organizationDisplayName: string;
    email: string;
    role: OrganizationRole;
    expiresAt: Date;
  }>;
  getCustomerInvitationContext?(input: {
    contextTokenHash: string;
    now: Date;
  }): Promise<{
    organizationId: string;
    organizationDisplayName: string;
    email: string;
    role: OrganizationRole;
    expiresAt: Date;
  }>;
  acceptCustomerInvitation?(input: {
    accountUserId: string;
    authenticationSessionId: string;
    contextTokenHash: string;
    email: string;
    userDisplayName: string;
    expiresAt: Date;
    now: Date;
  }): Promise<SessionPrincipal>;
  recordCustomerOwnerStepUp?(input: {
    authenticationSessionId: string;
    accountUserId: string;
    authenticatedAt: Date;
  }): Promise<void>;
  getCustomerOwnerStepUp?(input: {
    authenticationSessionId: string;
    accountUserId: string;
  }): Promise<Date | null>;
  revokeCustomerProductSession(input: {
    authenticationSessionId: string;
    accountUserId: string;
    now: Date;
  }): Promise<void>;
}
export type OrganizationCustomRoleSummary = {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  status: "active" | "archived";
  version: number;
  catalogVersion: number;
  grants: OrganizationPermissionGrant[];
  assignedMembershipCount: number;
  assignedMembershipIds: string[];
  createdAt: string;
  updatedAt: string;
};
export type OrganizationInvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export type OrganizationInvitationSummary = {
  invitationId: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  status: OrganizationInvitationStatus;
  deliveryGeneration: number;
  expiresAt: string;
  acceptedMembershipId: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationSsoState = "pending" | "active" | "enforced" | "suspended" | "disconnected";
export type OrganizationSsoTransition =
  | "domain_verified"
  | "test_succeeded"
  | "recovery_confirmed"
  | "enforce"
  | "suspend"
  | "rollback"
  | "disconnect";
export type OrganizationSsoConfigurationChange = "credentials_rotated" | "metadata_refreshed";

export type OrganizationSsoConnectionSummary = {
  id: string;
  organizationId: string;
  authenticationProviderId: string;
  protocol: "oidc" | "saml";
  domain: string;
  issuer: string;
  state: OrganizationSsoState;
  configVersion: number;
  domainVerifiedAt: string | null;
  lastTestedAt: string | null;
  recoveryConfirmedAt: string | null;
  enforcedAt: string | null;
  suspendedAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface IdentityPolicyStore {
  createLoginAttempt(input: { stateHash: string; verifierCiphertext: string; nonce: string; returnPath: string; expiresAt: Date }): Promise<void>;
  consumeLoginAttempt(stateHash: string, now: Date): Promise<OidcLoginAttempt | null>;
  resolveAuthenticatedIdentity(input: AuthenticatedIdentity): Promise<SessionPrincipal>;
  createSession(input: { tokenHash: string; userId: string; membershipId?: string; expiresAt: Date }): Promise<void>;
  getSession(tokenHash: string, now: Date): Promise<SessionPrincipal | null>;
  revokeSession(tokenHash: string): Promise<void>;
  revokeSessionWithAccessAudit?(tokenHash: string, provider: "entra" | "entra-external-id", occurredAt: Date): Promise<void>;
  getPrincipal(userId: string): Promise<SessionPrincipal | null>;
  getEffectivePolicy(userId: string): Promise<EffectivePolicy | null>;
  listUsers(tenantId: string): Promise<AdminUserSummary[]>;
  updateOrganizationDisplayName?(input: {
    organizationId: string;
    updatedBy: string;
    displayName: string;
    now: Date;
  }): Promise<{ id: string; displayName: string }>;
  listOrganizationMemberships?(organizationId: string): Promise<OrganizationMembershipSummary[]>;
  listOrganizationInvitations?(organizationId: string, now: Date): Promise<OrganizationInvitationSummary[]>;
  getOrganizationInvitationContext?(tokenHash: string, now: Date): Promise<OrganizationInvitationContext | null>;
  recordOrganizationAccessEvent?(input: {
    organizationId: string;
    membershipId?: string;
    invitationId?: string;
    actorUserId?: string;
    eventType: "authentication.login_succeeded" | "authentication.login_failed" | "authentication.logout" | "invitation.link_failed" | "session.revoked";
    provider: "entra" | "entra-external-id" | "product";
    reasonCode?: string;
    occurredAt: Date;
  }): Promise<void>;
  recordInvitationLinkFailure?(tokenHash: string, provider: "entra" | "entra-external-id", reasonCode: string, occurredAt: Date): Promise<void>;
  recordExternalIdentityAuthenticationFailure?(input: {
    provider: "entra" | "entra-external-id";
    issuer: string;
    subject: string;
    reasonCode: string;
    occurredAt: Date;
  }): Promise<void>;
  createOrganizationInvitation?(input: {
    organizationId: string;
    email: string;
    role: OrganizationRole;
    tokenHash: string;
    idempotencyKeyHash: string;
    expiresAt: Date;
    createdBy: string;
    now: Date;
  }): Promise<{ invitation: OrganizationInvitationSummary; replayed: boolean }>;
  resendOrganizationInvitation?(input: {
    organizationId: string;
    invitationId: string;
    tokenHash: string;
    idempotencyKeyHash: string;
    expiresAt: Date;
    updatedBy: string;
    now: Date;
  }): Promise<{ invitation: OrganizationInvitationSummary; replayed: boolean }>;
  revokeOrganizationInvitation?(input: {
    organizationId: string;
    invitationId: string;
    revokedBy: string;
    now: Date;
  }): Promise<{ invitation: OrganizationInvitationSummary; replayed: boolean }>;
  changeOrganizationMembership?(input: {
    organizationId: string;
    targetUserId: string;
    role?: OrganizationRole;
    status?: OrganizationMembershipStatus;
    updatedBy: string;
  }): Promise<{ membership: OrganizationMembershipSummary; revokedSessions: number }>;
  transferOrganizationOwnership?(input: {
    organizationId: string;
    currentOwnerUserId: string;
    targetMembershipId: string;
    recentStepUpAt: Date;
    now: Date;
  }): Promise<{
    previousOwner: { membershipId: string; role: "admin" };
    owner: { membershipId: string; userId: string; role: "owner" };
    revokedSessions: number;
  }>;
  initiateOrganizationClosure?(input: {
    organizationId: string;
    requestedBy: string;
    reason: string;
    idempotencyKey: string;
    recentStepUpAt: Date;
    now: Date;
  }): Promise<{
    replayed: boolean;
    request: { id: string; status: "pending"; requestedAt: string; executeAfter: string };
  }>;
  listOrganizationRoles?(organizationId: string): Promise<OrganizationCustomRoleSummary[]>;
  listOrganizationSsoConnections?(organizationId: string): Promise<OrganizationSsoConnectionSummary[]>;
  findEnforcedOrganizationSsoConnectionByDomain?(domain: string): Promise<OrganizationSsoConnectionSummary | null>;
  createOrganizationSsoConnection?(input: {
    organizationId: string;
    authenticationProviderId: string;
    protocol: "oidc" | "saml";
    domain: string;
    issuer: string;
    createdBy: string;
  }): Promise<OrganizationSsoConnectionSummary>;
  transitionOrganizationSsoConnection?(input: {
    organizationId: string;
    connectionId: string;
    action: OrganizationSsoTransition;
    actorUserId: string;
  }): Promise<OrganizationSsoConnectionSummary>;
  prepareOrganizationSsoConfigurationChange?(input: {
    organizationId: string;
    connectionId: string;
    change: OrganizationSsoConfigurationChange;
    actorUserId: string;
  }): Promise<OrganizationSsoConnectionSummary>;
  createOrganizationRole?(input: {
    organizationId: string;
    name: string;
    description: string;
    grants: OrganizationPermissionGrant[];
    createdBy: string;
  }): Promise<OrganizationCustomRoleSummary>;
  updateOrganizationRole?(input: {
    organizationId: string;
    roleId: string;
    expectedVersion: number;
    name: string;
    description: string;
    grants: OrganizationPermissionGrant[];
    updatedBy: string;
  }): Promise<OrganizationCustomRoleSummary & { revokedSessions: number }>;
  archiveOrganizationRole?(input: {
    organizationId: string;
    roleId: string;
    expectedVersion: number;
    archivedBy: string;
  }): Promise<{ role: OrganizationCustomRoleSummary; revokedSessions: number }>;
  assignOrganizationRole?(input: {
    organizationId: string;
    membershipId: string;
    roleId: string;
    assignedBy: string;
  }): Promise<{ revokedSessions: number }>;
  unassignOrganizationRole?(input: {
    organizationId: string;
    membershipId: string;
    roleId: string;
    unassignedBy: string;
  }): Promise<{ revokedSessions: number }>;
  resolveOrganizationAuthorization?(input: {
    organizationId: string;
    membershipId: string;
  }): Promise<EffectiveOrganizationPermissions>;
  setUserStatus(input: { tenantId: string; targetUserId: string; status: LemmaComputerUserStatus; updatedBy: string }): Promise<{ status: LemmaComputerUserStatus; revokedSessions: number }>;
  revokeUserSessions(input: { tenantId: string; targetUserId: string; revokedBy: string }): Promise<number>;
  assignMvpPolicy(input: { tenantId: string; targetUserId: string; assignedBy: string }): Promise<EffectivePolicy>;
  revokeMvpPolicy(input: { tenantId: string; targetUserId: string; revokedBy: string }): Promise<boolean>;
  createMvpPolicyVersion(input: { tenantId: string; createdBy: string; revisionNote: string }): Promise<{ id: string; version: number; documentHash: string }>;
  updateMvpToolPolicy(input: { tenantId: string; updatedBy: string; tools: Record<string, McpToolPolicyDecision> }): Promise<{ id: string; version: number; documentHash: string }>;
  listEgressSecurityGroups(tenantId: string, createdBy?: string): Promise<EgressSecurityGroupVersion[]>;
  saveEgressSecurityGroup(input: { tenantId: string; updatedBy: string; securityGroupId?: string; name: string; description: string; defaultAction: "deny" | "allow-public-http-https"; rules: EgressSecurityGroupRule[] }): Promise<EgressSecurityGroupVersion>;
  assignEgressSecurityGroup(input: { tenantId: string; targetUserId: string; assignedBy: string; securityGroupVersionId: string }): Promise<EffectivePolicy>;
  getWorkspaceEgressSecurityGroup?(input: { tenantId: string; subjectId: string; grantId: string }): Promise<EgressSecurityGroupVersion | null>;
  listWorkspaceEgressSecurityGroupAssignments?(input: { tenantId: string; securityGroupId: string }): Promise<Array<{ subjectId: string; grantId: string }>>;
  assignWorkspaceEgressSecurityGroup?(input: { tenantId: string; subjectId: string; grantId: string; assignedBy: string; securityGroupVersionId: string }): Promise<EgressSecurityGroupVersion>;
}

const mvpAgentIds = ["claude-desktop", "claude-cli", "codex-cli", "hermes-desktop", "hermes-claw"] as const;
const mvpDefaultAgentIds = ["claude-desktop", "hermes-claw"] as const;
const mvpApplicationIds = ["firefox", "google-chrome"] as const;
const mvpDefaultApplicationIds = ["firefox"] as const;
const mvpDefaultModelAliases = ["lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-glm", "lemmacomputer-bedrock"] as const;
const historicMvpDefaultModelAliasSets = [
  ["lemmacomputer-claude", "lemmacomputer-openai"],
  ["lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-glm"],
  ["lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-bedrock"],
] as const;

const applyMvpSandboxCatalog = (document: Record<string, OwnedJson>) => {
  document.workspaceProfile = "claude-desktop-standard-v1";
  document.workspaceProfiles = ["claude-desktop-standard-v1", "disposable-open-v1"];
  document.agents = [...mvpAgentIds];
  document.defaultAgents = [...mvpDefaultAgentIds];
  document.applications = [...mvpApplicationIds];
  document.defaultApplications = [...mvpDefaultApplicationIds];
  return document;
};

export const withOpenWorkspaceProfile = (document: OwnedJson): OwnedJson | null => {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const source = document as Record<string, OwnedJson>;
  const profiles = Array.isArray(source.workspaceProfiles)
    ? source.workspaceProfiles.filter((value): value is string => typeof value === "string")
    : typeof source.workspaceProfile === "string"
      ? [source.workspaceProfile]
      : [];
  if (!profiles.includes("claude-desktop-standard-v1") || profiles.includes("disposable-open-v1")) return null;
  return {
    ...structuredClone(source),
    workspaceProfiles: [...profiles, "disposable-open-v1"],
  };
};

export const mvpPolicyDocument = (
  revisionNote = "Initial MVP policy",
  modelAliases: readonly string[] = mvpDefaultModelAliases,
) => ({
  schemaVersion: 1,
  revisionNote,
  workspaceProfile: "claude-desktop-standard-v1",
  workspaceProfiles: ["claude-desktop-standard-v1", "disposable-open-v1"],
  agentProfile: "claude-desktop-managed-v1",
  agents: [...mvpAgentIds],
  defaultAgents: [...mvpDefaultAgentIds],
  applications: [...mvpApplicationIds],
  defaultApplications: [...mvpDefaultApplicationIds],
  // The demo bootstrap uses only routes managed by Provider settings.
  modelAliases: [...modelAliases],
  networkProfile: "controlled-egress-v1",
  clipboard: defaultClipboardPolicy,
  mcp: {
    servers: {
      lemmacomputer_ms365: {
        tools: Object.keys(m365ToolCatalog),
        toolPolicies: Object.fromEntries(Object.entries(m365ToolCatalog).map(([name, tool]) => [name, tool.decision])),
      },
    },
  },
  capabilities: ["ai-assistant", "coding-tools", "m365-read", "m365-write-protected"],
  protectedOperations: {
    "m365-write-protected": "approval_required",
    defaultWrite: "deny",
  },
}) satisfies OwnedJson;

// Only exact historic defaults are upgraded. Customer-created policy versions
// remain opt-in and are never broadened by the demo adoption path.
const historicMvpPolicyDocuments = () => [
  ...historicMvpDefaultModelAliasSets.map((aliases) => mvpPolicyDocument("Initial MVP policy", aliases)),
  mvpPolicyDocument("Enabled Bedrock for the historic default MVP policy", historicMvpDefaultModelAliasSets[2]),
];

const stableJson = (value: OwnedJson): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
};

const policyHash = (document: OwnedJson) => createHash("sha256").update(stableJson(document)).digest("hex");
export const upgradeHistoricMvpPolicyDocument = (document: OwnedJson): OwnedJson | null => {
  const documentHash = policyHash(document);
  if (!historicMvpPolicyDocuments().some((historic) => policyHash(historic) === documentHash)) return null;
  return mvpPolicyDocument("Enabled managed GLM and Bedrock for the demo default policy");
};
const mvpPolicyBundleId = (tenantId: string) => `mvp-standard:${tenantId}`;
const defaultEgressSecurityGroupId = (tenantId: string) => `esg_${createHash("sha256").update(`egress:${tenantId}`).digest("hex").slice(0, 24)}`;
const defaultEgressSecurityGroupVersionId = (tenantId: string) => `egv_${createHash("sha256").update(`egress:${tenantId}`).digest("hex").slice(0, 24)}_v1`;
const organizationSlugBase = (displayName: string) => displayName
  .normalize("NFKD")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 40)
  .replace(/-+$/g, "") || "organization";
const defaultEgressDocument = () => ({
  schemaVersion: 1,
  name: "Default security group",
  description: "The built-in network policy attached to new workspaces.",
  defaultAction: "allow-public-http-https",
  rules: [],
}) satisfies OwnedJson;

const mapPrincipal = (row: Record<string, unknown>): SessionPrincipal => ({
  userId: String(row.user_id),
  accountUserId: String(row.account_user_id),
  tenantId: String(row.organization_id),
  organizationId: String(row.organization_id),
  membershipId: String(row.membership_id),
  membershipStatus: String(row.membership_status) as OrganizationMembershipStatus,
  role: String(row.membership_role) as OrganizationRole,
  permissions: permissionsForOrganizationRoles([String(row.membership_role) as OrganizationRole]),
  email: String(row.email),
  displayName: String(row.display_name),
  tenantDisplayName: String(row.tenant_display_name),
  roles: [
    String(row.membership_role) as OrganizationRole,
    row.membership_role === "owner" || row.membership_role === "admin" ? "administrator" : "employee",
  ],
  identity: { tenantId: String(row.organization_id), subjectId: String(row.user_id), audience: "lemmacomputer-control" },
});

const principalColumns = `
  SELECT u.id AS user_id, m.account_user_id, m.organization_id, m.id AS membership_id,
    m.status AS membership_status, m.role AS membership_role,
    u.email, u.display_name, t.display_name AS tenant_display_name`;

const homePrincipalSelect = `${principalColumns}
  FROM users u
  JOIN organization_memberships m ON m.subject_user_id=u.id AND m.organization_id=u.tenant_id
  JOIN account_users account_user ON account_user.id=m.account_user_id
  JOIN organizations organization ON organization.id=m.organization_id
  JOIN tenants t ON t.id=m.organization_id
  LEFT JOIN platform_tenant_lifecycle platform_lifecycle ON platform_lifecycle.tenant_id=m.organization_id`;

const effectivePolicySelect = `
  SELECT pa.id AS assignment_id, pb.id AS policy_bundle_id, pv.id AS policy_version_id, pv.version,
    pv.document_hash, pv.document, pa.assigned_by, pa.assigned_at, pa.agent_id,
    vim.vendor_user_id, pa.tenant_id,
    esgv.id AS egress_version_id, esgv.security_group_id, esgv.version AS egress_version,
    esgv.document AS egress_document, esgv.document_hash AS egress_document_hash,
    esgv.created_by AS egress_created_by, esgv.created_at AS egress_created_at
  FROM policy_assignments pa
  JOIN policy_versions pv ON pv.id=pa.policy_version_id
  JOIN policy_bundles pb ON pb.id=pv.policy_bundle_id
  JOIN vendor_identity_mappings vim ON vim.user_id=pa.user_id AND vim.vendor='litellm' AND vim.mapping_kind='user'
  LEFT JOIN egress_security_group_versions esgv ON esgv.id=pa.egress_security_group_version_id
  WHERE pa.user_id=$1 AND pa.revoked_at IS NULL
  ORDER BY pa.assigned_at DESC LIMIT 1`;

const mapEgressVersion = (row: Record<string, unknown>): EgressSecurityGroupVersion => {
  const document = row.egress_document as Record<string, unknown>;
  const isDefault = String(row.security_group_id) === defaultEgressSecurityGroupId(String(row.tenant_id));
  return egressSecurityGroupVersionSchema.parse({
    schemaVersion: 1,
    id: String(row.egress_version_id),
    securityGroupId: String(row.security_group_id),
    tenantId: String(row.tenant_id),
    version: Number(row.egress_version),
    name: isDefault ? "Default security group" : document.name,
    description: isDefault ? "The built-in network policy attached to new workspaces." : document.description,
    defaultAction: isDefault ? "allow-public-http-https" : document.defaultAction ?? "deny",
    rules: document.rules,
    documentHash: String(row.egress_document_hash),
    createdBy: String(row.egress_created_by),
    createdAt: new Date(String(row.egress_created_at)).toISOString(),
    isDefault,
  });
};

const mapPolicy = (row: Record<string, unknown>): EffectivePolicy => {
  const egressDocument = row.egress_document as Record<string, unknown> | null;
  return {
    assignmentId: String(row.assignment_id),
    policyBundleId: String(row.policy_bundle_id),
    policyVersionId: String(row.policy_version_id),
    version: Number(row.version),
    documentHash: String(row.document_hash),
    assignedBy: String(row.assigned_by),
    assignedAt: new Date(String(row.assigned_at)).toISOString(),
    agentId: String(row.agent_id),
    vendorUserId: String(row.vendor_user_id),
    document: row.document as OwnedJson,
    egressSecurityGroup: row.egress_version_id && egressDocument ? mapEgressVersion(row) : null,
  };
};

export class PostgresIdentityPolicyStore implements IdentityPolicyStore, CustomerProductSessionStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresIdentityPolicyStore(new pg.Pool({ connectionString, max: 5 }));
  }

  async close() { await this.pool.end(); }

  async upgradeLegacyWorkspaceProfiles() {
    const candidates = await this.pool.query(
      `SELECT DISTINCT pv.id AS policy_version_id,pv.policy_bundle_id,pv.document,pv.created_by
       FROM policy_assignments pa
       JOIN policy_versions pv ON pv.id=pa.policy_version_id
       WHERE pa.revoked_at IS NULL
       AND pv.policy_bundle_id='mvp-standard:' || pa.tenant_id
       AND (
         pv.document->>'workspaceProfile'='claude-desktop-standard-v1'
         OR pv.document->'workspaceProfiles' @> '["claude-desktop-standard-v1"]'::jsonb
       )
       AND (
         NOT COALESCE(pv.document->'workspaceProfiles', '[]'::jsonb) @> '["disposable-open-v1"]'::jsonb
         OR pv.document_hash = ANY($1::text[])
       )`,
      [historicMvpPolicyDocuments().map(policyHash)],
    );
    let upgradedAssignments = 0;
    for (const candidate of candidates.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-version:${candidate.policy_bundle_id}`]);
        const assignments = await client.query(
          `SELECT id,tenant_id,user_id,agent_id,egress_security_group_version_id,assigned_by
           FROM policy_assignments
           WHERE policy_version_id=$1 AND revoked_at IS NULL
           FOR UPDATE`,
          [candidate.policy_version_id],
        );
        if (!assignments.rowCount) {
          await client.query("COMMIT");
          continue;
        }
        const profileDocument = withOpenWorkspaceProfile(candidate.document as OwnedJson);
        const document = profileDocument
          ? upgradeHistoricMvpPolicyDocument(profileDocument) ?? profileDocument
          : upgradeHistoricMvpPolicyDocument(candidate.document as OwnedJson);
        if (!document) {
          await client.query("COMMIT");
          continue;
        }
        const documentHash = policyHash(document);
        const existing = await client.query(
          "SELECT id FROM policy_versions WHERE policy_bundle_id=$1 AND document_hash=$2",
          [candidate.policy_bundle_id, documentHash],
        );
        let policyVersionId = existing.rowCount ? String(existing.rows[0].id) : "";
        if (!policyVersionId) {
          const latest = await client.query(
            "SELECT COALESCE(max(version),0) AS version FROM policy_versions WHERE policy_bundle_id=$1",
            [candidate.policy_bundle_id],
          );
          policyVersionId = randomUUID();
          await client.query(
            `INSERT INTO policy_versions (id,policy_bundle_id,version,document,document_hash,created_by)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
            [
              policyVersionId,
              candidate.policy_bundle_id,
              Number(latest.rows[0].version) + 1,
              JSON.stringify(document),
              documentHash,
              candidate.created_by,
            ],
          );
        }
        for (const assignment of assignments.rows) {
          await client.query(
            "UPDATE policy_assignments SET revoked_at=now(),revoked_by=$2 WHERE id=$1",
            [assignment.id, assignment.assigned_by],
          );
          const replacementId = randomUUID();
          await client.query(
            `INSERT INTO policy_assignments (
               id,tenant_id,user_id,agent_id,policy_version_id,
               egress_security_group_version_id,assigned_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              replacementId,
              assignment.tenant_id,
              assignment.user_id,
              assignment.agent_id,
              policyVersionId,
              assignment.egress_security_group_version_id,
              assignment.assigned_by,
            ],
          );
          await client.query(
            `INSERT INTO capability_assignments (policy_assignment_id,capability_id)
             SELECT $1,capability_id FROM capability_assignments WHERE policy_assignment_id=$2`,
            [replacementId, assignment.id],
          );
          upgradedAssignments += 1;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return upgradedAssignments;
  }

  async createLoginAttempt(input: { stateHash: string; verifierCiphertext: string; nonce: string; returnPath: string; expiresAt: Date }) {
    await this.pool.query("DELETE FROM oidc_login_attempts WHERE expires_at<=now()");
    await this.pool.query(
      "INSERT INTO oidc_login_attempts (state_hash,verifier_ciphertext,nonce,return_path,expires_at) VALUES ($1,$2,$3,$4,$5)",
      [input.stateHash, input.verifierCiphertext, input.nonce, input.returnPath, input.expiresAt],
    );
  }

  async consumeLoginAttempt(stateHash: string, now: Date) {
    const result = await this.pool.query(
      "DELETE FROM oidc_login_attempts WHERE state_hash=$1 AND expires_at>$2 RETURNING verifier_ciphertext,nonce,return_path",
      [stateHash, now],
    );
    return result.rowCount ? {
      verifierCiphertext: String(result.rows[0].verifier_ciphertext),
      nonce: String(result.rows[0].nonce),
      returnPath: String(result.rows[0].return_path),
    } : null;
  }

  async resolveAuthenticatedIdentity(input: AuthenticatedIdentity) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`identity:${input.provider}:${input.issuer}:${input.subject}`]);
      const mapped = await client.query(
        `SELECT identity.account_user_id,identity.user_id AS legacy_user_id,
           identity.external_tenant_id,identity.provider_object_id,
           mapped_user.tenant_id AS mapped_organization_id
         FROM external_identities identity
         LEFT JOIN users mapped_user ON mapped_user.id=identity.user_id
         WHERE identity.provider=$1 AND identity.issuer=$2 AND identity.external_subject=$3`,
        [input.provider, input.issuer, input.subject],
      );
      if (mapped.rowCount && input.providerObjectId) {
        const existingObjectId = mapped.rows[0].provider_object_id
          ? String(mapped.rows[0].provider_object_id)
          : null;
        if (String(mapped.rows[0].external_tenant_id) !== input.externalTenantId
          || (existingObjectId && existingObjectId !== input.providerObjectId)) {
          throw new LemmaComputerError("IDENTITY_IDENTIFIER_MISMATCH", "The immutable identity identifiers do not match", 403);
        }
      }
      let invitation: Record<string, unknown> | null = null;
      if (input.invitationTokenHash) {
        const invitationResult = await client.query(
          `SELECT invitation.*,organization.display_name AS organization_display_name,
             invitation.expires_at>now() AS invitation_active,
             membership.account_user_id AS accepted_account_user_id
           FROM organization_invitations invitation
           JOIN organizations organization ON organization.id=invitation.organization_id
           LEFT JOIN organization_memberships membership ON membership.id=invitation.accepted_membership_id
           WHERE invitation.token_hash=$1
           FOR UPDATE OF invitation`,
          [input.invitationTokenHash],
        );
        invitation = invitationResult.rowCount ? invitationResult.rows[0] : null;
        const invitationUsable = invitation !== null
          && String(invitation.organization_id) === input.organizationId
          && String(invitation.email) === input.email.trim().toLowerCase()
          && invitation.status === "pending"
          && invitation.invitation_active === true;
        if (!invitation || !invitationUsable) {
          throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
        }
      }
      const tenantId = invitation
        ? input.organizationId
        : input.membershipAdmissionMode === "existing-membership-only" && mapped.rows[0]?.mapped_organization_id
          ? String(mapped.rows[0].mapped_organization_id)
          : input.organizationId;
      let organization = await client.query(
        `SELECT tenant.administrator_bootstrapped_at,organization.status,
           COALESCE(platform_lifecycle.lifecycle_state,'active') AS platform_lifecycle_state
         FROM tenants tenant
         JOIN organizations organization ON organization.id=tenant.id
         LEFT JOIN platform_tenant_lifecycle platform_lifecycle ON platform_lifecycle.tenant_id=tenant.id
         WHERE tenant.id=$1
         FOR UPDATE OF tenant,organization`,
        [tenantId],
      );
      if (!organization.rowCount) {
        if (input.membershipAdmissionMode === "existing-membership-only") {
          throw new LemmaComputerError("ORGANIZATION_NOT_ADMITTED", "The organization is not available for this sign-in", 403);
        }
        await client.query(
          `INSERT INTO tenants (id,external_tenant_id,display_name)
           VALUES ($1,$2,$3)
           ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`,
          [tenantId, input.externalTenantId, input.organizationDisplayName],
        );
        await client.query(
          `INSERT INTO organizations (id,display_name)
           VALUES ($1,$2)
           ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=now()`,
          [tenantId, input.organizationDisplayName],
        );
        organization = await client.query(
          "SELECT administrator_bootstrapped_at FROM tenants WHERE id=$1 FOR UPDATE",
          [tenantId],
        );
      } else if (organization.rows[0].status !== "active"
        || ["suspended", "closed"].includes(String(organization.rows[0].platform_lifecycle_state))) {
        throw new LemmaComputerError("ORGANIZATION_NOT_ADMITTED", "The organization is not available for this sign-in", 403);
      }
      let accountUserId = mapped.rowCount && mapped.rows[0].account_user_id
        ? String(mapped.rows[0].account_user_id)
        : "";
      if (mapped.rowCount && !accountUserId) {
        throw new LemmaComputerError("IDENTITY_BACKFILL_REQUIRED", "The identity migration backfill must complete before sign-in", 503);
      }
      if (!accountUserId) {
        if (input.membershipAdmissionMode === "existing-membership-only" && !invitation) {
          throw new LemmaComputerError("MEMBERSHIP_REQUIRED", "An organization invitation is required", 403);
        }
        const account = await client.query("INSERT INTO account_users (status) VALUES ('active') RETURNING id");
        accountUserId = String(account.rows[0].id);
      }
      let membership = await client.query(
        `SELECT id,subject_user_id,status,role
         FROM organization_memberships
         WHERE organization_id=$1 AND account_user_id=$2
         FOR UPDATE`,
        [tenantId, accountUserId],
      );
      const membershipCreated = !membership.rowCount;
      if (membershipCreated && input.membershipAdmissionMode === "existing-membership-only" && !invitation) {
        throw new LemmaComputerError("MEMBERSHIP_REQUIRED", "An organization invitation is required", 403);
      }
      const userId = membership.rowCount
        ? String(membership.rows[0].subject_user_id)
        : mapped.rowCount
          ? `user-${createHash("sha256").update(`${tenantId}:${accountUserId}`).digest("hex").slice(0, 24)}`
          : input.userId;
      const shouldBootstrapOwner = membershipCreated
        && input.bootstrapOwner
        && !organization.rows[0]?.administrator_bootstrapped_at;
      await client.query(
        `INSERT INTO users (id,tenant_id,account_user_id,email,display_name)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET
           account_user_id=COALESCE(users.account_user_id,EXCLUDED.account_user_id),
           email=EXCLUDED.email,display_name=EXCLUDED.display_name,updated_at=now()`,
        [userId, tenantId, accountUserId, input.email.toLowerCase(), input.displayName],
      );
      if (membershipCreated) {
        membership = await client.query(
          `INSERT INTO organization_memberships (
             organization_id,account_user_id,subject_user_id,status,role,created_by,updated_by
           ) VALUES ($1,$2,$3,'active',$4,$5,$3)
           RETURNING id,subject_user_id,status,role`,
          [tenantId, accountUserId, userId, invitation ? String(invitation.role) : shouldBootstrapOwner ? "owner" : "member",
            invitation ? String(invitation.created_by) : userId],
        );
      }
      if (membership.rows[0].status !== "active") {
        throw new LemmaComputerError("MEMBERSHIP_NOT_ACTIVE", "The organization membership is not active", 403);
      }
      await client.query(
        `INSERT INTO external_identities (
           id,user_id,account_user_id,provider,issuer,external_subject,
           external_tenant_id,provider_object_id,email,last_authenticated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (provider,issuer,external_subject) DO UPDATE SET
           account_user_id=COALESCE(external_identities.account_user_id,EXCLUDED.account_user_id),
           provider_object_id=COALESCE(external_identities.provider_object_id,EXCLUDED.provider_object_id),
           email=EXCLUDED.email,last_authenticated_at=now()`,
        [randomUUID(), userId, accountUserId, input.provider, input.issuer, input.subject, input.externalTenantId, input.providerObjectId ?? null, input.email.toLowerCase()],
      );
      if (invitation?.status === "pending") {
        const accepted = await client.query(
          `UPDATE organization_invitations
           SET status='accepted',accepted_membership_id=$3,accepted_at=now(),updated_by=$4,updated_at=now()
           WHERE organization_id=$1 AND id=$2 AND status='pending' AND expires_at>now()
           RETURNING id`,
          [tenantId, invitation.id, membership.rows[0].id, userId],
        );
        if (!accepted.rowCount) throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
        await this.recordInvitationEvent(client, {
          organizationId: tenantId,
          invitationId: String(invitation.id),
          actorUserId: userId,
          eventType: "invitation.accepted",
          oldStatus: "pending",
          newStatus: "accepted",
          role: String(invitation.role) as OrganizationRole,
          deliveryGeneration: Number(invitation.delivery_generation),
          occurredAt: new Date(),
        });
      }
      await client.query(
        "INSERT INTO user_roles (user_id,role,assigned_by) VALUES ($1,'employee',$1) ON CONFLICT DO NOTHING",
        [userId],
      );
      if (shouldBootstrapOwner) {
        await client.query("INSERT INTO user_roles (user_id,role,assigned_by) VALUES ($1,'administrator',$1) ON CONFLICT DO NOTHING", [userId]);
        await client.query("UPDATE tenants SET administrator_bootstrapped_at=now() WHERE id=$1", [tenantId]);
      }
      const agentId = randomUUID();
      await client.query(
        "INSERT INTO agent_identities (id,tenant_id,owner_user_id,name) VALUES ($1,$2,$3,'Default agent') ON CONFLICT (owner_user_id,name) DO NOTHING",
        [agentId, tenantId, userId],
      );
      await client.query(
        `INSERT INTO vendor_identity_mappings (id,tenant_id,user_id,vendor,vendor_user_id,mapping_kind,verified_at)
         VALUES ($1,$2,$3,'litellm',$4,'user',now())
         ON CONFLICT (user_id,vendor,mapping_kind) DO UPDATE SET vendor_user_id=EXCLUDED.vendor_user_id,verified_at=now()`,
        [randomUUID(), tenantId, userId, `oc-user-${createHash("sha256").update(`lemmacomputer:litellm:user:${tenantId}:${userId}`).digest("base64url")}`],
      );
      await this.ensureDefaultSpendingTeamFoundation(client, tenantId, userId, userId);
      if (shouldAssignDefaultPolicyOnAuthentication(!membershipCreated, shouldBootstrapOwner)) {
        await this.ensurePolicyFoundation(client, tenantId, userId);
        await this.assignMvpPolicyWithClient(client, tenantId, userId, userId);
      }
      if (input.browserSession) {
        await client.query(
          "INSERT INTO browser_sessions (id,token_hash,user_id,membership_id,expires_at) VALUES ($1,$2,$3,$4,$5)",
          [randomUUID(), input.browserSession.tokenHash, userId, membership.rows[0].id, input.browserSession.expiresAt],
        );
        await client.query(
          `INSERT INTO organization_access_audit_events (
             organization_id,membership_id,invitation_id,actor_user_id,event_type,provider
           ) VALUES ($1,$2,$3,$4,'authentication.login_succeeded',$5)`,
          [tenantId, membership.rows[0].id, invitation ? invitation.id : null, userId, input.provider],
        );
      }
      const principal = await this.getPrincipalForOrganization(userId, tenantId, client);
      if (!principal) throw new LemmaComputerError("MEMBERSHIP_NOT_ACTIVE", "The organization membership is not active", 403);
      await client.query("COMMIT");
      return principal;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async getPrincipalForOrganization(userId: string, organizationId: string, queryable: pg.Pool | pg.PoolClient = this.pool) {
    const result = await queryable.query(
      `${principalColumns}
       FROM users u
       JOIN organization_memberships m ON m.subject_user_id=u.id AND m.organization_id=$2
       JOIN account_users account_user ON account_user.id=m.account_user_id
       JOIN organizations organization ON organization.id=m.organization_id
       JOIN tenants t ON t.id=m.organization_id
       LEFT JOIN platform_tenant_lifecycle platform_lifecycle ON platform_lifecycle.tenant_id=m.organization_id
       WHERE u.id=$1 AND u.status='active' AND m.status='active'
         AND account_user.status='active' AND organization.status='active'
         AND COALESCE(platform_lifecycle.lifecycle_state,'active') NOT IN ('suspended','closed')`,
      [userId, organizationId],
    );
    return result.rowCount ? this.mapAuthorizedPrincipal(result.rows[0], queryable) : null;
  }

  private async mapAuthorizedPrincipal(row: Record<string, unknown>, queryable: pg.Pool | pg.PoolClient = this.pool) {
    const principal = mapPrincipal(row);
    const effectiveAuthorization = await this.resolveOrganizationAuthorizationWith(queryable, {
      organizationId: principal.organizationId!,
      membershipId: principal.membershipId!,
    });
    return {
      ...principal,
      permissions: effectiveAuthorization.valid
        ? [...new Set(effectiveAuthorization.grants.map((grant) => grant.permission))]
        : [],
      effectiveAuthorization,
    };
  }

  async ensureCustomerAccount(input: { accountUserId: string }) {
    await this.pool.query(
      `INSERT INTO account_users (id,status) VALUES ($1,'active')
       ON CONFLICT (id) DO NOTHING`,
      [input.accountUserId],
    );
    const account = await this.pool.query(
      "SELECT id,status FROM account_users WHERE id=$1",
      [input.accountUserId],
    );
    if (!account.rowCount) throw new LemmaComputerError("ACCOUNT_MAPPING_FAILED", "The customer account could not be mapped", 500);
    return {
      accountUserId: String(account.rows[0].id),
      status: String(account.rows[0].status) as LemmaComputerUserStatus,
    };
  }

  async listCustomerMemberships(accountUserId: string) {
    const result = await this.pool.query(
      `SELECT membership.id AS membership_id,membership.organization_id,
         organization.display_name AS organization_display_name,
         membership.subject_user_id AS user_id,membership.status,membership.role
       FROM organization_memberships membership
       JOIN organizations organization ON organization.id=membership.organization_id
       WHERE membership.account_user_id=$1
       ORDER BY organization.display_name,membership.organization_id`,
      [accountUserId],
    );
    return result.rows.map((row) => ({
      membershipId: String(row.membership_id),
      organizationId: String(row.organization_id),
      organizationDisplayName: String(row.organization_display_name),
      userId: String(row.user_id),
      status: String(row.status) as OrganizationMembershipStatus,
      role: String(row.role) as OrganizationRole,
    }));
  }

  async getCustomerProductSession(input: {
    authenticationSessionId: string;
    accountUserId: string;
    now: Date;
  }) {
    const result = await this.pool.query(
      `${principalColumns}
       FROM browser_sessions session
       JOIN organization_memberships m ON m.id=session.membership_id
         AND m.subject_user_id=session.user_id AND m.account_user_id=$2
       JOIN users u ON u.id=m.subject_user_id
       JOIN account_users account_user ON account_user.id=m.account_user_id
       JOIN organizations organization ON organization.id=m.organization_id
       JOIN tenants t ON t.id=m.organization_id
       WHERE session.authentication_session_id=$1 AND session.revoked_at IS NULL
         AND session.expires_at>$3 AND u.status='active' AND m.status='active'
         AND account_user.status='active' AND organization.status='active'`,
      [input.authenticationSessionId, input.accountUserId, input.now],
    );
    if (!result.rowCount) return null;
    await this.pool.query(
      "UPDATE browser_sessions SET last_seen_at=$2 WHERE authentication_session_id=$1 AND revoked_at IS NULL",
      [input.authenticationSessionId, input.now],
    );
    return mapPrincipal(result.rows[0]);
  }

  async selectCustomerProductSession(input: {
    authenticationSessionId: string;
    accountUserId: string;
    membershipId: string;
    expiresAt: Date;
    now: Date;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const membership = await client.query(
        `${principalColumns}
         FROM organization_memberships m
         JOIN users u ON u.id=m.subject_user_id
         JOIN account_users account_user ON account_user.id=m.account_user_id
         JOIN organizations organization ON organization.id=m.organization_id
         JOIN tenants t ON t.id=m.organization_id
         WHERE m.id=$1 AND m.account_user_id=$2 AND u.status='active'
           AND m.status='active' AND account_user.status='active' AND organization.status='active'
         FOR UPDATE OF m,account_user,organization,u`,
        [input.membershipId, input.accountUserId],
      );
      if (!membership.rowCount) {
        throw new LemmaComputerError("MEMBERSHIP_NOT_ACTIVE", "The organization membership is not active", 403);
      }
      const tokenHash = createHash("sha256")
        .update(`better-auth-product-session\0${input.authenticationSessionId}`)
        .digest("hex");
      const context = await client.query(
        `INSERT INTO browser_sessions (
           id,token_hash,user_id,membership_id,authentication_session_id,expires_at,last_seen_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (authentication_session_id) WHERE authentication_session_id IS NOT NULL
         DO UPDATE SET token_hash=EXCLUDED.token_hash,user_id=EXCLUDED.user_id,
           membership_id=EXCLUDED.membership_id,expires_at=EXCLUDED.expires_at,
           last_seen_at=EXCLUDED.last_seen_at
         WHERE browser_sessions.revoked_at IS NULL
         RETURNING id`,
        [randomUUID(), tokenHash, membership.rows[0].user_id, input.membershipId,
          input.authenticationSessionId, input.expiresAt, input.now],
      );
      if (!context.rowCount) {
        throw new LemmaComputerError("PRODUCT_SESSION_REVOKED", "The product authorization session is revoked", 403);
      }
      await client.query(
        `INSERT INTO organization_access_audit_events (
           organization_id,membership_id,actor_user_id,event_type,provider,occurred_at
         ) VALUES ($1,$2,$3,'authentication.login_succeeded','product',$4)`,
        [membership.rows[0].organization_id, input.membershipId, membership.rows[0].user_id, input.now],
      );
      await client.query("COMMIT");
      return mapPrincipal(membership.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordCustomerOwnerStepUp(input: {
    authenticationSessionId: string;
    accountUserId: string;
    authenticatedAt: Date;
  }) {
    const result = await this.pool.query(
      `INSERT INTO customer_owner_step_up_proofs (
         authentication_session_id,account_user_id,authenticated_at,created_at,updated_at
       )
       SELECT $1,$2,$3,$3,$3
       FROM account_users WHERE id=$2 AND status='active'
       ON CONFLICT (authentication_session_id) DO UPDATE
       SET account_user_id=EXCLUDED.account_user_id,
         authenticated_at=EXCLUDED.authenticated_at,
         updated_at=EXCLUDED.updated_at
       WHERE customer_owner_step_up_proofs.account_user_id=EXCLUDED.account_user_id
       RETURNING authentication_session_id`,
      [input.authenticationSessionId, input.accountUserId, input.authenticatedAt],
    );
    if (!result.rowCount) {
      throw new LemmaComputerError("OWNER_STEP_UP_RECORD_REJECTED", "The MFA proof could not be bound to this account and session", 403);
    }
  }

  async getCustomerOwnerStepUp(input: {
    authenticationSessionId: string;
    accountUserId: string;
  }) {
    const result = await this.pool.query(
      `SELECT authenticated_at FROM customer_owner_step_up_proofs
       WHERE authentication_session_id=$1 AND account_user_id=$2`,
      [input.authenticationSessionId, input.accountUserId],
    );
    return result.rowCount ? new Date(String(result.rows[0].authenticated_at)) : null;
  }

  async createCustomerOrganization(input: {
    accountUserId: string;
    authenticationSessionId: string;
    email: string;
    userDisplayName: string;
    organizationDisplayName: string;
    idempotencyKey: string;
    installationKind: "customer-managed" | "hosted" | "worktree";
    expiresAt: Date;
    now: Date;
  }): Promise<CustomerOrganizationCreation> {
    const client = await this.pool.connect();
    const idempotencyKeyHash = createHash("sha256")
      .update(`organization-onboarding-idempotency\0${input.idempotencyKey}`)
      .digest("hex");
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify({
        organizationDisplayName: input.organizationDisplayName,
        installationKind: input.installationKind,
      }))
      .digest("hex");
    const establishProductContext = async (subjectUserId: string, membershipId: string, organizationId: string) => {
      const tokenHash = createHash("sha256")
        .update(`better-auth-product-session\0${input.authenticationSessionId}`)
        .digest("hex");
      const context = await client.query(
        `INSERT INTO browser_sessions (
           id,token_hash,user_id,membership_id,authentication_session_id,expires_at,last_seen_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (authentication_session_id) WHERE authentication_session_id IS NOT NULL
         DO UPDATE SET token_hash=EXCLUDED.token_hash,user_id=EXCLUDED.user_id,
           membership_id=EXCLUDED.membership_id,expires_at=EXCLUDED.expires_at,
           last_seen_at=EXCLUDED.last_seen_at
         WHERE browser_sessions.revoked_at IS NULL
         RETURNING id`,
        [randomUUID(), tokenHash, subjectUserId, membershipId,
          input.authenticationSessionId, input.expiresAt, input.now],
      );
      if (!context.rowCount) {
        throw new LemmaComputerError("PRODUCT_SESSION_REVOKED", "The product authorization session is revoked", 403);
      }
      await client.query(
        `INSERT INTO organization_access_audit_events (
           organization_id,membership_id,actor_user_id,event_type,provider,occurred_at
         ) VALUES ($1,$2,$3,'authentication.login_succeeded','product',$4)`,
        [organizationId, membershipId, subjectUserId, input.now],
      );
    };
    const ensureOwnerWorkspaceFoundation = async (subjectUserId: string, organizationId: string) => {
      await client.query(
        `INSERT INTO agent_identities (id,tenant_id,owner_user_id,name)
         VALUES ($1,$2,$3,'Default agent')
         ON CONFLICT (owner_user_id,name) DO NOTHING`,
        [randomUUID(), organizationId, subjectUserId],
      );
      await client.query(
        `INSERT INTO vendor_identity_mappings (
           id,tenant_id,user_id,vendor,vendor_user_id,mapping_kind,verified_at
         ) VALUES ($1,$2,$3,'litellm',$4,'user',$5)
         ON CONFLICT (user_id,vendor,mapping_kind)
         DO UPDATE SET vendor_user_id=EXCLUDED.vendor_user_id,verified_at=EXCLUDED.verified_at`,
        [randomUUID(), organizationId, subjectUserId,
          `oc-user-${createHash("sha256").update(`lemmacomputer:litellm:user:${organizationId}:${subjectUserId}`).digest("base64url")}`,
          input.now],
      );
      await this.ensureDefaultSpendingTeamFoundation(
        client,
        organizationId,
        subjectUserId,
        subjectUserId,
        input.now,
      );
      await this.ensurePolicyFoundation(client, organizationId, subjectUserId);
      await this.assignMvpPolicyWithClient(client, organizationId, subjectUserId, subjectUserId);
    };
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`organization-onboarding:${input.accountUserId}`],
      );
      if (input.installationKind === "customer-managed") {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          ["organization-onboarding:customer-managed-installation"],
        );
      }
      const account = await client.query(
        "SELECT status FROM account_users WHERE id=$1 FOR UPDATE",
        [input.accountUserId],
      );
      if (!account.rowCount) {
        throw new LemmaComputerError("ACCOUNT_MAPPING_FAILED", "The customer account could not be mapped", 500);
      }
      if (account.rows[0].status !== "active") {
        throw new LemmaComputerError("ACCOUNT_DISABLED", "This account is disabled", 403);
      }
      const replay = await client.query(
        `SELECT request.request_fingerprint,organization.id AS organization_id,
           organization.slug,organization.display_name,membership.id AS membership_id,
           membership.subject_user_id,membership.status,membership.role
         FROM organization_onboarding_requests request
         JOIN organizations organization ON organization.id=request.organization_id
         JOIN organization_memberships membership ON membership.id=request.membership_id
         WHERE request.account_user_id=$1 AND request.idempotency_key_hash=$2`,
        [input.accountUserId, idempotencyKeyHash],
      );
      if (replay.rowCount) {
        const row = replay.rows[0];
        if (row.request_fingerprint !== requestFingerprint) {
          throw new LemmaComputerError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different organization request", 409);
        }
        if (row.status !== "active" || row.role !== "owner") {
          throw new LemmaComputerError("ORGANIZATION_OWNER_NOT_ACTIVE", "The organization owner is not active", 403);
        }
        await ensureOwnerWorkspaceFoundation(String(row.subject_user_id), String(row.organization_id));
        await establishProductContext(String(row.subject_user_id), String(row.membership_id), String(row.organization_id));
        await client.query("COMMIT");
        return {
          replayed: true,
          organization: {
            id: String(row.organization_id),
            slug: String(row.slug),
            displayName: String(row.display_name),
          },
          membership: { id: String(row.membership_id), status: "active", role: "owner" },
        };
      }
      if (input.installationKind === "customer-managed") {
        const organizations = await client.query("SELECT count(*)::integer AS count FROM organizations");
        if (Number(organizations.rows[0].count) >= 1) {
          throw new LemmaComputerError(
            "ORGANIZATION_LIMIT_REACHED",
            "This customer-managed installation already has its organization",
            409,
          );
        }
      }
      const recent = await client.query(
        `SELECT count(*)::integer AS count FROM organization_onboarding_requests
         WHERE account_user_id=$1 AND created_at>$2::timestamptz-interval '1 hour'`,
        [input.accountUserId, input.now],
      );
      if (Number(recent.rows[0].count) >= 5) {
        throw new LemmaComputerError(
          "ORGANIZATION_SIGNUP_RATE_LIMITED",
          "Too many organizations were created by this account; try again later",
          429,
          true,
        );
      }

      const organizationId = randomUUID();
      const organizationSlug = `${organizationSlugBase(input.organizationDisplayName)}-${organizationId.replaceAll("-", "")}`;
      const subjectUserId = `user_${randomUUID().replaceAll("-", "")}`;
      const membershipId = randomUUID();
      await client.query(
        `INSERT INTO tenants (id,external_tenant_id,display_name,administrator_bootstrapped_at,created_at)
         VALUES ($1,$2,$3,$4,$4)`,
        [organizationId, `self-service:${organizationId}`, input.organizationDisplayName, input.now],
      );
      await client.query(
        `INSERT INTO organizations (id,display_name,slug,status,created_at,updated_at)
         VALUES ($1,$2,$3,'active',$4,$4)`,
        [organizationId, input.organizationDisplayName, organizationSlug, input.now],
      );
      await client.query(
        `INSERT INTO users (id,tenant_id,email,display_name,status,account_user_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$6)`,
        [subjectUserId, organizationId, input.email, input.userDisplayName, input.accountUserId, input.now],
      );
      await client.query(
        `INSERT INTO user_roles (user_id,role,assigned_by,assigned_at) VALUES
         ($1,'employee',$1,$2),($1,'administrator',$1,$2)`,
        [subjectUserId, input.now],
      );
      await client.query(
        `INSERT INTO organization_memberships (
           id,organization_id,account_user_id,subject_user_id,status,role,
           created_by,updated_by,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,'active','owner',$4,$4,$5,$5)`,
        [membershipId, organizationId, input.accountUserId, subjectUserId, input.now],
      );
      await client.query(
        `INSERT INTO organization_settings (organization_id,onboarding_state,settings,created_at,updated_at)
         VALUES ($1,'ready','{}'::jsonb,$2,$2)`,
        [organizationId, input.now],
      );
      await client.query(
        `INSERT INTO organization_lifecycle_audit_events (
           organization_id,actor_user_id,event_type,detail,occurred_at
         ) VALUES ($1,$2,'organization.created',$3::jsonb,$4)`,
        [organizationId, subjectUserId, JSON.stringify({ source: "self-service" }), input.now],
      );
      await client.query(
        `INSERT INTO organization_onboarding_requests (
           account_user_id,idempotency_key_hash,request_fingerprint,
           organization_id,membership_id,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.accountUserId, idempotencyKeyHash, requestFingerprint, organizationId, membershipId, input.now],
      );
      await ensureOwnerWorkspaceFoundation(subjectUserId, organizationId);
      await establishProductContext(subjectUserId, membershipId, organizationId);
      await client.query("COMMIT");
      return {
        replayed: false,
        organization: { id: organizationId, slug: organizationSlug, displayName: input.organizationDisplayName },
        membership: { id: membershipId, status: "active", role: "owner" },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createCustomerInvitationContext(input: {
    invitationTokenHash: string;
    contextTokenHash: string;
    expiresAt: Date;
    now: Date;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const invitation = await client.query(
        `SELECT invitation.id,invitation.organization_id,invitation.email,invitation.role,
           invitation.delivery_generation,invitation.expires_at,
           organization.display_name
         FROM organization_invitations invitation
         JOIN organizations organization ON organization.id=invitation.organization_id
         LEFT JOIN platform_tenant_lifecycle lifecycle
           ON lifecycle.tenant_id=invitation.organization_id
         WHERE invitation.token_hash=$1 AND invitation.status='pending'
           AND invitation.expires_at>$2 AND organization.status='active'
           AND COALESCE(lifecycle.lifecycle_state,'active') NOT IN ('suspended','closed')
         FOR UPDATE OF invitation,organization`,
        [input.invitationTokenHash, input.now],
      );
      if (!invitation.rowCount) {
        throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
      }
      const recentContexts = await client.query(
        `SELECT count(*)::integer AS count
         FROM organization_invitation_activation_contexts
         WHERE invitation_id=$1 AND created_at>$2::timestamptz-interval '1 hour'`,
        [invitation.rows[0].id, input.now],
      );
      if (Number(recentContexts.rows[0].count) >= 20) {
        throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 429, true);
      }
      const expiresAt = new Date(Math.min(
        input.expiresAt.getTime(),
        new Date(String(invitation.rows[0].expires_at)).getTime(),
      ));
      await client.query(
        `INSERT INTO organization_invitation_activation_contexts (
           organization_id,invitation_id,delivery_generation,context_token_hash,
           expires_at,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [invitation.rows[0].organization_id, invitation.rows[0].id,
          invitation.rows[0].delivery_generation, input.contextTokenHash, expiresAt, input.now],
      );
      await client.query("COMMIT");
      return {
        organizationId: String(invitation.rows[0].organization_id),
        organizationDisplayName: String(invitation.rows[0].display_name),
        email: String(invitation.rows[0].email),
        role: String(invitation.rows[0].role) as OrganizationRole,
        expiresAt,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCustomerInvitationContext(input: { contextTokenHash: string; now: Date }) {
    const context = await this.pool.query(
      `SELECT context.organization_id,organization.display_name,invitation.email,invitation.role,
         LEAST(context.expires_at,invitation.expires_at) AS expires_at
       FROM organization_invitation_activation_contexts context
       JOIN organization_invitations invitation ON invitation.id=context.invitation_id
       JOIN organizations organization ON organization.id=context.organization_id
       LEFT JOIN platform_tenant_lifecycle lifecycle
         ON lifecycle.tenant_id=context.organization_id
       WHERE context.context_token_hash=$1 AND context.consumed_at IS NULL
         AND context.expires_at>$2 AND context.attempt_count<10
         AND invitation.status='pending' AND invitation.expires_at>$2
         AND invitation.delivery_generation=context.delivery_generation
         AND organization.status='active'
         AND COALESCE(lifecycle.lifecycle_state,'active') NOT IN ('suspended','closed')`,
      [input.contextTokenHash, input.now],
    );
    if (!context.rowCount) {
      throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
    }
    return {
      organizationId: String(context.rows[0].organization_id),
      organizationDisplayName: String(context.rows[0].display_name),
      email: String(context.rows[0].email),
      role: String(context.rows[0].role) as OrganizationRole,
      expiresAt: new Date(String(context.rows[0].expires_at)),
    };
  }

  async acceptCustomerInvitation(input: {
    accountUserId: string;
    authenticationSessionId: string;
    contextTokenHash: string;
    email: string;
    userDisplayName: string;
    expiresAt: Date;
    now: Date;
  }) {
    const counted = await this.pool.query(
      `UPDATE organization_invitation_activation_contexts
       SET attempt_count=attempt_count+1
       WHERE context_token_hash=$1 AND consumed_at IS NULL AND expires_at>$2
         AND attempt_count<10
       RETURNING id`,
      [input.contextTokenHash, input.now],
    );
    if (!counted.rowCount) {
      throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
    }
    const email = input.email.trim().toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const context = await client.query(
        `SELECT context.id AS context_id,context.delivery_generation AS context_generation,
           invitation.*,organization.display_name AS organization_display_name,
           organization.status AS organization_status,
           COALESCE(lifecycle.lifecycle_state,'active') AS lifecycle_state
         FROM organization_invitation_activation_contexts context
         JOIN organization_invitations invitation
           ON invitation.organization_id=context.organization_id
          AND invitation.id=context.invitation_id
         JOIN organizations organization ON organization.id=invitation.organization_id
         LEFT JOIN platform_tenant_lifecycle lifecycle
           ON lifecycle.tenant_id=invitation.organization_id
         WHERE context.context_token_hash=$1 AND context.consumed_at IS NULL
           AND context.expires_at>$2
         FOR UPDATE OF context,invitation,organization`,
        [input.contextTokenHash, input.now],
      );
      const row = context.rows[0];
      const usable = context.rowCount
        && row.status === "pending"
        && new Date(String(row.expires_at)) > input.now
        && Number(row.context_generation) === Number(row.delivery_generation)
        && String(row.email) === email
        && row.organization_status === "active"
        && !["suspended", "closed"].includes(String(row.lifecycle_state));
      if (!usable) {
        throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
      }
      await client.query(
        `INSERT INTO account_users (id,status) VALUES ($1,'active')
         ON CONFLICT (id) DO NOTHING`,
        [input.accountUserId],
      );
      const account = await client.query(
        "SELECT status FROM account_users WHERE id=$1 FOR UPDATE",
        [input.accountUserId],
      );
      if (!account.rowCount || account.rows[0].status !== "active") {
        throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
      }
      const existingMembership = await client.query(
        `SELECT 1 FROM organization_memberships
         WHERE organization_id=$1 AND account_user_id=$2 FOR UPDATE`,
        [row.organization_id, input.accountUserId],
      );
      if (existingMembership.rowCount) {
        throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
      }
      const userId = `user-${createHash("sha256")
        .update(`${row.organization_id}:${input.accountUserId}`)
        .digest("hex").slice(0, 24)}`;
      const membershipId = randomUUID();
      await client.query(
        `INSERT INTO users (
           id,tenant_id,account_user_id,email,display_name,status,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,'active',$6,$6)`,
        [userId, row.organization_id, input.accountUserId, email, input.userDisplayName, input.now],
      );
      await client.query(
        `INSERT INTO organization_memberships (
           id,organization_id,account_user_id,subject_user_id,status,role,
           created_by,updated_by,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,'active',$5,$6,$4,$7,$7)`,
        [membershipId, row.organization_id, input.accountUserId, userId,
          row.role, row.created_by, input.now],
      );
      await client.query(
        "INSERT INTO user_roles (user_id,role,assigned_by,assigned_at) VALUES ($1,'employee',$1,$2)",
        [userId, input.now],
      );
      if (row.role === "admin" || row.role === "owner") {
        await client.query(
          "INSERT INTO user_roles (user_id,role,assigned_by,assigned_at) VALUES ($1,'administrator',$1,$2)",
          [userId, input.now],
        );
      }
      await client.query(
        `INSERT INTO agent_identities (id,tenant_id,owner_user_id,name)
         VALUES ($1,$2,$3,'Default agent')`,
        [randomUUID(), row.organization_id, userId],
      );
      await client.query(
        `INSERT INTO vendor_identity_mappings (
           id,tenant_id,user_id,vendor,vendor_user_id,mapping_kind,verified_at
         ) VALUES ($1,$2,$3,'litellm',$4,'user',$5)`,
        [randomUUID(), row.organization_id, userId,
          `oc-user-${createHash("sha256").update(`lemmacomputer:litellm:user:${row.organization_id}:${userId}`).digest("base64url")}`,
          input.now],
      );
      await this.ensureDefaultSpendingTeamFoundation(
        client,
        String(row.organization_id),
        userId,
        userId,
        input.now,
      );
      await this.ensurePolicyFoundation(client, String(row.organization_id), userId);
      await this.assignMvpPolicyWithClient(client, String(row.organization_id), userId, userId);
      const tokenHash = createHash("sha256")
        .update(`better-auth-product-session\0${input.authenticationSessionId}`)
        .digest("hex");
      const productSession = await client.query(
        `INSERT INTO browser_sessions (
           id,token_hash,user_id,membership_id,authentication_session_id,
           expires_at,last_seen_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (authentication_session_id) WHERE authentication_session_id IS NOT NULL
         DO UPDATE SET token_hash=EXCLUDED.token_hash,user_id=EXCLUDED.user_id,
           membership_id=EXCLUDED.membership_id,expires_at=EXCLUDED.expires_at,
           last_seen_at=EXCLUDED.last_seen_at
         WHERE browser_sessions.revoked_at IS NULL
         RETURNING id`,
        [randomUUID(), tokenHash, userId, membershipId, input.authenticationSessionId,
          input.expiresAt, input.now],
      );
      if (!productSession.rowCount) {
        throw new LemmaComputerError("PRODUCT_SESSION_REVOKED", "The product authorization session is revoked", 403);
      }
      const accepted = await client.query(
        `UPDATE organization_invitations
         SET status='accepted',accepted_membership_id=$3,accepted_at=$4,
           updated_by=$5,updated_at=$4
         WHERE organization_id=$1 AND id=$2 AND status='pending'
           AND delivery_generation=$6 AND expires_at>$4
         RETURNING id`,
        [row.organization_id, row.id, membershipId, input.now, userId, row.context_generation],
      );
      if (!accepted.rowCount) {
        throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
      }
      await client.query(
        `UPDATE organization_invitation_activation_contexts
         SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL`,
        [row.context_id, input.now],
      );
      await this.recordInvitationEvent(client, {
        organizationId: String(row.organization_id),
        invitationId: String(row.id),
        actorUserId: userId,
        eventType: "invitation.accepted",
        oldStatus: "pending",
        newStatus: "accepted",
        role: String(row.role) as OrganizationRole,
        deliveryGeneration: Number(row.delivery_generation),
        occurredAt: input.now,
      });
      await client.query(
        `INSERT INTO organization_access_audit_events (
           organization_id,membership_id,invitation_id,actor_user_id,
           event_type,provider,occurred_at
         ) VALUES ($1,$2,$3,$4,'authentication.login_succeeded','product',$5)`,
        [row.organization_id, membershipId, row.id, userId, input.now],
      );
      const principal = await this.getPrincipalForOrganization(userId, String(row.organization_id), client);
      if (!principal) throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
      await client.query("COMMIT");
      return principal;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeCustomerProductSession(input: {
    authenticationSessionId: string;
    accountUserId: string;
    now: Date;
  }) {
    await this.pool.query(
      `WITH revoked AS (
         UPDATE browser_sessions session SET revoked_at=$3
         FROM organization_memberships membership
         WHERE session.authentication_session_id=$1 AND session.membership_id=membership.id
           AND membership.account_user_id=$2 AND session.revoked_at IS NULL
         RETURNING session.user_id,session.membership_id,membership.organization_id
       )
       INSERT INTO organization_access_audit_events (
         organization_id,membership_id,actor_user_id,event_type,provider,occurred_at
       )
       SELECT organization_id,membership_id,user_id,'authentication.logout','product',$3
       FROM revoked`,
      [input.authenticationSessionId, input.accountUserId, input.now],
    );
  }

  async createSession(input: { tokenHash: string; userId: string; membershipId?: string; expiresAt: Date }) {
    await this.pool.query("DELETE FROM browser_sessions WHERE expires_at<=now() OR revoked_at IS NOT NULL");
    const membership = await this.pool.query(
      `SELECT m.id
       FROM organization_memberships m
       JOIN users u ON u.id=m.subject_user_id
       JOIN account_users account_user ON account_user.id=m.account_user_id
       JOIN organizations organization ON organization.id=m.organization_id
       LEFT JOIN platform_tenant_lifecycle platform_lifecycle ON platform_lifecycle.tenant_id=m.organization_id
       WHERE m.subject_user_id=$1 AND m.status='active' AND u.status='active'
         AND account_user.status='active' AND organization.status='active'
         AND COALESCE(platform_lifecycle.lifecycle_state,'active') NOT IN ('suspended','closed')
         AND (($2::uuid IS NOT NULL AND m.id=$2::uuid)
           OR ($2::uuid IS NULL AND m.organization_id=u.tenant_id))`,
      [input.userId, input.membershipId ?? null],
    );
    if (!membership.rowCount) throw new LemmaComputerError("MEMBERSHIP_NOT_ACTIVE", "The organization membership is not active", 403);
    await this.pool.query(
      "INSERT INTO browser_sessions (id,token_hash,user_id,membership_id,expires_at) VALUES ($1,$2,$3,$4,$5)",
      [randomUUID(), input.tokenHash, input.userId, membership.rows[0].id, input.expiresAt],
    );
  }

  async getSession(tokenHash: string, now: Date) {
    const result = await this.pool.query(
      `${principalColumns}
       FROM browser_sessions s
       JOIN users u ON u.id=s.user_id
       JOIN organization_memberships m ON m.subject_user_id=u.id
         AND (m.id=s.membership_id OR s.membership_id IS NULL AND m.organization_id=u.tenant_id)
       JOIN account_users account_user ON account_user.id=m.account_user_id
       JOIN organizations organization ON organization.id=m.organization_id
       JOIN tenants t ON t.id=m.organization_id
       LEFT JOIN platform_tenant_lifecycle platform_lifecycle ON platform_lifecycle.tenant_id=m.organization_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2
         AND u.status='active' AND m.status='active'
         AND account_user.status='active' AND organization.status='active'
         AND COALESCE(platform_lifecycle.lifecycle_state,'active') NOT IN ('suspended','closed')`,
      [tokenHash, now],
    );
    if (!result.rowCount) return null;
    await this.pool.query("UPDATE browser_sessions SET last_seen_at=$2 WHERE token_hash=$1", [tokenHash, now]);
    return this.mapAuthorizedPrincipal(result.rows[0]);
  }

  async revokeSession(tokenHash: string) {
    await this.pool.query("UPDATE browser_sessions SET revoked_at=now() WHERE token_hash=$1", [tokenHash]);
  }

  async revokeSessionWithAccessAudit(tokenHash: string, provider: "entra" | "entra-external-id", occurredAt: Date) {
    await this.pool.query(
      `WITH revoked AS (
         UPDATE browser_sessions SET revoked_at=$3
         WHERE token_hash=$1 AND revoked_at IS NULL
         RETURNING user_id,membership_id
       )
       INSERT INTO organization_access_audit_events (
         organization_id,membership_id,actor_user_id,event_type,provider,occurred_at
       )
       SELECT membership.organization_id,revoked.membership_id,revoked.user_id,
         'authentication.logout',$2,$3
       FROM revoked
       JOIN organization_memberships membership ON membership.id=revoked.membership_id`,
      [tokenHash, provider, occurredAt],
    );
  }

  async getPrincipal(userId: string) {
    const result = await this.pool.query(
      `${homePrincipalSelect} WHERE u.id=$1 AND u.status='active' AND m.status='active'
        AND account_user.status='active' AND organization.status='active'
        AND COALESCE(platform_lifecycle.lifecycle_state,'active') NOT IN ('suspended','closed')`,
      [userId],
    );
    return result.rowCount ? this.mapAuthorizedPrincipal(result.rows[0]) : null;
  }

  async getEffectivePolicy(userId: string) {
    const result = await this.pool.query(effectivePolicySelect, [userId]);
    return result.rowCount ? mapPolicy(result.rows[0]) : null;
  }

  async listUsers(tenantId: string) {
    const result = await this.pool.query(
      `SELECT u.id AS user_id,u.email,u.display_name,m.id AS membership_id,
       m.account_user_id,m.organization_id,m.status AS membership_status,m.role AS membership_role
       FROM organization_memberships m
       JOIN users u ON u.id=m.subject_user_id
       WHERE m.organization_id=$1
       ORDER BY u.email`,
      [tenantId],
    );
    return Promise.all(result.rows.map(async (row) => ({
      userId: String(row.user_id),
      membershipId: String(row.membership_id),
      organizationId: String(row.organization_id),
      accountUserId: String(row.account_user_id),
      membershipStatus: String(row.membership_status) as OrganizationMembershipStatus,
      role: String(row.membership_role) as OrganizationRole,
      email: String(row.email),
      displayName: String(row.display_name),
      status: row.membership_status === "active" ? "active" as const : "disabled" as const,
      roles: [
        String(row.membership_role) as OrganizationRole,
        row.membership_role === "owner" || row.membership_role === "admin" ? "administrator" as const : "employee" as const,
      ],
      effectivePolicy: await this.getEffectivePolicy(String(row.user_id)),
    })));
  }

  async listOrganizationMemberships(organizationId: string) {
    const result = await this.pool.query(
      `SELECT m.id AS membership_id,m.organization_id,m.account_user_id,m.subject_user_id AS user_id,m.status,m.role,
        m.created_at,m.updated_at,u.email,u.display_name
       FROM organization_memberships m
       JOIN users u ON u.id=m.subject_user_id
       WHERE m.organization_id=$1
       ORDER BY u.email,m.id`,
      [organizationId],
    );
    return result.rows.map((row) => this.mapMembership(row));
  }

  private async resolveOrganizationAuthorizationWith(
    queryable: pg.Pool | pg.PoolClient,
    input: { organizationId: string; membershipId: string },
  ): Promise<EffectiveOrganizationPermissions> {
    const result = await queryable.query(
      `SELECT membership.role AS membership_role,
         membership.permission_catalog_version AS membership_catalog_version,
         assignment.role_version AS assigned_role_version,
         custom_role.id AS custom_role_id,custom_role.status AS custom_role_status,
         custom_role.current_version,custom_role.catalog_version AS custom_role_catalog_version,
         grant_record.permission_key,grant_record.scope_type,grant_record.resource_id,
         grant_record.catalog_version AS grant_catalog_version
       FROM organization_memberships membership
       LEFT JOIN organization_membership_role_assignments assignment
         ON assignment.organization_id=membership.organization_id
        AND assignment.membership_id=membership.id
       LEFT JOIN organization_custom_roles custom_role
         ON custom_role.organization_id=assignment.organization_id
        AND custom_role.id=assignment.role_id
       LEFT JOIN organization_custom_role_grants grant_record
         ON grant_record.organization_id=assignment.organization_id
        AND grant_record.role_id=assignment.role_id
        AND grant_record.role_version=assignment.role_version
       WHERE membership.organization_id=$1 AND membership.id=$2
         AND membership.status='active'
       ORDER BY custom_role.id,grant_record.permission_key,grant_record.scope_type,grant_record.resource_id`,
      [input.organizationId, input.membershipId],
    );
    if (!result.rowCount) {
      return resolveEffectiveOrganizationPermissions({ catalogVersion: 0, builtInRoles: [], customRoleVersions: [] });
    }
    const catalogVersion = Number(result.rows[0].membership_catalog_version);
    const customRoles = new Map<string, {
      roleId: string;
      version: number;
      catalogVersion: number;
      status: "active" | "archived";
      grants: OrganizationPermissionGrant[];
    }>();
    for (const row of result.rows) {
      if (!row.custom_role_id) continue;
      const roleId = String(row.custom_role_id);
      const assignedVersion = Number(row.assigned_role_version);
      const currentVersion = Number(row.current_version);
      const role = customRoles.get(roleId) ?? {
        roleId,
        version: assignedVersion === currentVersion ? assignedVersion : 0,
        catalogVersion: Number(row.custom_role_catalog_version),
        status: String(row.custom_role_status) as "active" | "archived",
        grants: [],
      };
      if (row.permission_key) {
        if (Number(row.grant_catalog_version) !== role.catalogVersion) role.catalogVersion = 0;
        role.grants.push({
          permission: String(row.permission_key) as OrganizationPermission,
          scope: String(row.scope_type) === "organization"
            ? { type: "organization" }
            : {
                type: String(row.scope_type) as "workspace" | "provider",
                resourceId: String(row.resource_id),
              },
        });
      }
      customRoles.set(roleId, role);
    }
    return resolveEffectiveOrganizationPermissions({
      catalogVersion,
      builtInRoles: [String(result.rows[0].membership_role) as OrganizationRole],
      customRoleVersions: [...customRoles.values()],
    });
  }

  async resolveOrganizationAuthorization(input: { organizationId: string; membershipId: string }) {
    return this.resolveOrganizationAuthorizationWith(this.pool, input);
  }

  private async actorOrganizationAuthorization(
    client: pg.PoolClient,
    organizationId: string,
    actorUserId: string,
  ) {
    const membership = await client.query(
      `SELECT id FROM organization_memberships
       WHERE organization_id=$1 AND subject_user_id=$2 AND status='active'`,
      [organizationId, actorUserId],
    );
    if (!membership.rowCount) {
      throw new LemmaComputerError("ROLE_ACTOR_INVALID", "The role actor does not have active organization access", 403);
    }
    return this.resolveOrganizationAuthorizationWith(client, {
      organizationId,
      membershipId: String(membership.rows[0].id),
    });
  }

  private async organizationMembershipActor(
    client: pg.PoolClient,
    organizationId: string,
    actorUserId: string,
  ) {
    const membership = await client.query(
      `SELECT id,role FROM organization_memberships
       WHERE organization_id=$1 AND subject_user_id=$2 AND status='active'`,
      [organizationId, actorUserId],
    );
    if (!membership.rowCount) {
      throw new LemmaComputerError("MEMBERSHIP_ACTOR_INVALID", "The membership actor cannot manage organization access", 403);
    }
    return {
      role: String(membership.rows[0].role) as OrganizationRole,
      authorization: await this.resolveOrganizationAuthorizationWith(client, {
        organizationId,
        membershipId: String(membership.rows[0].id),
      }),
    };
  }

  private canDelegateBuiltInRole(
    actor: { role: OrganizationRole; authorization: EffectiveOrganizationPermissions },
    role: OrganizationRole,
  ) {
    if (role === "owner") return actor.role === "owner";
    return canDelegateOrganizationGrants(actor.authorization, permissionsByOrganizationRole[role].map((permission) => ({
      permission,
      scope: { type: "organization" as const },
    })));
  }

  private normalizeOrganizationRoleInput(input: {
    name: string;
    description: string;
    grants: OrganizationPermissionGrant[];
  }) {
    const name = input.name.trim();
    const description = input.description.trim();
    if (!name || name.length > 80 || description.length > 500) {
      throw new LemmaComputerError("ROLE_INVALID", "Role name or description is invalid", 400);
    }
    if (["owner", "administrator", "admin", "member"].includes(name.toLowerCase())) {
      throw new LemmaComputerError("ROLE_NAME_RESERVED", "Protected organization role names cannot be reused", 400);
    }
    if (!input.grants.length) throw new LemmaComputerError("ROLE_GRANTS_REQUIRED", "Select at least one permission", 400);
    const grants = [...new Map(input.grants.map((grant) => [
      `${grant.permission}\0${grant.scope.type}\0${grant.scope.resourceId ?? ""}`,
      grant,
    ])).values()];
    for (const grant of grants) {
      const entry = organizationPermissionCatalog[grant.permission];
      const resourceId = grant.scope.resourceId?.trim();
      if (!entry) throw new LemmaComputerError("ROLE_PERMISSION_INVALID", "The role includes an unknown permission", 400);
      if (!entry.scopeTypes.includes(grant.scope.type as never)
        || grant.scope.type === "organization" && resourceId
        || grant.scope.type !== "organization" && !resourceId) {
        throw new LemmaComputerError("ROLE_SCOPE_INVALID", "The role includes an unsupported resource scope", 400);
      }
    }
    return { name, description, grants };
  }

  private async validateOrganizationRoleResources(
    client: pg.PoolClient,
    organizationId: string,
    grants: readonly OrganizationPermissionGrant[],
  ) {
    for (const grant of grants) {
      if (grant.scope.type === "organization") continue;
      const resourceId = grant.scope.resourceId!;
      const result = grant.scope.type === "workspace"
        ? await client.query("SELECT 1 FROM workspaces WHERE tenant_id=$1 AND id::text=$2", [organizationId, resourceId])
        : await client.query(
            `SELECT 1 FROM connector_registry WHERE tenant_id=$1 AND id=$2
             UNION ALL SELECT 1 FROM provider_settings WHERE tenant_id=$1 AND provider=$2
             LIMIT 1`,
            [organizationId, resourceId],
          );
      if (!result.rowCount) throw new LemmaComputerError("ROLE_SCOPE_INVALID", "The selected resource is outside this organization", 400);
    }
  }

  private async insertOrganizationRoleVersion(
    client: pg.PoolClient,
    input: {
      organizationId: string;
      roleId: string;
      version: number;
      name: string;
      description: string;
      grants: readonly OrganizationPermissionGrant[];
      actorUserId: string;
    },
  ) {
    await client.query(
      `INSERT INTO organization_custom_role_versions (
         organization_id,role_id,version,catalog_version,name,description,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.organizationId, input.roleId, input.version, organizationPermissionCatalogVersion,
        input.name, input.description, input.actorUserId],
    );
    for (const grant of input.grants) {
      await client.query(
        `INSERT INTO organization_custom_role_grants (
           organization_id,role_id,role_version,catalog_version,permission_key,scope_type,resource_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [input.organizationId, input.roleId, input.version, organizationPermissionCatalogVersion,
          grant.permission, grant.scope.type, grant.scope.resourceId ?? ""],
      );
    }
  }

  private async revokeMembershipRoleSessions(
    client: pg.PoolClient,
    organizationId: string,
    membershipIds: readonly string[],
    actorUserId: string,
  ) {
    if (!membershipIds.length) return 0;
    const revoked = await client.query(
      `UPDATE browser_sessions SET revoked_at=now()
       WHERE membership_id=ANY($1::uuid[]) AND revoked_at IS NULL
       RETURNING membership_id`,
      [membershipIds],
    );
    const affected = [...new Set(revoked.rows.map((row) => String(row.membership_id)))];
    for (const membershipId of affected) {
      await client.query(
        `INSERT INTO organization_access_audit_events (
           organization_id,membership_id,actor_user_id,event_type,provider,reason_code
         ) VALUES ($1,$2,$3,'session.revoked','product','ROLE_AUTHORITY_CHANGED')`,
        [organizationId, membershipId, actorUserId],
      );
    }
    return revoked.rowCount ?? 0;
  }

  private mapOrganizationRoles(rows: Record<string, unknown>[]): OrganizationCustomRoleSummary[] {
    const roles = new Map<string, OrganizationCustomRoleSummary>();
    for (const row of rows) {
      const id = String(row.id);
      const role = roles.get(id) ?? {
        id,
        organizationId: String(row.organization_id),
        name: String(row.name),
        description: String(row.description),
        status: String(row.status) as "active" | "archived",
        version: Number(row.current_version),
        catalogVersion: Number(row.catalog_version),
        grants: [],
        assignedMembershipCount: Number(row.assigned_membership_count),
        assignedMembershipIds: Array.isArray(row.assigned_membership_ids)
          ? row.assigned_membership_ids.map(String)
          : [],
        createdAt: new Date(String(row.created_at)).toISOString(),
        updatedAt: new Date(String(row.updated_at)).toISOString(),
      };
      if (row.permission_key) role.grants.push({
        permission: String(row.permission_key) as OrganizationPermission,
        scope: String(row.scope_type) === "organization"
          ? { type: "organization" }
          : { type: String(row.scope_type) as "workspace" | "provider", resourceId: String(row.resource_id) },
      });
      roles.set(id, role);
    }
    return [...roles.values()];
  }

  private mapOrganizationSsoConnection(row: Record<string, unknown>): OrganizationSsoConnectionSummary {
    const timestamp = (value: unknown) => value ? new Date(String(value)).toISOString() : null;
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      authenticationProviderId: String(row.authentication_provider_id),
      protocol: String(row.protocol) as "oidc" | "saml",
      domain: String(row.domain),
      issuer: String(row.issuer),
      state: String(row.state) as OrganizationSsoState,
      configVersion: Number(row.config_version),
      domainVerifiedAt: timestamp(row.domain_verified_at),
      lastTestedAt: timestamp(row.last_tested_at),
      recoveryConfirmedAt: timestamp(row.recovery_confirmed_at),
      enforcedAt: timestamp(row.enforced_at),
      suspendedAt: timestamp(row.suspended_at),
      disconnectedAt: timestamp(row.disconnected_at),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }

  async listOrganizationSsoConnections(organizationId: string) {
    const result = await this.pool.query(
      `SELECT * FROM organization_sso_connections
       WHERE organization_id=$1 ORDER BY created_at,id`,
      [organizationId],
    );
    return result.rows.map((row) => this.mapOrganizationSsoConnection(row));
  }

  async findEnforcedOrganizationSsoConnectionByDomain(domain: string) {
    const normalized = domain.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(normalized) || !normalized.includes(".")) return null;
    const result = await this.pool.query(
      `SELECT * FROM organization_sso_connections
       WHERE domain=$1 AND state='enforced' AND domain_verified_at IS NOT NULL
         AND last_tested_at IS NOT NULL AND recovery_confirmed_at IS NOT NULL
       LIMIT 1`,
      [normalized],
    );
    return result.rowCount ? this.mapOrganizationSsoConnection(result.rows[0]) : null;
  }

  async createOrganizationSsoConnection(input: {
    organizationId: string;
    authenticationProviderId: string;
    protocol: "oidc" | "saml";
    domain: string;
    issuer: string;
    createdBy: string;
  }) {
    const domain = input.domain.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) || !domain.includes(".")) {
      throw new LemmaComputerError("SSO_DOMAIN_INVALID", "The SSO domain is invalid", 400);
    }
    let issuer: URL;
    try { issuer = new URL(input.issuer); } catch {
      throw new LemmaComputerError("SSO_ISSUER_INVALID", "The SSO issuer is invalid", 400);
    }
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
      throw new LemmaComputerError("SSO_ISSUER_INVALID", "The SSO issuer must be an HTTPS URL without credentials, query, or fragment", 400);
    }
    if (!/^sso_[A-Za-z0-9_-]{4,120}$/.test(input.authenticationProviderId)) {
      throw new LemmaComputerError("SSO_PROVIDER_INVALID", "The SSO provider identifier is invalid", 400);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.actorOrganizationAuthorization(client, input.organizationId, input.createdBy)
        .catch((error) => {
          if (error instanceof LemmaComputerError) {
            throw new LemmaComputerError("SSO_ACTOR_INVALID", "The SSO actor cannot manage organization settings", 403);
          }
          throw error;
        });
      if (!actor.allows("organization.manage_settings", { type: "organization" })) {
        throw new LemmaComputerError("SSO_ACTOR_INVALID", "The SSO actor cannot manage organization settings", 403);
      }
      const created = await client.query(
        `INSERT INTO organization_sso_connections (
           organization_id,authentication_provider_id,protocol,domain,issuer,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
        [input.organizationId, input.authenticationProviderId, input.protocol, domain, issuer.toString(), input.createdBy],
      );
      await client.query(
        `INSERT INTO organization_sso_audit_events (
           organization_id,connection_id,actor_user_id,event_type,new_state,config_version,details
         ) VALUES ($1,$2,$3,'sso.created','pending',1,$4)`,
        [input.organizationId, created.rows[0].id, input.createdBy,
          JSON.stringify({ protocol: input.protocol, domain, issuer: issuer.toString() })],
      );
      await client.query("COMMIT");
      return this.mapOrganizationSsoConnection(created.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new LemmaComputerError("SSO_DOMAIN_CONFLICT", "The SSO domain or provider is already registered", 409);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionOrganizationSsoConnection(input: {
    organizationId: string;
    connectionId: string;
    action: OrganizationSsoTransition;
    actorUserId: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.organizationMembershipActor(client, input.organizationId, input.actorUserId)
        .catch((error) => {
          if (error instanceof LemmaComputerError) {
            throw new LemmaComputerError("SSO_ACTOR_INVALID", "The SSO actor cannot manage organization settings", 403);
          }
          throw error;
        });
      if (!actor.authorization.allows("organization.manage_settings", { type: "organization" })) {
        throw new LemmaComputerError("SSO_ACTOR_INVALID", "The SSO actor cannot manage organization settings", 403);
      }
      const current = await client.query(
        "SELECT * FROM organization_sso_connections WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [input.organizationId, input.connectionId],
      );
      if (!current.rowCount) throw new LemmaComputerError("SSO_CONNECTION_NOT_FOUND", "SSO connection not found", 404);
      const row = current.rows[0];
      const state = String(row.state) as OrganizationSsoState;
      if (state === "disconnected") throw new LemmaComputerError("SSO_CONNECTION_INACTIVE", "The SSO connection is disconnected", 409);
      const ownerRequired = ["recovery_confirmed", "enforce", "rollback", "disconnect"].includes(input.action);
      if (ownerRequired && actor.role !== "owner") {
        throw new LemmaComputerError("SSO_OWNER_REQUIRED", "A protected organization owner must complete this SSO action", 403);
      }
      if (input.action === "test_succeeded" && !row.domain_verified_at) {
        throw new LemmaComputerError("SSO_DOMAIN_NOT_VERIFIED", "Verify the SSO domain before testing the provider", 409);
      }
      if (input.action === "enforce") {
        if (state !== "active" || !row.last_tested_at) {
          throw new LemmaComputerError("SSO_TEST_REQUIRED", "Test the SSO provider successfully before enforcement", 409);
        }
        if (!row.recovery_confirmed_at) {
          throw new LemmaComputerError("SSO_RECOVERY_NOT_CONFIRMED", "Confirm the protected owner recovery path before enforcement", 409);
        }
      }
      if (input.action === "suspend" && !["active", "enforced"].includes(state)) {
        throw new LemmaComputerError("SSO_TRANSITION_INVALID", "Only an active SSO connection can be suspended", 409);
      }
      if (input.action === "rollback" && state !== "suspended") {
        throw new LemmaComputerError("SSO_TRANSITION_INVALID", "Only a suspended SSO connection can be rolled back", 409);
      }
      const eventType = {
        domain_verified: "sso.domain_verified",
        test_succeeded: "sso.test_succeeded",
        recovery_confirmed: "sso.recovery_confirmed",
        enforce: "sso.enforced",
        suspend: "sso.suspended",
        rollback: "sso.rolled_back",
        disconnect: "sso.disconnected",
      }[input.action];
      const nextState: OrganizationSsoState = input.action === "test_succeeded" || input.action === "rollback"
        ? "active"
        : input.action === "enforce" ? "enforced"
          : input.action === "suspend" ? "suspended"
            : input.action === "disconnect" ? "disconnected"
              : state;
      const updated = await client.query(
        `UPDATE organization_sso_connections SET
           state=$3,
           domain_verified_at=CASE WHEN $4='domain_verified' THEN now() ELSE domain_verified_at END,
           last_tested_at=CASE WHEN $4='test_succeeded' THEN now() ELSE last_tested_at END,
           recovery_confirmed_at=CASE WHEN $4='recovery_confirmed' THEN now() ELSE recovery_confirmed_at END,
           enforced_at=CASE WHEN $4='enforce' THEN now() WHEN $4='rollback' THEN NULL ELSE enforced_at END,
           suspended_at=CASE WHEN $4='suspend' THEN now() WHEN $4='rollback' THEN NULL ELSE suspended_at END,
           disconnected_at=CASE WHEN $4='disconnect' THEN now() ELSE disconnected_at END,
           updated_by=$5,updated_at=now()
         WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [input.organizationId, input.connectionId, nextState, input.action, input.actorUserId],
      );
      await client.query(
        `INSERT INTO organization_sso_audit_events (
           organization_id,connection_id,actor_user_id,event_type,old_state,new_state,config_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [input.organizationId, input.connectionId, input.actorUserId, eventType, state, nextState, Number(row.config_version)],
      );
      await client.query("COMMIT");
      return this.mapOrganizationSsoConnection(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareOrganizationSsoConfigurationChange(input: {
    organizationId: string;
    connectionId: string;
    change: OrganizationSsoConfigurationChange;
    actorUserId: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.actorOrganizationAuthorization(client, input.organizationId, input.actorUserId)
        .catch((error) => {
          if (error instanceof LemmaComputerError) {
            throw new LemmaComputerError("SSO_ACTOR_INVALID", "The SSO actor cannot manage organization settings", 403);
          }
          throw error;
        });
      if (!actor.allows("organization.manage_settings", { type: "organization" })) {
        throw new LemmaComputerError("SSO_ACTOR_INVALID", "The SSO actor cannot manage organization settings", 403);
      }
      const current = await client.query(
        "SELECT * FROM organization_sso_connections WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [input.organizationId, input.connectionId],
      );
      if (!current.rowCount) throw new LemmaComputerError("SSO_CONNECTION_NOT_FOUND", "SSO connection not found", 404);
      const row = current.rows[0];
      const state = String(row.state) as OrganizationSsoState;
      if (state === "disconnected") {
        throw new LemmaComputerError("SSO_CONNECTION_INACTIVE", "The SSO connection is disconnected", 409);
      }
      const updated = await client.query(
        `UPDATE organization_sso_connections SET
           state='pending',config_version=config_version+1,
           last_tested_at=NULL,recovery_confirmed_at=NULL,enforced_at=NULL,suspended_at=NULL,
           updated_by=$3,updated_at=now()
         WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [input.organizationId, input.connectionId, input.actorUserId],
      );
      await client.query(
        `INSERT INTO organization_sso_audit_events (
           organization_id,connection_id,actor_user_id,event_type,old_state,new_state,config_version
         ) VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
        [
          input.organizationId,
          input.connectionId,
          input.actorUserId,
          input.change === "credentials_rotated" ? "sso.rotated" : "sso.metadata_refreshed",
          state,
          Number(updated.rows[0].config_version),
        ],
      );
      await client.query("COMMIT");
      return this.mapOrganizationSsoConnection(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listOrganizationRoles(organizationId: string) {
    const result = await this.pool.query(
      `SELECT role_record.*,
         grant_record.permission_key,grant_record.scope_type,grant_record.resource_id,
         (SELECT count(*)::integer FROM organization_membership_role_assignments assignment
          WHERE assignment.organization_id=role_record.organization_id AND assignment.role_id=role_record.id)
           AS assigned_membership_count,
         (SELECT coalesce(array_agg(assignment.membership_id ORDER BY assignment.membership_id),'{}'::uuid[])
          FROM organization_membership_role_assignments assignment
          WHERE assignment.organization_id=role_record.organization_id AND assignment.role_id=role_record.id)
           AS assigned_membership_ids
       FROM organization_custom_roles role_record
       LEFT JOIN organization_custom_role_grants grant_record
         ON grant_record.organization_id=role_record.organization_id
        AND grant_record.role_id=role_record.id
        AND grant_record.role_version=role_record.current_version
       WHERE role_record.organization_id=$1
       ORDER BY role_record.status,lower(role_record.name),grant_record.permission_key,grant_record.scope_type,grant_record.resource_id`,
      [organizationId],
    );
    return this.mapOrganizationRoles(result.rows);
  }

  async createOrganizationRole(input: {
    organizationId: string;
    name: string;
    description: string;
    grants: OrganizationPermissionGrant[];
    createdBy: string;
  }) {
    const normalized = this.normalizeOrganizationRoleInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.actorOrganizationAuthorization(client, input.organizationId, input.createdBy);
      if (!actor.allows("organization.manage_roles", { type: "organization" })
        || !canDelegateOrganizationGrants(actor, normalized.grants)) {
        throw new LemmaComputerError("ROLE_DELEGATION_EXCEEDED", "The role exceeds the actor's delegated authority", 403);
      }
      await this.validateOrganizationRoleResources(client, input.organizationId, normalized.grants);
      const roleId = randomUUID();
      await client.query(
        `INSERT INTO organization_custom_roles (
           id,organization_id,name,description,status,current_version,catalog_version,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,'active',1,$5,$6,$6)`,
        [roleId, input.organizationId, normalized.name, normalized.description,
          organizationPermissionCatalogVersion, input.createdBy],
      );
      await this.insertOrganizationRoleVersion(client, {
        organizationId: input.organizationId, roleId, version: 1, ...normalized, actorUserId: input.createdBy,
      });
      await client.query(
        `INSERT INTO organization_role_audit_events (
           organization_id,role_id,role_version,actor_user_id,event_type,details
         ) VALUES ($1,$2,1,$3,'role.created',$4)`,
        [input.organizationId, roleId, input.createdBy, JSON.stringify({ permissionCount: normalized.grants.length })],
      );
      await client.query("COMMIT");
      return (await this.listOrganizationRoles(input.organizationId)).find((role) => role.id === roleId)!;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && "code" in error && (error as Error & { code?: string }).code === "23505") {
        throw new LemmaComputerError("ROLE_NAME_CONFLICT", "An active role already uses this name", 409);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateOrganizationRole(input: {
    organizationId: string;
    roleId: string;
    expectedVersion: number;
    name: string;
    description: string;
    grants: OrganizationPermissionGrant[];
    updatedBy: string;
  }) {
    const normalized = this.normalizeOrganizationRoleInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.actorOrganizationAuthorization(client, input.organizationId, input.updatedBy);
      if (!actor.allows("organization.manage_roles", { type: "organization" })
        || !canDelegateOrganizationGrants(actor, normalized.grants)) {
        throw new LemmaComputerError("ROLE_DELEGATION_EXCEEDED", "The role exceeds the actor's delegated authority", 403);
      }
      await this.validateOrganizationRoleResources(client, input.organizationId, normalized.grants);
      const current = await client.query(
        `SELECT current_version FROM organization_custom_roles
         WHERE organization_id=$1 AND id=$2 AND status='active' FOR UPDATE`,
        [input.organizationId, input.roleId],
      );
      if (!current.rowCount) throw new LemmaComputerError("ROLE_NOT_FOUND", "Role not found", 404);
      if (Number(current.rows[0].current_version) !== input.expectedVersion) {
        throw new LemmaComputerError("ROLE_VERSION_CONFLICT", "The role changed; reload before saving", 409);
      }
      const nextVersion = input.expectedVersion + 1;
      await this.insertOrganizationRoleVersion(client, {
        organizationId: input.organizationId, roleId: input.roleId, version: nextVersion,
        ...normalized, actorUserId: input.updatedBy,
      });
      await client.query(
        `UPDATE organization_custom_roles
         SET name=$3,description=$4,current_version=$5,catalog_version=$6,updated_by=$7,updated_at=now()
         WHERE organization_id=$1 AND id=$2`,
        [input.organizationId, input.roleId, normalized.name, normalized.description,
          nextVersion, organizationPermissionCatalogVersion, input.updatedBy],
      );
      const assignments = await client.query(
        `UPDATE organization_membership_role_assignments
         SET role_version=$3
         WHERE organization_id=$1 AND role_id=$2
         RETURNING membership_id`,
        [input.organizationId, input.roleId, nextVersion],
      );
      const membershipIds = [...new Set(assignments.rows.map((row) => String(row.membership_id)))];
      const revokedSessions = await this.revokeMembershipRoleSessions(client, input.organizationId, membershipIds, input.updatedBy);
      await client.query(
        `INSERT INTO organization_role_audit_events (
           organization_id,role_id,role_version,actor_user_id,event_type,details
         ) VALUES ($1,$2,$3,$4,'role.updated',$5)`,
        [input.organizationId, input.roleId, nextVersion, input.updatedBy,
          JSON.stringify({ previousVersion: input.expectedVersion, permissionCount: normalized.grants.length, affectedMemberships: membershipIds.length })],
      );
      await client.query("COMMIT");
      const role = (await this.listOrganizationRoles(input.organizationId)).find((candidate) => candidate.id === input.roleId)!;
      return { ...role, revokedSessions };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async assignOrganizationRole(input: {
    organizationId: string;
    membershipId: string;
    roleId: string;
    assignedBy: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.actorOrganizationAuthorization(client, input.organizationId, input.assignedBy);
      const role = (await client.query(
        `SELECT current_version FROM organization_custom_roles
         WHERE organization_id=$1 AND id=$2 AND status='active'`,
        [input.organizationId, input.roleId],
      )).rows[0];
      const target = await client.query(
        `SELECT 1 FROM organization_memberships WHERE organization_id=$1 AND id=$2 AND status='active'`,
        [input.organizationId, input.membershipId],
      );
      if (!role || !target.rowCount) throw new LemmaComputerError("ROLE_ASSIGNMENT_INVALID", "The role or membership is not active in this organization", 404);
      const candidate = await this.roleVersionGrants(client, input.organizationId, input.roleId, Number(role.current_version));
      if (!actor.allows("organization.manage_roles", { type: "organization" })
        || !canDelegateOrganizationGrants(actor, candidate)) {
        throw new LemmaComputerError("ROLE_DELEGATION_EXCEEDED", "The assignment exceeds the actor's delegated authority", 403);
      }
      const assigned = await client.query(
        `INSERT INTO organization_membership_role_assignments (
           organization_id,membership_id,role_id,role_version,assigned_by
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (organization_id,membership_id,role_id) DO NOTHING
         RETURNING role_version`,
        [input.organizationId, input.membershipId, input.roleId, role.current_version, input.assignedBy],
      );
      const revokedSessions = assigned.rowCount
        ? await this.revokeMembershipRoleSessions(client, input.organizationId, [input.membershipId], input.assignedBy)
        : 0;
      if (assigned.rowCount) await client.query(
        `INSERT INTO organization_role_audit_events (
           organization_id,role_id,role_version,membership_id,actor_user_id,event_type
         ) VALUES ($1,$2,$3,$4,$5,'role.assigned')`,
        [input.organizationId, input.roleId, role.current_version, input.membershipId, input.assignedBy],
      );
      await client.query("COMMIT");
      return { revokedSessions };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async roleVersionGrants(client: pg.PoolClient, organizationId: string, roleId: string, version: number) {
    const result = await client.query(
      `SELECT permission_key,scope_type,resource_id
       FROM organization_custom_role_grants
       WHERE organization_id=$1 AND role_id=$2 AND role_version=$3`,
      [organizationId, roleId, version],
    );
    return result.rows.map((row): OrganizationPermissionGrant => ({
      permission: String(row.permission_key) as OrganizationPermission,
      scope: String(row.scope_type) === "organization"
        ? { type: "organization" }
        : { type: String(row.scope_type) as "workspace" | "provider", resourceId: String(row.resource_id) },
    }));
  }

  async unassignOrganizationRole(input: {
    organizationId: string;
    membershipId: string;
    roleId: string;
    unassignedBy: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.actorOrganizationAuthorization(client, input.organizationId, input.unassignedBy);
      if (!actor.allows("organization.manage_roles", { type: "organization" })) {
        throw new LemmaComputerError("ROLE_ACTOR_INVALID", "The role actor cannot manage organization roles", 403);
      }
      const removed = await client.query(
        `DELETE FROM organization_membership_role_assignments
         WHERE organization_id=$1 AND membership_id=$2 AND role_id=$3
         RETURNING role_version`,
        [input.organizationId, input.membershipId, input.roleId],
      );
      if (!removed.rowCount) throw new LemmaComputerError("ROLE_ASSIGNMENT_INVALID", "Role assignment not found", 404);
      const revokedSessions = await this.revokeMembershipRoleSessions(client, input.organizationId, [input.membershipId], input.unassignedBy);
      await client.query(
        `INSERT INTO organization_role_audit_events (
           organization_id,role_id,role_version,membership_id,actor_user_id,event_type
         ) VALUES ($1,$2,$3,$4,$5,'role.unassigned')`,
        [input.organizationId, input.roleId, removed.rows[0].role_version, input.membershipId, input.unassignedBy],
      );
      await client.query("COMMIT");
      return { revokedSessions };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async archiveOrganizationRole(input: {
    organizationId: string;
    roleId: string;
    expectedVersion: number;
    archivedBy: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.actorOrganizationAuthorization(client, input.organizationId, input.archivedBy);
      if (!actor.allows("organization.manage_roles", { type: "organization" })) {
        throw new LemmaComputerError("ROLE_ACTOR_INVALID", "The role actor cannot manage organization roles", 403);
      }
      const role = await client.query(
        `UPDATE organization_custom_roles SET status='archived',updated_by=$4,updated_at=now()
         WHERE organization_id=$1 AND id=$2 AND status='active' AND current_version=$3
         RETURNING current_version`,
        [input.organizationId, input.roleId, input.expectedVersion, input.archivedBy],
      );
      if (!role.rowCount) throw new LemmaComputerError("ROLE_VERSION_CONFLICT", "The role changed or is no longer active", 409);
      const removed = await client.query(
        `DELETE FROM organization_membership_role_assignments
         WHERE organization_id=$1 AND role_id=$2 RETURNING membership_id`,
        [input.organizationId, input.roleId],
      );
      const membershipIds = [...new Set(removed.rows.map((row) => String(row.membership_id)))];
      const revokedSessions = await this.revokeMembershipRoleSessions(client, input.organizationId, membershipIds, input.archivedBy);
      await client.query(
        `INSERT INTO organization_role_audit_events (
           organization_id,role_id,role_version,actor_user_id,event_type,details
         ) VALUES ($1,$2,$3,$4,'role.archived',$5)`,
        [input.organizationId, input.roleId, input.expectedVersion, input.archivedBy,
          JSON.stringify({ affectedMemberships: membershipIds.length })],
      );
      await client.query("COMMIT");
      const summary = (await this.listOrganizationRoles(input.organizationId)).find((candidate) => candidate.id === input.roleId)!;
      return { role: summary, revokedSessions };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listOrganizationInvitations(organizationId: string, now: Date) {
    const result = await this.pool.query(
      `SELECT * FROM organization_invitations
       WHERE organization_id=$1
       ORDER BY created_at DESC,id DESC`,
      [organizationId],
    );
    return result.rows.map((row) => this.mapInvitation(row, now));
  }

  async getOrganizationInvitationContext(tokenHash: string, now: Date): Promise<OrganizationInvitationContext | null> {
    const result = await this.pool.query(
      `SELECT invitation.id,invitation.organization_id,invitation.status,organization.display_name
       FROM organization_invitations invitation
       JOIN organizations organization ON organization.id=invitation.organization_id
       WHERE invitation.token_hash=$1
         AND invitation.status='pending' AND invitation.expires_at>$2`,
      [tokenHash, now],
    );
    return result.rowCount ? {
      organizationId: String(result.rows[0].organization_id),
      organizationDisplayName: String(result.rows[0].display_name),
      invitationId: String(result.rows[0].id),
      status: "pending" as const,
    } : null;
  }

  async recordOrganizationAccessEvent(input: {
    organizationId: string;
    membershipId?: string;
    invitationId?: string;
    actorUserId?: string;
    eventType: "authentication.login_succeeded" | "authentication.login_failed" | "authentication.logout" | "invitation.link_failed" | "session.revoked";
    provider: "entra" | "entra-external-id" | "product";
    reasonCode?: string;
    occurredAt: Date;
  }) {
    await this.pool.query(
      `INSERT INTO organization_access_audit_events (
         organization_id,membership_id,invitation_id,actor_user_id,event_type,provider,reason_code,occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.organizationId, input.membershipId ?? null, input.invitationId ?? null, input.actorUserId ?? null,
        input.eventType, input.provider, input.reasonCode ?? null, input.occurredAt],
    );
  }

  async recordInvitationLinkFailure(tokenHash: string, provider: "entra" | "entra-external-id", reasonCode: string, occurredAt: Date) {
    await this.pool.query(
      `INSERT INTO organization_access_audit_events (
         organization_id,invitation_id,event_type,provider,reason_code,occurred_at
       )
       SELECT organization_id,id,'invitation.link_failed',$2,$3,$4
       FROM organization_invitations WHERE token_hash=$1`,
      [tokenHash, provider, reasonCode, occurredAt],
    );
  }

  async recordExternalIdentityAuthenticationFailure(input: {
    provider: "entra" | "entra-external-id";
    issuer: string;
    subject: string;
    reasonCode: string;
    occurredAt: Date;
  }) {
    await this.pool.query(
      `INSERT INTO organization_access_audit_events (
         organization_id,membership_id,actor_user_id,event_type,provider,reason_code,occurred_at
       )
       SELECT user_record.tenant_id,membership.id,user_record.id,
         'authentication.login_failed',$4,$5,$6
       FROM external_identities identity
       JOIN users user_record ON user_record.id=identity.user_id
       JOIN organization_memberships membership
         ON membership.organization_id=user_record.tenant_id
        AND membership.subject_user_id=user_record.id
       WHERE identity.provider=$1 AND identity.issuer=$2 AND identity.external_subject=$3`,
      [input.provider, input.issuer, input.subject, input.provider, input.reasonCode, input.occurredAt],
    );
  }

  private mapInvitation(row: Record<string, unknown>, now: Date): OrganizationInvitationSummary {
    const storedStatus = String(row.status) as OrganizationInvitationStatus;
    const status = storedStatus === "pending" && new Date(String(row.expires_at)) <= now
      ? "expired"
      : storedStatus;
    return {
      invitationId: String(row.id),
      organizationId: String(row.organization_id),
      email: String(row.email),
      role: String(row.role) as OrganizationRole,
      status,
      deliveryGeneration: Number(row.delivery_generation),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      acceptedMembershipId: row.accepted_membership_id ? String(row.accepted_membership_id) : null,
      createdBy: String(row.created_by),
      updatedBy: String(row.updated_by),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }

  private async requireInvitationActor(
    client: pg.PoolClient,
    organizationId: string,
    actorUserId: string,
    targetRole?: OrganizationRole,
  ) {
    const actor = await this.organizationMembershipActor(client, organizationId, actorUserId);
    if (!actor.authorization.allows("organization.manage_members", { type: "organization" })) {
      throw new LemmaComputerError("MEMBERSHIP_ACTOR_INVALID", "The membership actor cannot manage organization access", 403);
    }
    if (targetRole && targetRole !== "member"
      && !actor.authorization.allows("organization.manage_roles", { type: "organization" })) {
      throw new LemmaComputerError("MEMBERSHIP_ACTOR_INVALID", "The membership actor cannot assign organization roles", 403);
    }
    if (targetRole && !this.canDelegateBuiltInRole(actor, targetRole)) {
      if (targetRole !== "owner") {
        throw new LemmaComputerError("ROLE_DELEGATION_EXCEEDED", "The invitation role exceeds the actor's delegated authority", 403);
      }
      throw new LemmaComputerError("OWNER_CHANGE_FORBIDDEN", "Only an organization owner can invite another owner", 403);
    }
    return actor.role;
  }

  private async recordInvitationEvent(client: pg.PoolClient, input: {
    organizationId: string;
    invitationId: string;
    actorUserId: string;
    eventType: "invitation.created" | "invitation.resent" | "invitation.expired" | "invitation.revoked" | "invitation.accepted";
    oldStatus?: OrganizationInvitationStatus;
    newStatus: OrganizationInvitationStatus;
    role: OrganizationRole;
    deliveryGeneration: number;
    occurredAt: Date;
  }) {
    await client.query(
      `INSERT INTO organization_invitation_audit_events (
         organization_id,invitation_id,actor_user_id,event_type,
         old_status,new_status,role,delivery_generation,occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.organizationId,
        input.invitationId,
        input.actorUserId,
        input.eventType,
        input.oldStatus ?? null,
        input.newStatus,
        input.role,
        input.deliveryGeneration,
        input.occurredAt,
      ],
    );
  }

  private async enforceInvitationDeliveryRate(
    client: pg.PoolClient,
    organizationId: string,
    actorUserId: string,
    now: Date,
  ) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
      [`organization-invitation-rate:${organizationId}:${actorUserId}`],
    );
    const recent = await client.query(
      `SELECT count(*)::integer AS count
       FROM organization_invitation_audit_events
       WHERE organization_id=$1 AND actor_user_id=$2
         AND event_type IN ('invitation.created','invitation.resent')
         AND occurred_at>$3::timestamptz-interval '1 hour'`,
      [organizationId, actorUserId, now],
    );
    if (Number(recent.rows[0].count) >= 20) {
      throw new LemmaComputerError(
        "INVITATION_RATE_LIMITED",
        "Too many organization invitations were sent. Try again later",
        429,
        true,
      );
    }
  }

  async createOrganizationInvitation(input: {
    organizationId: string;
    email: string;
    role: OrganizationRole;
    tokenHash: string;
    idempotencyKeyHash: string;
    expiresAt: Date;
    createdBy: string;
    now: Date;
  }) {
    const email = input.email.trim().toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`organization-invitation:${input.organizationId}:${email}`]);
      await this.requireInvitationActor(client, input.organizationId, input.createdBy, input.role);
      const expired = await client.query(
        `UPDATE organization_invitations
         SET status='expired',updated_by=$3,updated_at=$4
         WHERE organization_id=$1 AND email=$2 AND status='pending' AND expires_at<=$4
         RETURNING *`,
        [input.organizationId, email, input.createdBy, input.now],
      );
      for (const row of expired.rows) await this.recordInvitationEvent(client, {
        organizationId: input.organizationId,
        invitationId: String(row.id),
        actorUserId: input.createdBy,
        eventType: "invitation.expired",
        oldStatus: "pending",
        newStatus: "expired",
        role: String(row.role) as OrganizationRole,
        deliveryGeneration: Number(row.delivery_generation),
        occurredAt: input.now,
      });
      const replay = await client.query(
        `SELECT * FROM organization_invitations
         WHERE organization_id=$1 AND create_idempotency_key_hash=$2`,
        [input.organizationId, input.idempotencyKeyHash],
      );
      if (replay.rowCount) {
        if (String(replay.rows[0].email) !== email || String(replay.rows[0].role) !== input.role) {
          throw new LemmaComputerError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different invitation", 409);
        }
        await client.query("COMMIT");
        return { invitation: this.mapInvitation(replay.rows[0], input.now), replayed: true };
      }
      const pending = await client.query(
        `SELECT id FROM organization_invitations
         WHERE organization_id=$1 AND email=$2 AND status='pending'`,
        [input.organizationId, email],
      );
      if (pending.rowCount) {
        throw new LemmaComputerError("INVITATION_ALREADY_PENDING", "A pending invitation already exists for this email", 409);
      }
      const existingMembership = await client.query(
        `SELECT 1
         FROM organization_memberships membership
         JOIN users user_record ON user_record.id=membership.subject_user_id
         WHERE membership.organization_id=$1 AND lower(user_record.email)=$2
         LIMIT 1`,
        [input.organizationId, email],
      );
      if (existingMembership.rowCount) {
        throw new LemmaComputerError("MEMBERSHIP_ALREADY_EXISTS", "This email already has organization access", 409);
      }
      await this.enforceInvitationDeliveryRate(client, input.organizationId, input.createdBy, input.now);
      const created = await client.query(
        `INSERT INTO organization_invitations (
           organization_id,email,role,token_hash,create_idempotency_key_hash,
           expires_at,created_by,updated_by,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$8)
         RETURNING *`,
        [
          input.organizationId,
          email,
          input.role,
          input.tokenHash,
          input.idempotencyKeyHash,
          input.expiresAt,
          input.createdBy,
          input.now,
        ],
      );
      await this.recordInvitationEvent(client, {
        organizationId: input.organizationId,
        invitationId: String(created.rows[0].id),
        actorUserId: input.createdBy,
        eventType: "invitation.created",
        newStatus: "pending",
        role: input.role,
        deliveryGeneration: 1,
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return { invitation: this.mapInvitation(created.rows[0], input.now), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resendOrganizationInvitation(input: {
    organizationId: string;
    invitationId: string;
    tokenHash: string;
    idempotencyKeyHash: string;
    expiresAt: Date;
    updatedBy: string;
    now: Date;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`organization-invitation:${input.organizationId}:${input.invitationId}`]);
      const current = await client.query(
        `SELECT * FROM organization_invitations
         WHERE organization_id=$1 AND id=$2
         FOR UPDATE`,
        [input.organizationId, input.invitationId],
      );
      if (!current.rowCount) throw new LemmaComputerError("INVITATION_NOT_FOUND", "Invitation not found", 404);
      const row = current.rows[0];
      await this.requireInvitationActor(client, input.organizationId, input.updatedBy, String(row.role) as OrganizationRole);
      if (row.last_resend_idempotency_key_hash === input.idempotencyKeyHash) {
        await client.query("COMMIT");
        return { invitation: this.mapInvitation(row, input.now), replayed: true };
      }
      if (row.status === "accepted" || row.status === "revoked") {
        throw new LemmaComputerError("INVITATION_NOT_ACTIVE", "Only pending or expired invitations can be resent", 409);
      }
      await this.enforceInvitationDeliveryRate(client, input.organizationId, input.updatedBy, input.now);
      const oldStatus = row.status === "pending" && new Date(String(row.expires_at)) <= input.now
        ? "expired"
        : String(row.status) as OrganizationInvitationStatus;
      const resent = await client.query(
        `UPDATE organization_invitations
         SET status='pending',token_hash=$3,last_resend_idempotency_key_hash=$4,
           delivery_generation=delivery_generation+1,expires_at=$5,
           updated_by=$6,updated_at=$7
         WHERE organization_id=$1 AND id=$2
         RETURNING *`,
        [input.organizationId, input.invitationId, input.tokenHash, input.idempotencyKeyHash, input.expiresAt, input.updatedBy, input.now],
      );
      await this.recordInvitationEvent(client, {
        organizationId: input.organizationId,
        invitationId: input.invitationId,
        actorUserId: input.updatedBy,
        eventType: "invitation.resent",
        oldStatus,
        newStatus: "pending",
        role: String(resent.rows[0].role) as OrganizationRole,
        deliveryGeneration: Number(resent.rows[0].delivery_generation),
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return { invitation: this.mapInvitation(resent.rows[0], input.now), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeOrganizationInvitation(input: {
    organizationId: string;
    invitationId: string;
    revokedBy: string;
    now: Date;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        `SELECT * FROM organization_invitations
         WHERE organization_id=$1 AND id=$2
         FOR UPDATE`,
        [input.organizationId, input.invitationId],
      );
      if (!current.rowCount) throw new LemmaComputerError("INVITATION_NOT_FOUND", "Invitation not found", 404);
      const row = current.rows[0];
      await this.requireInvitationActor(client, input.organizationId, input.revokedBy, String(row.role) as OrganizationRole);
      if (row.status === "revoked") {
        await client.query("COMMIT");
        return { invitation: this.mapInvitation(row, input.now), replayed: true };
      }
      if (row.status === "accepted") {
        throw new LemmaComputerError("INVITATION_NOT_ACTIVE", "An accepted invitation cannot be revoked", 409);
      }
      const oldStatus = row.status === "pending" && new Date(String(row.expires_at)) <= input.now
        ? "expired"
        : String(row.status) as OrganizationInvitationStatus;
      const revoked = await client.query(
        `UPDATE organization_invitations
         SET status='revoked',revoked_at=$3,updated_by=$4,updated_at=$3
         WHERE organization_id=$1 AND id=$2
         RETURNING *`,
        [input.organizationId, input.invitationId, input.now, input.revokedBy],
      );
      await this.recordInvitationEvent(client, {
        organizationId: input.organizationId,
        invitationId: input.invitationId,
        actorUserId: input.revokedBy,
        eventType: "invitation.revoked",
        oldStatus,
        newStatus: "revoked",
        role: String(revoked.rows[0].role) as OrganizationRole,
        deliveryGeneration: Number(revoked.rows[0].delivery_generation),
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return { invitation: this.mapInvitation(revoked.rows[0], input.now), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private mapMembership(row: Record<string, unknown>): OrganizationMembershipSummary {
    return {
      membershipId: String(row.membership_id),
      organizationId: String(row.organization_id),
      accountUserId: String(row.account_user_id),
      userId: String(row.user_id),
      email: String(row.email),
      displayName: String(row.display_name),
      status: String(row.status) as OrganizationMembershipStatus,
      role: String(row.role) as OrganizationRole,
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }

  async changeOrganizationMembership(input: {
    organizationId: string;
    targetUserId: string;
    role?: OrganizationRole;
    status?: OrganizationMembershipStatus;
    updatedBy: string;
  }) {
    if (!input.role && !input.status) throw new LemmaComputerError("MEMBERSHIP_CHANGE_EMPTY", "No membership change was requested", 400);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`organization-membership:${input.organizationId}`]);
      const actor = await this.organizationMembershipActor(client, input.organizationId, input.updatedBy);
      if (input.status && !actor.authorization.allows("organization.manage_members", { type: "organization" })) {
        throw new LemmaComputerError("MEMBERSHIP_ACTOR_INVALID", "The membership actor cannot manage organization access", 403);
      }
      if (input.role && !actor.authorization.allows("organization.manage_roles", { type: "organization" })) {
        throw new LemmaComputerError("MEMBERSHIP_ACTOR_INVALID", "The membership actor cannot assign organization roles", 403);
      }
      const targetBefore = await client.query(
        `SELECT role,status FROM organization_memberships
         WHERE organization_id=$1 AND subject_user_id=$2
         FOR UPDATE`,
        [input.organizationId, input.targetUserId],
      );
      if (!targetBefore.rowCount) throw new LemmaComputerError("MEMBERSHIP_NOT_FOUND", "Membership not found", 404);
      const roleChanged = input.role !== undefined && input.role !== targetBefore.rows[0].role;
      if (actor.role !== "owner" && (input.role === "owner" || targetBefore.rows[0].role === "owner")) {
        throw new LemmaComputerError("OWNER_CHANGE_FORBIDDEN", "Only an organization owner can change ownership", 403);
      }
      if (input.role && !this.canDelegateBuiltInRole(actor, input.role)) {
        throw new LemmaComputerError("ROLE_DELEGATION_EXCEEDED", "The membership role exceeds the actor's delegated authority", 403);
      }
      const changed = await client.query(
        `UPDATE organization_memberships membership
         SET role=COALESCE($3,membership.role),
           status=COALESCE($4,membership.status),updated_by=$5,updated_at=now()
         FROM users user_record
         WHERE membership.organization_id=$1 AND membership.subject_user_id=$2
           AND user_record.id=membership.subject_user_id
         RETURNING membership.id AS membership_id,membership.organization_id,membership.account_user_id,
           membership.subject_user_id AS user_id,
           membership.status,membership.role,membership.created_at,membership.updated_at,
           user_record.email,user_record.display_name`,
        [input.organizationId, input.targetUserId, input.role ?? null, input.status ?? null, input.updatedBy],
      );
      if (!changed.rowCount) throw new LemmaComputerError("MEMBERSHIP_NOT_FOUND", "Membership not found", 404);
      await client.query(
        `INSERT INTO user_roles (user_id,role,assigned_by)
         VALUES ($1,'employee',$2)
         ON CONFLICT (user_id,role) DO NOTHING`,
        [input.targetUserId, input.updatedBy],
      );
      if (changed.rows[0].role === "owner" || changed.rows[0].role === "admin") {
        await client.query(
          `INSERT INTO user_roles (user_id,role,assigned_by)
           VALUES ($1,'administrator',$2)
           ON CONFLICT (user_id,role) DO NOTHING`,
          [input.targetUserId, input.updatedBy],
        );
      } else {
        await client.query(
          "DELETE FROM user_roles WHERE user_id=$1 AND role='administrator'",
          [input.targetUserId],
        );
      }
      const activeMemberships = await client.query(
        "SELECT 1 FROM organization_memberships WHERE subject_user_id=$1 AND status='active' LIMIT 1",
        [input.targetUserId],
      );
      await client.query(
        "UPDATE users SET status=$2,updated_at=now() WHERE id=$1",
        [input.targetUserId, activeMemberships.rowCount ? "active" : "disabled"],
      );
      let revokedSessions = 0;
      if (roleChanged) {
        revokedSessions = await this.revokeMembershipRoleSessions(
          client,
          input.organizationId,
          [String(changed.rows[0].membership_id)],
          input.updatedBy,
        );
      } else if (input.status === "suspended" || input.status === "revoked") {
        const revoked = await client.query(
          `UPDATE browser_sessions SET revoked_at=now()
           WHERE membership_id=$1 AND revoked_at IS NULL RETURNING id`,
          [changed.rows[0].membership_id],
        );
        revokedSessions = revoked.rowCount ?? 0;
        if (revokedSessions > 0) {
          await client.query(
            `INSERT INTO organization_access_audit_events (
               organization_id,membership_id,actor_user_id,event_type,provider,reason_code
             ) VALUES ($1,$2,$3,'session.revoked','product',$4)`,
            [input.organizationId, changed.rows[0].membership_id, input.updatedBy,
              input.status === "suspended" ? "MEMBERSHIP_SUSPENDED" : "MEMBERSHIP_REVOKED"],
          );
        }
      }
      await client.query("COMMIT");
      return { membership: this.mapMembership(changed.rows[0]), revokedSessions };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isLastActiveOwnerViolation(error)) {
        throw new LemmaComputerError(
          "LAST_OWNER_REQUIRED",
          "Assign another active owner before changing this owner's access",
          409,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private assertRecentOwnerStepUp(recentStepUpAt: Date, now: Date) {
    const ageMs = now.getTime() - recentStepUpAt.getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > recentAuthenticationStepUpWindowMs) {
      throw new LemmaComputerError("OWNER_STEP_UP_REQUIRED", "Recent MFA verification is required", 403);
    }
  }

  async updateOrganizationDisplayName(input: {
    organizationId: string;
    updatedBy: string;
    displayName: string;
    now: Date;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`organization-settings:${input.organizationId}`],
      );
      const owner = await client.query(
        `SELECT organization.display_name
         FROM organizations organization
         JOIN organization_memberships membership
           ON membership.organization_id=organization.id
          AND membership.subject_user_id=$2
          AND membership.role='owner'
          AND membership.status='active'
         WHERE organization.id=$1 AND organization.status='active'
         FOR UPDATE OF organization`,
        [input.organizationId, input.updatedBy],
      );
      if (!owner.rowCount) {
        throw new LemmaComputerError(
          "ORGANIZATION_OWNER_REQUIRED",
          "Only the active organization owner can rename the organization",
          403,
        );
      }
      const previousDisplayName = String(owner.rows[0].display_name);
      if (previousDisplayName !== input.displayName) {
        await client.query(
          "UPDATE organizations SET display_name=$2,updated_at=$3 WHERE id=$1",
          [input.organizationId, input.displayName, input.now],
        );
        await client.query(
          "UPDATE tenants SET display_name=$2 WHERE id=$1",
          [input.organizationId, input.displayName],
        );
        await client.query(
          `INSERT INTO organization_lifecycle_audit_events (
             organization_id,actor_user_id,event_type,detail,occurred_at
           ) VALUES ($1,$2,'organization.renamed',$3::jsonb,$4)`,
          [input.organizationId, input.updatedBy, JSON.stringify({
            previousDisplayName,
            displayName: input.displayName,
          }), input.now],
        );
      }
      await client.query("COMMIT");
      return { id: input.organizationId, displayName: input.displayName };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transferOrganizationOwnership(input: {
    organizationId: string;
    currentOwnerUserId: string;
    targetMembershipId: string;
    recentStepUpAt: Date;
    now: Date;
  }) {
    this.assertRecentOwnerStepUp(input.recentStepUpAt, input.now);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`organization-membership:${input.organizationId}`]);
      const owner = await client.query(
        `SELECT id,subject_user_id FROM organization_memberships
         WHERE organization_id=$1 AND subject_user_id=$2 AND role='owner' AND status='active'
         FOR UPDATE`,
        [input.organizationId, input.currentOwnerUserId],
      );
      if (!owner.rowCount) {
        throw new LemmaComputerError("OWNER_CHANGE_FORBIDDEN", "Only an active organization owner can transfer ownership", 403);
      }
      const connectedSso = await client.query(
        `SELECT id FROM organization_sso_connections
         WHERE organization_id=$1 AND state<>'disconnected'
         LIMIT 1
         FOR UPDATE`,
        [input.organizationId],
      );
      if (connectedSso.rowCount) {
        throw new LemmaComputerError(
          "OWNER_TRANSFER_REQUIRES_SSO_DISCONNECT",
          "Disconnect Company SSO before transferring ownership so provider administration is not stranded with the former owner",
          409,
        );
      }
      const target = await client.query(
        `SELECT id,subject_user_id FROM organization_memberships
         WHERE organization_id=$1 AND id=$2 AND status='active'
         FOR UPDATE`,
        [input.organizationId, input.targetMembershipId],
      );
      if (!target.rowCount) throw new LemmaComputerError("MEMBERSHIP_NOT_ACTIVE", "The new owner membership is not active", 403);
      if (target.rows[0].subject_user_id === input.currentOwnerUserId) {
        throw new LemmaComputerError("OWNER_TRANSFER_TARGET_INVALID", "Choose a different active member as the new owner", 409);
      }
      await client.query(
        `UPDATE organization_memberships SET role='owner',updated_by=$3,updated_at=$4
         WHERE organization_id=$1 AND id=$2`,
        [input.organizationId, input.targetMembershipId, input.currentOwnerUserId, input.now],
      );
      await client.query(
        `UPDATE organization_memberships SET role='admin',updated_by=$3,updated_at=$4
         WHERE organization_id=$1 AND id=$2`,
        [input.organizationId, owner.rows[0].id, input.currentOwnerUserId, input.now],
      );
      await client.query(
        `INSERT INTO user_roles (user_id,role,assigned_by,assigned_at)
         VALUES ($1,'administrator',$2,$3)
         ON CONFLICT (user_id,role) DO NOTHING`,
        [target.rows[0].subject_user_id, input.currentOwnerUserId, input.now],
      );
      const revoked = await client.query(
        `UPDATE browser_sessions SET revoked_at=$3
         WHERE membership_id=ANY($1::uuid[]) AND revoked_at IS NULL AND expires_at>$2
         RETURNING id`,
        [[owner.rows[0].id, input.targetMembershipId], input.now, input.now],
      );
      await client.query(
        `INSERT INTO organization_lifecycle_audit_events (
           organization_id,actor_user_id,event_type,detail,occurred_at
         ) VALUES ($1,$2,'organization.ownership_transferred',$3::jsonb,$4)`,
        [input.organizationId, input.currentOwnerUserId, JSON.stringify({
          previousOwnerMembershipId: String(owner.rows[0].id),
          newOwnerMembershipId: input.targetMembershipId,
        }), input.now],
      );
      await client.query("COMMIT");
      return {
        previousOwner: { membershipId: String(owner.rows[0].id), role: "admin" as const },
        owner: { membershipId: input.targetMembershipId, userId: String(target.rows[0].subject_user_id), role: "owner" as const },
        revokedSessions: revoked.rowCount ?? 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async initiateOrganizationClosure(input: {
    organizationId: string;
    requestedBy: string;
    reason: string;
    idempotencyKey: string;
    recentStepUpAt: Date;
    now: Date;
  }) {
    this.assertRecentOwnerStepUp(input.recentStepUpAt, input.now);
    const idempotencyKeyHash = createHash("sha256")
      .update(`organization-closure-idempotency\0${input.idempotencyKey}`)
      .digest("hex");
    const requestFingerprint = createHash("sha256").update(input.reason).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`organization-lifecycle:${input.organizationId}`]);
      const owner = await client.query(
        `SELECT id FROM organization_memberships
         WHERE organization_id=$1 AND subject_user_id=$2 AND role='owner' AND status='active'
         FOR UPDATE`,
        [input.organizationId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new LemmaComputerError("OWNER_CHANGE_FORBIDDEN", "Only an active organization owner can initiate closure", 403);
      }
      const replay = await client.query(
        `SELECT id,status,request_fingerprint,requested_at,execute_after
         FROM organization_closure_requests
         WHERE organization_id=$1 AND idempotency_key_hash=$2`,
        [input.organizationId, idempotencyKeyHash],
      );
      if (replay.rowCount) {
        const row = replay.rows[0];
        if (row.request_fingerprint !== requestFingerprint) {
          throw new LemmaComputerError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for another closure request", 409);
        }
        if (row.status !== "pending") {
          throw new LemmaComputerError("ORGANIZATION_CLOSURE_NOT_PENDING", "The closure request is no longer pending", 409);
        }
        await client.query("COMMIT");
        return {
          replayed: true,
          request: {
            id: String(row.id), status: "pending" as const,
            requestedAt: new Date(String(row.requested_at)).toISOString(),
            executeAfter: new Date(String(row.execute_after)).toISOString(),
          },
        };
      }
      const pending = await client.query(
        "SELECT id FROM organization_closure_requests WHERE organization_id=$1 AND status='pending' FOR UPDATE",
        [input.organizationId],
      );
      if (pending.rowCount) {
        throw new LemmaComputerError("ORGANIZATION_CLOSURE_ALREADY_PENDING", "This organization already has a pending closure request", 409);
      }
      const requestId = randomUUID();
      const executeAfter = new Date(input.now.getTime() + 7 * 24 * 60 * 60_000);
      await client.query(
        `INSERT INTO organization_closure_requests (
           id,organization_id,requested_by,idempotency_key_hash,request_fingerprint,
           reason,status,recent_step_up_at,requested_at,execute_after
         ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)`,
        [requestId, input.organizationId, input.requestedBy, idempotencyKeyHash,
          requestFingerprint, input.reason, input.recentStepUpAt, input.now, executeAfter],
      );
      await client.query(
        `INSERT INTO organization_lifecycle_audit_events (
           organization_id,actor_user_id,event_type,detail,occurred_at
         ) VALUES ($1,$2,'organization.closure_requested',$3::jsonb,$4)`,
        [input.organizationId, input.requestedBy, JSON.stringify({ closureRequestId: requestId }), input.now],
      );
      await client.query("COMMIT");
      return {
        replayed: false,
        request: { id: requestId, status: "pending" as const, requestedAt: input.now.toISOString(), executeAfter: executeAfter.toISOString() },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setUserStatus(input: { tenantId: string; targetUserId: string; status: LemmaComputerUserStatus; updatedBy: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`organization-membership:${input.tenantId}`]);
      const target = await client.query(
        `SELECT u.id,m.id AS membership_id,m.role
         FROM users u
         JOIN organization_memberships m ON m.subject_user_id=u.id AND m.organization_id=$2
         WHERE u.id=$1
         FOR UPDATE OF u,m`,
        [input.targetUserId, input.tenantId],
      );
      if (!target.rowCount) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
      const actor = await this.organizationMembershipActor(client, input.tenantId, input.updatedBy);
      if (!actor.authorization.allows("organization.manage_members", { type: "organization" })) {
        throw new LemmaComputerError("MEMBERSHIP_ACTOR_INVALID", "The membership actor cannot manage organization access", 403);
      }
      if (actor.role !== "owner" && target.rows[0].role === "owner") {
        throw new LemmaComputerError("OWNER_CHANGE_FORBIDDEN", "Only an organization owner can change ownership", 403);
      }
      const membershipStatus = input.status === "active" ? "active" : "suspended";
      await client.query(
        `UPDATE organization_memberships
         SET status=$3,updated_by=$4,updated_at=now()
         WHERE subject_user_id=$1 AND organization_id=$2`, [
        input.targetUserId,
        input.tenantId,
        membershipStatus,
        input.updatedBy,
      ]);
      const activeMemberships = await client.query(
        "SELECT 1 FROM organization_memberships WHERE subject_user_id=$1 AND status='active' LIMIT 1",
        [input.targetUserId],
      );
      await client.query("UPDATE users SET status=$2,updated_at=now() WHERE id=$1", [
        input.targetUserId,
        activeMemberships.rowCount ? "active" : "disabled",
      ]);
      let revokedSessions = 0;
      if (input.status === "disabled") {
        const revoked = await client.query(
          "UPDATE browser_sessions SET revoked_at=now() WHERE membership_id=$1 AND revoked_at IS NULL RETURNING id",
          [target.rows[0].membership_id],
        );
        revokedSessions = revoked.rowCount ?? 0;
        if (revokedSessions > 0) {
          await client.query(
            `INSERT INTO organization_access_audit_events (
               organization_id,membership_id,actor_user_id,event_type,provider,reason_code
             ) VALUES ($1,$2,$3,'session.revoked','product','USER_DISABLED')`,
            [input.tenantId, target.rows[0].membership_id, input.updatedBy],
          );
        }
      }
      await client.query("COMMIT");
      return { status: input.status, revokedSessions };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeUserSessions(input: { tenantId: string; targetUserId: string; revokedBy: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query(
        `SELECT m.id AS membership_id
         FROM organization_memberships m
         WHERE m.subject_user_id=$1 AND m.organization_id=$2
         FOR UPDATE`,
        [input.targetUserId, input.tenantId],
      );
      if (!target.rowCount) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
      const revoked = await client.query(
        "UPDATE browser_sessions SET revoked_at=now() WHERE membership_id=$1 AND revoked_at IS NULL RETURNING id",
        [target.rows[0].membership_id],
      );
      const revokedSessions = revoked.rowCount ?? 0;
      if (revokedSessions > 0) {
        await client.query(
          `INSERT INTO organization_access_audit_events (
             organization_id,membership_id,actor_user_id,event_type,provider,reason_code
           ) VALUES ($1,$2,$3,'session.revoked','product','ADMIN_SESSION_REVOCATION')`,
          [input.tenantId, target.rows[0].membership_id, input.revokedBy],
        );
      }
      await client.query("COMMIT");
      return revokedSessions;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async assignMvpPolicy(input: { tenantId: string; targetUserId: string; assignedBy: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const policy = await this.assignMvpPolicyWithClient(client, input.tenantId, input.targetUserId, input.assignedBy);
      await client.query("COMMIT");
      return policy;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async revokeMvpPolicy(input: { tenantId: string; targetUserId: string; revokedBy: string }) {
    const result = await this.pool.query(
      `UPDATE policy_assignments SET revoked_at=now(),revoked_by=$3
       WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`,
      [input.tenantId, input.targetUserId, input.revokedBy],
    );
    return Boolean(result.rowCount);
  }

  async createMvpPolicyVersion(input: { tenantId: string; createdBy: string; revisionNote: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2", [input.createdBy, input.tenantId]);
      if (!user.rowCount) throw new Error("Policy creator is outside the tenant");
      const bundleId = mvpPolicyBundleId(input.tenantId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-version:${bundleId}`]);
      await this.ensurePolicyFoundation(client, input.tenantId, input.createdBy);
      const latest = await client.query("SELECT COALESCE(max(version),0) AS version FROM policy_versions WHERE policy_bundle_id=$1", [bundleId]);
      const version = Number(latest.rows[0].version) + 1;
      const document = mvpPolicyDocument(input.revisionNote);
      const documentHash = policyHash(document);
      const id = randomUUID();
      await client.query(
        "INSERT INTO policy_versions (id,policy_bundle_id,version,document,document_hash,created_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6)",
        [id, bundleId, version, JSON.stringify(document), documentHash, input.createdBy],
      );
      await client.query("COMMIT");
      return { id, version, documentHash };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async updateMvpToolPolicy(input: { tenantId: string; updatedBy: string; tools: Record<string, McpToolPolicyDecision> }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const bundleId = mvpPolicyBundleId(input.tenantId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-version:${bundleId}`]);
      await this.ensurePolicyFoundation(client, input.tenantId, input.updatedBy);
      const latest = await client.query(
        "SELECT id,version,document FROM policy_versions WHERE policy_bundle_id=$1 ORDER BY version DESC LIMIT 1",
        [bundleId],
      );
      const document = structuredClone((latest.rows[0]?.document ?? mvpPolicyDocument()) as OwnedJson) as Record<string, OwnedJson>;
      applyMvpSandboxCatalog(document);
      document.revisionNote = "Updated Microsoft 365 tool approval rules";
      const mcp = document.mcp as Record<string, OwnedJson>;
      const servers = mcp.servers as Record<string, OwnedJson>;
      const server = servers.lemmacomputer_ms365 as Record<string, OwnedJson>;
      server.tools = Object.keys(input.tools);
      server.toolPolicies = input.tools;
      const documentHash = policyHash(document);
      const existing = await client.query(
        "SELECT id,version FROM policy_versions WHERE policy_bundle_id=$1 AND document_hash=$2",
        [bundleId, documentHash],
      );
      let id: string;
      let version: number;
      if (existing.rowCount) {
        id = String(existing.rows[0].id);
        version = Number(existing.rows[0].version);
      } else {
        version = Number(latest.rows[0]?.version ?? 0) + 1;
        id = randomUUID();
        await client.query(
          "INSERT INTO policy_versions (id,policy_bundle_id,version,document,document_hash,created_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6)",
          [id, bundleId, version, JSON.stringify(document), documentHash, input.updatedBy],
        );
      }
      const assignments = await client.query(
        `SELECT pa.id,pa.tenant_id,pa.user_id,pa.agent_id,pa.egress_security_group_version_id
         FROM policy_assignments pa JOIN policy_versions pv ON pv.id=pa.policy_version_id
         WHERE pa.tenant_id=$1 AND pv.policy_bundle_id=$2 AND pa.revoked_at IS NULL FOR UPDATE`,
        [input.tenantId, bundleId],
      );
      for (const assignment of assignments.rows) {
        await client.query("UPDATE policy_assignments SET revoked_at=now(),revoked_by=$2 WHERE id=$1", [assignment.id, input.updatedBy]);
        const replacementId = randomUUID();
        await client.query(
          `INSERT INTO policy_assignments (id,tenant_id,user_id,agent_id,policy_version_id,egress_security_group_version_id,assigned_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [replacementId, assignment.tenant_id, assignment.user_id, assignment.agent_id, id, assignment.egress_security_group_version_id, input.updatedBy],
        );
        await client.query(
          "INSERT INTO capability_assignments (policy_assignment_id,capability_id) SELECT $1,capability_id FROM capability_assignments WHERE policy_assignment_id=$2",
          [replacementId, assignment.id],
        );
      }
      await client.query("COMMIT");
      return { id, version, documentHash };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async listEgressSecurityGroups(tenantId: string, createdBy?: string) {
    if (createdBy) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await this.ensurePolicyFoundation(client, tenantId, createdBy);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    const result = await this.pool.query(
      `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
       esgv.version AS egress_version,esgv.document AS egress_document,
       esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
       esgv.created_at AS egress_created_at
       FROM egress_security_group_versions esgv
       JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
       WHERE esg.tenant_id=$1
       ORDER BY esg.name,esgv.version DESC`,
      [tenantId],
    );
    return result.rows.map(mapEgressVersion);
  }

  async saveEgressSecurityGroup(input: { tenantId: string; updatedBy: string; securityGroupId?: string; name: string; description: string; defaultAction: "deny" | "allow-public-http-https"; rules: EgressSecurityGroupRule[] }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await client.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2", [input.updatedBy, input.tenantId]);
      if (!actor.rowCount) throw new LemmaComputerError("EGRESS_TENANT_MISMATCH", "Firewall editor is outside the tenant", 403);
      const securityGroupId = input.securityGroupId ?? `esg_${randomUUID().replaceAll("-", "")}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`egress-security-group:${securityGroupId}`]);
      const existingGroup = await client.query(
        "SELECT id FROM egress_security_groups WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [securityGroupId, input.tenantId],
      );
      if (input.securityGroupId && !existingGroup.rowCount) throw new LemmaComputerError("EGRESS_SECURITY_GROUP_NOT_FOUND", "Network security group not found", 404);
      if (!existingGroup.rowCount) {
        await client.query(
          `INSERT INTO egress_security_groups (id,tenant_id,name,description,created_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [securityGroupId, input.tenantId, input.name, input.description, input.updatedBy],
        );
      }
      const latest = await client.query(
        "SELECT COALESCE(max(version),0) AS version FROM egress_security_group_versions WHERE security_group_id=$1",
        [securityGroupId],
      );
      const version = Number(latest.rows[0].version) + 1;
      const id = `egv_${randomUUID().replaceAll("-", "")}`;
      const provisional = egressSecurityGroupVersionSchema.parse({
        schemaVersion: 1,
        id,
        securityGroupId,
        tenantId: input.tenantId,
        version,
        name: input.name,
        description: input.description,
        defaultAction: input.defaultAction,
        rules: input.rules,
        documentHash: "0".repeat(64),
        createdBy: input.updatedBy,
        createdAt: new Date().toISOString(),
      });
      const compiled = compileEgressSecurityGroup(provisional);
      const document = {
        schemaVersion: 1,
        name: input.name,
        description: input.description,
        defaultAction: input.defaultAction,
        rules: compiled.rules,
      } satisfies OwnedJson;
      const documentHash = policyHash(document);
      const unchanged = await client.query(
        `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
         esgv.version AS egress_version,esgv.document AS egress_document,
         esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
         esgv.created_at AS egress_created_at
         FROM egress_security_group_versions esgv
         JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
         WHERE esgv.security_group_id=$1 AND esgv.document_hash=$2`,
        [securityGroupId, documentHash],
      );
      if (unchanged.rowCount) {
        await client.query("COMMIT");
        return mapEgressVersion(unchanged.rows[0]);
      }
      const inserted = await client.query(
        `INSERT INTO egress_security_group_versions (id,security_group_id,version,document,document_hash,created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING created_at`,
        [id, securityGroupId, version, JSON.stringify(document), documentHash, input.updatedBy],
      );
      await client.query(
        "UPDATE egress_security_groups SET name=$2,description=$3,updated_at=now() WHERE id=$1",
        [securityGroupId, input.name, input.description],
      );
      await client.query("COMMIT");
      return egressSecurityGroupVersionSchema.parse({
        ...provisional,
        rules: compiled.rules,
        documentHash,
        createdAt: new Date(String(inserted.rows[0].created_at)).toISOString(),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async getWorkspaceEgressSecurityGroup(input: { tenantId: string; subjectId: string; grantId: string }) {
    const result = await this.pool.query(
      `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
       esgv.version AS egress_version,esgv.document AS egress_document,
       esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
       esgv.created_at AS egress_created_at
       FROM workspace_egress_security_group_assignments assignment
       JOIN egress_security_groups esg ON esg.id=assignment.security_group_id
       JOIN LATERAL (
         SELECT *
         FROM egress_security_group_versions candidate
         WHERE candidate.security_group_id=assignment.security_group_id
         ORDER BY candidate.version DESC
         LIMIT 1
       ) esgv ON true
       WHERE assignment.tenant_id=$1 AND assignment.subject_id=$2 AND assignment.grant_id=$3`,
      [input.tenantId, input.subjectId, input.grantId],
    );
    if (result.rowCount) return mapEgressVersion(result.rows[0]);
    const fallback = await this.pool.query(
      `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
       esgv.version AS egress_version,esgv.document AS egress_document,
       esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
       esgv.created_at AS egress_created_at
       FROM egress_security_group_versions esgv
       JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
       WHERE esgv.security_group_id=$1 AND esg.tenant_id=$2
       ORDER BY esgv.version DESC
       LIMIT 1`,
      [defaultEgressSecurityGroupId(input.tenantId), input.tenantId],
    );
    return fallback.rowCount ? mapEgressVersion(fallback.rows[0]) : null;
  }

  async listWorkspaceEgressSecurityGroupAssignments(input: { tenantId: string; securityGroupId: string }) {
    const result = await this.pool.query(
      `SELECT workspace.subject_id,workspace.grant_id
       FROM workspaces workspace
       LEFT JOIN workspace_egress_security_group_assignments assignment
         ON assignment.tenant_id=workspace.tenant_id
        AND assignment.subject_id=workspace.subject_id
        AND assignment.grant_id=workspace.grant_id
       WHERE workspace.tenant_id=$1
         AND (
           assignment.security_group_id=$2
           OR (
             assignment.security_group_id IS NULL
             AND $2=$3
           )
         )
       ORDER BY workspace.subject_id,workspace.grant_id`,
      [input.tenantId, input.securityGroupId, defaultEgressSecurityGroupId(input.tenantId)],
    );
    return result.rows.map((row) => ({
      subjectId: String(row.subject_id),
      grantId: String(row.grant_id),
    }));
  }

  async assignWorkspaceEgressSecurityGroup(input: { tenantId: string; subjectId: string; grantId: string; assignedBy: string; securityGroupVersionId: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query(
        "SELECT id FROM users WHERE id=$1 AND tenant_id=$2",
        [input.subjectId, input.tenantId],
      );
      if (!target.rowCount) throw new LemmaComputerError("USER_NOT_FOUND", "Workspace owner not found", 404);
      const version = await client.query(
        `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
         esgv.version AS egress_version,esgv.document AS egress_document,
         esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
         esgv.created_at AS egress_created_at
         FROM egress_security_group_versions esgv
         JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
         WHERE esgv.id=$1 AND esg.tenant_id=$2`,
        [input.securityGroupVersionId, input.tenantId],
      );
      if (!version.rowCount) throw new LemmaComputerError("EGRESS_SECURITY_GROUP_NOT_FOUND", "Security group version not found", 404);
      await client.query(
        `INSERT INTO workspace_egress_security_group_assignments
         (tenant_id,subject_id,grant_id,security_group_id,assigned_by,assigned_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (tenant_id,subject_id,grant_id) DO UPDATE
         SET security_group_id=EXCLUDED.security_group_id,
             assigned_by=EXCLUDED.assigned_by,
             assigned_at=now()`,
        [input.tenantId, input.subjectId, input.grantId, version.rows[0].security_group_id, input.assignedBy],
      );
      await client.query("COMMIT");
      return mapEgressVersion(version.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async assignEgressSecurityGroup(input: { tenantId: string; targetUserId: string; assignedBy: string; securityGroupVersionId: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-assignment:${input.tenantId}:${input.targetUserId}`]);
      const target = await client.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2", [input.targetUserId, input.tenantId]);
      if (!target.rowCount) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
      const groupVersion = await client.query(
        `SELECT esgv.id FROM egress_security_group_versions esgv
         JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
         WHERE esgv.id=$1 AND esg.tenant_id=$2`,
        [input.securityGroupVersionId, input.tenantId],
      );
      if (!groupVersion.rowCount) throw new LemmaComputerError("EGRESS_SECURITY_GROUP_NOT_FOUND", "Network security group version not found", 404);
      const current = await client.query(
        `SELECT id,tenant_id,user_id,agent_id,policy_version_id
         FROM policy_assignments WHERE user_id=$1 AND tenant_id=$2 AND revoked_at IS NULL
         ORDER BY assigned_at DESC LIMIT 1 FOR UPDATE`,
        [input.targetUserId, input.tenantId],
      );
      if (!current.rowCount) throw new LemmaComputerError("POLICY_ASSIGNMENT_NOT_FOUND", "Assign a workspace policy before attaching a network security group", 409);
      const assignment = current.rows[0];
      await client.query("UPDATE policy_assignments SET revoked_at=now(),revoked_by=$2 WHERE id=$1", [assignment.id, input.assignedBy]);
      const replacementId = randomUUID();
      await client.query(
        `INSERT INTO policy_assignments (id,tenant_id,user_id,agent_id,policy_version_id,egress_security_group_version_id,assigned_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [replacementId, assignment.tenant_id, assignment.user_id, assignment.agent_id, assignment.policy_version_id, input.securityGroupVersionId, input.assignedBy],
      );
      await client.query(
        "INSERT INTO capability_assignments (policy_assignment_id,capability_id) SELECT $1,capability_id FROM capability_assignments WHERE policy_assignment_id=$2",
        [replacementId, assignment.id],
      );
      const result = await client.query(effectivePolicySelect, [input.targetUserId]);
      await client.query("COMMIT");
      return mapPolicy(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async ensurePolicyFoundation(client: pg.PoolClient, tenantId: string, createdBy: string) {
    const bundleId = mvpPolicyBundleId(tenantId);
    await client.query("INSERT INTO policy_bundles (id,tenant_id,display_name) VALUES ($1,$2,'MVP standard workspace') ON CONFLICT DO NOTHING", [bundleId, tenantId]);
    for (const capability of [
      ["ai-assistant", "AI assistant", "standard"],
      ["coding-tools", "Coding tools", "standard"],
      ["m365-read", "Microsoft 365 read", "standard"],
      ["m365-write-protected", "Microsoft 365 protected writes", "protected"],
    ]) {
      await client.query("INSERT INTO capabilities (id,display_name,risk) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", capability);
    }
    const document = mvpPolicyDocument();
    await client.query(
      `INSERT INTO policy_versions (id,policy_bundle_id,version,document,document_hash,created_by)
       VALUES ($1,$2,1,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING`,
      [randomUUID(), bundleId, JSON.stringify(document), policyHash(document), createdBy],
    );
    const egressDocument = defaultEgressDocument();
    const securityGroupId = defaultEgressSecurityGroupId(tenantId);
    const securityGroupVersionId = defaultEgressSecurityGroupVersionId(tenantId);
    await client.query(
      `INSERT INTO egress_security_groups (id,tenant_id,name,description,created_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [securityGroupId, tenantId, egressDocument.name, egressDocument.description, createdBy],
    );
    await client.query(
      `INSERT INTO egress_security_group_versions (id,security_group_id,version,document,document_hash,created_by)
       VALUES ($1,$2,1,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING`,
      [securityGroupVersionId, securityGroupId, JSON.stringify(egressDocument), policyHash(egressDocument), createdBy],
    );
    await client.query(
      `UPDATE policy_assignments pa SET egress_security_group_version_id=$2
       WHERE pa.tenant_id=$1
       AND pa.revoked_at IS NULL AND pa.egress_security_group_version_id IS NULL`,
      [tenantId, securityGroupVersionId],
    );
  }

  private async ensureDefaultSpendingTeamFoundation(
    client: pg.PoolClient,
    tenantId: string,
    userId: string,
    assignedBy: string,
    effectiveFrom = new Date(),
  ) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`default-spending-team-foundation:${tenantId}`],
    );
    let team = await client.query(
      `SELECT id FROM allocation_units
       WHERE tenant_id=$1 AND allocation_type='team' AND status='active'
         AND is_rollout_fallback=false
       ORDER BY created_at,id LIMIT 1`,
      [tenantId],
    );
    if (!team.rowCount) {
      const teamId = randomUUID();
      team = await client.query(
        `INSERT INTO allocation_units(
           id,tenant_id,allocation_type,display_name,description,owner_user_id,
           cost_center_code,status,is_rollout_fallback,created_by,updated_by
         ) VALUES($1,$2,'team','Everyone','Default organization-wide spending and routing team',$3,
           NULL,'active',false,$4,$4)
         RETURNING id`,
        [teamId, tenantId, userId, assignedBy],
      );
    }
    const teamId = String(team.rows[0].id);
    await client.query(
      `INSERT INTO allocation_memberships(
         id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by
       ) SELECT $1,$2,$3,$4,$5,$6
       WHERE NOT EXISTS(
         SELECT 1 FROM allocation_memberships
         WHERE tenant_id=$2 AND allocation_unit_id=$3 AND user_id=$4 AND effective_to IS NULL
       )`,
      [randomUUID(), tenantId, teamId, userId, effectiveFrom, assignedBy],
    );
    await client.query(
      `INSERT INTO default_spending_team_assignments(
         id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by
       ) SELECT $1,$2,$3,$4,$5,$6
       WHERE NOT EXISTS(
         SELECT 1 FROM default_spending_team_assignments
         WHERE tenant_id=$2 AND user_id=$4 AND effective_to IS NULL
       )`,
      [randomUUID(), tenantId, teamId, userId, effectiveFrom, assignedBy],
    );
  }

  private async assignMvpPolicyWithClient(client: pg.PoolClient, tenantId: string, targetUserId: string, assignedBy: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-assignment:${tenantId}:${targetUserId}`]);
    const owned = await client.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2", [targetUserId, tenantId]);
    if (!owned.rowCount) throw new Error("Policy target is outside the tenant");
    await this.ensurePolicyFoundation(client, tenantId, assignedBy);
    // The per-user advisory lock above serializes assignment changes. Do not
    // append FOR UPDATE here: effectivePolicySelect contains nullable outer
    // joins, which PostgreSQL correctly refuses to lock as a single rowset.
    const existing = await client.query(effectivePolicySelect, [targetUserId]);
    if (existing.rowCount) return mapPolicy(existing.rows[0]);
    const resources = await client.query(
      `SELECT a.id AS agent_id,pv.id AS policy_version_id
       FROM agent_identities a
       CROSS JOIN LATERAL (SELECT id FROM policy_versions WHERE policy_bundle_id=$2 ORDER BY version DESC LIMIT 1) pv
       WHERE a.owner_user_id=$1 AND a.status='active' LIMIT 1`,
      [targetUserId, mvpPolicyBundleId(tenantId)],
    );
    if (!resources.rowCount) throw new Error("Policy target agent identity is missing");
    const assignmentId = randomUUID();
    await client.query(
      `INSERT INTO policy_assignments (id,tenant_id,user_id,agent_id,policy_version_id,egress_security_group_version_id,assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [assignmentId, tenantId, targetUserId, resources.rows[0].agent_id, resources.rows[0].policy_version_id, defaultEgressSecurityGroupVersionId(tenantId), assignedBy],
    );
    await client.query(
      "INSERT INTO capability_assignments (policy_assignment_id,capability_id) SELECT $1,id FROM capabilities ON CONFLICT DO NOTHING",
      [assignmentId],
    );
    const result = await client.query(effectivePolicySelect, [targetUserId]);
    return mapPolicy(result.rows[0]);
  }
}
