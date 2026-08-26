import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { LogController } from "fastify";
import { anthropicProviderModelIdSchema, assignEgressSecurityGroupSchema, assignTeamMembershipSchema, bedrockApiKeyModelProfileIdSchema, bedrockApiKeyRegionSchema, channelArtifactDownloadRequestSchema, channelArtifactMaxBytes, channelRouteSchema, channelTurnRequestSchema, channelTurnResponseSchema, channelTurnStreamEventSchema, chatAgentCatalogIdSchema, chatPartIdSchema, chatSessionIdSchema, createChatSessionSchema, createScheduleSchema, createTeamSchema, deleteWorkspaceSchema, egressSecurityGroupVersionSchema, executeScheduleRunSchema, glmProviderModelIdSchema, isWorkspaceSelectableAgentCatalogId, LemmaComputerError, recentAuthenticationStepUpWindowMs, TelegramTokenIntakeGrantIssuer, createDeleteFileOperationSchema, createWorkspaceSchema, fixtureApprovalSchema, identityContextSchema, mcpPolicyRequestSchema, openAiProviderModelIdSchema, ownedAgentCatalog, providerEmissionsRegionSchema, reviewedAgentSkillCatalog, policyVerificationKeySetSchema, runtimePolicySchema, saveEgressSecurityGroupSchema, saveHostedConnectorToolPolicySchema, saveMcpToolPolicySchema, saveTelegramChannelConnectionSchema, saveTelegramCredentialSchema, telegramTokenIntakePath, telegramTokenIntakeGrantSchema, sandboxApplicationSchema, sandboxConfigurationSchema, sandboxProfileSchema, sandboxSettingsSchema, saveSandboxSettingsSchema, sendChatTurnSchema, setDefaultSpendingTeamSchema, telegramChannelConnectionStatusSchema, toolAuditTerminalInputSchema, updateScheduleSchema, updateTeamSchema, workspaceManifestAgentIdFor, workspaceManifestChatAgentIdFor, workspaceManifestSchema, type AgentCatalogId, type AgentChatEvent, type ChannelRoute, type ChatUiMessage, type EgressSecurityGroupVersion, type IdentityContext, type RuntimePolicy, type SandboxApplicationId, type SandboxModelAlias, type SandboxProfileId, type SandboxConfiguration, type TelegramChannelConnectionStatus, type WorkspaceManifest, type WorkspaceState } from "@lemmacomputer/contracts";
import { organizationWorkspacePolicyConstraintsSchema, type OrganizationWorkspacePolicyConstraints } from "@lemmacomputer/contracts";
import { createMutualTlsFetch, LiteLLMGatewayAdapter, LiteLLMProviderAdministration, LiteLlmTeamBudgetProjector, managedProviderForAlias, type GatewayClient, type GovernedToolExecutor, type ManagedProviderName, type OAuthConnectionGateway, type ProviderAdministrationGateway } from "@lemmacomputer/litellm-adapter";
import {qualifiedAgentReasoningAdapter,RoutingDecisionBindingAuthority} from "@lemmacomputer/model-router";
import { PostgresAuthenticationStore } from "@lemmacomputer/auth-store";
import { FilesystemArtifactStore, S3ArtifactStore, type ArtifactStore } from "@lemmacomputer/artifact-store";
import { PolicyBundleSigner } from "@lemmacomputer/policy-integrity";
import { hasOrganizationPermission, organizationPermissionCatalog, organizationPermissionCatalogVersion, organizationPermissions, permissionsByOrganizationRole, PostgresAgentInstanceStore, PostgresChatStore, PostgresConnectorRegistryStore, PostgresIdentityPolicyStore, PostgresPlatformOperatorStore, PostgresProviderSettingsStore, PostgresRoutingStore, PostgresScheduleStore, PostgresSiteStore, PostgresTeamBudgetStore, PostgresTeamStore, PostgresToolAuditStore, PostgresWorkspaceStore, runtimePolicyFor, type ActivityEventScope, type ActivityStore, type AgentInstanceStore, type ChannelStore, type ChatConversationRecord, type ChatStore, type ConnectorRegistryStore, type EffectivePolicy, type GovernanceStore, type IdentityPolicyStore, type OrganizationPermission, type OrganizationResourceScope, type OrganizationResourceScopeType, type PlatformOperatorSession, type ProviderSettingsStore, type RoutingStore, type ScheduleStore, type SessionPrincipal, type SiteStore, type TeamBudgetStore, type TeamStore, type ToolAuditStore, type WorkspaceStore } from "@lemmacomputer/workspace-store";
import { PostgresProtectedWorkspacePolicyStore, type OrganizationWorkspacePolicyVersionRecord } from "@lemmacomputer/workspace-store";
import { compileEgressSecurityGroup } from "@lemmacomputer/egress-policy";
import { WorkspaceIngressAuthority } from "@lemmacomputer/workspace-ingress-auth";
import { PostgresSpendObservabilityStore, SpendReadLimitError, spendReportCsv, type SpendObservabilityStore } from "@lemmacomputer/workspace-store";
import { z } from "zod";
import postgres from "pg";
import { BudgetUsageAttemptAdmission, PostgresUsageLedgerStore, type RateAmount, type UsageAttemptAdmissionHook } from "@lemmacomputer/workspace-store";
import { FixtureApprovalAuthority, GovernedOperationService } from "./operations.js";
import { McpConnectionService } from "./connections.js";
import { MicrosoftSharePointSitePermissionClient, type MicrosoftSharePointSitePermissionGateway } from "./microsoft-sharepoint-site-permissions.js";
import { isStaticCredentialGroup, type StaticCredentialGroup } from "./connector-catalog.js";
import { ToolAuditService } from "./tool-audit.js";
import { resolveConnectorPolicyApplication, resolveEffectiveConnectorPolicy } from "./connector-policy-administration.js";
import { ProviderSettingsService } from "./provider-settings.js";
import { EgressProxyGrantAuthority, HttpControllerClient, PolicyBundleAuthority, RoutedControllerClient, WorkspaceService, type ControllerClient } from "./service.js";
import { McpPolicyService, m365CapabilityDefinitions, resumableUploadCapability } from "./mcp-policy.js";
import { OpenVtcApprovalCoordinator } from "./openvtc.js";
import { HttpOpenVtcConsentClient } from "./openvtc-consent-client.js";
import { AgentBridgeAuthority, agentBridgeAudience, type AgentBridgeIdentity, type AgentBridgeScope } from "./agent-bridge.js";
import { COMPANION_PUSH_PROTOCOL, WebPushProvider } from "./web-push.js";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  AgentChatAuthority,
  AgentMessageAccumulator,
  AgentUiStreamMapper,
  HttpAgentChatClient,
  assignedChatAgentIds,
  chatApprovalSummary,
  reconcileChatMessages,
  type AgentChatClient,
} from "./agent-chat.js";
import { DurableChatService } from "./durable-chat.js";
import { HttpChannelBrokerManagementClient, type ChannelBrokerManagementClient } from "./channel-broker.js";
import { SchedulePromptVault, ScheduleService } from "./schedules.js";
import { BudgetUsageEventRecordedHook, budgetOverrideSchema, saveTeamBudgetSchema, TeamBudgetAdministrationService } from "./budgets.js";
import { ActivityEventService, activitySseFrame } from "./activity.js";
import { SitesService } from "./sites.js";
import { AgentProcessLifecycleService, callerSuppliedAgentInstanceId } from "./agent-process-lifecycle.js";
import { UsageLedgerService,UsageTaskBindingAuthority,adminRateCardSchema,adminReconciliationSchema,adminUsageQuerySchema,decodeUsageCursor,encodeUsageCursor,internalUsageAdmissionSchema,internalUsageCompletionSchema } from "./usage-ledger.js";
import { assertHostedLiteLlmAdminSecurity } from "./litellm-admin-security.js";
import {RoutingAdministrationService,RoutingExecutionService,createRoutingMappingSchema,internalRoutingDecisionSchema,internalRoutingObservationSchema} from "./routing.js";
import { createCustomerAuthentication, createCustomerSsoAuthentication, customerAuthenticationBasePath, customerAuthenticationControlPath, parseVersionedBetterAuthSecrets, registerCustomerAuthenticationRoutes, type CustomerAuthentication } from "./customer-authentication.js";
import { CaptureTransactionalEmailAdapter, createTransactionalEmailAdapter, deliverOrganizationInvitationEmail, type TransactionalEmailAdapter } from "./transactional-email.js";
import {
  customerInvitationContextMaxAgeSeconds,
  createBetterAuthSessionReader,
  CustomerProductAuthenticationService,
  type CustomerProductAuthenticationResolution,
} from "./customer-product-authentication.js";
import { fromNodeHeaders } from "better-auth/node";
import { registerPlatformOperatorRoutes, type PlatformOperatorAuthenticationBoundary, type PlatformOperatorStoreBoundary } from "./platform-operator-routes.js";
import {
  BetterAuthPlatformOperatorAuthenticationService,
  createPlatformAuthentication,
  platformAuthenticationControlPath,
  registerPlatformAuthenticationRoutes,
  worktreePlatformOperatorBootstrap,
  type PlatformAuthentication,
  type PlatformOperatorBootstrap,
} from "./platform-better-authentication.js";
import { PlatformSecurityAlertDispatcher, SignedWebhookPlatformSecurityAlertAdapter, type PlatformSecurityAlertDispatcherStatus } from "./platform-security-alert-dispatcher.js";
import { ControlPlaneTenantCleanupAdapter, PlatformTenantCleanupDispatcher, type PlatformTenantCleanupDispatcherStatus } from "./platform-tenant-cleanup-dispatcher.js";
import { createBetterAuthTenantSsoAuthenticationAdministration, TenantSsoAdministrationService } from "./tenant-sso.js";
import {
  ProtectedWorkspacePolicyAdministrationService,
  type ProtectedWorkspacePolicyAdministrationBoundary,
} from "./protected-workspace-policy.js";

import { paginateSpendReport, parseSpendQuery, parseUnpricedUsageAcknowledgement } from "./spend-observability.js";
import { parsePersonalAiUsageQuery, personalAiUsageReport } from "./personal-ai-usage.js";
type CustomerProductAuthenticationBoundary = Pick<
  CustomerProductAuthenticationService,
  "resolve" | "selectMembership" | "createOrganization" | "createPersonalTenant" | "prepareInvitation" | "getInvitationContext" | "getInvitationSsoContext" | "acceptInvitation"
  | "recordRecentStepUp" | "requireRecentStepUp" | "revokeCurrentSession" | "clearCurrentOrganizationSelection"
>;
type TenantSsoAdministrationBoundary = Pick<
  TenantSsoAdministrationService,
  "list" | "register" | "requestDomainVerification" | "verifyDomain" | "startTest" | "completeTest" | "startEnforcedSignIn" | "startInvitationSignIn" | "transition"
  | "rotateCredentials" | "refreshMetadata" | "disconnect"
> & Partial<Pick<TenantSsoAdministrationService, "isInvitationSignInAvailable">>;

const testPrincipalFromHeaders = (headers: Record<string, unknown>): SessionPrincipal => {
  const tenantId = String(headers["x-lemmacomputer-test-tenant-id"] ?? "test-tenant");
  const userId = String(headers["x-lemmacomputer-test-user-id"] ?? "test-user");
  return {
    userId,
    tenantId,
    organizationId: tenantId,
    membershipId: `test-membership:${tenantId}:${userId}`,
    membershipStatus: "active",
    role: "owner",
    email: `${userId}@example.test`,
    displayName: userId,
    tenantDisplayName: tenantId,
    tenantKind: "organization",
    roles: ["owner", "administrator"],
    identity: { tenantId, subjectId: userId, audience: "lemmacomputer-control" },
  };
};

const invitationContextCookieName = "lemmacomputer_invitation_context";
const invitationContextFromCookie = (header: string | undefined) => {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== invitationContextCookieName) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ""; }
  }
  return "";
};

const workspaceMemoryGiB = 4;

const sandboxProfiles = [
  sandboxProfileSchema.parse({
    id: "claude-desktop-standard-v1",
    version: 1,
    displayName: "Restricted workspace",
    description: "A restricted workspace for any selected AI agent, routed through organization-approved models, tools, and destinations.",
    executionMode: "managed",
    egressMode: "restricted",
    dataGuidance: "Use for organization work. Local tools and public destinations remain policy restricted.",
    client: "LemmaComputer managed workspace",
    clientVersion: "managed-v1",
    persistence: "persistent-home",
    network: "gateway-only",
    resources: { cpus: 2, memoryGiB: workspaceMemoryGiB },
  }),
  sandboxProfileSchema.parse({
    id: "kasm-persistent-standard",
    version: 1,
    displayName: "Qualification workspace (legacy)",
    description: "The earlier CLI qualification image retained only for pinned policy compatibility.",
    executionMode: "managed",
    egressMode: "restricted",
    dataGuidance: "Use only for existing qualification workspaces.",
    client: "LemmaComputer qualification CLI",
    clientVersion: "issue-006",
    persistence: "persistent-home",
    network: "gateway-only",
    resources: { cpus: 2, memoryGiB: workspaceMemoryGiB },
  }),
  sandboxProfileSchema.parse({
    id: "disposable-open-v1",
    version: 1,
    displayName: "Internet workspace",
    description: "A flexible workspace with local coding tools and public internet access inside the isolated workspace boundary.",
    executionMode: "disposable-open",
    egressMode: "full-web",
    dataGuidance: "Non-sensitive work only. Downloads and installed tools are untrusted; Delete permanently removes the workspace.",
    client: "LemmaComputer open workspace",
    clientVersion: "disposable-open-v1",
    persistence: "persistent-home",
    network: "gateway-only",
    resources: { cpus: 2, memoryGiB: workspaceMemoryGiB },
  }),
] as const;

const sandboxModels = [
  { alias: "lemmacomputer-auto", displayName: "Governed routing", provider: "LemmaComputer" },
  { alias: "lemmacomputer-claude", displayName: "Claude", provider: "Anthropic" },
  { alias: "lemmacomputer-openai", displayName: "OpenAI", provider: "OpenAI" },
  { alias: "lemmacomputer-glm", displayName: "GLM", provider: "Z.ai" },
  { alias: "lemmacomputer-bedrock", displayName: "Claude Sonnet 4.5", provider: "Amazon Bedrock" },
  { alias: "lemmacomputer-assistant", displayName: "Standard route (legacy)", provider: "OpenAI" },
] as const;

const workspaceServiceClasses = [
  { value: "lite", displayName: "Lite", description: "Fast, economical work." },
  { value: "balanced", displayName: "Balanced", description: "Everyday reasoning and tool use." },
  { value: "pro", displayName: "Pro", description: "Highest capability for complex work." },
] as const;
type ExplicitWorkspaceServiceClass = typeof workspaceServiceClasses[number]["value"];
const explicitWorkspaceServiceClassValues = new Set<string>(workspaceServiceClasses.map(({ value }) => value));
const assignedWorkspaceServiceClasses = (document: Record<string, unknown>): ExplicitWorkspaceServiceClass[] => {
  if (!Array.isArray(document.serviceClasses)) return workspaceServiceClasses.map(({ value }) => value);
  const assigned = document.serviceClasses.filter(
    (value): value is ExplicitWorkspaceServiceClass => explicitWorkspaceServiceClassValues.has(String(value)),
  );
  if (document.serviceClasses.includes("auto") && !assigned.includes("balanced")) assigned.push("balanced");
  return assigned;
};
const explicitWorkspaceServiceClass = (
  value: unknown,
  assigned: ExplicitWorkspaceServiceClass[],
): ExplicitWorkspaceServiceClass | null => (
  typeof value === "string" && explicitWorkspaceServiceClassValues.has(value) && assigned.includes(value as ExplicitWorkspaceServiceClass)
    ? value as ExplicitWorkspaceServiceClass
    : assigned.includes("balanced") ? "balanced" : assigned[0] ?? null
);

const sandboxApplications = [
  sandboxApplicationSchema.parse({
    id: "firefox",
    displayName: "Firefox ESR",
    category: "Browser",
    version: "140.12.0esr",
    description: "Managed browser locked to the governed egress proxy.",
  }),
  sandboxApplicationSchema.parse({
    id: "google-chrome",
    displayName: "Google Chrome",
    category: "Browser",
    version: "151.0.7922.137",
    description: "Pinned Chrome browser locked to the governed egress proxy.",
  }),
  sandboxApplicationSchema.parse({
    id: "visual-studio-code",
    displayName: "Visual Studio Code",
    category: "Development",
    version: "1.133.0",
    description: "Pinned editor available only when assigned by workspace policy.",
  }),
  sandboxApplicationSchema.parse({
    id: "obsidian",
    displayName: "Obsidian",
    category: "Knowledge",
    version: "1.13.7",
    description: "Pinned local knowledge workspace available only when assigned by workspace policy.",
  }),
] as const;

const assignedApplicationIds = (document: Record<string, unknown>): SandboxApplicationId[] => {
  const configured = Array.isArray(document.applications)
    ? document.applications.filter((item): item is SandboxApplicationId => sandboxApplications.some((application) => application.id === item))
    : ["firefox"] as SandboxApplicationId[];
  return configured;
};

const defaultApplicationIds = (document: Record<string, unknown>, assigned = assignedApplicationIds(document)): SandboxApplicationId[] => {
  const configured = Array.isArray(document.defaultApplications)
    ? document.defaultApplications.filter((item): item is SandboxApplicationId => assigned.includes(item as SandboxApplicationId))
    : assigned;
  return configured.length ? configured : assigned.length ? [assigned[0]!] : [];
};

const assignedAgentIds = (document: Record<string, unknown>): AgentCatalogId[] => {
  const configured = Array.isArray(document.agents)
    ? document.agents.filter((item): item is AgentCatalogId => isWorkspaceSelectableAgentCatalogId(item) && ownedAgentCatalog.some((agent) => agent.id === item))
    : [{
      "claude-cli-managed-v1": "claude-cli",
      "codex-cli-managed-v1": "codex-cli",
      "hermes-claw-managed-v1": "hermes-claw",
    }[String(document.agentProfile)] ?? "claude-desktop"]
      .filter(isWorkspaceSelectableAgentCatalogId) as AgentCatalogId[];
  return configured.length ? configured : ["claude-desktop"];
};

const defaultAgentIds = (document: Record<string, unknown>, assigned = assignedAgentIds(document)): AgentCatalogId[] => {
  const configured = Array.isArray(document.defaultAgents)
    ? document.defaultAgents.filter((item): item is AgentCatalogId => assigned.includes(item as AgentCatalogId))
    : assigned;
  return configured.length ? configured : assigned.length ? [assigned[0]!] : [];
};

export type CompatibleSandboxSelection = {
  profileId: SandboxProfileId;
  applicationIds: SandboxApplicationId[];
  modelAlias: SandboxModelAlias | null;
  requestedServiceClass: ExplicitWorkspaceServiceClass;
  allowedServiceClasses: ExplicitWorkspaceServiceClass[];
  agentIds: AgentCatalogId[];
  changed: boolean;
};

export const compatibleSandboxSelection = (
  document: Record<string, unknown>,
  saved: Awaited<ReturnType<NonNullable<WorkspaceStore["getSandboxSettings"]>>> | null | undefined,
  publishedServiceClasses: readonly ExplicitWorkspaceServiceClass[] | null,
): CompatibleSandboxSelection | null => {
  const profiles = Array.isArray(document.workspaceProfiles)
    ? document.workspaceProfiles.filter((value): value is SandboxProfileId => sandboxProfiles.some((profile) => profile.id === value))
    : typeof document.workspaceProfile === "string" && sandboxProfiles.some((profile) => profile.id === document.workspaceProfile)
      ? [document.workspaceProfile as SandboxProfileId]
      : [];
  const applications = assignedApplicationIds(document);
  const agents = assignedAgentIds(document);
  const models = Array.isArray(document.modelAliases)
    ? document.modelAliases.filter((value): value is SandboxModelAlias => sandboxModels.some((model) => model.alias === value))
    : ["lemmacomputer-assistant"] as SandboxModelAlias[];
  const assignedServiceClasses = assignedWorkspaceServiceClasses(document);
  const serviceClasses = publishedServiceClasses === null
    ? assignedServiceClasses
    : assignedServiceClasses.filter((serviceClass) => publishedServiceClasses.includes(serviceClass));
  const governedRoutingEnabled = publishedServiceClasses !== null;
  const governedRoutingAvailable = Boolean(publishedServiceClasses?.length);
  const profileId = saved
    ? profiles.includes(saved.profileId) ? saved.profileId : null
    : profiles[0] ?? null;
  const applicationIds = saved
    ? saved.applicationIds.filter((id) => applications.includes(id))
    : defaultApplicationIds(document, applications);
  const agentIds = governedRoutingEnabled && !governedRoutingAvailable
    ? []
    : saved
      ? saved.agentIds.filter((id) => agents.includes(id))
      : defaultAgentIds(document, agents);
  const modelAlias = agentIds.length === 0
    ? null
    : governedRoutingEnabled
      ? governedRoutingAvailable ? "lemmacomputer-auto" as const : null
      : saved?.modelAlias && models.includes(saved.modelAlias)
          ? saved.modelAlias
          : models[0] ?? null;
  const requestedServiceClass = serviceClasses.length
    ? saved
      ? saved.requestedServiceClass === undefined
        ? explicitWorkspaceServiceClass(document.defaultServiceClass, serviceClasses)
        : serviceClasses.includes(saved.requestedServiceClass as ExplicitWorkspaceServiceClass)
          ? saved.requestedServiceClass as ExplicitWorkspaceServiceClass
          : null
      : explicitWorkspaceServiceClass(document.defaultServiceClass, serviceClasses)
    : agentIds.length === 0
      ? saved && assignedServiceClasses.includes(saved.requestedServiceClass as ExplicitWorkspaceServiceClass)
        ? saved.requestedServiceClass as ExplicitWorkspaceServiceClass
        : explicitWorkspaceServiceClass(document.defaultServiceClass, assignedServiceClasses)
      : null;
  if (!profileId || (agentIds.length > 0 && !modelAlias) || !requestedServiceClass) return null;
  return {
    profileId,
    applicationIds,
    modelAlias,
    requestedServiceClass,
    allowedServiceClasses: serviceClasses,
    agentIds,
    changed: Boolean(saved && (
      saved.profileId !== profileId
      || saved.modelAlias !== modelAlias
      || saved.requestedServiceClass !== requestedServiceClass
      || saved.applicationIds.length !== applicationIds.length
      || saved.applicationIds.some((id, index) => id !== applicationIds[index])
      || saved.agentIds.length !== agentIds.length
      || saved.agentIds.some((id, index) => id !== agentIds[index])
    )),
  };
};

export const shouldPersistCompatibleSandboxSelection = (
  selection: CompatibleSandboxSelection,
  publishedServiceClasses: readonly ExplicitWorkspaceServiceClass[] | null,
) => selection.changed && publishedServiceClasses?.length !== 0;

const constrainAssigned = <T extends string>(
  configured: unknown,
  constraint: { allow?: readonly T[]; deny: readonly T[] } | undefined,
): T[] => {
  const values = Array.isArray(configured)
    ? configured.filter((value): value is T => typeof value === "string")
    : [];
  if (!constraint) return values;
  const allowed = constraint.allow ?? values;
  return values.filter((value) => allowed.includes(value) && !constraint.deny.includes(value));
};

export const constrainEffectivePolicy = (
  policy: EffectivePolicy,
  organizationPolicy: OrganizationWorkspacePolicyVersionRecord,
): EffectivePolicy => {
  const document = policy.document as Record<string, unknown>;
  const constraints: OrganizationWorkspacePolicyConstraints = organizationPolicy.constraints;
  const workspaceProfiles = constrainAssigned(document.workspaceProfiles, constraints.workspaceProfiles);
  const agents = constrainAssigned(document.agents, constraints.agents).filter(isWorkspaceSelectableAgentCatalogId);
  const applications = constrainAssigned(document.applications, constraints.applications);
  const modelAliases = constrainAssigned(document.modelAliases, constraints.modelAliases);
  const capabilities = constrainAssigned(document.capabilities, constraints.capabilities);
  const serviceClasses = constrainAssigned(assignedWorkspaceServiceClasses(document), constraints.serviceClasses);
  const constrainedAgentIds = new Set<string>(agents);
  const defaultAgents = defaultAgentIds(document, agents as AgentCatalogId[]).filter((id) => constrainedAgentIds.has(id));
  const defaultApplications = defaultApplicationIds(document, applications as SandboxApplicationId[]).filter((id) => applications.includes(id));
  const configuredDefaultServiceClass = explicitWorkspaceServiceClass(document.defaultServiceClass, serviceClasses as ExplicitWorkspaceServiceClass[]);
  const mcp = structuredClone((document.mcp ?? {}) as Record<string, unknown>);
  const servers = (mcp.servers ?? {}) as Record<string, unknown>;
  const microsoft365 = servers.lemmacomputer_ms365 as Record<string, unknown> | undefined;
  const organizationToolPolicies = constraints.connectors?.toolPolicies["microsoft-365"];
  if (microsoft365 && organizationToolPolicies) {
    const configuredTools = Array.isArray(microsoft365.tools) ? microsoft365.tools.filter((tool): tool is string => typeof tool === "string") : [];
    const configuredDecisions = (microsoft365.toolPolicies ?? {}) as Record<string, "allow" | "approval_required" | "deny">;
    const rank = { allow: 0, approval_required: 1, deny: 2 } as const;
    microsoft365.toolPolicies = Object.fromEntries(configuredTools.map((tool) => {
      const configured = configuredDecisions[tool] ?? "deny";
      const maximum = organizationToolPolicies[tool] ?? configured;
      return [tool, rank[configured] >= rank[maximum] ? configured : maximum];
    }));
  }
  const configuredClipboard = document.clipboard && typeof document.clipboard === "object" && !Array.isArray(document.clipboard)
    ? document.clipboard as Record<string, unknown>
    : {};
  const organizationConnectorIds = constraints.connectors
    ? constrainAssigned(["microsoft-365"], constraints.connectors)
    : undefined;
  return {
    ...policy,
    policyVersionId: organizationPolicy.policyVersionId,
    version: organizationPolicy.version,
    documentHash: organizationPolicy.documentHash,
    document: {
      ...document,
      workspaceProfiles,
      workspaceProfile: workspaceProfiles.some((profile) => profile === document.workspaceProfile) ? document.workspaceProfile : workspaceProfiles[0],
      agents,
      defaultAgents,
      applications,
      defaultApplications,
      modelAliases,
      capabilities,
      clipboard: {
        ...configuredClipboard,
        ...constraints.clipboard,
        enabled: (constraints.clipboard?.localToWorkspace ?? configuredClipboard.localToWorkspace ?? true)
          || (constraints.clipboard?.workspaceToLocal ?? configuredClipboard.workspaceToLocal ?? true),
      },
      mcp,
      serviceClasses,
      defaultServiceClass: configuredDefaultServiceClass,
      ...(constraints.maximumReasoningEffort ? { maximumReasoningEffort: constraints.maximumReasoningEffort } : {}),
      ...(constraints.maximumEgressMode ? { maximumEgressMode: constraints.maximumEgressMode } : {}),
      ...(organizationConnectorIds ? { organizationConnectorIds } : {}),
      organizationPolicyVersionId: organizationPolicy.policyVersionId,
      organizationPolicyHash: organizationPolicy.documentHash,
    } as unknown as EffectivePolicy["document"],
  };
};

const optionalEnvString = (minimum = 1) => z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(minimum).optional(),
);

const createConnectorSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  shortDescription: z.string().trim().min(3).max(140),
  description: z.string().trim().min(3).max(600),
  category: z.enum(["Productivity", "Search", "Developer tools", "Business", "Communication", "Data and analytics", "Other"]),
  services: z.array(z.string().trim().min(1).max(80)).max(16).default([]),
  endpointUrl: z.string().url().max(2048),
  scopes: z.array(z.string().trim().min(1).max(160)).max(64).default([]),
  iconDataUrl: z.string().max(350000).optional(),
  clientId: z.string().trim().min(1).max(512).optional(),
  clientSecret: z.string().min(1).max(4096).optional(),
  discoveryToken: z.string().min(32).max(256).optional(),
});

const connectorIconSchema = z.strictObject({
  iconDataUrl: z.string().max(350000).nullable(),
});
const providerNameSchema = z.enum(["openai", "anthropic", "glm", "bedrock"]);
const saveProviderApiKeySchema = z.strictObject({
  apiKey: z.string().trim().min(8).max(4096),
  emissionsRegion: providerEmissionsRegionSchema.optional(),
});
const uniqueModelIds = <T extends string>(modelIds: T[]) => new Set(modelIds).size === modelIds.length;
const saveOpenAiProviderApiKeySchema = z.union([
  saveProviderApiKeySchema.extend({ modelId: openAiProviderModelIdSchema }),
  saveProviderApiKeySchema.extend({
    modelIds: z.array(openAiProviderModelIdSchema).min(1).max(3)
      .refine(uniqueModelIds, "Provider model selections must be unique"),
  }),
]);
const saveAnthropicProviderApiKeySchema = z.union([
  saveProviderApiKeySchema.extend({ modelId: anthropicProviderModelIdSchema }),
  saveProviderApiKeySchema.extend({
    modelIds: z.array(anthropicProviderModelIdSchema).min(1).max(2)
      .refine(uniqueModelIds, "Provider model selections must be unique"),
  }),
]);
const saveGlmProviderApiKeySchema = z.union([
  saveProviderApiKeySchema.extend({ modelId: glmProviderModelIdSchema }),
  saveProviderApiKeySchema.extend({
    modelIds: z.array(glmProviderModelIdSchema).min(1).max(2)
      .refine(uniqueModelIds, "Provider model selections must be unique"),
  }),
]);
const saveBedrockProviderApiKeySchema = z.strictObject({
  apiKey: z.string().trim().min(8).max(4096),
  region: bedrockApiKeyRegionSchema,
  modelProfileId: bedrockApiKeyModelProfileIdSchema,
  emissionsRegion: providerEmissionsRegionSchema.optional(),
});

const envSchema = z.object({
  CONTROL_HOST: z.string().default("127.0.0.1"),
  CONTROL_PORT: z.coerce.number().int().positive().default(4100),
  WEB_PROXY_TOKEN: z.string().min(24),
  CONTROLLER_URL: z.string().url().default("http://127.0.0.1:4101"),
  WORKSPACE_NODE_TOPOLOGY: z.enum(["colocated", "remote"]).default("colocated"),
  CONTROLLER_INTERNAL_TOKEN: z.string().min(24),
  CONTROLLER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(330_000).default(90_000),
  CONTROLLER_TLS_CA_B64: optionalEnvString(),
  CONTROLLER_TLS_CLIENT_CERT_B64: optionalEnvString(),
  CONTROLLER_TLS_CLIENT_KEY_B64: optionalEnvString(),
  CONTROLLER_TLS_SERVER_NAME: optionalEnvString(),
  DATABASE_URL: z.string().min(1),
  AUTH_DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRETS: z.string().min(1),
  PLATFORM_AUTH_DATABASE_URL: optionalEnvString(),
  PLATFORM_BETTER_AUTH_SECRETS: optionalEnvString(),
  PLATFORM_AUTH_BOOTSTRAP_EMAIL: optionalEnvString(),
  PLATFORM_AUTH_BOOTSTRAP_DISPLAY_NAME: z.string().min(1).default("Platform administrator"),
  PLATFORM_AUTH_BOOTSTRAP_SECRET: optionalEnvString(32),
  BETTER_AUTH_TRUSTED_PROXY_CIDRS: z.string().default(""),
  CUSTOMER_SSO_TRUSTED_IDP_ORIGINS: z.string().default(""),
  AUTH_EMAIL_TRANSPORT: z.enum(["capture", "postmark"]),
  INVITATION_DELIVERY_MODE: z.enum(["email", "copy-link"]),
  RUNTIME_ENVIRONMENT: z.enum(["development", "production"]),
  POSTMARK_SERVER_TOKEN: optionalEnvString(),
  POSTMARK_FROM: optionalEnvString(),
  POSTMARK_MESSAGE_STREAM: z.string().min(1).default("outbound"),
  GOOGLE_AUTH_CLIENT_ID: optionalEnvString(),
  GOOGLE_AUTH_CLIENT_SECRET: optionalEnvString(),
  MICROSOFT_AUTH_CLIENT_ID: optionalEnvString(),
  MICROSOFT_AUTH_CLIENT_SECRET: optionalEnvString(),
  MICROSOFT_AUTH_TENANT_ID: z.string().min(1).default("common"),
  LEMMACOMPUTER_INSTALLATION_KIND: z.enum(["customer-managed", "hosted", "worktree"]).default("customer-managed"),
  LITELLM_ADMIN_URL: z.string().url().optional(),
  LITELLM_ADMIN_TLS_CA_B64: optionalEnvString(),
  LITELLM_ADMIN_TLS_CLIENT_CERT_B64: optionalEnvString(),
  LITELLM_ADMIN_TLS_CLIENT_KEY_B64: optionalEnvString(),
  LITELLM_ADMIN_TLS_SERVER_NAME: optionalEnvString(),
  LITELLM_WORKSPACE_URL: z.string().url().optional(),
  LITELLM_MASTER_KEY: z.string().min(24).optional(),
  LITELLM_CREDENTIAL_SECRET: z.string().min(32).optional(),
  MCP_EGRESS_PROXY_TOKEN: z.string().min(32),
  HOSTED_MCP_EGRESS_ORIGINS: z.string().default(""),
  LITELLM_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  // Comma-separated credential groups the deployment has registered with the
  // provider. Presence only; the gateway holds the client ids and secrets.
  CONFIGURED_STATIC_MCP_CLIENTS: z.string().default(""),
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:4174"),
  M365_AUTHORIZATION_ORIGIN: z.string().url().default("http://localhost:4311"),
  // The Entra application id is not a secret; the matching client secret stays
  // with the ms365-mcp service. Both of these are absent in a deployment that
  // has not configured Microsoft 365, which leaves consent links unavailable
  // rather than broken.
  M365_CLIENT_ID: z.string().default(""),
  M365_TENANT_ID: z.string().default(""),
  M365_SITE_ADMIN_CLIENT_ID: z.string().default(""),
  M365_SITE_ADMIN_CLIENT_SECRET: z.string().default(""),
  CONNECTOR_CONSENT_SECRET: z.string().default(""),
  AGENT_BRIDGE_URL: z.string().url().default("http://lemmacomputer-control:4100"),
  AGENT_BRIDGE_SECRET: z.string().min(32),
  AGENT_BRIDGE_GRANT_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  FIXTURE_APPROVAL_SECRET: z.string().min(32).default("local-disabled-fixture-approval-secret-32-chars"),
  OPENVTC_CONSENT_URL: z.string().url().optional(),
  OPENVTC_CONSENT_TOKEN: z.string().min(32).optional(),
  WEB_PUSH_VAPID_SUBJECT: optionalEnvString(),
  WEB_PUSH_VAPID_PUBLIC_KEY: optionalEnvString(),
  WEB_PUSH_VAPID_PRIVATE_KEY: optionalEnvString(),
  WEB_PUSH_SUBSCRIPTION_SECRET: optionalEnvString(32),
  PLATFORM_SECURITY_ALERT_WEBHOOK_URL: optionalEnvString(),
  PLATFORM_SECURITY_ALERT_WEBHOOK_SECRET: optionalEnvString(32),
  PLATFORM_SUPPORT_APPROVAL_REQUIRED: z.enum(["true", "false"]).default("true"),
  AI_USAGE_INTERNAL_TOKEN: z.string().min(32),
  AI_USAGE_TASK_BINDING_SECRET: z.string().min(32),
  WORKSPACE_INGRESS_PUBLIC_URL: optionalEnvString(),
  WORKSPACE_INGRESS_SECRET: optionalEnvString(32),
  WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  WORKSPACE_INGRESS_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
  EGRESS_GRANT_SECRET: z.string().min(32).optional(),
  AGENT_CHAT_SECRET: z.string().min(32),
  ARTIFACT_STORE_BACKEND: z.enum(["filesystem", "s3"]),
  ARTIFACT_FILESYSTEM_ROOT: optionalEnvString(),
  ARTIFACT_S3_BUCKET: optionalEnvString(),
  ARTIFACT_S3_REGION: optionalEnvString(),
  ARTIFACT_S3_ENDPOINT: optionalEnvString(),
  ARTIFACT_S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  ARTIFACT_S3_KMS_KEY_ID: optionalEnvString(),
  CHANNEL_BROKER_URL: optionalEnvString(),
  CHANNEL_BROKER_INTERNAL_TOKEN: optionalEnvString(32),
  TELEGRAM_RAW_TOKEN_INPUT_MODE: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.enum(["legacy", "reject"]).optional(),
  ),
  TELEGRAM_INTAKE_GRANT_PRIVATE_KEY_B64: optionalEnvString(32),
  TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64: optionalEnvString(64),
  TELEGRAM_INTAKE_URL: z.literal(telegramTokenIntakePath).default(telegramTokenIntakePath),
  TELEGRAM_INTAKE_GRANT_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(300),
  SCHEDULER_INTERNAL_TOKEN: z.string().min(32),
  SCHEDULE_PROMPT_SECRET: z.string().min(32),
  POLICY_SIGNING_KEY_ID: z.string().regex(/^psk_[a-z0-9][a-z0-9_-]{2,63}$/),
  POLICY_SIGNING_PRIVATE_KEY_B64: z.string().min(40),
  POLICY_VERIFICATION_KEYS_B64: z.string().min(32),
  POLICY_BUNDLE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
  GATEWAY_GRANT_RENEWAL_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  BOOTSTRAP_TENANT_ID: z.string().min(1).default("acme"),
});

export const usesPlacementRoutedController = (input: {
  installationKind: "customer-managed" | "hosted" | "worktree";
  workspaceNodeTopology: "colocated" | "remote";
}) => input.workspaceNodeTopology === "remote" && input.installationKind !== "customer-managed";

const sameSecret = (received: string | undefined, expected: string) => {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

const agentBridgeScopeForRequest = (method: string, url: string): AgentBridgeScope | null => {
  const path = url.split("?", 1)[0];
  if (method === "POST" && path === "/internal/v1/agent/grants/renew") return "agent:renew";
  if (method === "POST" && path === "/internal/v1/agent/usage-bindings") return "agent:usage-bindings";
  if (method === "POST" && (
    path === "/internal/v1/agent/instances"
    || /^\/internal\/v1\/agent\/instances\/[^/]+\/(?:running|end)$/.test(path)
  )) return "agent:instances";
  if (method === "GET" && (
    path === "/internal/v1/agent/mcp-discovery-plan"
    || path === "/internal/v1/agent/sharepoint-sites"
  )) return "agent:mcp-discovery";
  if (method === "POST" && path === "/internal/v1/agent/sites") return "agent:sites";
  if (method === "GET" && /^\/internal\/v1\/agent\/operations\/[^/]+$/.test(path)) return "agent:operations:read";
  if (method === "POST" && (
    path === "/internal/v1/agent/uploads"
    || /^\/internal\/v1\/agent\/uploads\/[^/]+\/(?:begin|complete|fail)$/.test(path)
  )) return "agent:uploads";
  if (method === "POST" && path === "/internal/v1/agent/deletions") return "agent:deletions";
  if (method === "POST" && path === "/internal/v1/agent/tool-audit/terminal") return "agent:tool-audit";
  return null;
};

// The administrator-consent landing page. It is deliberately self-contained and
// says nothing an unauthenticated reader should not see: no organization name,
// no connector inventory, no identifiers. Every interpolated value is either a
// fixed literal chosen here or escaped, because the reader arrives straight
// from the provider with a query string they may control.
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character
));

const adminConsentPage = (result: { outcome: "granted" | "refused" | "invalid"; connectorName: string | null }) => {
  const service = result.connectorName ? escapeHtml(result.connectorName) : "This service";
  const { title, detail } = result.outcome === "granted"
    ? {
      title: "Approval recorded",
      detail: `${service} is approved for your organization. The person who sent you this link can now finish connecting it. You can close this page.`,
    }
    : result.outcome === "refused"
      ? {
        title: "Approval was not completed",
        detail: `${service} was not approved. Nothing has changed for your organization. Ask the person who sent you this link to send it again if you want to approve it.`,
      }
      : {
        title: "This approval link is not valid",
        detail: "The link has expired or was changed in transit. Ask the person who sent it to you to request a new one.",
      };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
main { max-width: 32rem; }
h1 { margin: 0 0 12px; font-size: 22px; }
p { margin: 0; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${detail}</p></main></body>
</html>`;
};

export function createControlServer(
  store: WorkspaceStore & GovernanceStore & ActivityStore & Partial<ChannelStore>,
  controller: ControllerClient,
  proxyToken: string,
  gateway?: GatewayClient & Partial<GovernedToolExecutor>,
  fixtureApprovalSecret = "local-test-fixture-approval-secret-32-characters",
  connectionOptions: {
    publicWebUrl?: string;
    authorizationOrigin?: string;
    liteLlmPublicUrl?: string;
    agentBridgeUrl?: string;
    installationKind?: "customer-managed" | "hosted" | "worktree";
    hostedCustomConnectorEgressOrigins?: string[];
    configuredStaticMcpClients?: StaticCredentialGroup[];
    microsoftAdminConsent?: { clientId: string; consentSecret: string };
    microsoftSharePointSitePermissions?: MicrosoftSharePointSitePermissionGateway;
    microsoftSharePointConnectorClientId?: string;
  } = {},
  security: {
    customerAuthentication?: CustomerAuthentication;
    customerSsoAuthentication?: CustomerAuthentication;
    customerProductAuthentication?: CustomerProductAuthenticationBoundary;
    tenantSsoAdministration?: TenantSsoAdministrationBoundary;
    invitationDelivery?: {
      mode: "email" | "copy-link";
      email?: TransactionalEmailAdapter;
    };
    developmentEmailCapture?: Pick<CaptureTransactionalEmailAdapter, "takeLatest">;
    closeCustomerAuthentication?: () => Promise<void>;
    platformAuthentication?: PlatformAuthentication;
    platformBetterAuthService?: BetterAuthPlatformOperatorAuthenticationService;
    closePlatformAuthentication?: () => Promise<void>;
    platformOperatorAuthentication?: PlatformOperatorAuthenticationBoundary;
    platformOperatorStore?: PlatformOperatorStoreBoundary;
    platformSecurityAlertDispatcher?: { status(): PlatformSecurityAlertDispatcherStatus };
    platformTenantCleanupDispatcher?: { status(): PlatformTenantCleanupDispatcherStatus };
    platformOperatorApprovalConfigured?: boolean;
    identityPolicyStore?: IdentityPolicyStore;
    protectedWorkspacePolicy?: ProtectedWorkspacePolicyAdministrationBoundary;
    mcpPolicyToken?: string;
    mcpEgressProxyToken?: string;
    agentBridgeSecret?: string;
    agentBridgeGrantTtlSeconds?: number;
    testIdentityMode?: boolean;
    openVtc?: OpenVtcApprovalCoordinator;
    egressGrantSecret?: string;
    workspaceAccessAuthorization?: { url: string; token: string };
    policyBundleAuthority?: PolicyBundleAuthority;
    agentChatSecret?: string;
    agentChatClient?: AgentChatClient;
    chatStore?: ChatStore;
    artifactStore?: ArtifactStore;
    requireArtifactNodePlacement?: boolean;
    requireCanonicalChatPersistence?: boolean;
    agentInstanceStore?: AgentInstanceStore;
    toolAuditStore?: ToolAuditStore;
    channelBrokerClient?: ChannelBrokerManagementClient;
    channelBrokerInternalToken?: string;
    telegramTokenIntake?: {
      grantIssuer: TelegramTokenIntakeGrantIssuer;
      encryptionPublicKeySpkiBase64: string;
      intakeUrl: string;
      ttlSeconds: number;
    };
    telegramRawTokenInputMode?: "legacy" | "reject";
    scheduleStore?: ScheduleStore;
    siteStore?: SiteStore;
    teamStore?: TeamStore;
    budgetStore?: TeamBudgetStore;
    routingStore?: RoutingStore;
    budgetProjector?: LiteLlmTeamBudgetProjector;
    spendObservabilityStore?: SpendObservabilityStore;
    schedulerInternalToken?: string;
    schedulePromptSecret?: string;
    connectorRegistryStore?: ConnectorRegistryStore;
    providerSettingsStore?: ProviderSettingsStore;
    providerAdministration?: ProviderAdministrationGateway;
    workspaceIngress?: {
      publicUrl: string;
      authority: WorkspaceIngressAuthority;
    };
    usageLedgerStore?: PostgresUsageLedgerStore;
    usageInternalToken?: string;
    usageTaskBindingSecret?: string;
    usageAdmissionHook?: UsageAttemptAdmissionHook;
    grantRenewal?: {
      tenantId: string;
      intervalMs: number;
    };
  } = {},
) {
  const testRuntimePolicy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "test-policy-v1",
    policyVersion: 1,
    policyHash: "0".repeat(64),
    workspaceProfile: "kasm-persistent-standard",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "test-default-agent",
    agentProfile: "lemmacomputer-default-agent",
    applications: ["firefox"],
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    requestedServiceClass: "auto",
    mcpServer: "lemmacomputer_fixture",
    allowedTools: ["search_files"],
    toolPolicies: { search_files: "allow" },
  };
  const app = Fastify({
    logger: { redact: ["req.headers.x-lemmacomputer-proxy-token", "req.headers.x-lemmacomputer-mcp-policy-token", "req.headers.x-lemmacomputer-ai-usage-token", "req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie", "req.body", "*.arguments", "*.launchUrl"] },
    logController: new LogController({
      disableRequestLogging: (request) => /^\/v1\/connections\/[^/]+\/callback/.test(request.url)
        || request.url.startsWith("/v1/auth/")
        || request.url.startsWith("/v1/platform/auth/"),
    }),
    bodyLimit: 32 * 1024,
    routerOptions: { maxParamLength: 2048 },
  });
  if (!security.customerProductAuthentication && !security.testIdentityMode) {
    throw new Error("Control requires the customer Better Auth product boundary; test identity mode must be enabled explicitly in tests");
  }
  const invitationDelivery = security.invitationDelivery
    ?? (security.testIdentityMode ? { mode: "copy-link" as const } : undefined);
  if (invitationDelivery?.mode === "copy-link" && connectionOptions.installationKind === "hosted") {
    throw new Error("Hosted invitation activation requires transactional email delivery");
  }
  if (invitationDelivery?.mode === "email" && !invitationDelivery.email) {
    throw new Error("Invitation email delivery requires the transactional email adapter");
  }
  if (security.customerAuthentication) registerCustomerAuthenticationRoutes(
    app,
    security.customerAuthentication,
    security.customerSsoAuthentication,
  );
  if (security.closeCustomerAuthentication) app.addHook("onClose", security.closeCustomerAuthentication);
  if (security.platformAuthentication && security.platformBetterAuthService) registerPlatformAuthenticationRoutes(
    app,
    security.platformAuthentication,
    security.platformBetterAuthService,
    connectionOptions.installationKind ?? "customer-managed",
  );
  if (security.closePlatformAuthentication) app.addHook("onClose", security.closePlatformAuthentication);
  // The fallback exists only for the explicit in-memory test identity mode. Runtime
  // boot requires AGENT_BRIDGE_SECRET and never derives this key from another trust boundary.
  const agentBridgeSecret = security.agentBridgeSecret ?? (
    security.testIdentityMode ? "test-agent-bridge-secret-at-least-32-characters" : undefined
  );
  if (!agentBridgeSecret) throw new Error("AGENT_BRIDGE_SECRET is required");
  if (sameSecret(agentBridgeSecret, proxyToken)) {
    throw new Error("AGENT_BRIDGE_SECRET must differ from the web proxy token");
  }
  if (security.mcpPolicyToken && sameSecret(agentBridgeSecret, security.mcpPolicyToken)) {
    throw new Error("AGENT_BRIDGE_SECRET must differ from the MCP policy token");
  }
  if (security.mcpEgressProxyToken && sameSecret(agentBridgeSecret, security.mcpEgressProxyToken)) {
    throw new Error("AGENT_BRIDGE_SECRET must differ from the MCP egress proxy token");
  }
  if (security.mcpEgressProxyToken && security.mcpPolicyToken && sameSecret(security.mcpEgressProxyToken, security.mcpPolicyToken)) {
    throw new Error("MCP egress proxy token must differ from the MCP policy token");
  }
  const agentBridgeAuthority = new AgentBridgeAuthority(agentBridgeSecret, security.agentBridgeGrantTtlSeconds);
  const agentChatAuthority = security.agentChatSecret ? new AgentChatAuthority(security.agentChatSecret) : undefined;
  const agentChat = security.agentChatClient ?? new HttpAgentChatClient();
  const durableChat = security.chatStore && security.artifactStore
    ? new DurableChatService(security.chatStore, security.artifactStore, {
        requireNodePlacement: security.requireArtifactNodePlacement ?? false,
      })
    : undefined;
  if (!durableChat && security.requireCanonicalChatPersistence) {
    throw new Error("Control requires ChatStore and ArtifactStore canonical persistence");
  }
  const requireDurableChat = () => {
    if (!durableChat || !security.chatStore) {
      throw new LemmaComputerError("CHAT_STORE_UNAVAILABLE", "Durable Chat is unavailable", 503, true);
    }
    return { service: durableChat, store: security.chatStore };
  };
  let artifactStagingCleanupTimer: NodeJS.Timeout | undefined;
  if (durableChat) {
    app.addHook("onReady", async () => {
      await durableChat.cleanupExpiredStaging();
      artifactStagingCleanupTimer = setInterval(() => {
        void durableChat.cleanupExpiredStaging().catch(() => undefined);
      }, 60_000);
      artifactStagingCleanupTimer.unref();
    });
    app.addHook("onClose", async () => {
      if (artifactStagingCleanupTimer) clearInterval(artifactStagingCleanupTimer);
    });
  }
  const agentProcesses = new AgentProcessLifecycleService(security.agentInstanceStore);
  const activityEvents = new ActivityEventService(store);
  const sites = security.siteStore ? new SitesService(security.siteStore) : undefined;
  const requireSites = () => {
    if (!sites) throw new LemmaComputerError("SITES_NOT_CONFIGURED", "Sites are unavailable", 503, true);
    return sites;
  };
  const requireTeams = () => {
    if (!security.teamStore) {
      throw new LemmaComputerError("TEAMS_NOT_CONFIGURED", "Team administration is unavailable", 503, true);
    }
    return security.teamStore;
  };
  const usageDependencies = [security.usageLedgerStore, security.usageInternalToken, security.usageTaskBindingSecret];
  if (usageDependencies.some(Boolean) && (!usageDependencies.every(Boolean) || !security.teamStore)) {
    throw new Error("AI usage ledger store, internal token, task-binding secret, and Team store must be configured together");
  }
  const usageBindings = security.usageTaskBindingSecret
    ? new UsageTaskBindingAuthority(security.usageTaskBindingSecret)
    : undefined;
  const usageRecordedHook=security.budgetStore?new BudgetUsageEventRecordedHook(security.budgetStore):undefined;
  const usageLedger = security.usageLedgerStore && security.teamStore && usageBindings
    ? new UsageLedgerService(security.usageLedgerStore, security.teamStore, usageBindings, security.usageAdmissionHook, usageRecordedHook, async (binding) => {
        const owner = { tenantId: binding.tenantId, subjectId: binding.subjectId, audience: "lemmacomputer-control" as const };
        const workspace = await store.getOwned(owner, binding.workspaceId);
        if (!workspace) throw new LemmaComputerError("AGENT_INSTANCE_INVALID", "The usage identity does not belong to an active workspace", 403);
        await agentProcesses.requireActive({ identity: owner, workspace, logicalAgentId: binding.agentId, agentInstanceId: binding.agentInstanceId! });
      })
    : undefined;
  const requireUsageLedger = () => {
    if (!usageLedger || !security.usageLedgerStore) {
      throw new LemmaComputerError("AI_USAGE_NOT_CONFIGURED", "AI usage governance is unavailable", 503, true);
    }
    return { service: usageLedger, store: security.usageLedgerStore };
  };
  const issueUsageTaskBinding = (
    owner: IdentityContext,
    workspaceId: string,
    agentId: string,
    contextKind: "chat" | "channel" | "schedule" | "background",
    taskId: string,
    sessionId?: string,
    turnId?: string,
    requestedServiceClass: "auto"|"lite"|"balanced"|"pro" = "auto",
    agentInstanceId?: string,
    requestedReasoningEffort?: "auto"|"low"|"medium"|"high",
    maximumReasoningEffort?: "disabled"|"low"|"medium"|"high"|"max",
  ) => usageBindings?.issue({
    tenantId: owner.tenantId, subjectId: owner.subjectId, workspaceId, agentId,
    contextKind, taskId, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}),
    ...(agentInstanceId ? { agentInstanceId } : {}),
    ...(requestedReasoningEffort ? { requestedReasoningEffort } : {}),
    ...(maximumReasoningEffort ? { maximumReasoningEffort } : {}),
    requestedServiceClass,
  });
  const budgets=security.budgetStore?new TeamBudgetAdministrationService(security.budgetStore,security.budgetProjector):undefined;
  const requireBudgets=()=>{if(!budgets)throw new LemmaComputerError("BUDGETS_NOT_CONFIGURED","Team budget administration is unavailable",503,true);return budgets;};
  const routingExecution=security.routingStore&&security.teamStore&&usageBindings?new RoutingExecutionService(security.routingStore,security.teamStore,new RoutingDecisionBindingAuthority(security.usageTaskBindingSecret!),usageBindings,security.budgetStore):undefined;
  const routing=security.routingStore?new RoutingAdministrationService(security.routingStore,security.teamStore):undefined;
  const requireRouting=()=>{if(!routing)throw new LemmaComputerError("ROUTING_NOT_CONFIGURED","Model routing administration is unavailable",503,true);return routing;};
  const publishedWorkspaceServiceClassesFor = async (tenantId: string): Promise<ExplicitWorkspaceServiceClass[] | null> => {
    if (!security.routingStore) return null;
    if (!routingExecution) {
      const routeMapping = await security.routingStore.latestMappingVersion(tenantId);
      return workspaceServiceClasses
        .filter(({ value }) => routeMapping?.deployments.some((deployment) => deployment.serviceClass === value))
        .map(({ value }) => value);
    }
    return (await routingExecution.serviceClassOptions(tenantId))
      .filter((option) => option.available)
      .map((option) => option.value);
  };
  const chatServiceClassOptionsFor = async (owner: IdentityContext, policy?: RuntimePolicy) => {
    const options = routingExecution
      ? await routingExecution.serviceClassOptions(owner.tenantId, owner.subjectId)
      : [
        { value: "lite" as const, available: false, reasonCode: "route_unavailable" as const },
        { value: "balanced" as const, available: true, reasonCode: "ready" as const },
        { value: "pro" as const, available: false, reasonCode: "route_unavailable" as const },
      ];
    const allowed = policy?.allowedServiceClasses;
    return allowed
      ? options.map((option) => allowed.includes(option.value)
          ? option
          : { ...option, available: false as const, reasonCode: "policy_denied" as const })
      : options;
  };
  const requireChatServiceClass = async (
    owner: IdentityContext,
    serviceClass: "lite" | "balanced" | "pro",
    policy?: RuntimePolicy,
  ) => {
    const option = (await chatServiceClassOptionsFor(owner, policy)).find((candidate) => candidate.value === serviceClass);
    if (option?.available) return;
    const reasonCode: "policy_denied" | "pricing_unavailable" | "provider_unavailable" | "route_unavailable" = option && !option.available
      ? option.reasonCode === "ready" ? "route_unavailable" : option.reasonCode
      : "route_unavailable";
    const failures: Record<typeof reasonCode, readonly [string, string, number, boolean]> = {
      policy_denied: ["MODEL_TIER_DENIED", "That model tier is not allowed by your organization", 403, false],
      pricing_unavailable: ["MODEL_TIER_PRICING_UNAVAILABLE", "Pricing is not ready for that model tier", 422, false],
      provider_unavailable: ["MODEL_TIER_PROVIDER_UNAVAILABLE", "That model tier is temporarily unavailable", 503, true],
      route_unavailable: ["MODEL_TIER_ROUTE_UNAVAILABLE", "No ready route is available for that model tier", 503, true],
    };
    const failure = failures[reasonCode];
    throw new LemmaComputerError(failure[0], failure[1], failure[2], failure[3]);
  };
  const reasoningEffortsFor = async (
    owner: IdentityContext,
    policy: RuntimePolicy,
    catalogId: string,
  ) => {
    const empty = { auto: [], lite: [], balanced: [], pro: [] } as Record<
      "auto" | "lite" | "balanced" | "pro",
      Array<"auto" | "low" | "medium" | "high">
    >;
    const catalogEntry = ownedAgentCatalog.find((entry) => entry.id === catalogId);
    const adapter = catalogEntry
      ? qualifiedAgentReasoningAdapter({
          agentCatalogId: catalogEntry.id,
          clientVersion: catalogEntry.clientVersion,
        })
      : null;
    if (!adapter || !routingExecution || !policy.maximumReasoningEffort) return empty;
    const maximumRank = ({ disabled: 0, low: 1, medium: 2, high: 3, max: 3 } as const)[policy.maximumReasoningEffort];
    if (maximumRank === 0) return empty;
    const qualified = await routingExecution.reasoningOptions(owner.tenantId, owner.subjectId, adapter);
    return Object.fromEntries(Object.entries(empty).map(([serviceClass]) => {
      const levels = (qualified[serviceClass as keyof typeof qualified] ?? []).filter(
        (effort) => ({ low: 1, medium: 2, high: 3 } as const)[effort] <= maximumRank,
      );
      return [serviceClass, levels.length ? ["auto", ...levels] : []];
    })) as typeof empty;
  };
  const requireReasoningEffort = async (
    owner: IdentityContext,
    policy: RuntimePolicy,
    catalogId: string,
    serviceClass: "auto" | "lite" | "balanced" | "pro",
    effort?: "auto" | "low" | "medium" | "high",
  ) => {
    if (!effort) return;
    const options = await reasoningEffortsFor(owner, policy, catalogId);
    if (!options[serviceClass].includes(effort)) {
      throw new LemmaComputerError(
        "MODEL_REASONING_EFFORT_UNAVAILABLE",
        "That thinking effort is not qualified for the selected organization route",
        422,
      );
    }
  };
  const channelBroker = security.channelBrokerClient;
  const telegramRawTokenInputMode = security.telegramRawTokenInputMode ?? "legacy";
  const requireSpendObservability = (request: object) => {
    const actor = principal(request);
    if (!allowsPermission(actor, "usage.read")) {
      throw new LemmaComputerError("SPEND_VIEW_NOT_FOUND", "Spend view not found", 404);
    }
    if (!security.spendObservabilityStore) {
      throw new LemmaComputerError("SPEND_OBSERVABILITY_NOT_CONFIGURED", "Spend observability is unavailable", 503, true);
    }
    return { actor, store: security.spendObservabilityStore };
  };
  const readSpendReport = async (tenantId: string, range: Parameters<SpendObservabilityStore["report"]>[1]) => {
    try {
      return await security.spendObservabilityStore!.report(tenantId, range);
    } catch (error) {
      if (error instanceof SpendReadLimitError) {
        throw new LemmaComputerError("SPEND_RANGE_TOO_LARGE", error.message, 422);
      }
      throw error;
    }
  };

  const service = new WorkspaceService(store, controller, gateway, {
    baseUrl: connectionOptions.agentBridgeUrl ?? "http://lemmacomputer-control:4100",
    issue: (identity, workspace, policy) => agentBridgeAuthority.issue(identity, workspace.id, policy, {
      workspaceGeneration: workspace.accessGeneration,
    }),
  }, security.egressGrantSecret ? new EgressProxyGrantAuthority(security.egressGrantSecret, security.workspaceAccessAuthorization) : undefined, security.policyBundleAuthority, agentChatAuthority, security.workspaceIngress);
  const executor: GovernedToolExecutor = gateway?.executeGovernedTool
    ? { executeGovernedTool: (input) => gateway.executeGovernedTool!(input) }
    : { executeGovernedTool: async () => { throw new LemmaComputerError("GATEWAY_NOT_CONFIGURED", "The governed tool gateway is not configured", 503, true); } };
  const operations = new GovernedOperationService(store, executor, new FixtureApprovalAuthority(fixtureApprovalSecret), undefined, security.openVtc);
  const oauthGateway = gateway
    && typeof (gateway as Partial<OAuthConnectionGateway>).beginUserOAuthConnection === "function"
    && typeof (gateway as Partial<OAuthConnectionGateway>).completeUserOAuthConnection === "function"
    && typeof (gateway as Partial<OAuthConnectionGateway>).userOAuthConnectionStatus === "function"
    && typeof (gateway as Partial<OAuthConnectionGateway>).disconnectUserOAuthConnection === "function"
    ? gateway as GatewayClient & OAuthConnectionGateway
    : undefined;
  const connections = oauthGateway ? new McpConnectionService(oauthGateway, {
    publicWebUrl: connectionOptions.publicWebUrl ?? "http://localhost:4174",
    authorizationOrigin: connectionOptions.authorizationOrigin ?? "http://localhost:4311",
    liteLlmPublicUrl: connectionOptions.liteLlmPublicUrl,
    registry: security.connectorRegistryStore,
    installationKind: connectionOptions.installationKind,
    hostedCustomConnectorEgressOrigins: connectionOptions.hostedCustomConnectorEgressOrigins,
    configuredStaticMcpClients: connectionOptions.configuredStaticMcpClients,
    microsoftAdminConsent: connectionOptions.microsoftAdminConsent,
    microsoftSharePointSitePermissions: connectionOptions.microsoftSharePointSitePermissions,
    microsoftSharePointConnectorClientId: connectionOptions.microsoftSharePointConnectorClientId,
  }) : undefined;
  if (Boolean(security.providerSettingsStore) !== Boolean(security.providerAdministration)) {
    throw new Error("Provider settings dependencies must be configured together");
  }
  const providerSettings = security.providerSettingsStore && security.providerAdministration
    ? new ProviderSettingsService(security.providerSettingsStore, security.providerAdministration, {
      revokeWorkspaceGrants: async (tenantId, provider) => revokeTenantProviderWorkspaceGrants(tenantId, provider),
    })
    : undefined;
  const mcpPolicy = security.identityPolicyStore ? new McpPolicyService(
    security.identityPolicyStore,
    store,
    operations,
    async (actor, grantId) => {
      const assigned = await security.identityPolicyStore!.getEffectivePolicy(actor.userId);
      const effective = (await effectivePolicyFor(actor, assigned)).effective;
      return effective ? (await policyForGrant(actor, effective, grantId)).policy : null;
    },
    connections ? (actor, serverName, toolName) => connections.hostedToolPolicy(actor, serverName, toolName) : undefined,
    connections ? (actor, toolName, argumentsValue) => connections.authorizeMicrosoft365SharePointTarget(actor, toolName, argumentsValue) : undefined,
  ) : undefined;
  const toolAudit = security.toolAuditStore ? new ToolAuditService(
    security.toolAuditStore,
    async (tenantId, serverName) => connections?.auditConnector(tenantId, serverName) ?? null,
  ) : undefined;
  const requireConnections = () => {
    if (!connections) throw new LemmaComputerError("MCP_CONNECTIONS_NOT_CONFIGURED", "MCP connections are not configured", 503, true);
    return connections;
  };
  const requireProviderSettings = () => {
    if (!providerSettings) throw new LemmaComputerError("PROVIDER_SETTINGS_NOT_CONFIGURED", "Provider settings are not configured", 503, true);
    return providerSettings;
  };
  const assertProviderConfiguration = async (actor: SessionPrincipal, policy: RuntimePolicy) => {
    if (!providerSettings) return;
    const selectedModelAliases = policy.agents === undefined
      ? policy.modelAlias ? [policy.modelAlias] : []
      : policy.agents.map((agent) => agent.modelAlias);
    for (const modelAlias of new Set(selectedModelAliases)) {
      await providerSettings.assertConfigured(actor, modelAlias);
    }
  };
  const requireChannelBroker = () => {
    if (!channelBroker) throw new LemmaComputerError("CHANNEL_BROKER_NOT_CONFIGURED", "Messaging connections are not configured", 503, true);
    return channelBroker;
  };
  const requireTelegramTokenIntake = () => {
    if (!security.telegramTokenIntake) {
      throw new LemmaComputerError("TELEGRAM_INTAKE_NOT_CONFIGURED", "Telegram credential intake is unavailable", 503, true);
    }
    return security.telegramTokenIntake;
  };
  const workspaceManifest = (
    configuration: SandboxConfiguration,
    telegram: TelegramChannelConnectionStatus | null,
  ): WorkspaceManifest => workspaceManifestSchema.parse({
    schemaVersion: 2,
    sandbox: {
      schemaVersion: 1,
      profileId: configuration.profileId,
      executionMode: configuration.executionMode,
      egressMode: configuration.egressMode,
      applicationIds: configuration.applicationIds,
      agentIds: configuration.agentIds.map(workspaceManifestAgentIdFor),
      modelAlias: configuration.modelAlias,
      requestedServiceClass: configuration.requestedServiceClass,
      egress: configuration.egress,
    },
    channels: telegram?.state === "connected"
      && telegram.credentialId
      && telegram.tokenVersion
      && telegram.defaultAgentId
      && configuration.agentIds.includes(telegram.defaultAgentId)
      ? [{
        adapter: "telegram",
        credentialRef: telegram.credentialId,
        credentialVersion: telegram.tokenVersion,
        allowedSenderIds: telegram.allowedUserIds,
        defaultAgentId: workspaceManifestChatAgentIdFor(telegram.defaultAgentId),
        allowAgentSwitch: telegram.allowAgentSwitch,
        inboundPolicy: "private-dm-only",
      }]
      : [],
  });
  const principals = new WeakMap<object, SessionPrincipal>();
  const platformOperatorPrincipals = new WeakMap<object, PlatformOperatorSession>();
  const agentPrincipals = new WeakMap<object, AgentBridgeIdentity>();

  app.addHook("onRequest", async (request, reply) => {
    // Fastify's request.url includes the raw query string. Authenticate based
    // on the route pathname so a query suffix cannot bypass an exact internal
    // route check and fall through to a less-specific boundary below.
    const requestPath = request.url.split("?", 1)[0] ?? request.url;
    if (requestPath === "/healthz") return;
    if (requestPath === "/v1/openvtc/inbox" || requestPath === "/trust-tasks") return;
    if (requestPath.startsWith("/internal/v1/channels/")) {
      if (!security.channelBrokerInternalToken || !sameSecret(
        request.headers["x-lemmacomputer-channel-token"] as string | undefined,
        security.channelBrokerInternalToken,
      )) {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Channel broker authentication is required", correlationId: request.id, retryable: false } });
      }
      return;
    }
    if (requestPath.startsWith("/internal/v1/schedules/")) {
      if (!security.schedulerInternalToken || !sameSecret(
        request.headers["x-lemmacomputer-scheduler-token"] as string | undefined,
        security.schedulerInternalToken,
      )) {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Scheduler authentication is required", correlationId: request.id, retryable: false } });
      }
      return;
    }
    if (requestPath.startsWith("/internal/v1/ai-usage/")) {
      if (!security.usageInternalToken || !sameSecret(
        request.headers["x-lemmacomputer-ai-usage-token"] as string | undefined,
        security.usageInternalToken,
      )) {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "AI usage callback authentication is required", correlationId: request.id, retryable: false } });
      }
      return;
    }
    if (requestPath === "/internal/v1/workspace-access/authorize") {
      if (!sameSecret(request.headers["x-lemmacomputer-mcp-policy-token"] as string | undefined, security.mcpPolicyToken ?? proxyToken)) {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Workspace access authorization is required", correlationId: request.id, retryable: false } });
      }
      return;
    }
    if (requestPath === "/internal/v1/mcp-egress/authorize") {
      const authorization = request.headers.authorization;
      const value = Array.isArray(authorization) ? authorization[0] : authorization;
      const match = typeof value === "string" ? /^Bearer (.+)$/.exec(value) : null;
      if (!security.mcpEgressProxyToken || !match || !sameSecret(match[1]!, security.mcpEgressProxyToken)) {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "MCP egress proxy authentication is required", correlationId: request.id, retryable: false } });
      }
      return;
    }
    const agentBridgeScope = agentBridgeScopeForRequest(request.method, requestPath);
    if (agentBridgeScope) {
      const authorization = request.headers.authorization;
      const value = Array.isArray(authorization) ? authorization[0] : authorization;
      const match = typeof value === "string" ? /^Bearer (.+)$/.exec(value) : null;
      if (!match) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Agent bridge authentication is required", correlationId: request.id, retryable: false } });
      const actor = agentBridgeAuthority.verify(match[1]!, {
        audience: agentBridgeAudience,
        scope: agentBridgeScope,
      });
      const accessIdentity = {
        tenantId: actor.tenantId,
        subjectId: actor.subjectId,
        audience: "lemmacomputer-control",
      } as const;
      // Connector discovery is part of workspace bootstrap: Hermes resolves
      // its MCP tool catalogue before the controller can mark the sandbox
      // ready. Keep every mutating/operational bridge scope ready-only, while
      // allowing this read-only, generation-bound projection during the two
      // states that actively create a replacement runtime.
      const activeStates: WorkspaceState[] = agentBridgeScope === "agent:mcp-discovery"
        ? ["provisioning", "restarting", "ready", "open"]
        : ["ready", "open"];
      if (!await store.authorizeWorkspaceAccess({
        ...accessIdentity,
        workspaceId: actor.workspaceId,
        accessGeneration: actor.workspaceGeneration,
      }, activeStates)) {
        throw new LemmaComputerError("AGENT_BRIDGE_GRANT_REVOKED", "Agent bridge authentication is no longer active", 403);
      }
      agentPrincipals.set(request, actor);
      return;
    }
    if (requestPath === "/internal/v1/mcp/authorize") {
      if (!sameSecret(request.headers["x-lemmacomputer-mcp-policy-token"] as string | undefined, security.mcpPolicyToken ?? proxyToken)) {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Internal policy authentication is required", correlationId: request.id, retryable: false } });
      }
      return;
    }
    if (!sameSecret(request.headers["x-lemmacomputer-proxy-token"] as string | undefined, proxyToken)) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication is required", correlationId: request.id, retryable: false } });
    }
    if (security.customerAuthentication && requestPath.startsWith(`${customerAuthenticationControlPath}/`)) return;
    if (security.platformAuthentication && requestPath.startsWith(`${platformAuthenticationControlPath}/`)) return;
    if (requestPath.startsWith("/v1/platform/")) {
      if (connectionOptions.installationKind === "customer-managed") {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found", correlationId: request.id, retryable: false } });
      }
      if (requestPath === "/v1/platform/auth/login") return;
      if (!security.platformOperatorAuthentication) {
        return reply.code(503).send({ error: { code: "PLATFORM_AUTH_NOT_CONFIGURED", message: "Platform authentication is unavailable", correlationId: request.id, retryable: true } });
      }
      const operator = await security.platformOperatorAuthentication.authenticate(request.headers.cookie);
      if (!operator) {
        if (requestPath === "/v1/platform/ui") {
          return reply.code(303).header("location", "/api/v1/platform/auth/login?return=%2Fplatform").send();
        }
        return reply.code(401).send({ error: { code: "PLATFORM_UNAUTHENTICATED", message: "Sign in with your platform operator account", correlationId: request.id, retryable: false } });
      }
      platformOperatorPrincipals.set(request, operator);
      return;
    }
    // A customer's directory administrator opens the consent link from their
    // mail client and has no LemmaComputer session, and usually no account.
    // The signed state in the query is what binds the response to an
    // organization; the route reads nothing from the session.
    if (/^\/v1\/connections\/[^/]+\/admin-consent\/callback$/.test(requestPath)) return;
    if (requestPath === "/v1/auth/product-session" || requestPath === "/v1/auth/customer-capabilities"
      || (requestPath === "/v1/auth/development-email-capture" && security.developmentEmailCapture)
      || requestPath === "/v1/auth/customer-sso"
      || requestPath === "/v1/auth/organizations" || requestPath === "/v1/auth/personal-tenant"
      || requestPath === "/v1/auth/owner-step-up"
      || requestPath === "/v1/auth/invitations/context" || requestPath === "/v1/auth/invitations/accept") return;
    let customerResolution: CustomerProductAuthenticationResolution | undefined;
    if (security.customerProductAuthentication && !security.testIdentityMode) {
      customerResolution = await security.customerProductAuthentication.resolve(fromNodeHeaders(request.raw.headers));
      if (customerResolution.status === "membership-required") {
        return reply.code(403).send({
          error: {
            code: "ACTIVE_MEMBERSHIP_REQUIRED",
            message: "Select an active organization to continue",
            correlationId: request.id,
            retryable: false,
          },
        });
      }
    }
    const principal = security.testIdentityMode
      ? testPrincipalFromHeaders(request.headers)
      : customerResolution?.status === "authorized"
        ? customerResolution.principal
        : null;
    if (!principal) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in with your work account", correlationId: request.id, retryable: false } });
    }
    principals.set(request, principal);
    const rejectedRawTelegramRoute = (
      request.method === "POST" && /^\/v1\/credentials\/telegram(?:\?|$)/.test(request.url)
    ) || (
      request.method === "PUT" && /^\/v1\/credentials\/[^/]+\/telegram(?:\?|$)/.test(request.url)
    );
    // This hook runs before Fastify parses a request body. Hosted deployments
    // therefore reject deprecated raw-token routes without materializing the
    // usable secret in Control's request handling path.
    if (telegramRawTokenInputMode === "reject" && rejectedRawTelegramRoute) {
      return reply.code(410).send({
        error: {
          code: "TELEGRAM_RAW_TOKEN_INPUT_REJECTED",
          message: "Broker-only Telegram credential intake is required",
          correlationId: request.id,
          retryable: false,
        },
      });
    }
  });

  const principal = (request: object) => {
    const value = principals.get(request);
    if (!value) throw new LemmaComputerError("UNAUTHENTICATED", "Sign in with your work account", 401);
    return value;
  };
  const platformOperatorPrincipal = (request: object) => {
    const value = platformOperatorPrincipals.get(request);
    if (!value) throw new LemmaComputerError("PLATFORM_UNAUTHENTICATED", "Sign in with your workforce account", 401);
    return value;
  };
  if (
    connectionOptions.installationKind !== "customer-managed"
    && security.platformOperatorAuthentication
    && security.platformOperatorStore
  ) registerPlatformOperatorRoutes(app, {
    authentication: security.platformOperatorAuthentication,
    store: security.platformOperatorStore,
    securityAlertDelivery: security.platformSecurityAlertDispatcher,
    tenantCleanupDelivery: security.platformTenantCleanupDispatcher,
    approvalConfigured: security.platformOperatorApprovalConfigured ?? false,
    sessionFor: platformOperatorPrincipal,
  });
  const identity = (request: object) => identityContextSchema.parse(principal(request).identity);
  const allowsPermission = (
    value: SessionPrincipal,
    permission: OrganizationPermission,
    scope: OrganizationResourceScope = { type: "organization" },
  ) => value.effectiveAuthorization
    ? value.effectiveAuthorization.allows(permission, scope)
    : hasOrganizationPermission(value, permission);
  const hasAnyPermissionGrant = (value: SessionPrincipal, permission: OrganizationPermission) => (
    value.effectiveAuthorization
      ? value.effectiveAuthorization.valid
        && value.effectiveAuthorization.grants.some((grant) => grant.permission === permission)
      : hasOrganizationPermission(value, permission)
  );
  const requirePermission = (
    request: object,
    permission: OrganizationPermission,
    scope: OrganizationResourceScope = { type: "organization" },
  ) => {
    const value = principal(request);
    if (!allowsPermission(value, permission, scope)) {
      throw new LemmaComputerError("FORBIDDEN", "Your organization role does not allow this action", 403);
    }
    return value;
  };
  const requireOwnedWorkspaceManagement = (request: object, workspaceId: string) => {
    const actor = principal(request);
    const scope = { type: "workspace" as const, resourceId: workspaceId };
    if (allowsPermission(actor, "workspace.manage", scope) || allowsPermission(actor, "workspace.manage_own", scope)) {
      return actor;
    }
    throw new LemmaComputerError("FORBIDDEN", "Your organization role does not allow this action", 403);
  };
  const allowsWorkspaceGrantPermission = async (
    actor: SessionPrincipal,
    permission: "workspace.manage" | "policy.manage",
    owner: IdentityContext,
    grantId: string,
  ) => {
    if (allowsPermission(actor, permission)) return true;
    const workspace = await store.getCurrent(owner, grantId);
    return Boolean(workspace && allowsPermission(actor, permission, { type: "workspace", resourceId: workspace.id }));
  };
  const requireWorkspaceGrantPermission = async (
    request: object,
    permission: "workspace.manage" | "policy.manage",
    owner: IdentityContext,
    grantId: string,
  ) => {
    const actor = principal(request);
    if (await allowsWorkspaceGrantPermission(actor, permission, owner, grantId)) return actor;
    throw new LemmaComputerError("FORBIDDEN", "Your organization role does not allow this action", 403);
  };
  async function effectivePolicyFor(value: SessionPrincipal, effective: EffectivePolicy | null) {
    const organizationPolicy = await security.protectedWorkspacePolicy?.currentOrganizationPolicy?.(value.tenantId) ?? null;
    return {
      effective: effective && organizationPolicy ? constrainEffectivePolicy(effective, organizationPolicy) : effective,
      organizationPolicy,
    };
  }
  const assignedPolicy = async (request: object) => {
    const value = principal(request);
    const effective = security.identityPolicyStore ? await security.identityPolicyStore.getEffectivePolicy(value.userId) : null;
    if (security.identityPolicyStore && !effective) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    return { principal: value, ...(await effectivePolicyFor(value, effective)) };
  };
  const requireProtectedWorkspacePolicy = () => {
    if (!security.protectedWorkspacePolicy) {
      throw new LemmaComputerError("PROTECTED_POLICY_STORE_NOT_CONFIGURED", "Protected workspace policy storage is unavailable", 503);
    }
    return security.protectedWorkspacePolicy;
  };
  const restrictWorkspaceEgress = (
    value: SessionPrincipal,
    effective: EffectivePolicy | null,
    selected: EgressSecurityGroupVersion | null,
  ): EgressSecurityGroupVersion | null => {
    const document = effective?.document as Record<string, unknown> | undefined;
    if (document?.maximumEgressMode !== "restricted" || selected?.defaultAction === "deny") return selected;
    const sourceHash = selected?.documentHash ?? "no-security-group";
    const documentHash = createHash("sha256")
      .update(`organization-restricted-egress-v1\0${value.tenantId}\0${effective?.documentHash ?? "no-policy"}\0${sourceHash}`)
      .digest("hex");
    return egressSecurityGroupVersionSchema.parse({
      schemaVersion: 1,
      id: selected?.id ?? `egv_organization_restricted_${documentHash.slice(0, 24)}`,
      securityGroupId: selected?.securityGroupId ?? `esg_organization_restricted_${documentHash.slice(0, 24)}`,
      tenantId: value.tenantId,
      version: selected?.version ?? effective?.version ?? 1,
      name: selected?.name ?? "Organization policy restricted egress",
      description: selected?.description ?? "Deny-by-default egress enforced by the active organization policy.",
      defaultAction: "deny",
      rules: selected?.rules ?? [],
      documentHash,
      createdBy: selected?.createdBy ?? effective?.assignedBy ?? value.userId,
      createdAt: selected?.createdAt ?? effective?.assignedAt ?? new Date(0).toISOString(),
      ...(selected?.isDefault === undefined ? {} : { isDefault: selected.isDefault }),
      ...(selected?.defaultFor === undefined ? {} : { defaultFor: selected.defaultFor }),
      ...(selected?.assignmentSource === undefined ? {} : { assignmentSource: selected.assignmentSource }),
    });
  };
  const workspaceEgressFor = async (value: SessionPrincipal, effective: EffectivePolicy | null, grantId: string, profileId: SandboxProfileId) => restrictWorkspaceEgress(
    value,
    effective,
    await security.identityPolicyStore?.getWorkspaceEgressSecurityGroup?.({
      tenantId: value.tenantId,
      subjectId: value.userId,
      grantId,
      profileId,
    }) ?? null,
  );
  const runtimeEgressForSecurityGroup = (group: EgressSecurityGroupVersion) => {
    const compiled = compileEgressSecurityGroup(group);
    const base = {
      schemaVersion: 2 as const,
      id: group.id,
      securityGroupId: group.securityGroupId,
      version: group.version,
      name: group.name,
      description: group.description,
      rules: compiled.rules,
      documentHash: group.documentHash,
    };
    return group.defaultAction === "allow-public-http-https"
      ? { ...base, mode: "full-web" as const, defaultAction: "allow-public-http-https" as const }
      : { ...base, mode: "restricted" as const, defaultAction: "deny" as const };
  };
  const requiredEgressDefaultActionForProfile = (profileId: SandboxProfileId) => (
    profileId === "disposable-open-v1" ? "allow-public-http-https" as const : "deny" as const
  );
  const assertEgressGroupMatchesProfile = (group: EgressSecurityGroupVersion, profileId: SandboxProfileId) => {
    if (group.defaultAction === requiredEgressDefaultActionForProfile(profileId)) return;
    throw new LemmaComputerError(
      "EGRESS_SECURITY_GROUP_INCOMPATIBLE",
      profileId === "disposable-open-v1"
        ? "Internet workspaces require a public-web security group"
        : "Restricted workspaces require an approved-destinations security group",
      409,
    );
  };
  const workspaceProfileIdFor = async (value: SessionPrincipal, effective: EffectivePolicy | null, grantId: string): Promise<SandboxProfileId> => {
    const saved = await store.getSandboxSettings?.(value.identity, grantId);
    const document = effective?.document as Record<string, unknown> | undefined;
    return (saved?.profileId
      ?? (Array.isArray(document?.workspaceProfiles) ? document.workspaceProfiles.find((candidate) => sandboxProfiles.some((profile) => profile.id === candidate)) : undefined)
      ?? document?.workspaceProfile
      ?? testRuntimePolicy.workspaceProfile) as SandboxProfileId;
  };
  const protectedWorkspacePolicyOverviewFor = async (tenantId: string) => {
    const [overview, publishedServiceClasses] = await Promise.all([
      requireProtectedWorkspacePolicy().overview(tenantId),
      publishedWorkspaceServiceClassesFor(tenantId),
    ]);
    if (publishedServiceClasses === null) return overview;
    return {
      ...overview,
      catalog: {
        ...overview.catalog,
        constraints: {
          ...overview.catalog.constraints,
          serviceClasses: { allow: publishedServiceClasses, deny: [] },
        },
      },
    };
  };
  const policyForGrant = async (value: SessionPrincipal, effective: EffectivePolicy | null, grantId = "personal") => {
    let policy = testRuntimePolicy;
    if (effective) {
      const saved = await store.getSandboxSettings?.(value.identity, grantId);
      const publishedServiceClasses = await publishedWorkspaceServiceClassesFor(value.tenantId);
      const governedRoutingAvailable = Boolean(publishedServiceClasses?.length);
      const document = effective.document as Record<string, unknown>;
      const selection = compatibleSandboxSelection(document, saved, publishedServiceClasses);
      if (!selection) {
        if (publishedServiceClasses?.length === 0) {
          throw new LemmaComputerError(
            "MODEL_ROUTES_NOT_PUBLISHED",
            "No organization model routes have been published for this workspace",
            409,
          );
        }
        throw new LemmaComputerError(
          "WORKSPACE_POLICY_SELECTION_REQUIRED",
          "This workspace has a saved selection that is no longer allowed. Review its agents and applications before starting it again.",
          409,
        );
      }
      if (
        saved
        && shouldPersistCompatibleSandboxSelection(selection, publishedServiceClasses)
        && store.saveSandboxSettings
      ) {
        await store.saveSandboxSettings(value.identity, {
          grantId,
          profileId: selection.profileId,
          applicationIds: selection.applicationIds,
          modelAlias: selection.modelAlias,
          requestedServiceClass: selection.requestedServiceClass,
          agentIds: selection.agentIds,
        });
      }
      const workspaceEgress = await workspaceEgressFor(value, effective, grantId, selection.profileId);
      policy = {
        ...runtimePolicyFor(
          effective,
          selection.modelAlias,
          selection.profileId,
          selection.agentIds,
          selection.applicationIds,
          workspaceEgress,
          governedRoutingAvailable ? ["lemmacomputer-auto"] : [],
        ),
        requestedServiceClass: selection.requestedServiceClass,
        allowedServiceClasses: selection.allowedServiceClasses,
      };
      if (document.maximumEgressMode === "restricted" && policy.egressMode !== "restricted") {
        throw new LemmaComputerError("EGRESS_MODE_NOT_ASSIGNED", "Full-web egress is denied by the organization policy", 403);
      }
    }
    const projected = connections ? await connections.projectConnectedConnectors(value.identity, policy) : policy;
    const organizationConnectorIds = effective?.document && Array.isArray((effective.document as Record<string, unknown>).organizationConnectorIds)
      ? (effective.document as Record<string, unknown>).organizationConnectorIds as string[]
      : null;
    const constrainedProjection = organizationConnectorIds ? (() => {
      const primaryAllowed = organizationConnectorIds.includes("microsoft-365");
      const mcpServers = [projected.mcpServer];
      const activeMcpServers = primaryAllowed
        ? (projected.activeMcpServers ?? []).filter((server) => mcpServers.includes(server))
        : [];
      const allowedTools = primaryAllowed ? projected.mcpToolPermissions?.[projected.mcpServer] ?? projected.allowedTools : projected.allowedTools;
      const toolPolicies = Object.fromEntries(allowedTools.map((tool) => [tool, primaryAllowed ? projected.toolPolicies[tool] ?? "deny" : "deny"]));
      return runtimePolicySchema.parse({
        ...projected,
        mcpServers,
        activeMcpServers,
        mcpToolPermissions: primaryAllowed ? { [projected.mcpServer]: allowedTools } : {},
        allowedTools,
        toolPolicies,
        ...(projected.agents ? { agents: projected.agents.map((agent) => ({
          ...agent,
          mcpServers,
          activeMcpServers,
          mcpToolPermissions: primaryAllowed ? { [projected.mcpServer]: allowedTools } : {},
          allowedTools,
          toolPolicies,
        })) } : {}),
      });
    })() : projected;
    return {
      principal: value,
      policy: constrainedProjection,
    };
  };
  const refreshOwnedWorkspaceConnectionGrants = async (value: SessionPrincipal) => {
    const effective = security.identityPolicyStore ? await security.identityPolicyStore.getEffectivePolicy(value.userId) : null;
    const workspaces = await store.listCurrent(value.identity);
    const receipts = await Promise.all(workspaces.map(async (workspace) => {
      if (["not_created", "stopped", "failed"].includes(workspace.state)) {
        return {
          workspaceId: workspace.id,
          ownerSubjectId: value.userId,
          grantId: workspace.grantId,
          workspaceState: workspace.state,
          outcome: "applies_on_next_start" as const,
          failureCode: null,
        };
      }
      let policy: RuntimePolicy | null = null;
      try {
        ({ policy } = await policyForGrant(value, effective, workspace.grantId));
        const refreshed = await service.refreshPolicyGrant(value.identity, policy, workspace.grantId);
        return {
          workspaceId: workspace.id,
          ownerSubjectId: value.userId,
          grantId: workspace.grantId,
          workspaceState: workspace.state,
          outcome: refreshed ? "refreshed" as const : "failed" as const,
          failureCode: refreshed ? null : "CONNECTOR_GRANT_REFRESH_NOT_CONFIRMED",
        };
      } catch (error) {
        // A connector/model gateway refresh failure must fail closed at the
        // gateway without revoking unrelated workspace-to-Control capabilities
        // such as Sites, governed uploads, or operation status.
        if (policy) await service.revokeGatewayGrants(workspace.id, policy).catch(() => undefined);
        return {
          workspaceId: workspace.id,
          ownerSubjectId: value.userId,
          grantId: workspace.grantId,
          workspaceState: workspace.state,
          outcome: "failed" as const,
          failureCode: error instanceof LemmaComputerError ? error.code : "CONNECTOR_GRANT_REFRESH_FAILED",
        };
      }
    }));
    return {
      refreshed: receipts.filter((receipt) => receipt.outcome === "refreshed").length,
      failed: receipts.filter((receipt) => receipt.outcome === "failed").length,
      appliesOnNextStart: receipts.filter((receipt) => receipt.outcome === "applies_on_next_start").length,
      receipts,
    };
  };
  const refreshTenantWorkspaceConnectionGrants = async (tenantId: string, changeEventId?: string) => {
    if (!security.identityPolicyStore) return { refreshed: 0, failed: 0, appliesOnNextStart: 0, members: [] };
    const users = await security.identityPolicyStore.listUsers(tenantId);
    const results = await Promise.allSettled(users.map(async (user) => {
      if (user.status === "disabled") return { user, refreshed: 0, failed: 0, appliesOnNextStart: 0, receipts: [] };
      const owner = await security.identityPolicyStore!.getPrincipal(user.userId);
      if (!owner || owner.tenantId !== tenantId) return { user, refreshed: 0, failed: 0, appliesOnNextStart: 0, receipts: [] };
      return { user, ...(await refreshOwnedWorkspaceConnectionGrants(owner)) };
    }));
    const fulfilled = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const rawReceipts = fulfilled.flatMap((result) => result.receipts);
    if (changeEventId && security.connectorRegistryStore && rawReceipts.length) {
      await security.connectorRegistryStore.appendPolicyWorkspaceDeliveryReceipts(rawReceipts.map((receipt) => ({
        tenantId,
        changeEventId,
        ...receipt,
      })));
    }
    return {
      refreshed: fulfilled.reduce((sum, result) => sum + result.refreshed, 0),
      failed: fulfilled.reduce((sum, result) => sum + result.failed, 0) + results.filter((result) => result.status === "rejected").length,
      appliesOnNextStart: fulfilled.reduce((sum, result) => sum + result.appliesOnNextStart, 0),
      members: fulfilled.filter((result) => result.receipts.length).map((result) => ({
        userId: result.user.userId,
        displayName: result.user.displayName,
        email: result.user.email,
        workspaces: result.receipts.map((receipt) => ({
          workspaceId: receipt.workspaceId,
          grantId: receipt.grantId,
          state: receipt.workspaceState,
          delivery: receipt.outcome,
          failureCode: receipt.failureCode,
        })),
      })),
    };
  };
  const reconcileTenantWorkspaceRoutePolicies = async (tenantId: string, routeVersionId: string, correlationId: string) => {
    const workspaces = await store.listTenantCurrent(tenantId);
    const restartableStates = new Set<WorkspaceState>(["ready", "open", "provisioning", "restarting"]);
    if (!workspaces.length) {
      return { restarted: 0, restartFailed: 0, appliesOnNextStart: 0, actionRequired: 0 };
    }
    if (!security.identityPolicyStore) {
      const stopped = await Promise.allSettled(workspaces
        .filter((workspace) => restartableStates.has(workspace.state))
        .map((workspace) => service.suspendForPolicyChange(identityContextSchema.parse({
          tenantId,
          subjectId: workspace.subjectId,
          audience: "lemmacomputer-control",
        }), workspace.id)));
      return {
        restarted: 0,
        restartFailed: stopped.filter((result) => result.status === "rejected").length,
        appliesOnNextStart: workspaces.filter((workspace) => !restartableStates.has(workspace.state)).length,
        actionRequired: workspaces.length,
      };
    }
    const users = await security.identityPolicyStore.listUsers(tenantId);
    const usersById = new Map(users.map((user) => [user.userId, user]));
    const results = await Promise.all(workspaces.map(async (workspace) => {
      const shouldRestart = restartableStates.has(workspace.state);
      const user = usersById.get(workspace.subjectId);
      const owner = user?.effectivePolicy
        ? await security.identityPolicyStore!.getPrincipal(workspace.subjectId)
        : null;
      if (!user?.effectivePolicy || !owner || owner.tenantId !== tenantId) {
        if (shouldRestart) {
          await service.suspendForPolicyChange(identityContextSchema.parse({
            tenantId,
            subjectId: workspace.subjectId,
            audience: "lemmacomputer-control",
          }), workspace.id).catch(() => undefined);
        }
        return "action_required" as const;
      }
      let policy: RuntimePolicy;
      try {
        ({ policy } = await policyForGrant(owner, user.effectivePolicy, workspace.grantId));
      } catch {
        if (shouldRestart) await service.suspendForPolicyChange(owner.identity, workspace.id).catch(() => undefined);
        return "action_required" as const;
      }
      if (!shouldRestart) return "applies_on_next_start" as const;
      try {
        await service.suspendForPolicyChange(owner.identity, workspace.id, { restartPending: true });
        await service.create(
          owner.identity,
          policy,
          workspace.grantId,
          `organization-routes:${routeVersionId}:${workspace.id}`,
          `${correlationId}:organization-routes:${workspace.id}`,
        );
        return "restarted" as const;
      } catch (error) {
        app.log.warn({ err: error, workspaceId: workspace.id }, "workspace did not restart after organization routes changed");
        return "restart_failed" as const;
      }
    }));
    return {
      restarted: results.filter((result) => result === "restarted").length,
      restartFailed: results.filter((result) => result === "restart_failed").length,
      appliesOnNextStart: results.filter((result) => result === "applies_on_next_start").length,
      actionRequired: results.filter((result) => result === "action_required").length,
    };
  };
  const usesManagedProvider = (policy: RuntimePolicy, provider: ManagedProviderName) => (
    (policy.agents === undefined
      ? policy.modelAlias ? [policy.modelAlias] : []
      : policy.agents.map((agent) => agent.modelAlias))
      .some((modelAlias) => managedProviderForAlias(modelAlias) === provider)
  );
  const revokeTenantProviderWorkspaceGrants = async (tenantId: string, provider: ManagedProviderName) => {
    if (!security.identityPolicyStore || !gateway) return { revoked: 0, failed: 0 };
    const users = await security.identityPolicyStore.listUsers(tenantId);
    const usersResult = await Promise.allSettled(users.map(async (user) => {
      if (user.status === "disabled") return { revoked: 0, failed: 0 };
      const owner = await security.identityPolicyStore!.getPrincipal(user.userId);
      const effective = owner ? await security.identityPolicyStore!.getEffectivePolicy(user.userId) : null;
      if (!owner || owner.tenantId !== tenantId || !effective) return { revoked: 0, failed: 0 };
      const workspaces = await store.listCurrent(owner.identity);
      const results = await Promise.allSettled(workspaces.map(async (workspace) => {
        const { policy } = await policyForGrant(owner, effective, workspace.grantId);
        if (!usesManagedProvider(policy, provider)) return false;
        await service.revokeGatewayGrants(workspace.id, policy);
        return true;
      }));
      return {
        revoked: results.filter((result) => result.status === "fulfilled" && result.value).length,
        failed: results.filter((result) => result.status === "rejected").length,
      };
    }));
    return usersResult.reduce((summary, result) => {
      if (result.status === "rejected") return { ...summary, failed: summary.failed + 1 };
      return {
        revoked: summary.revoked + result.value.revoked,
        failed: summary.failed + result.value.failed,
      };
    }, { revoked: 0, failed: 0 });
  };
  const requirePolicy = async (request: object) => {
    await assignedPolicy(request);
  };
  const requireWorkspacePolicy = async (request: object, workspaceId: string) => {
    requirePermission(request, "workspace.use", { type: "workspace", resourceId: workspaceId });
    const { principal: value, effective } = await assignedPolicy(request);
    const workspace = await store.getOwned(value.identity, workspaceId);
    if (!workspace) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    return { ...await policyForGrant(value, effective, workspace.grantId), workspace };
  };
  const channelPolicy = async (channelIdentity: IdentityContext, workspaceId: string) => {
    const workspace = await store.getOwned(channelIdentity, workspaceId);
    if (!workspace) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    let actor: SessionPrincipal;
    let effective: EffectivePolicy | null;
    if (security.identityPolicyStore) {
      const resolved = await security.identityPolicyStore.getPrincipal(channelIdentity.subjectId);
      if (!resolved || resolved.tenantId !== channelIdentity.tenantId) {
        throw new LemmaComputerError("CHANNEL_IDENTITY_NOT_FOUND", "The channel owner is unavailable", 403);
      }
      actor = resolved;
      effective = await security.identityPolicyStore.getEffectivePolicy(resolved.userId);
      if (!effective) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    } else if (security.testIdentityMode) {
      actor = {
        userId: channelIdentity.subjectId,
        tenantId: channelIdentity.tenantId,
        email: `${channelIdentity.subjectId}@example.test`,
        displayName: channelIdentity.subjectId,
        tenantDisplayName: channelIdentity.tenantId,
        tenantKind: "organization",
        roles: ["employee"],
        identity: channelIdentity,
      };
      effective = null;
    } else {
      throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503, true);
    }
    return { ...await policyForGrant(actor, effective, workspace.grantId), workspace };
  };
  const requireAgentInstance = async (request: { headers: Record<string, unknown> }, actor: AgentBridgeIdentity) => {
    if (!security.agentInstanceStore) return undefined;
    const raw = request.headers["x-lemmacomputer-agent-instance-id"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const agentInstanceId = z.uuid().parse(value);
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    const workspace = await store.getOwned(owner, actor.workspaceId);
    if (!workspace) throw new LemmaComputerError("AGENT_INSTANCE_INVALID", "The agent process identity is unavailable", 403);
    await agentProcesses.requireActive({ identity: owner, workspace, logicalAgentId: actor.agentId, agentInstanceId });
    return agentInstanceId;
  };
  const schedules = security.scheduleStore && security.schedulePromptSecret
    ? new ScheduleService(
        security.scheduleStore,
        new SchedulePromptVault(security.schedulePromptSecret),
        agentChat,
        async (owner, workspaceId, catalogId) => {
          const { policy } = await channelPolicy(owner, workspaceId);
          if (!assignedChatAgentIds(policy).includes(catalogId)) {
            throw new LemmaComputerError("CHAT_AGENT_NOT_SELECTED", "That agent is not selected for this workspace", 409);
          }
        },
        async (owner, workspaceId, catalogId) => {
          const { policy } = await channelPolicy(owner, workspaceId);
          return service.agentChatAccess(owner, policy, workspaceId, catalogId);
        },
        ({ identity: owner, workspaceId, agentId, taskId, sessionId, turnId, agentInstanceId }) => issueUsageTaskBinding(
          owner, workspaceId, agentId, "schedule", taskId, sessionId, turnId, "auto", agentInstanceId,
        ),
        async ({ identity: owner, workspaceId, catalogId, logicalAgentId, sessionId, runId }) => {
          const { policy, workspace } = await channelPolicy(owner, workspaceId);
          return agentProcesses.begin({
            identity: owner, workspace, policy, catalogId, logicalAgentId,
            launchKind: "schedule", sessionId, idempotencyKey: runId,
          });
        },
        security.chatStore,
        durableChat,
      )
    : undefined;
  const requireSchedules = () => {
    if (!schedules) throw new LemmaComputerError("SCHEDULER_NOT_CONFIGURED", "Scheduling is unavailable", 503, true);
    return schedules;
  };
  const verifiedChannelRoute = async (route: ChannelRoute, enforceSelectedRoute: boolean) => {
    if (!store.getOwnedChannelConnection) {
      throw new LemmaComputerError("CHANNEL_STORE_NOT_CONFIGURED", "Channel storage is unavailable", 503, true);
    }
    const connection = await store.getOwnedChannelConnection(route.identity, "telegram", route.workspaceId);
    if (
      !connection
      || connection.id !== route.connectionId
      || connection.workspaceId !== route.workspaceId
      || !connection.allowedUserIds.includes(route.externalSenderId)
    ) {
      throw new LemmaComputerError("CHANNEL_ROUTE_REJECTED", "The channel route is not authorized", 403);
    }
    if (enforceSelectedRoute) {
      const selected = await store.getChannelSenderAgent?.(connection.id, route.externalSenderId)
        ?? connection.defaultAgentId;
      if (selected !== route.agentCatalogId) {
        throw new LemmaComputerError("CHANNEL_AGENT_MISMATCH", "The channel agent route changed", 409);
      }
    }
    const { policy, workspace } = await channelPolicy(route.identity, route.workspaceId);
    if (!assignedChatAgentIds(policy).includes(route.agentCatalogId)) {
      throw new LemmaComputerError("CHAT_AGENT_NOT_SELECTED", "That chat agent is not selected for this workspace", 409);
    }
    return {
      policy,
      workspace,
      access: await service.agentChatAccess(route.identity, policy, route.workspaceId, route.agentCatalogId),
    };
  };
  const idempotency = (headers: Record<string, unknown>) => {
    const key = headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 128) throw new LemmaComputerError("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required", 400);
    return key;
  };
  const telegramIntakeIdempotency = (headers: Record<string, unknown>) => {
    const key = idempotency(headers);
    if (!/^[A-Za-z0-9._~-]{16,128}$/.test(key)) {
      throw new LemmaComputerError("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required", 400);
    }
    return key;
  };
  const browserAgentToken = (authorization: string | string[] | undefined) => {
    const value = Array.isArray(authorization) ? authorization[0] : authorization;
    const match = typeof value === "string" ? /^Bearer (ocvta_[A-Za-z0-9_-]{43})$/.exec(value) : null;
    if (!match) throw new LemmaComputerError("UNAUTHENTICATED", "Browser agent authentication is required", 401);
    return match[1];
  };

  app.post("/internal/v1/ai-usage/routing/decide",async(request,reply)=>{
    if(!routingExecution)throw new LemmaComputerError("ROUTING_NOT_CONFIGURED","Governed model routing is unavailable",503,true);const result=await routingExecution.decide(internalRoutingDecisionSchema.parse(request.body??{}));return reply.code(result.status==="created"?201:200).send(result);
  });
  app.post("/internal/v1/ai-usage/routing/verify",async(request)=>{
    if(!routingExecution)throw new LemmaComputerError("ROUTING_NOT_CONFIGURED","Governed model routing is unavailable",503,true);const body=z.strictObject({binding:z.strictObject({schemaVersion:z.literal(1),tenantId:z.string(),requestId:z.string(),decisionId:z.string(),deploymentId:z.string(),mappingVersionId:z.string(),policyVersionId:z.string(),expiresAt:z.iso.datetime(),signature:z.string()}),actual:z.strictObject({tenantId:z.string(),requestId:z.string(),deploymentId:z.string()})}).parse(request.body??{});return routingExecution.verify(body.binding,body.actual);
  });
  app.post("/internal/v1/ai-usage/routing/observations",async(request,reply)=>{
    if(!routingExecution)throw new LemmaComputerError("ROUTING_NOT_CONFIGURED","Governed model routing is unavailable",503,true);const result=await routingExecution.observe(internalRoutingObservationSchema.parse(request.body??{}));return reply.code(result.status==="created"?201:200).send(result);
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.post("/internal/v1/ai-usage/attempts/admit", async (request, reply) => {
    const result = await requireUsageLedger().service.admit(internalUsageAdmissionSchema.parse(request.body ?? {}));
    return reply.code(result.status === "created" ? 201 : 200).send(result);
  });
  app.post("/internal/v1/ai-usage/events", async (request, reply) => {
    const result = await requireUsageLedger().service.complete(internalUsageCompletionSchema.parse(request.body ?? {}));
    return reply.code(result.status === "created" ? 201 : 200).send(result);
  });
  app.post("/internal/v1/mcp/authorize", { bodyLimit: 6 * 1024 * 1024 }, async (request) => {
    if (!mcpPolicy) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "MCP policy storage is unavailable", 503, true);
    const input = mcpPolicyRequestSchema.parse(request.body ?? {});
    if (security.agentInstanceStore) {
      if (!input.agentInstanceId) throw new LemmaComputerError("AGENT_INSTANCE_REQUIRED", "Tool calls require an authoritative agent process identity", 403);
      const owner = { tenantId: input.tenantId, subjectId: input.subjectId, audience: "lemmacomputer-control" as const };
      const workspace = await store.getOwned(owner, input.workspaceId);
      if (!workspace) throw new LemmaComputerError("AGENT_INSTANCE_INVALID", "The tool-call identity is not bound to this workspace", 403);
      await agentProcesses.requireActive({ identity: owner, workspace, logicalAgentId: input.agentId, agentInstanceId: input.agentInstanceId });
    }
    const decision = await mcpPolicy.authorize(input, request.id);
    if (toolAudit) await toolAudit.admitMcp(input, decision, request.id);
    return decision;
  });
  app.post("/internal/v1/agent/tool-audit/terminal", async (request, reply) => {
    if (!toolAudit) throw new LemmaComputerError("TOOL_AUDIT_NOT_CONFIGURED", "Tool compliance auditing is unavailable", 503, true);
    const actor = agentPrincipals.get(request)!;
    const agentInstanceId = await requireAgentInstance(request, actor);
    if (!agentInstanceId) throw new LemmaComputerError("AGENT_INSTANCE_REQUIRED", "Tool calls require an authoritative agent process identity", 403);
    const body = z.strictObject({
      sourceInvocationId: z.uuid(),
      terminal: toolAuditTerminalInputSchema,
    }).parse(request.body ?? {});
    const result = await toolAudit.finalizeMcp({
      tenantId: actor.tenantId,
      subjectId: actor.subjectId,
      workspaceId: actor.workspaceId,
      agentInstanceId,
      sourceInvocationId: body.sourceInvocationId,
      ...body.terminal,
    });
    return reply.code(result.status === "created" ? 201 : 200).send(result);
  });
  app.post("/internal/v1/workspace-access/authorize", async (request) => {
    const input = z.strictObject({
      tenantId: z.string().min(1).max(200),
      subjectId: z.string().min(1).max(200),
      workspaceId: z.uuid(),
      accessGeneration: z.number().int().positive(),
    }).parse(request.body ?? {});
    return { allowed: await store.authorizeWorkspaceAccess({ ...input, audience: "lemmacomputer-control" }) };
  });
  app.post("/internal/v1/mcp-egress/authorize", async (request) => {
    const destination = z.strictObject({
      protocol: z.literal("https"),
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65_535),
    }).parse(request.body ?? {});
    return { allowed: await requireConnections().isGatewayEgressDestinationAllowed(destination) };
  });
  app.post("/internal/v1/channels/routes/validate", async (request, reply) => {
    const route = channelRouteSchema.parse(request.body ?? {});
    const { access } = await verifiedChannelRoute(route, false);
    await agentChat.health(access);
    return reply.code(204).send();
  });
  app.post("/internal/v1/channels/turns", { bodyLimit: 112 * 1024 * 1024 }, async (request, reply) => {
    const input = channelTurnRequestSchema.parse(request.body ?? {});
    const { access, policy, workspace } = await verifiedChannelRoute(input, true);
    if (!store.claimChannelUpdate || !await store.claimChannelUpdate(
      input.connectionId,
      input.updateId,
      input.externalSenderId,
    )) {
      throw new LemmaComputerError("CHANNEL_UPDATE_REPLAYED", "The channel update was already dispatched", 409);
    }
    const durable = requireDurableChat();
    const existingConversation = input.sessionId
      ? await durable.store.getConversation(input.identity, input.sessionId)
      : null;
    if (input.sessionId && (
      !existingConversation
      || existingConversation.workspaceId !== input.workspaceId
      || existingConversation.defaultAgentCatalogId !== input.agentCatalogId
    )) {
      throw new LemmaComputerError("CHAT_CONVERSATION_NOT_FOUND", "Conversation not found", 404);
    }
    const conversation = existingConversation ?? await durable.store.createConversation({
      identity: input.identity,
      workspaceId: input.workspaceId,
      defaultAgentCatalogId: input.agentCatalogId,
      title: `Telegram ${input.externalSenderId}`,
      requestedServiceClass: "balanced",
    });
    const session = { id: conversation.id };
    const history = await durable.store.listMessages(input.identity, session.id);
    const message = sendChatTurnSchema.parse({
      message: {
        id: randomUUID(),
        role: "user",
        metadata: {
          agentCatalogId: input.agentCatalogId,
          state: "completed",
          createdAt: new Date().toISOString(),
          source: "telegram",
        },
        parts: [
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
          ...(input.attachments ?? []),
        ],
      },
    }).message;
    const persistedUser = await durable.service.persistUserMessage({
      identity: input.identity,
      conversation,
      access,
      message,
    });
    const vendorSessionId = await durable.store.getVendorSession(
      input.identity,
      session.id,
      input.agentCatalogId,
    ) ?? undefined;
    const frame = (event: unknown) => `${JSON.stringify(channelTurnStreamEventSchema.parse(event))}\n`;
    const stream = async function*() {
      let text = "";
      const notices: string[] = [];
      const artifacts: Array<{ artifactId: string; revisionId: string; mediaType: string; filename: string; byteLength: number; sha256: string }> = [];
      let state: "needs_input" | "completed" | "cancelled" | "failed" = "failed";
      const accumulator = new AgentMessageAccumulator(input.agentCatalogId);
      let lifecycle: Awaited<ReturnType<AgentProcessLifecycleService["begin"]>> | undefined;
      let processStarted = false;
      let processEnded = false;
      try {
        lifecycle = await agentProcesses.begin({
          identity: input.identity, workspace, policy, catalogId: input.agentCatalogId,
          logicalAgentId: access.agentId, launchKind: "channel", sessionId: session.id,
          idempotencyKey: `${input.connectionId}:${input.updateId}`,
        });
        const agentInstanceId = lifecycle.identity.state === "verified" ? lifecycle.identity.agentInstanceId : undefined;
        const usageTaskBinding = issueUsageTaskBinding(
          input.identity, input.workspaceId, access.agentId, "channel",
          `channel:${input.connectionId}:${input.updateId}`, session.id, undefined, "auto", agentInstanceId,
        );
        for await (const event of agentChat.streamTurn(
          access, session.id, persistedUser.runtimeMessage, undefined, usageTaskBinding, agentInstanceId,
          undefined, history, vendorSessionId,
        )) {
          if (event.type === "turn-start") {
            await lifecycle.markRunning(event.turnId);
            await durable.store.beginRun({
              identity: input.identity,
              conversationId: session.id,
              turnId: event.turnId,
              effectiveAgentCatalogId: input.agentCatalogId,
              requestedServiceClass: conversation.requestedServiceClass,
              reasoningEffort: conversation.reasoningEffort,
              policyVersionId: policy.policyVersionId,
              policyVersion: policy.policyVersion,
              policyHash: policy.policyHash,
              workspaceId: input.workspaceId,
              workspaceNodeId: access.workspaceNodeId,
              accessGeneration: access.accessGeneration,
              agentInstanceId,
            });
            processStarted = true;
          }
          const projected: AgentChatEvent = event.type === "artifact"
            ? await durable.service.persistGeneratedArtifact({
                identity: input.identity,
                conversation,
                access,
                client: agentChat,
                event,
              })
            : event;
          accumulator.apply(projected);
          const checkpoint = accumulator.snapshot();
          if (checkpoint) {
            await durable.store.upsertMessage(input.identity, session.id, checkpoint);
            await durable.service.bindMessageArtifacts(input.identity, session.id, checkpoint);
          }
          if (projected.type === "progress") {
            yield frame({ type: "heartbeat" });
          }
          if (projected.type === "text-delta") {
            text += projected.delta;
            if (text.length > 16_000) {
              throw new LemmaComputerError("CHANNEL_RESPONSE_TOO_LARGE", "The channel response exceeded its limit", 502);
            }
            yield frame({ type: "text-delta", delta: projected.delta });
          }
          if (projected.type === "artifact") {
            artifacts.push({ artifactId: projected.artifactId, revisionId: projected.revisionId!, mediaType: projected.mediaType, filename: projected.filename,
              byteLength: projected.byteLength, sha256: projected.sha256 });
          }
          if (projected.type === "notice" && !notices.includes(projected.message)) {
            notices.push(projected.message);
            yield frame({ type: "notice", notice: projected.message });
          }
          if (projected.type === "approval") {
            let summary = projected.summary;
            try {
              const operation = await operations.get(input.identity, projected.operationId);
              summary = chatApprovalSummary(projected.state, operation.safeSummary);
            } catch (error) {
              if (!(error instanceof LemmaComputerError && error.code === "OPERATION_NOT_FOUND")) throw error;
            }
            const notice = `${summary.replace(/[.!?]+$/, "")}. Open LemmaComputer to review this protected action.`;
            if (!notices.includes(notice)) {
              notices.push(notice);
              yield frame({ type: "notice", notice });
            }
          }
          if (projected.type === "turn-finish") {
            state = projected.state;
            if (projected.vendorSessionId) {
              await durable.store.setVendorSession(input.identity, session.id, input.agentCatalogId, projected.vendorSessionId);
            }
            await durable.store.finishRun(input.identity, session.id, projected.turnId, {
              status: projected.state,
              assistantMessageId: checkpoint?.id,
              ...(projected.state === "failed" ? { failureCode: "AGENT_TURN_FAILED" } : {}),
              completedAt: new Date(projected.completedAt),
            });
            await lifecycle.end(projected.state === "failed" ? "provider_failed" : "process_exited");
            processEnded = true;
            if (projected.state === "failed" && !text) {
              yield frame({
                type: "error",
                code: "CHANNEL_TURN_FAILED",
                message: projected.message ?? "The agent could not complete the message",
                retryable: true,
              });
              return;
            }
          }
        }
        yield frame({
          type: "result",
          response: channelTurnResponseSchema.parse({ sessionId: session.id, text, notices, ...(artifacts.length ? { artifacts } : {}), state }),
        });
      } catch (error) {
        if (lifecycle && !processEnded) {
          try { await lifecycle.end(processStarted ? "provider_failed" : "launch_failed"); } catch (lifecycleError) { error = lifecycleError; }
        }
        const owned = error instanceof LemmaComputerError ? error : undefined;
        yield frame({
          type: "error",
          code: owned?.code ?? "CHANNEL_TURN_FAILED",
          message: owned?.message ?? "The agent could not complete the message",
          retryable: owned?.retryable ?? true,
        });
      }
    };
    return reply
      .header("content-type", "application/x-ndjson; charset=utf-8")
      .header("cache-control", "no-store")
      .send(Readable.from(stream()));
  });
  app.post("/internal/v1/channels/artifacts", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const input = channelArtifactDownloadRequestSchema.parse(request.body ?? {});
    await verifiedChannelRoute(input, false);
    const saved = await requireDurableChat().service.readArtifact(
      input.identity,
      input.artifact.artifactId,
      input.artifact.revisionId,
    );
    const data = saved.bytes;
    if (
      saved.artifact.workspaceId !== input.workspaceId
      || data.length !== input.artifact.byteLength
      || saved.revision.sha256 !== input.artifact.sha256
      || createHash("sha256").update(data).digest("hex") !== input.artifact.sha256
    ) {
      throw new LemmaComputerError("CHANNEL_ARTIFACT_MISMATCH", "The generated file changed before delivery", 409);
    }
    if (data.length > channelArtifactMaxBytes) throw new LemmaComputerError("CHANNEL_ARTIFACT_TOO_LARGE", "The generated file exceeds its delivery limit", 502);
    return reply.header("cache-control", "no-store").type(input.artifact.mediaType).send(data);
  });
  app.post("/internal/v1/schedules/runs/execute", async (request) => {
    const input = executeScheduleRunSchema.parse(request.body ?? {});
    return requireSchedules().executeClaimed(input.runId, input.leaseToken);
  });
  app.post("/internal/v1/agent/grants/renew", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const token = agentBridgeAuthority.renew(actor);
    const renewed = agentBridgeAuthority.verify(token, {
      audience: agentBridgeAudience,
      scope: "agent:renew",
    });
    return {
      token,
      expiresAt: new Date(renewed.expiresAt * 1_000).toISOString(),
    };
  });
  app.get("/internal/v1/agent/mcp-discovery-plan", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    const { policy } = await channelPolicy(owner, actor.workspaceId);
    const allowedAgentIds = new Set([policy.agentId, ...(policy.agents?.map((agent) => agent.agentId) ?? [])]);
    if (!allowedAgentIds.has(actor.agentId)) {
      throw new LemmaComputerError("MCP_POLICY_BINDING_MISMATCH", "Connector discovery is not assigned to this workspace agent", 403);
    }
    const assigned = policy.agents?.find((candidate) => candidate.agentId === actor.agentId);
    const assignedTools = assigned?.allowedTools ?? policy.allowedTools;
    const assignedToolPolicies = assigned?.toolPolicies ?? policy.toolPolicies;
    const servers = policy.activeMcpServers ?? policy.mcpServers ?? [policy.mcpServer];
    return {
      servers,
      localTools: servers.includes("lemmacomputer_ms365")
        && assignedTools.includes("list-approved-sharepoint-sites")
        && assignedToolPolicies["list-approved-sharepoint-sites"] !== "deny"
        ? ["list-approved-sharepoint-sites"]
        : [],
      projectionHash: policy.connectionProjectionHash ?? null,
    };
  });
  app.get("/internal/v1/agent/sharepoint-sites", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    await requireAgentInstance(request, actor);
    const { policy } = await channelPolicy(owner, actor.workspaceId);
    const assigned = policy.agents?.find((candidate) => candidate.agentId === actor.agentId);
    const allowedAgentIds = new Set([policy.agentId, ...(policy.agents?.map((candidate) => candidate.agentId) ?? [])]);
    const assignedTools = assigned?.allowedTools ?? policy.allowedTools;
    const assignedToolPolicies = assigned?.toolPolicies ?? policy.toolPolicies;
    if (
      !allowedAgentIds.has(actor.agentId)
      || !assignedTools.includes("list-approved-sharepoint-sites")
      || assignedToolPolicies["list-approved-sharepoint-sites"] === "deny"
    ) {
      throw new LemmaComputerError("MCP_POLICY_BINDING_MISMATCH", "SharePoint site discovery is not assigned to this workspace agent", 403);
    }
    return { sites: await requireConnections().approvedMicrosoft365SharePointSites(owner) };
  });
  app.post("/internal/v1/agent/usage-bindings", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({
      requestedServiceClass: z.enum(["auto", "lite", "balanced", "pro"]),
      requestedReasoningEffort: z.enum(["low", "medium", "high"]).optional(),
      taskId: z.string().min(1).max(256),
    }).parse(request.body ?? {});
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    const { policy } = await channelPolicy(owner, actor.workspaceId);
    const allowedAgentIds = new Set([policy.agentId, ...(policy.agents?.map((agent) => agent.agentId) ?? [])]);
    if (!allowedAgentIds.has(actor.agentId)) {
      throw new LemmaComputerError("AI_USAGE_TASK_BINDING_MISMATCH", "The route preference is not assigned to this workspace agent", 403);
    }
    const agentInstanceId = await requireAgentInstance(request, actor);
    if (input.requestedServiceClass !== "auto") {
      await requireChatServiceClass(owner, input.requestedServiceClass, policy);
    }
    const assigned = policy.agents?.find((candidate) => candidate.agentId === actor.agentId);
    const catalogId = assigned?.catalogId ?? ({
      "claude-desktop-managed-v1": "claude-desktop",
      "claude-cli-managed-v1": "claude-cli",
      "codex-cli-managed-v1": "codex-cli",
      "hermes-desktop-managed-v1": "hermes-desktop",
      "hermes-claw-managed-v1": "hermes-claw",
    } as const)[policy.agentProfile as Exclude<typeof policy.agentProfile, "lemmacomputer-default-agent">];
    if (input.requestedReasoningEffort) {
      if (!catalogId) {
        throw new LemmaComputerError("MODEL_REASONING_EFFORT_UNAVAILABLE", "This agent has no qualified thinking-effort adapter", 422);
      }
      await requireReasoningEffort(
        owner,
        policy,
        catalogId,
        input.requestedServiceClass,
        input.requestedReasoningEffort,
      );
    }
    const binding = issueUsageTaskBinding(
      owner,
      actor.workspaceId,
      actor.agentId,
      "background",
      input.taskId,
      undefined,
      undefined,
      input.requestedServiceClass,
      agentInstanceId,
      input.requestedReasoningEffort,
      policy.maximumReasoningEffort,
    );
    if (!binding) throw new LemmaComputerError("AI_USAGE_NOT_CONFIGURED", "AI usage governance is unavailable", 503, true);
    return { binding };
  });

  app.post("/internal/v1/agent/instances", async (request, reply) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({ launchNonce: z.uuid() }).parse(request.body ?? {});
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    const { policy, workspace } = await channelPolicy(owner, actor.workspaceId);
    const assigned = policy.agents?.find((candidate) => candidate.agentId === actor.agentId);
    const catalogId = assigned?.catalogId ?? (policy.agentId === actor.agentId
      ? ({ "claude-desktop-managed-v1": "claude-desktop", "claude-cli-managed-v1": "claude-cli", "codex-cli-managed-v1": "codex-cli", "hermes-desktop-managed-v1": "hermes-desktop", "hermes-claw-managed-v1": "hermes-claw" } as const)[policy.agentProfile as Exclude<typeof policy.agentProfile, "lemmacomputer-default-agent">]
      : undefined);
    if (!catalogId) throw new LemmaComputerError("AGENT_INSTANCE_POLICY_MISMATCH", "The launcher is not assigned to this workspace", 403);
    const lifecycle = await agentProcesses.begin({
      identity: owner, workspace, policy, catalogId, logicalAgentId: actor.agentId,
      launchKind: "interactive", idempotencyKey: `${actor.jti}:${input.launchNonce}`,
    });
    if (lifecycle.identity.state !== "verified") throw new LemmaComputerError("AGENT_INSTANCE_NOT_CONFIGURED", "Agent process identity is unavailable", 503, true);
    return reply.code(201).send({ agentInstanceId: lifecycle.identity.agentInstanceId });
  });
  app.post<{ Params: { agentInstanceId: string } }>("/internal/v1/agent/instances/:agentInstanceId/running", async (request) => {
    const actor = agentPrincipals.get(request)!;
    const input = z.strictObject({ providerRuntimeId: z.string().min(1).max(300), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), imageVersion: z.string().min(1).max(200).optional() }).parse(request.body ?? {});
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    const workspace = await store.getOwned(owner, actor.workspaceId);
    if (!workspace) throw new LemmaComputerError("AGENT_INSTANCE_INVALID", "Agent process identity is unavailable", 403);
    const current = await security.agentInstanceStore?.get({ tenantId: actor.tenantId, ownerSubjectId: actor.subjectId, workspaceId: actor.workspaceId, agentInstanceId: z.uuid().parse(request.params.agentInstanceId) });
    if (!current || current.logicalAgentId !== actor.agentId || current.accessGeneration !== actor.workspaceGeneration) throw new LemmaComputerError("AGENT_INSTANCE_INVALID", "Agent process identity is unknown or stale", 403);
    const updated = await security.agentInstanceStore!.markRunning({ tenantId: actor.tenantId, ownerSubjectId: actor.subjectId, workspaceId: actor.workspaceId, agentInstanceId: current.id, ...input });
    return { agentInstanceId: updated!.id, status: updated!.status };
  });
  app.post<{ Params: { agentInstanceId: string } }>("/internal/v1/agent/instances/:agentInstanceId/end", async (request) => {
    const actor = agentPrincipals.get(request)!;
    const input = z.strictObject({ reason: z.enum(["process_exited", "launch_failed", "provider_failed"]) }).parse(request.body ?? {});
    const current = await security.agentInstanceStore?.get({ tenantId: actor.tenantId, ownerSubjectId: actor.subjectId, workspaceId: actor.workspaceId, agentInstanceId: z.uuid().parse(request.params.agentInstanceId) });
    if (!current || current.logicalAgentId !== actor.agentId || current.accessGeneration !== actor.workspaceGeneration) throw new LemmaComputerError("AGENT_INSTANCE_INVALID", "Agent process identity is unknown or stale", 403);
    const updated = await security.agentInstanceStore!.end({ tenantId: actor.tenantId, ownerSubjectId: actor.subjectId, workspaceId: actor.workspaceId, agentInstanceId: current.id, reason: input.reason });
    return { agentInstanceId: updated!.id, status: updated!.status };
  });

  app.post("/internal/v1/agent/sites", { bodyLimit: 800 * 1024 }, async (request, reply) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    const { policy } = await channelPolicy(owner, actor.workspaceId);
    const allowedAgentIds = new Set([policy.agentId, ...(policy.agents?.map((agent) => agent.agentId) ?? [])]);
    if (!allowedAgentIds.has(actor.agentId)) {
      throw new LemmaComputerError("SITE_POLICY_BINDING_MISMATCH", "Publishing is not assigned to this workspace agent", 403);
    }
    const input = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    const site = await requireSites().publish(owner, {
      ...input,
      sourceWorkspaceId: actor.workspaceId,
      sourceAgentId: actor.agentId,
    });
    return reply.code(201).send(site);
  });

  app.get<{ Params: { operationId: string } }>("/internal/v1/agent/operations/:operationId", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const agentInstanceId = await requireAgentInstance(request, actor);
    return operations.getForAgent(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId, agentInstanceId },
    );
  });
  app.post("/internal/v1/agent/uploads", async (request, reply) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({
      driveId: z.string().trim().min(1).max(512),
      driveItemId: z.string().trim().min(1).max(512),
      fileName: z.string().trim().min(1).max(255),
      size: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      idempotencyKey: z.string().min(16).max(128),
    }).parse(request.body ?? {});
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    const agentInstanceId = await requireAgentInstance(request, actor);
    const { policy } = await channelPolicy(owner, actor.workspaceId);
    const allowedAgentIds = new Set([policy.agentId, ...(policy.agents?.map((agent) => agent.agentId) ?? [])]);
    if (
      !allowedAgentIds.has(actor.agentId)
      || !policy.allowedTools.includes("upload-file-content")
      || policy.toolPolicies["upload-file-content"] !== "approval_required"
    ) {
      throw new LemmaComputerError("MCP_POLICY_BINDING_MISMATCH", "The upload is not assigned to this workspace agent", 403);
    }
    const operation = await operations.createMicrosoft365Operation(
      owner,
      actor.workspaceId,
      {
        capabilityId: resumableUploadCapability.capabilityId,
        schemaId: resumableUploadCapability.schemaId,
        serverName: "lemmacomputer_ms365",
        toolName: "create-upload-session",
        arguments: {
          driveId: input.driveId,
          driveItemId: input.driveItemId,
          body: { item: { "@microsoft.graph.conflictBehavior": "replace" } },
          lemmacomputerFile: { name: input.fileName, size: input.size, sha256: input.sha256 },
          confirm: true,
        },
        displayName: "Upload large OneDrive file",
        safeSummary: `Upload ${input.fileName} (${input.size} bytes) to OneDrive`,
        resourceName: input.fileName,
        resourceLocation: "OneDrive",
      },
      actor.agentId,
      { policyVersionId: policy.policyVersionId, policyHash: policy.policyHash },
      input.idempotencyKey,
      request.id,
      false,
      agentInstanceId,
    );
    return reply.code(201).send(operation);
  });
  app.post("/internal/v1/agent/deletions", async (request, reply) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({
      driveId: z.string().trim().min(1).max(512),
      driveItemId: z.string().trim().min(1).max(512),
      resourceName: z.string().trim().min(1).max(255),
      "If-Match": z.string().trim().min(1).max(512),
      idempotencyKey: z.string().min(16).max(128),
    }).parse(request.body ?? {});
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    const agentInstanceId = await requireAgentInstance(request, actor);
    const { policy } = await channelPolicy(owner, actor.workspaceId);
    const allowedAgentIds = new Set([policy.agentId, ...(policy.agents?.map((agent) => agent.agentId) ?? [])]);
    if (
      !allowedAgentIds.has(actor.agentId)
      || !policy.allowedTools.includes("delete-onedrive-file")
      || policy.toolPolicies["delete-onedrive-file"] !== "approval_required"
    ) {
      throw new LemmaComputerError("MCP_POLICY_BINDING_MISMATCH", "OneDrive deletion is not assigned to this workspace agent", 403);
    }
    const capability = m365CapabilityDefinitions["delete-onedrive-file"];
    const operation = await operations.createMicrosoft365Operation(
      owner,
      actor.workspaceId,
      {
        capabilityId: capability.capabilityId,
        schemaId: capability.schemaId,
        serverName: "lemmacomputer_ms365",
        toolName: "delete-onedrive-file",
        arguments: {
          driveId: input.driveId,
          driveItemId: input.driveItemId,
          "If-Match": input["If-Match"],
          confirm: true,
          excludeResponse: true,
        },
        displayName: "Delete OneDrive file",
        safeSummary: `Delete ${input.resourceName} from OneDrive`,
        resourceName: input.resourceName,
        resourceLocation: "OneDrive",
      },
      actor.agentId,
      { policyVersionId: policy.policyVersionId, policyHash: policy.policyHash },
      input.idempotencyKey,
      request.id,
      false,
      agentInstanceId,
    );
    return reply.code(201).send(operation);
  });
  app.post<{ Params: { operationId: string } }>("/internal/v1/agent/uploads/:operationId/begin", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const agentInstanceId = await requireAgentInstance(request, actor);
    return operations.beginResumableUpload(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId, agentInstanceId },
      request.id,
    );
  });
  app.post<{ Params: { operationId: string } }>("/internal/v1/agent/uploads/:operationId/complete", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({ leaseId: z.uuid() }).parse(request.body ?? {});
    const agentInstanceId = await requireAgentInstance(request, actor);
    return operations.completeResumableUpload(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId, agentInstanceId },
      input.leaseId,
      request.id,
    );
  });
  app.post<{ Params: { operationId: string } }>("/internal/v1/agent/uploads/:operationId/fail", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({ leaseId: z.uuid() }).parse(request.body ?? {});
    const agentInstanceId = await requireAgentInstance(request, actor);
    return operations.failResumableUpload(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId, agentInstanceId },
      input.leaseId,
      request.id,
    );
  });
  app.get("/v1/auth/session", async (request) => {
    const current = principal(request);
    const effectivePolicy = security.identityPolicyStore ? await security.identityPolicyStore.getEffectivePolicy(current.userId) : null;
    const capabilities = organizationPermissions.filter((permission) => allowsPermission(current, permission));
    const resourceCapabilities = current.effectiveAuthorization?.valid
      ? current.effectiveAuthorization.grants.filter((grant) => grant.scope.type !== "organization")
      : [];
    const memberships = current.accountUserId && security.identityPolicyStore?.listCustomerMemberships
      ? await security.identityPolicyStore.listCustomerMemberships(current.accountUserId)
      : [];
    return {
      user: { id: current.userId, email: current.email, displayName: current.displayName },
      tenant: { id: current.tenantId, displayName: current.tenantDisplayName, kind: current.tenantKind },
      memberships,
      organizationCreationAvailable:
        (connectionOptions.installationKind ?? "customer-managed") !== "customer-managed",
      roles: current.roles,
      capabilities,
      resourceCapabilities,
      effectivePolicy,
    };
  });
  app.get("/v1/auth/customer-capabilities", async (_request, reply) => {
    if (!security.customerAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
    }
    const options = security.customerAuthentication.options;
    return reply.header("cache-control", "no-store").send({
      emailPassword: options.emailAndPassword?.enabled === true,
      passkey: options.plugins?.some((plugin) => plugin.id === "passkey") === true,
      socialProviders: Object.keys(options.socialProviders ?? {}).sort(),
      companySso: Boolean(security.tenantSsoAdministration),
      ...(security.developmentEmailCapture ? { developmentEmailCapture: true } : {}),
    });
  });
  app.post("/v1/auth/development-email-capture", async (request, reply) => {
    if (!security.developmentEmailCapture || !connectionOptions.publicWebUrl) {
      throw new LemmaComputerError("DEVELOPMENT_EMAIL_CAPTURE_UNAVAILABLE", "Development email capture is unavailable", 404);
    }
    const publicOrigin = new URL(connectionOptions.publicWebUrl).origin;
    if (request.headers.origin !== publicOrigin) {
      throw new LemmaComputerError("FORBIDDEN", "Development email capture requires the worktree Web origin", 403);
    }
    const input = z.strictObject({
      email: z.email().max(320).transform((value) => value.toLowerCase()),
      kind: z.enum(["email-verification", "password-recovery"]),
    }).parse(request.body ?? {});
    const message = security.developmentEmailCapture.takeLatest(input.email, input.kind);
    if (!message) {
      throw new LemmaComputerError("DEVELOPMENT_EMAIL_NOT_FOUND", "No captured development email is available", 404);
    }
    const actionUrl = message.text.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//.test(line));
    if (!actionUrl || new URL(actionUrl).origin !== publicOrigin) {
      throw new LemmaComputerError("DEVELOPMENT_EMAIL_INVALID", "The captured development email is invalid", 500);
    }
    return reply.header("cache-control", "no-store").send({ url: actionUrl });
  });
  app.post("/v1/auth/customer-sso", async (request, reply) => {
    const tenantSsoAdministration = security.tenantSsoAdministration;
    if (!tenantSsoAdministration) {
      throw new LemmaComputerError("COMPANY_SSO_UNAVAILABLE", "Company SSO is unavailable", 404);
    }
    const input = z.strictObject({
      email: z.email().max(320).transform((value) => value.toLowerCase()),
      returnPath: z.enum(["/", "/invite"]).default("/"),
    }).parse(request.body ?? {});
    const requestHeaders = fromNodeHeaders(request.raw.headers);
    const started = input.returnPath === "/invite"
      ? await (async () => {
          if (!security.customerProductAuthentication) {
            throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
          }
          const contextToken = invitationContextFromCookie(request.headers.cookie);
          if (!contextToken) {
            throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
          }
          const invitation = await security.customerProductAuthentication.getInvitationSsoContext(contextToken, input.email);
          return tenantSsoAdministration.startInvitationSignIn(
            requestHeaders,
            invitation.organizationId,
            invitation.email,
          );
        })()
      : await tenantSsoAdministration.startEnforcedSignIn(requestHeaders, input.email, "/");
    if (started.cookies.length) reply.header("set-cookie", started.cookies);
    return reply.header("cache-control", "no-store").send({ location: started.location });
  });
  app.get("/v1/auth/product-session", async (request, reply) => {
    if (!security.customerProductAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
    }
    const resolution = await security.customerProductAuthentication.resolve(fromNodeHeaders(request.raw.headers));
    if (resolution.status === "anonymous") {
      throw new LemmaComputerError("UNAUTHENTICATED", "Authentication is required", 401);
    }
    return reply.header("cache-control", "no-store").send({
      status: resolution.status,
      account: { id: resolution.accountUserId },
      user: resolution.user,
      memberships: resolution.memberships,
      personalTenantAvailable:
        (connectionOptions.installationKind ?? "customer-managed") !== "customer-managed",
      ...(resolution.status === "authorized" ? {
        activeMembership: {
          id: resolution.principal.membershipId,
          organizationId: resolution.principal.organizationId,
        },
      } : {}),
    });
  });
  app.put<{ Body: { membershipId: string } }>("/v1/auth/product-session", async (request, reply) => {
    if (!security.customerProductAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
    }
    const input = z.strictObject({ membershipId: z.uuid() }).parse(request.body ?? {});
    const selected = await security.customerProductAuthentication.selectMembership(
      fromNodeHeaders(request.raw.headers),
      input.membershipId,
    );
    return reply.header("cache-control", "no-store").send({
      membership: {
        id: selected.membershipId,
        organizationId: selected.organizationId,
        status: selected.membershipStatus,
        role: selected.role,
      },
    });
  });
  app.post<{ Headers: { "idempotency-key"?: string } }>("/v1/auth/personal-tenant", async (request, reply) => {
    if (!security.customerProductAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
    }
    const idempotencyKey = z.uuid().parse(request.headers["idempotency-key"]);
    const created = await security.customerProductAuthentication.createPersonalTenant(
      fromNodeHeaders(request.raw.headers),
      { idempotencyKey },
    );
    return reply
      .header("cache-control", "no-store")
      .code(created.replayed ? 200 : 201)
      .send(created);
  });
  app.post<{ Body: { displayName: string }; Headers: { "idempotency-key"?: string } }>(
    "/v1/auth/organizations",
    async (request, reply) => {
      if (!security.customerProductAuthentication) {
        throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
      }
      const input = z.strictObject({
        displayName: z.string().min(1).max(200),
      }).parse(request.body ?? {});
      const idempotencyKey = z.uuid().parse(request.headers["idempotency-key"]);
      const created = await security.customerProductAuthentication.createOrganization(
        fromNodeHeaders(request.raw.headers),
        { ...input, idempotencyKey },
      );
      return reply
        .header("cache-control", "no-store")
        .code(created.replayed ? 200 : 201)
      .send(created);
    },
  );
  app.post<{ Body: { token: string } }>("/v1/auth/invitations/context", async (request, reply) => {
    if (!security.customerProductAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
    }
    const input = z.strictObject({ token: z.string().min(36).max(260) }).parse(request.body ?? {});
    const prepared = await security.customerProductAuthentication.prepareInvitation(input.token);
    const secure = new URL(connectionOptions.publicWebUrl ?? "http://localhost:4174").protocol === "https:";
    const attributes = [
      `${invitationContextCookieName}=${encodeURIComponent(prepared.contextToken)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${customerInvitationContextMaxAgeSeconds}`,
      ...(secure ? ["Secure"] : []),
    ];
    return reply.header("cache-control", "no-store").header("set-cookie", attributes.join("; ")).send({
      organizationDisplayName: prepared.organizationDisplayName,
      email: prepared.email,
      role: prepared.role,
      companySsoAvailable: security.tenantSsoAdministration?.isInvitationSignInAvailable
        ? await security.tenantSsoAdministration.isInvitationSignInAvailable(prepared.organizationId, prepared.email)
        : false,
      expiresAt: prepared.expiresAt,
    });
  });
  app.get("/v1/auth/invitations/context", async (request, reply) => {
    if (!security.customerProductAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
    }
    const contextToken = invitationContextFromCookie(request.headers.cookie);
    if (!contextToken) {
      throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
    }
    const context = await security.customerProductAuthentication.getInvitationContext(contextToken);
    return reply.header("cache-control", "no-store").send({
      organizationDisplayName: context.organizationDisplayName,
      email: context.email,
      role: context.role,
      companySsoAvailable: security.tenantSsoAdministration?.isInvitationSignInAvailable
        ? await security.tenantSsoAdministration.isInvitationSignInAvailable(context.organizationId, context.email)
        : false,
      expiresAt: context.expiresAt,
    });
  });
  app.post("/v1/auth/invitations/accept", async (request, reply) => {
    if (!security.customerProductAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
    }
    const contextToken = invitationContextFromCookie(request.headers.cookie);
    if (!contextToken) {
      throw new LemmaComputerError("INVITATION_SIGNIN_FAILED", "This invitation cannot be used to sign in", 403);
    }
    const accepted = await security.customerProductAuthentication.acceptInvitation(
      fromNodeHeaders(request.raw.headers),
      contextToken,
    );
    const secure = new URL(connectionOptions.publicWebUrl ?? "http://localhost:4174").protocol === "https:";
    const clearCookie = [
      `${invitationContextCookieName}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
      ...(secure ? ["Secure"] : []),
    ];
    return reply.header("cache-control", "no-store").header("set-cookie", clearCookie.join("; ")).send({
      organization: { id: accepted.organizationId, displayName: accepted.tenantDisplayName },
      membership: { id: accepted.membershipId, role: accepted.role, status: accepted.membershipStatus },
    });
  });
  app.post<{ Body: { code: string } }>("/v1/auth/owner-step-up", async (request, reply) => {
    if (!security.customerAuthentication || !security.customerProductAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
    }
    const input = z.strictObject({ code: z.string().regex(/^\d{6}$/) }).parse(request.body ?? {});
    const verificationUrl = new URL(
      `${customerAuthenticationBasePath}/two-factor/verify-totp`,
      security.customerAuthentication.options.baseURL as string,
    );
    const verificationResponse = await security.customerAuthentication.handler(new Request(verificationUrl, {
      method: "POST",
      headers: fromNodeHeaders(request.raw.headers),
      body: JSON.stringify({ code: input.code, trustDevice: false }),
    }));
    if (!verificationResponse.ok) {
      throw new LemmaComputerError("OWNER_STEP_UP_INVALID", "The authenticator code was not accepted", 401);
    }
    const proof = await security.customerProductAuthentication.recordRecentStepUp(fromNodeHeaders(request.raw.headers));
    request.log.info({
      event: "customer_authentication_security_event",
      action: "organization.owner_step_up",
      outcome: "succeeded",
      accountUserId: proof.accountUserId,
      authenticationSessionId: proof.authenticationSessionId,
    }, "customer authentication security event");
    return reply.header("cache-control", "no-store").send({
      verifiedAt: proof.recentStepUpAt.toISOString(),
      validForSeconds: recentAuthenticationStepUpWindowMs / 1_000,
    });
  });
  app.delete("/v1/auth/product-session", async (request, reply) => {
    if (!security.customerProductAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "Customer authentication is unavailable", 404);
    }
    await security.customerProductAuthentication.clearCurrentOrganizationSelection(fromNodeHeaders(request.raw.headers));
    return reply.code(204).send();
  });
  app.post("/v1/auth/logout", async (request, reply) => {
    await security.customerProductAuthentication?.revokeCurrentSession(fromNodeHeaders(request.raw.headers));
    return reply.code(204).send();
  });
  app.get("/v1/teams/default", async (request, reply) => {
    const actor = principal(request);
    reply.header("cache-control", "no-store");
    return {
      team: await requireTeams().getCurrentDefaultSpendingTeam(actor.tenantId, actor.userId),
    };
  });
  const usageQueryFor = (tenantId: string, query: unknown) => {
    const parsed = adminUsageQuerySchema.parse(query);
    return {
      tenantId, from: new Date(parsed.from), to: new Date(parsed.to), limit: parsed.limit,
      ...(parsed.cursor ? { cursor: decodeUsageCursor(parsed.cursor) } : {}),
      ...(parsed.teamId ? { teamId: parsed.teamId } : {}),
      ...(parsed.subjectId ? { subjectId: parsed.subjectId } : {}),
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
      ...(parsed.provider ? { provider: parsed.provider } : {}),
    };
  };
  const requireUsageQueryPermission = (
    request: object,
    permission: "usage.read" | "usage.manage",
    query: { workspaceId?: string; provider?: string },
  ) => {
    const actor = principal(request);
    if (query.workspaceId && allowsPermission(actor, permission, { type: "workspace", resourceId: query.workspaceId })) return actor;
    if (query.provider && allowsPermission(actor, permission, { type: "provider", resourceId: query.provider })) return actor;
    return requirePermission(request, permission);
  };
  app.get("/v1/admin/ai-usage/events", async (request, reply) => {
    const query = usageQueryFor(principal(request).tenantId, request.query);
    const actor = requireUsageQueryPermission(request, "usage.read", query);
    const result = await requireUsageLedger().store.listUsageEvents({ ...query, tenantId: actor.tenantId });
    reply.header("cache-control", "no-store");
    return { events: result.events, nextCursor: encodeUsageCursor(result.nextCursor) };
  });
  app.get("/v1/admin/ai-usage/totals", async (request, reply) => {
    const query = usageQueryFor(principal(request).tenantId, request.query);
    const actor = requireUsageQueryPermission(request, "usage.read", query);
    const { limit: _limit, cursor: _cursor, ...totalsQuery } = query;
    reply.header("cache-control", "no-store");
    return { totals: await requireUsageLedger().store.providerCostTotals(totalsQuery) };
  });
  app.get("/v1/admin/ai-usage/export.csv", async (request, reply) => {
    const query = usageQueryFor(principal(request).tenantId, request.query);
    const actor = requireUsageQueryPermission(request, "usage.read", query);
    const result = await requireUsageLedger().store.listUsageEvents({ ...query, limit: Math.min(query.limit, 500) });
    const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const header = ["occurred_at","event_id","team","cost_center","subject","task","context","alias","provider","model","deployment","cost","currency","price_status"];
    const rows = result.events.map((event) => [event.occurredAt,event.id,event.teamDisplayName,event.costCenterCode,event.subjectId,event.taskId,event.contextKind,event.requestedAlias,event.resolvedProvider,event.resolvedModel,event.resolvedDeploymentId,event.providerCost,event.currency,event.priceStatus].map(csv).join(","));
    return reply.header("cache-control", "no-store")
      .header("x-lemmacomputer-export-complete", result.nextCursor ? "false" : "true")
      .header("x-lemmacomputer-export-next-cursor", encodeUsageCursor(result.nextCursor) ?? "")
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", "attachment; filename=ai-usage.csv")
      .send(`${header.join(",")}\n${rows.join("\n")}\n`);
  });
  app.get<{ Querystring: { provider?: string } }>("/v1/admin/ai-usage/rate-cards", async (request, reply) => {
    const provider = request.query.provider ? z.string().trim().min(1).max(200).parse(request.query.provider) : undefined;
    const actor = provider
      ? requirePermission(request, "usage.read", { type: "provider", resourceId: provider })
      : requirePermission(request, "usage.read");
    reply.header("cache-control", "no-store");
    const rateCards = await requireUsageLedger().store.listRateCards(actor.tenantId);
    return { rateCards: provider ? rateCards.filter((card) => card.provider === provider) : rateCards };
  });
  app.post("/v1/admin/ai-usage/rate-cards", async (request, reply) => {
    const input = adminRateCardSchema.parse(request.body ?? {});
    const actor = requirePermission(request, "usage.manage", { type: "provider", resourceId: input.provider });
    const id = await requireUsageLedger().store.createRateCard({
      tenantId: actor.tenantId, provider: input.provider, providerAccountId: input.providerAccountId,
      baseModel: input.baseModel, deploymentId: input.deploymentId,
      ...(input.region ? { region: input.region } : {}),
      ...(input.providerServiceTier ? { providerServiceTier: input.providerServiceTier } : {}),
      currency: input.currency, source: input.source, sourceVersion: input.sourceVersion, sourceHash: input.sourceHash,
      effectiveFrom: new Date(input.effectiveFrom), ...(input.effectiveTo ? { effectiveTo: new Date(input.effectiveTo) } : {}),
      approvedBy: actor.userId, ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}), rates: input.rates as RateAmount[],
    });
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ id });
  });
  app.post("/v1/admin/ai-usage/reconciliation-runs", async (request, reply) => {
    const actor = requirePermission(request, "usage.manage");
    const input = adminReconciliationSchema.parse(request.body ?? {});
    const result = await requireUsageLedger().store.reconcile({
      tenantId: actor.tenantId, sourceSystem: input.sourceSystem,
      windowStart: new Date(input.windowStart), windowEnd: new Date(input.windowEnd),
      expected: input.expected, startedBy: actor.userId,
    });
    reply.header("cache-control", "no-store");
    return reply.code(201).send(result);
  });
  app.get<{ Querystring: { includeArchived?: string } }>("/v1/admin/teams", async (request) => {
    const actor = requirePermission(request, "usage.read");
    return {
      teams: await requireTeams().listTeams(actor.tenantId, request.query.includeArchived === "true"),
    };
  });
  app.get("/v1/admin/spend", async (request, reply) => {
    const { actor } = requireSpendObservability(request);
    const query = parseSpendQuery(request.query);
    const report = await readSpendReport(actor.tenantId, query.range);
    reply.header("cache-control", "no-store");
    return paginateSpendReport(report, query);
  });
  app.get("/v1/me/ai-usage", async (request, reply) => {
    const actor = principal(request);
    if (!security.spendObservabilityStore) {
      throw new LemmaComputerError("PERSONAL_AI_USAGE_NOT_CONFIGURED", "Your AI usage overview is unavailable", 503, true);
    }
    const range = {
      ...parsePersonalAiUsageQuery(request.query),
      userId: actor.userId,
    };
    const report = await readSpendReport(actor.tenantId, range);
    const providers = await security.providerSettingsStore?.listProviderSettings(actor.tenantId) ?? [];
    reply.header("cache-control", "private, no-store");
    return { report: personalAiUsageReport(report, providers) };
  });
  app.post("/v1/admin/spend/cost-coverage/acknowledgements", async (request, reply) => {
    const { actor, store: spendStore } = requireSpendObservability(request);
    const input = parseUnpricedUsageAcknowledgement(request.body);
    const acknowledgement = await spendStore.acknowledgeUnpricedUsage({
      tenantId: actor.tenantId,
      receivedBefore: input.receivedBefore,
      acknowledgedBy: actor.userId,
    });
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ acknowledgement });
  });
  app.get<{ Params: { taskKey: string } }>("/v1/admin/spend/tasks/:taskKey", async (request, reply) => {
    const { actor, store: spendStore } = requireSpendObservability(request);
    const query = parseSpendQuery(request.query);
    const task = await spendStore.task(actor.tenantId, request.params.taskKey, query.range);
    if (!task) throw new LemmaComputerError("SPEND_VIEW_NOT_FOUND", "Spend view not found", 404);
    reply.header("cache-control", "no-store");
    return { task };
  });
  app.get("/v1/admin/spend/export", async (request, reply) => {
    const { actor } = requireSpendObservability(request);
    const query = parseSpendQuery(request.query);
    const report = await readSpendReport(actor.tenantId, query.range);
    reply.header("cache-control", "no-store");
    if (query.format === "json") {
      reply.header("content-disposition", "attachment; filename=\"lemmacomputer-ai-spend.json\"");
      return { tenantId: actor.tenantId, report };
    }
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", "attachment; filename=\"lemmacomputer-ai-spend.csv\"")
      .send(spendReportCsv(report, actor.tenantId));
  });
  app.post("/v1/admin/teams", async (request, reply) => {
    const actor = requirePermission(request, "usage.manage");
    const input = createTeamSchema.parse(request.body ?? {});
    const team = await requireTeams().createTeam({
      tenantId: actor.tenantId,
      createdBy: actor.userId,
      ...input,
      costCenterCode: input.costCenterCode ?? null,
    });
    return reply.code(201).send({ team });
  });
  app.get<{ Params: { teamId: string } }>("/v1/admin/teams/:teamId", async (request) => {
    const actor = requirePermission(request, "usage.read");
    const team = await requireTeams().getTeam(actor.tenantId, z.uuid().parse(request.params.teamId));
    if (!team) throw new LemmaComputerError("TEAM_NOT_FOUND", "Team not found", 404);
    return { team };
  });
  app.patch<{ Params: { teamId: string } }>("/v1/admin/teams/:teamId", async (request) => {
    const actor = requirePermission(request, "usage.manage");
    const input = updateTeamSchema.parse(request.body ?? {});
    return {
      team: await requireTeams().updateTeam({
        tenantId: actor.tenantId,
        teamId: z.uuid().parse(request.params.teamId),
        updatedBy: actor.userId,
        ...input,
      }),
    };
  });
  app.post<{ Params: { teamId: string } }>("/v1/admin/teams/:teamId/archive", async (request) => {
    const actor = requirePermission(request, "usage.manage");
    return {
      team: await requireTeams().archiveTeam({
        tenantId: actor.tenantId,
        teamId: z.uuid().parse(request.params.teamId),
        archivedBy: actor.userId,
      }),
    };
  });
  app.post<{ Params: { teamId: string } }>("/v1/admin/teams/:teamId/memberships", async (request, reply) => {
    const actor = requirePermission(request, "usage.manage");
    const input = assignTeamMembershipSchema.parse(request.body ?? {});
    const membership = await requireTeams().assignMembership({
      tenantId: actor.tenantId,
      teamId: z.uuid().parse(request.params.teamId),
      userId: input.userId,
      assignedBy: actor.userId,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
      makeDefault: input.makeDefault,
    });
    return reply.code(201).send({ membership });
  });
  app.delete<{ Params: { teamId: string; userId: string } }>("/v1/admin/teams/:teamId/memberships/:userId", async (request, reply) => {
    const actor = requirePermission(request, "usage.manage");
    const removed = await requireTeams().removeMembership({
      tenantId: actor.tenantId,
      teamId: z.uuid().parse(request.params.teamId),
      userId: z.string().min(1).max(200).parse(request.params.userId),
      removedBy: actor.userId,
    });
    return removed ? reply.code(204).send() : reply.code(404).send({
      error: { code: "TEAM_MEMBERSHIP_NOT_FOUND", message: "Active Team membership not found", correlationId: request.id, retryable: false },
    });
  });
  app.put<{ Params: { teamId: string } }>("/v1/admin/teams/:teamId/default", async (request) => {
    const actor = requirePermission(request, "usage.manage");
    const input = setDefaultSpendingTeamSchema.parse(request.body ?? {});
    return {
      team: await requireTeams().setDefaultSpendingTeam({
        tenantId: actor.tenantId,
        teamId: z.uuid().parse(request.params.teamId),
        userId: input.userId,
        assignedBy: actor.userId,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
      }),
    };
  });
  app.get("/v1/admin/teams-audit", async (request) => {
    const actor = requirePermission(request, "audit.read");
    return { events: await requireTeams().listAuditEvents(actor.tenantId) };
  });
  app.get("/v1/admin/tool-audit", async (request, reply) => {
    const actor = requirePermission(request, "audit.read");
    if (!toolAudit) throw new LemmaComputerError("TOOL_AUDIT_NOT_CONFIGURED", "Tool compliance history is unavailable", 503, true);
    return reply.header("cache-control", "no-store").send(
      await toolAudit.query(actor.tenantId, request.query as Record<string, unknown>),
    );
  });
  app.get<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/budget",async(request)=>{
    const actor=requirePermission(request,"usage.read");return{status:await requireBudgets().get(actor,z.uuid().parse(request.params.teamId))};
  });
  app.put<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/budget",async(request)=>{
    const actor=requirePermission(request,"usage.manage");return requireBudgets().save(actor,z.uuid().parse(request.params.teamId),saveTeamBudgetSchema.parse(request.body??{}));
  });
  app.post<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/budget/override",async(request)=>{
    const actor=requirePermission(request,"usage.manage");return requireBudgets().override(actor,z.uuid().parse(request.params.teamId),budgetOverrideSchema.parse(request.body??{}));
  });
  app.post<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/budget/reconcile",async(request)=>{
    const actor=requirePermission(request,"usage.manage");return{reconciliation:await requireBudgets().sync(actor,z.uuid().parse(request.params.teamId))};
  });
  app.get("/v1/admin/routing/mappings/latest",async(request,reply)=>{
    const actor=requirePermission(request,"provider.manage");
    reply.header("cache-control","no-store");
    return {mapping:await requireRouting().latestMapping(actor)};
  });
  app.post("/v1/admin/routing/mappings",async(request,reply)=>{
    const actor=requirePermission(request,"provider.manage");const mapping=await requireRouting().createMapping(actor,createRoutingMappingSchema.parse(request.body??{}));
    const workspaceActivation=await reconcileTenantWorkspaceRoutePolicies(actor.tenantId,mapping.id,request.id);
    reply.header("cache-control","no-store");return reply.code(201).send({mapping,workspaceActivation});
  });
  app.get<{Params:{decisionId:string}}>("/v1/admin/routing/decisions/:decisionId",async(request,reply)=>{const actor=requirePermission(request,"audit.read");const decision=await requireRouting().decision(actor,z.uuid().parse(request.params.decisionId));if(!decision)return reply.code(404).send({error:{code:"ROUTING_DECISION_NOT_FOUND",message:"Routing decision not found",correlationId:request.id,retryable:false}});return decision;});
  app.get("/v1/admin/users", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const users = await security.identityPolicyStore.listUsers(actor.tenantId);
    const publishedServiceClasses = await publishedWorkspaceServiceClassesFor(actor.tenantId);
    const governedRoutingAvailable = Boolean(publishedServiceClasses?.length);
    return {
      delegableBuiltInRoles: delegableBuiltInRolesFor(actor),
      users: await Promise.all(users.map(async (user) => {
        const targetIdentity = identityContextSchema.parse({
          tenantId: actor.tenantId,
          subjectId: user.userId,
          audience: "lemmacomputer-control",
        });
        const workspaces = (await store.listCurrent(targetIdentity)).filter((workspace) => (
          allowsPermission(actor, "workspace.manage", { type: "workspace", resourceId: workspace.id })
        ));
        return {
          ...user,
          workspaces: await Promise.all(workspaces.map(async (workspace) => {
            const settings = await store.getSandboxSettings?.(targetIdentity, workspace.grantId);
            const userDocument = user.effectivePolicy?.document as Record<string, unknown> | undefined;
            const profileId = (settings?.profileId
              ?? (Array.isArray(userDocument?.workspaceProfiles) ? userDocument.workspaceProfiles.find((candidate) => sandboxProfiles.some((profile) => profile.id === candidate)) : undefined)
              ?? userDocument?.workspaceProfile
              ?? testRuntimePolicy.workspaceProfile) as SandboxProfileId;
            const workspaceEgress = await workspaceEgressFor({
              ...actor,
              userId: user.userId,
              identity: targetIdentity,
            }, user.effectivePolicy, workspace.grantId, profileId);
            const runtime = user.effectivePolicy
              ? runtimePolicyFor(
                  user.effectivePolicy,
                  settings?.modelAlias,
                  settings?.profileId,
                  settings?.agentIds,
                  settings?.applicationIds,
                  workspaceEgress,
                  governedRoutingAvailable ? ["lemmacomputer-auto"] : [],
                )
              : null;
            return {
              id: workspace.id,
              grantId: workspace.grantId,
              state: workspace.state,
              profileId: runtime?.workspaceProfile ?? settings?.profileId ?? null,
              executionMode: runtime?.executionMode ?? null,
              egressMode: runtime?.egressMode ?? null,
              egress: runtime?.egress ?? null,
            };
          })),
        };
      })),
    };
  });
  app.get("/v1/admin/member-workspaces", async (request, reply) => {
    const actor = principal(request);
    if (!hasAnyPermissionGrant(actor, "workspace.manage")) {
      throw new LemmaComputerError("FORBIDDEN", "Your organization role does not allow this action", 403);
    }
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const users = await security.identityPolicyStore.listUsers(actor.tenantId);
    const organizationPolicy = await security.protectedWorkspacePolicy?.currentOrganizationPolicy?.(actor.tenantId) ?? null;
    const publishedServiceClasses = await publishedWorkspaceServiceClassesFor(actor.tenantId);
    const governedRoutingAvailable = Boolean(publishedServiceClasses?.length);
    const managesOrganization = allowsPermission(actor, "workspace.manage");
    const members = (await Promise.all(users.map(async (user) => {
      const targetIdentity = identityContextSchema.parse({
        tenantId: actor.tenantId,
        subjectId: user.userId,
        audience: "lemmacomputer-control",
      });
      const targetPrincipal = { ...actor, userId: user.userId, identity: targetIdentity };
      const targetEffective = user.effectivePolicy && organizationPolicy
        ? constrainEffectivePolicy(user.effectivePolicy, organizationPolicy)
        : user.effectivePolicy;
      const authorized = (await store.listCurrent(targetIdentity)).filter((workspace) => (
        allowsPermission(actor, "workspace.manage", { type: "workspace", resourceId: workspace.id })
      ));
      if (!managesOrganization && authorized.length === 0) return null;
      const workspaces = await Promise.all(authorized.map(async (workspace) => {
        const settings = await store.getSandboxSettings?.(targetIdentity, workspace.grantId);
        const lastActivityAt = await store.lastWorkspaceActivityAt(targetIdentity, workspace.id);
        const document = user.effectivePolicy?.document as Record<string, unknown> | undefined;
        const configuredProfile = settings?.profileId
          ?? (Array.isArray(document?.workspaceProfiles) ? document.workspaceProfiles.find((value): value is string => typeof value === "string") : undefined)
          ?? (typeof document?.workspaceProfile === "string" ? document.workspaceProfile : null);
        const executionMode = configuredProfile === "disposable-open-v1" ? "disposable-open" : configuredProfile ? "managed" : null;
        const workspaceEgress = await workspaceEgressFor(targetPrincipal, targetEffective, workspace.grantId, (configuredProfile ?? testRuntimePolicy.workspaceProfile) as SandboxProfileId);
        const egressMode = workspaceEgress
          ? workspaceEgress.defaultAction === "allow-public-http-https" ? "full-web" : "restricted"
          : executionMode === "disposable-open" ? "full-web" : "restricted";
        const health = workspace.state === "failed"
          ? "needs_attention"
          : ["provisioning", "restarting", "stopping"].includes(workspace.state)
            ? "transitioning"
            : workspace.state === "stopped" || workspace.state === "not_created"
              ? "offline"
              : "healthy";
        const selection = targetEffective
          ? compatibleSandboxSelection(targetEffective.document as Record<string, unknown>, settings, publishedServiceClasses)
          : null;
        const policyRuntime = !targetEffective || !selection
          ? { state: "action_required" as const, reasonCode: "WORKSPACE_POLICY_SELECTION_REQUIRED" }
          : ["stopped", "not_created"].includes(workspace.state)
            ? { state: "applies_on_next_start" as const, reasonCode: null }
            : { state: "desired" as const, reasonCode: null };
        return {
          id: workspace.id,
          name: workspace.grantId === "personal"
            ? "Personal workspace"
            : workspace.grantId.split(/[-_]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "),
          state: workspace.state,
          health: {
            status: health,
            reasonCode: workspace.failureCode,
          },
          profile: configuredProfile ? { id: configuredProfile, executionMode } : null,
          networkAccess: {
            mode: egressMode,
            securityGroup: workspaceEgress ? {
              id: workspaceEgress.id,
              name: workspaceEgress.name,
              version: workspaceEgress.version,
              isDefault: workspaceEgress.isDefault ?? false,
              assignmentSource: workspaceEgress.assignmentSource ?? "workspace-type",
              defaultFor: workspaceEgress.defaultFor ?? null,
            } : null,
          },
          policyAssignment: organizationPolicy ? {
            authority: "organization_policy",
            version: organizationPolicy.version,
            hash: organizationPolicy.documentHash,
          } : user.effectivePolicy ? {
            authority: "runtime_policy",
            version: user.effectivePolicy.version,
            hash: user.effectivePolicy.documentHash,
          } : null,
          policyRuntime,
          lastActivityAt: lastActivityAt?.toISOString() ?? null,
          lastTransitionAt: workspace.updatedAt.toISOString(),
          createdAt: workspace.createdAt.toISOString(),
        };
      }));
      return {
        userId: user.userId,
        displayName: user.displayName,
        email: user.email,
        status: user.status,
        membershipStatus: user.membershipStatus ?? null,
        workspaceCount: workspaces.length,
        workspaces,
      };
    }))).filter((member): member is NonNullable<typeof member> => Boolean(member));
    return reply.header("cache-control", "no-store").send({ members });
  });
  const organizationRoleScopeSchema = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("organization") }),
    z.strictObject({ type: z.literal("workspace"), resourceId: z.string().trim().min(1).max(200) }),
    z.strictObject({ type: z.literal("provider"), resourceId: z.string().trim().min(1).max(200) }),
  ]);
  const organizationRoleGrantSchema = z.strictObject({
    permission: z.enum(organizationPermissions),
    scope: organizationRoleScopeSchema,
  });
  const organizationRoleDocumentSchema = z.strictObject({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
    grants: z.array(organizationRoleGrantSchema).min(1).max(100),
  });
  const requireRoleStore = () => {
    const roleStore = security.identityPolicyStore;
    if (!roleStore?.listOrganizationRoles || !roleStore.createOrganizationRole
      || !roleStore.updateOrganizationRole || !roleStore.archiveOrganizationRole
      || !roleStore.assignOrganizationRole || !roleStore.unassignOrganizationRole) {
      throw new LemmaComputerError("ROLE_ADMIN_NOT_CONFIGURED", "Organization role administration is unavailable", 503, true);
    }
    return roleStore;
  };
  const delegableBuiltInRolesFor = (actor: SessionPrincipal) => (["owner", "admin", "member"] as const).filter((role) => (
    role === "owner"
      ? actor.role === "owner"
      : permissionsByOrganizationRole[role].every((permission) => allowsPermission(actor, permission))
  ));
  const delegablePermissionCatalogFor = (actor: SessionPrincipal): Array<{
    key: OrganizationPermission;
    description: string;
    scopeTypes: OrganizationResourceScopeType[];
    resourceIds?: Partial<Record<OrganizationResourceScopeType, string[]>>;
  }> => organizationPermissions.flatMap((key) => {
    if (key === "organization.transfer_ownership") return [];
    const catalogEntry = organizationPermissionCatalog[key];
    const supportedScopeTypes: readonly OrganizationResourceScopeType[] = catalogEntry.scopeTypes;
    if (allowsPermission(actor, key)) {
      return [{ key, description: catalogEntry.description, scopeTypes: [...supportedScopeTypes] }];
    }
    const exactGrants = actor.effectiveAuthorization?.valid
      ? actor.effectiveAuthorization.grants.filter((grant) => (
          grant.permission === key
          && grant.scope.type !== "organization"
          && supportedScopeTypes.includes(grant.scope.type)
        ))
      : [];
    const scopeTypes = supportedScopeTypes.filter((type) => (
      type !== "organization" && exactGrants.some((grant) => grant.scope.type === type)
    ));
    if (!scopeTypes.length) return [];
    const resourceIds = Object.fromEntries(scopeTypes.map((type) => [
      type,
      [...new Set(exactGrants
        .filter((grant) => grant.scope.type === type)
        .map((grant) => grant.scope.resourceId)
        .filter((resourceId): resourceId is string => Boolean(resourceId)))],
    ]));
    return [{ key, description: catalogEntry.description, scopeTypes, resourceIds }];
  });

  app.get("/v1/admin/roles", async (request) => {
    const actor = requirePermission(request, "organization.manage_roles");
    const roleStore = requireRoleStore();
    const memberships = roleStore.listOrganizationMemberships
      ? await roleStore.listOrganizationMemberships(actor.tenantId)
      : [];
    return {
      catalog: {
        version: organizationPermissionCatalogVersion,
        permissions: delegablePermissionCatalogFor(actor),
      },
      builtInRoles: ["owner", "admin", "member"],
      delegableBuiltInRoles: delegableBuiltInRolesFor(actor),
      memberships,
      roles: await roleStore.listOrganizationRoles!(actor.tenantId),
    };
  });
  app.post("/v1/admin/roles", async (request, reply) => {
    const input = organizationRoleDocumentSchema.parse(request.body ?? {});
    const actor = requirePermission(request, "organization.manage_roles");
    const role = await requireRoleStore().createOrganizationRole!({
      organizationId: actor.tenantId,
      ...input,
      createdBy: actor.userId,
    });
    return reply.code(201).send({ role });
  });
  app.patch<{ Params: { roleId: string } }>("/v1/admin/roles/:roleId", async (request) => {
    const input = organizationRoleDocumentSchema.extend({ expectedVersion: z.number().int().positive() }).parse(request.body ?? {});
    const actor = requirePermission(request, "organization.manage_roles");
    const role = await requireRoleStore().updateOrganizationRole!({
      organizationId: actor.tenantId,
      roleId: z.uuid().parse(request.params.roleId),
      ...input,
      updatedBy: actor.userId,
    });
    return { role };
  });
  app.delete<{ Params: { roleId: string } }>("/v1/admin/roles/:roleId", async (request) => {
    const input = z.strictObject({ expectedVersion: z.number().int().positive() }).parse(request.body ?? {});
    const actor = requirePermission(request, "organization.manage_roles");
    return requireRoleStore().archiveOrganizationRole!({
      organizationId: actor.tenantId,
      roleId: z.uuid().parse(request.params.roleId),
      expectedVersion: input.expectedVersion,
      archivedBy: actor.userId,
    });
  });
  app.post<{ Params: { membershipId: string } }>("/v1/admin/memberships/:membershipId/roles", async (request) => {
    const input = z.strictObject({ roleId: z.uuid() }).parse(request.body ?? {});
    const actor = requirePermission(request, "organization.manage_roles");
    return requireRoleStore().assignOrganizationRole!({
      organizationId: actor.tenantId,
      membershipId: z.uuid().parse(request.params.membershipId),
      roleId: input.roleId,
      assignedBy: actor.userId,
    });
  });
  app.delete<{ Params: { membershipId: string; roleId: string } }>("/v1/admin/memberships/:membershipId/roles/:roleId", async (request) => {
    const actor = requirePermission(request, "organization.manage_roles");
    return requireRoleStore().unassignOrganizationRole!({
      organizationId: actor.tenantId,
      membershipId: z.uuid().parse(request.params.membershipId),
      roleId: z.uuid().parse(request.params.roleId),
      unassignedBy: actor.userId,
    });
  });

  app.get("/v1/admin/memberships", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    const membershipStore = security.identityPolicyStore;
    if (!membershipStore?.listOrganizationMemberships) {
      throw new LemmaComputerError("MEMBERSHIP_ADMIN_NOT_CONFIGURED", "Organization access administration is unavailable", 503, true);
    }
    return { memberships: await membershipStore.listOrganizationMemberships(actor.tenantId) };
  });
  const tenantSsoRegistrationSchema = z.discriminatedUnion("protocol", [
    z.strictObject({
      protocol: z.literal("oidc"),
      domain: z.string().trim().toLowerCase().min(3).max(253),
      issuer: z.url({ protocol: /^https$/ }).max(2_048),
      clientId: z.string().trim().min(1).max(1_024),
      clientSecret: z.string().min(1).max(8_192),
      discoveryEndpoint: z.url({ protocol: /^https$/ }).max(2_048).optional(),
    }),
    z.strictObject({
      protocol: z.literal("saml"),
      domain: z.string().trim().toLowerCase().min(3).max(253),
      issuer: z.url({ protocol: /^https$/ }).max(2_048),
      entryPoint: z.url({ protocol: /^https$/ }).max(2_048),
      certificate: z.string().trim().min(64).max(24 * 1_024),
    }),
  ]);
  const tenantSsoCredentialRotationSchema = z.discriminatedUnion("protocol", [
    z.strictObject({
      protocol: z.literal("oidc"),
      clientId: z.string().trim().min(1).max(1_024),
      clientSecret: z.string().min(1).max(8_192),
    }),
    z.strictObject({
      protocol: z.literal("saml"),
      certificate: z.string().trim().min(64).max(24 * 1_024),
    }),
  ]);
  const tenantSsoMetadataRefreshSchema = z.discriminatedUnion("protocol", [
    z.strictObject({ protocol: z.literal("oidc") }),
    z.strictObject({
      protocol: z.literal("saml"),
      metadata: z.string().trim().min(64).max(100 * 1_024),
    }),
  ]);
  const requireTenantSsoAdministration = () => {
    if (!security.tenantSsoAdministration) {
      throw new LemmaComputerError("SSO_ADMIN_NOT_CONFIGURED", "Organization SSO administration is unavailable", 503, true);
    }
    return security.tenantSsoAdministration;
  };
  const requireSsoOwner = (request: object) => {
    const actor = requirePermission(request, "organization.manage_settings");
    if (actor.role !== "owner") {
      throw new LemmaComputerError("SSO_OWNER_REQUIRED", "The organization owner must complete this SSO action", 403);
    }
    return actor;
  };
  const requireProtectedSsoOwner = async (request: object & { raw: { headers: Parameters<typeof fromNodeHeaders>[0] } }) => {
    const actor = requireSsoOwner(request);
    if (!security.customerProductAuthentication) {
      throw new LemmaComputerError("OWNER_STEP_UP_REQUIRED", "Customer MFA verification is required", 403);
    }
    await security.customerProductAuthentication.requireRecentStepUp(fromNodeHeaders(request.raw.headers));
    return actor;
  };
  app.get("/v1/admin/sso", async (request) => {
    const actor = requirePermission(request, "organization.manage_settings");
    return { connections: await requireTenantSsoAdministration().list(actor.tenantId) };
  });
  app.post("/v1/admin/sso", async (request, reply) => {
    // Better Auth's SSO provider row is owned by the registering Better Auth
    // account when its organization plugin is not authoritative. Bind the
    // lifecycle to LemmaComputer's single protected owner so later verify,
    // test, rotation, recovery, and disconnect calls use the same account.
    const actor = requireSsoOwner(request);
    const input = tenantSsoRegistrationSchema.parse(request.body ?? {});
    const result = await requireTenantSsoAdministration().register(fromNodeHeaders(request.raw.headers), {
      ...input,
      organizationId: actor.tenantId,
      actorUserId: actor.userId,
    });
    return reply.code(201).send(result);
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/domain-verification", async (request) => {
    const actor = requireSsoOwner(request);
    return requireTenantSsoAdministration().verifyDomain(
      fromNodeHeaders(request.raw.headers),
      actor.tenantId,
      z.uuid().parse(request.params.connectionId),
      actor.userId,
    );
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/domain-verification/request", async (request) => {
    const actor = requireSsoOwner(request);
    return requireTenantSsoAdministration().requestDomainVerification(
      fromNodeHeaders(request.raw.headers),
      actor.tenantId,
      z.uuid().parse(request.params.connectionId),
    );
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/test", async (request, reply) => {
    const actor = requirePermission(request, "organization.manage_settings");
    const started = await requireTenantSsoAdministration().startTest(
      fromNodeHeaders(request.raw.headers),
      actor.tenantId,
      z.uuid().parse(request.params.connectionId),
    );
    if (started.cookies.length) reply.header("set-cookie", started.cookies);
    return reply.header("cache-control", "no-store").send({ location: started.location });
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/test/complete", async (request) => {
    const actor = requirePermission(request, "organization.manage_settings");
    return requireTenantSsoAdministration().completeTest(
      fromNodeHeaders(request.raw.headers),
      actor.tenantId,
      z.uuid().parse(request.params.connectionId),
      actor.userId,
    );
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/recovery", async (request) => {
    const actor = await requireProtectedSsoOwner(request);
    return requireTenantSsoAdministration().transition(actor.tenantId, z.uuid().parse(request.params.connectionId), "recovery_confirmed", actor.userId);
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/enforce", async (request) => {
    const actor = await requireProtectedSsoOwner(request);
    return requireTenantSsoAdministration().transition(actor.tenantId, z.uuid().parse(request.params.connectionId), "enforce", actor.userId);
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/credentials/rotation", async (request) => {
    const actor = await requireProtectedSsoOwner(request);
    const input = tenantSsoCredentialRotationSchema.parse(request.body ?? {});
    return requireTenantSsoAdministration().rotateCredentials(fromNodeHeaders(request.raw.headers), {
      ...input,
      organizationId: actor.tenantId,
      connectionId: z.uuid().parse(request.params.connectionId),
      actorUserId: actor.userId,
    });
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/metadata/refresh", async (request) => {
    const actor = await requireProtectedSsoOwner(request);
    const input = tenantSsoMetadataRefreshSchema.parse(request.body ?? {});
    return requireTenantSsoAdministration().refreshMetadata(fromNodeHeaders(request.raw.headers), {
      ...input,
      organizationId: actor.tenantId,
      connectionId: z.uuid().parse(request.params.connectionId),
      actorUserId: actor.userId,
    });
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/suspend", async (request) => {
    const actor = requirePermission(request, "organization.manage_settings");
    return requireTenantSsoAdministration().transition(actor.tenantId, z.uuid().parse(request.params.connectionId), "suspend", actor.userId);
  });
  app.post<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId/rollback", async (request) => {
    const actor = await requireProtectedSsoOwner(request);
    return requireTenantSsoAdministration().transition(actor.tenantId, z.uuid().parse(request.params.connectionId), "rollback", actor.userId);
  });
  app.delete<{ Params: { connectionId: string } }>("/v1/admin/sso/:connectionId", async (request) => {
    const actor = await requireProtectedSsoOwner(request);
    return requireTenantSsoAdministration().disconnect(
      fromNodeHeaders(request.raw.headers),
      actor.tenantId,
      z.uuid().parse(request.params.connectionId),
      actor.userId,
    );
  });
  app.patch<{ Body: { displayName: string } }>("/v1/admin/organization", async (request) => {
    const actor = requirePermission(request, "organization.manage_settings");
    if (actor.role !== "owner") {
      throw new LemmaComputerError(
        "ORGANIZATION_OWNER_REQUIRED",
        "Only the active organization owner can rename the organization",
        403,
      );
    }
    const organizationStore = security.identityPolicyStore;
    if (!organizationStore?.updateOrganizationDisplayName) {
      throw new LemmaComputerError(
        "ORGANIZATION_SETTINGS_NOT_CONFIGURED",
        "Organization settings are unavailable",
        503,
        true,
      );
    }
    const input = z.strictObject({
      displayName: z.string()
        .transform((value) => value.trim().replace(/\s+/g, " "))
        .pipe(z.string().min(2).max(100)),
    }).parse(request.body ?? {});
    const organization = await organizationStore.updateOrganizationDisplayName({
      organizationId: actor.tenantId,
      updatedBy: actor.userId,
      displayName: input.displayName,
      now: new Date(),
    });
    return { organization };
  });
  app.post<{ Body: { targetMembershipId: string } }>("/v1/admin/organization/ownership-transfer", async (request) => {
    const actor = requirePermission(request, "organization.transfer_ownership");
    if (actor.role !== "owner") {
      throw new LemmaComputerError("OWNER_CHANGE_FORBIDDEN", "Only an active organization owner can transfer ownership", 403);
    }
    if (!security.customerProductAuthentication) {
      throw new LemmaComputerError("OWNER_STEP_UP_REQUIRED", "Customer MFA verification is required", 403);
    }
    const ownershipStore = security.identityPolicyStore;
    if (!ownershipStore?.transferOrganizationOwnership) {
      throw new LemmaComputerError("OWNER_LIFECYCLE_NOT_CONFIGURED", "Protected owner operations are unavailable", 503, true);
    }
    const input = z.strictObject({ targetMembershipId: z.uuid() }).parse(request.body ?? {});
    const proof = await security.customerProductAuthentication.requireRecentStepUp(fromNodeHeaders(request.raw.headers));
    return ownershipStore.transferOrganizationOwnership({
      organizationId: actor.tenantId,
      currentOwnerUserId: actor.userId,
      targetMembershipId: input.targetMembershipId,
      recentStepUpAt: proof.recentStepUpAt,
      now: new Date(),
    });
  });
  app.post<{ Body: { reason: string }; Headers: { "idempotency-key"?: string } }>(
    "/v1/admin/organization/closure",
    async (request, reply) => {
      const actor = requirePermission(request, "organization.manage_settings");
      if (actor.role !== "owner") {
        throw new LemmaComputerError("OWNER_CHANGE_FORBIDDEN", "Only an active organization owner can initiate closure", 403);
      }
      if (!security.customerProductAuthentication) {
        throw new LemmaComputerError("OWNER_STEP_UP_REQUIRED", "Customer MFA verification is required", 403);
      }
      const ownershipStore = security.identityPolicyStore;
      if (!ownershipStore?.initiateOrganizationClosure) {
        throw new LemmaComputerError("OWNER_LIFECYCLE_NOT_CONFIGURED", "Protected owner operations are unavailable", 503, true);
      }
      const input = z.strictObject({ reason: z.string().trim().min(12).max(1_000) }).parse(request.body ?? {});
      const idempotencyKey = z.uuid().parse(request.headers["idempotency-key"]);
      const proof = await security.customerProductAuthentication.requireRecentStepUp(fromNodeHeaders(request.raw.headers));
      const result = await ownershipStore.initiateOrganizationClosure({
        organizationId: actor.tenantId,
        requestedBy: actor.userId,
        reason: input.reason,
        idempotencyKey,
        recentStepUpAt: proof.recentStepUpAt,
        now: new Date(),
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    },
  );
  app.get("/v1/admin/invitations", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    const invitationStore = security.identityPolicyStore;
    if (!invitationStore?.listOrganizationInvitations) {
      throw new LemmaComputerError("INVITATION_ADMIN_NOT_CONFIGURED", "Organization invitation administration is unavailable", 503, true);
    }
    return { invitations: await invitationStore.listOrganizationInvitations(actor.tenantId, new Date()) };
  });
  app.post("/v1/admin/invitations", async (request, reply) => {
    const input = z.strictObject({
      email: z.email().max(320).transform((value) => value.toLowerCase()),
      role: z.enum(["owner", "admin", "member"]),
    }).parse(request.body ?? {});
    const actor = requirePermission(request, "organization.manage_members");
    if (input.role === "owner") {
      throw new LemmaComputerError("OWNER_TRANSFER_REQUIRED", "Use the protected ownership transfer flow", 409);
    }
    if (input.role !== "member") requirePermission(request, "organization.manage_roles");
    const invitationStore = security.identityPolicyStore;
    if (!invitationStore?.createOrganizationInvitation) {
      throw new LemmaComputerError("INVITATION_ADMIN_NOT_CONFIGURED", "Organization invitation administration is unavailable", 503, true);
    }
    if (!invitationDelivery) {
      throw new LemmaComputerError("INVITATION_DELIVERY_NOT_CONFIGURED", "Invitation delivery is unavailable", 503, true);
    }
    const token = `oci_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const result = await invitationStore.createOrganizationInvitation({
      organizationId: actor.tenantId,
      email: input.email,
      role: input.role,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      idempotencyKeyHash: createHash("sha256").update(idempotency(request.headers)).digest("hex"),
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
      createdBy: actor.userId,
      now,
    });
    const acceptancePath = `/invite?token=${encodeURIComponent(token)}`;
    if (!result.replayed && invitationDelivery.mode === "email") {
      await deliverOrganizationInvitationEmail(invitationDelivery.email!, {
        recipient: result.invitation.email,
        organizationDisplayName: actor.tenantDisplayName,
        role: result.invitation.role,
        activationUrl: new URL(acceptancePath, connectionOptions.publicWebUrl ?? "http://localhost:4174").toString(),
        expiresAt: new Date(result.invitation.expiresAt),
      });
    }
    return reply.code(result.replayed ? 200 : 201).send({
      invitation: result.invitation,
      replayed: result.replayed,
      acceptancePath: !result.replayed && invitationDelivery.mode === "copy-link" ? acceptancePath : null,
      delivery: {
        mode: invitationDelivery.mode,
        warning: invitationDelivery.mode === "copy-link"
          ? "Copy-link delivery is intended only for explicit local or customer-managed operation. Share it through a trusted channel."
          : null,
      },
    });
  });
  app.post<{ Params: { invitationId: string } }>("/v1/admin/invitations/:invitationId/resend", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    const invitationStore = security.identityPolicyStore;
    if (!invitationStore?.resendOrganizationInvitation) {
      throw new LemmaComputerError("INVITATION_ADMIN_NOT_CONFIGURED", "Organization invitation administration is unavailable", 503, true);
    }
    if (!invitationDelivery) {
      throw new LemmaComputerError("INVITATION_DELIVERY_NOT_CONFIGURED", "Invitation delivery is unavailable", 503, true);
    }
    const token = `oci_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const result = await invitationStore.resendOrganizationInvitation({
      organizationId: actor.tenantId,
      invitationId: z.uuid().parse(request.params.invitationId),
      tokenHash: createHash("sha256").update(token).digest("hex"),
      idempotencyKeyHash: createHash("sha256").update(idempotency(request.headers)).digest("hex"),
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
      updatedBy: actor.userId,
      now,
    });
    const acceptancePath = `/invite?token=${encodeURIComponent(token)}`;
    if (!result.replayed && invitationDelivery.mode === "email") {
      await deliverOrganizationInvitationEmail(invitationDelivery.email!, {
        recipient: result.invitation.email,
        organizationDisplayName: actor.tenantDisplayName,
        role: result.invitation.role,
        activationUrl: new URL(acceptancePath, connectionOptions.publicWebUrl ?? "http://localhost:4174").toString(),
        expiresAt: new Date(result.invitation.expiresAt),
      });
    }
    return {
      invitation: result.invitation,
      replayed: result.replayed,
      acceptancePath: !result.replayed && invitationDelivery.mode === "copy-link" ? acceptancePath : null,
      delivery: {
        mode: invitationDelivery.mode,
        warning: invitationDelivery.mode === "copy-link"
          ? "Copy-link delivery is intended only for explicit local or customer-managed operation. Share it through a trusted channel."
          : null,
      },
    };
  });
  app.delete<{ Params: { invitationId: string } }>("/v1/admin/invitations/:invitationId", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    const invitationStore = security.identityPolicyStore;
    if (!invitationStore?.revokeOrganizationInvitation) {
      throw new LemmaComputerError("INVITATION_ADMIN_NOT_CONFIGURED", "Organization invitation administration is unavailable", 503, true);
    }
    return invitationStore.revokeOrganizationInvitation({
      organizationId: actor.tenantId,
      invitationId: z.uuid().parse(request.params.invitationId),
      revokedBy: actor.userId,
      now: new Date(),
    });
  });
  app.patch<{ Params: { userId: string } }>("/v1/admin/memberships/:userId", async (request) => {
    const input = z.strictObject({
      role: z.enum(["owner", "admin", "member"]).optional(),
      status: z.enum(["active", "suspended", "revoked"]).optional(),
    }).refine((value) => value.role !== undefined || value.status !== undefined).parse(request.body ?? {});
    const actor = input.role
      ? requirePermission(request, "organization.manage_roles")
      : requirePermission(request, "organization.manage_members");
    if (input.status) requirePermission(request, "organization.manage_members");
    if (input.role === "owner") {
      throw new LemmaComputerError("OWNER_TRANSFER_REQUIRED", "Use the protected ownership transfer flow", 409);
    }
    if (request.params.userId === actor.userId && (input.status === "suspended" || input.status === "revoked")) {
      throw new LemmaComputerError("ADMIN_SELF_DISABLE_FORBIDDEN", "You cannot suspend your own administrator account", 409);
    }
    const membershipStore = security.identityPolicyStore;
    if (!membershipStore?.changeOrganizationMembership) {
      throw new LemmaComputerError("MEMBERSHIP_ADMIN_NOT_CONFIGURED", "Organization access administration is unavailable", 503, true);
    }
    const target = (await membershipStore.listUsers(actor.tenantId)).find((item) => item.userId === request.params.userId);
    if (!target) throw new LemmaComputerError("MEMBERSHIP_NOT_FOUND", "Membership not found", 404);
    if (target.role === "owner") {
      throw new LemmaComputerError("OWNER_TRANSFER_REQUIRED", "Use the protected ownership transfer flow", 409);
    }
    const targetIdentity = identityContextSchema.parse({
      tenantId: actor.tenantId,
      subjectId: target.userId,
      audience: "lemmacomputer-control",
    });
    const targetPrincipal: SessionPrincipal = {
      userId: target.userId,
      tenantId: actor.tenantId,
      email: target.email,
      displayName: target.displayName,
      tenantDisplayName: actor.tenantDisplayName,
      tenantKind: actor.tenantKind,
      roles: target.roles,
      identity: targetIdentity,
    };
    const shouldRevoke = input.status === "suspended" || input.status === "revoked";
    if (shouldRevoke && !store.cancelPendingGovernedOperations) {
      throw new LemmaComputerError("ACCESS_REVOCATION_NOT_CONFIGURED", "Organization access revocation is unavailable", 503, true);
    }
    const workspaces = shouldRevoke ? await store.listCurrent(targetIdentity) : [];
    const policies = shouldRevoke && target.effectivePolicy
      ? await Promise.all(workspaces.map(async (workspace) => ({
          workspace,
          policy: (await policyForGrant(targetPrincipal, target.effectivePolicy, workspace.grantId)).policy,
        })))
      : [];
    const updated = await membershipStore.changeOrganizationMembership({
      organizationId: actor.tenantId,
      targetUserId: target.userId,
      role: input.role,
      status: input.status,
      updatedBy: actor.userId,
    });
    const revokedPendingOperations = shouldRevoke
      ? await store.cancelPendingGovernedOperations!(targetIdentity, new Date(), request.id)
      : 0;
    const revokedWorkspaceGrants = shouldRevoke
      ? await Promise.allSettled(policies.map(({ workspace, policy }) => service.revokePolicyGrant(workspace.id, policy)))
      : [];
    return {
      ...updated,
      revokedPendingOperations,
      revokedWorkspaceGrants: {
        revoked: revokedWorkspaceGrants.filter((result) => result.status === "fulfilled").length,
        failed: revokedWorkspaceGrants.filter((result) => result.status === "rejected").length,
      },
    };
  });
  app.patch<{ Params: { userId: string } }>("/v1/admin/users/:userId/status", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const input = z.strictObject({ status: z.enum(["active", "disabled"]) }).parse(request.body ?? {});
    if (request.params.userId === actor.userId && input.status === "disabled") {
      throw new LemmaComputerError("ADMIN_SELF_DISABLE_FORBIDDEN", "You cannot suspend your own administrator account", 409);
    }
    const target = (await security.identityPolicyStore.listUsers(actor.tenantId)).find((item) => item.userId === request.params.userId);
    if (!target) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
    const targetIdentity = identityContextSchema.parse({
      tenantId: actor.tenantId,
      subjectId: target.userId,
      audience: "lemmacomputer-control",
    });
    const targetPrincipal: SessionPrincipal = {
      userId: target.userId,
      tenantId: actor.tenantId,
      email: target.email,
      displayName: target.displayName,
      tenantDisplayName: actor.tenantDisplayName,
      tenantKind: actor.tenantKind,
      roles: target.roles,
      identity: targetIdentity,
    };
    const workspaces = input.status === "disabled" ? await store.listCurrent(targetIdentity) : [];
    const policies = input.status === "disabled" && target.effectivePolicy
      ? await Promise.all(workspaces.map(async (workspace) => ({
          workspace,
          policy: (await policyForGrant(targetPrincipal, target.effectivePolicy, workspace.grantId)).policy,
        })))
      : [];
    const updated = await security.identityPolicyStore.setUserStatus({
      tenantId: actor.tenantId,
      targetUserId: target.userId,
      status: input.status,
      updatedBy: actor.userId,
    });
    if (input.status === "disabled") {
      await Promise.allSettled(policies.map(({ workspace, policy }) => service.revokePolicyGrant(workspace.id, policy)));
    }
    return { userId: target.userId, ...updated };
  });
  app.post<{ Params: { userId: string } }>("/v1/admin/users/:userId/sessions/revoke", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const revokedSessions = await security.identityPolicyStore.revokeUserSessions({
      tenantId: actor.tenantId,
      targetUserId: request.params.userId,
      revokedBy: actor.userId,
    });
    return { userId: request.params.userId, revokedSessions };
  });
  app.get("/v1/admin/protected-workspace-policy", async (request) => {
    const actor = requirePermission(request, "policy.manage");
    return protectedWorkspacePolicyOverviewFor(actor.tenantId);
  });
  app.get("/v1/admin/protected-workspace-policy/organization-versions", async (request) => {
    const actor = requirePermission(request, "policy.manage");
    return {
      versions: await requireProtectedWorkspacePolicy().listOrganizationPolicyVersions(actor.tenantId),
    };
  });
  app.post("/v1/admin/protected-workspace-policy/organization-versions", async (request, reply) => {
    const actor = requirePermission(request, "policy.manage");
    const input = z.strictObject({
      constraints: organizationWorkspacePolicyConstraintsSchema,
      revisionNote: z.string().trim().min(3).max(240),
    }).parse(request.body ?? {});
    const configuredAgentIds = [
      ...(input.constraints.agents?.allow ?? []),
      ...(input.constraints.agents?.deny ?? []),
    ];
    if (configuredAgentIds.some((agentId) => !isWorkspaceSelectableAgentCatalogId(agentId))) {
      throw new LemmaComputerError(
        "WORKSPACE_AGENT_NOT_SELECTABLE",
        "Organization workspace guardrails may include only release-qualified agents",
        400,
      );
    }
    if (input.constraints.maximumReasoningEffort && !["low", "medium", "high"].includes(input.constraints.maximumReasoningEffort)) {
      throw new LemmaComputerError(
        "WORKSPACE_REASONING_LEVEL_NOT_SELECTABLE",
        "Maximum thinking must be Low, Medium, or High",
        400,
      );
    }
    const publishedServiceClasses = await publishedWorkspaceServiceClassesFor(actor.tenantId);
    if (publishedServiceClasses !== null && input.constraints.serviceClasses?.allow?.some((serviceClass) => !publishedServiceClasses.includes(serviceClass as ExplicitWorkspaceServiceClass))) {
      throw new LemmaComputerError(
        "WORKSPACE_SERVICE_CLASS_ROUTE_UNAVAILABLE",
        "Workspace guardrails may include only published organization routes",
        400,
      );
    }
    const currentWorkspaces = await store.listTenantCurrent(actor.tenantId);
    const restartableStates = new Set<WorkspaceState>(["ready", "open", "provisioning", "restarting"]);
    const restartWorkspaceIds = new Set(
      currentWorkspaces.filter((workspace) => restartableStates.has(workspace.state)).map((workspace) => workspace.id),
    );
    const transitionResults = await Promise.allSettled(currentWorkspaces.map(async (workspace) => {
      const owner = identityContextSchema.parse({
        tenantId: actor.tenantId,
        subjectId: workspace.subjectId,
        audience: "lemmacomputer-control",
      });
      return service.suspendForPolicyChange(owner, workspace.id, {
        restartPending: restartWorkspaceIds.has(workspace.id),
      });
    }));
    const transitionFailures = transitionResults.filter((result) => result.status === "rejected");
    if (transitionFailures.length) {
      await Promise.allSettled(currentWorkspaces.map((workspace, index) => (
        restartWorkspaceIds.has(workspace.id) && transitionResults[index]?.status === "fulfilled"
          ? store.update(workspace.id, { state: "stopped", providerId: null, failureCode: null })
          : Promise.resolve()
      )));
      throw new LemmaComputerError(
        "WORKSPACE_POLICY_TRANSITION_FAILED",
        "The new guardrails were not activated because one or more workspace runtimes could not be stopped and revoked safely.",
        503,
        true,
      );
    }
    const version = await requireProtectedWorkspacePolicy().createOrganizationPolicyVersion({
      tenantId: actor.tenantId,
      constraints: input.constraints,
      revisionNote: input.revisionNote,
      createdBy: actor.userId,
    });
    let reconciled = 0;
    let actionRequired = 0;
    let restarted = 0;
    let restartFailed = 0;
    if (security.identityPolicyStore) {
      const users = await security.identityPolicyStore.listUsers(actor.tenantId);
      const usersById = new Map(users.map((user) => [user.userId, user]));
      const reconciliation = await Promise.all(currentWorkspaces.map(async (workspace) => {
        const user = usersById.get(workspace.subjectId);
        if (!user?.effectivePolicy) {
          if (restartWorkspaceIds.has(workspace.id)) {
            await store.update(workspace.id, { state: "stopped", providerId: null, failureCode: null });
          }
          return "action_required" as const;
        }
        const owner = await security.identityPolicyStore!.getPrincipal(user.userId);
        if (!owner || owner.tenantId !== actor.tenantId) {
          if (restartWorkspaceIds.has(workspace.id)) {
            await store.update(workspace.id, { state: "stopped", providerId: null, failureCode: null });
          }
          return "action_required" as const;
        }
        const effective = constrainEffectivePolicy(user.effectivePolicy, version);
        try {
          const { policy } = await policyForGrant(owner, effective, workspace.grantId);
          if (!restartWorkspaceIds.has(workspace.id)) return "reconciled" as const;
          try {
            await service.create(
              owner.identity,
              policy,
              workspace.grantId,
              `guardrail:${version.policyVersionId}:${workspace.id}`,
              `${request.id}:guardrail-restart:${workspace.id}`,
            );
            return "restarted" as const;
          } catch (error) {
            request.log.warn({ err: error, workspaceId: workspace.id }, "workspace did not restart after guardrail publication");
            return "restart_failed" as const;
          }
        } catch {
          // The version is already immutable and current. A settings write or
          // selection conflict must remain visible as per-workspace action,
          // rather than turning a successful policy commit into an ambiguous
          // request failure.
          if (restartWorkspaceIds.has(workspace.id)) {
            await store.update(workspace.id, { state: "stopped", providerId: null, failureCode: null });
          }
          return "action_required" as const;
        }
      }));
      reconciled = reconciliation.filter((result) => result === "reconciled" || result === "restarted" || result === "restart_failed").length;
      actionRequired = reconciliation.filter((result) => result === "action_required").length;
      restarted = reconciliation.filter((result) => result === "restarted").length;
      restartFailed = reconciliation.filter((result) => result === "restart_failed").length;
    } else {
      actionRequired = currentWorkspaces.length;
      await Promise.all(currentWorkspaces.map((workspace) => (
        restartWorkspaceIds.has(workspace.id)
          ? store.update(workspace.id, { state: "stopped", providerId: null, failureCode: null })
          : Promise.resolve()
      )));
    }
    return reply.code(201).send({
      version,
      enforcement: {
        stopped: transitionResults.filter((result) => result.status === "fulfilled" && result.value.stopped).length,
        alreadyStopped: transitionResults.filter((result) => result.status === "fulfilled" && !result.value.stopped).length,
        reconciled,
        actionRequired,
        restarted,
        restartFailed,
      },
    });
  });
  app.post<{ Params: { userId: string } }>("/v1/admin/users/:userId/policy", async (request) => {
    const actor = requirePermission(request, "policy.manage");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const target = (await security.identityPolicyStore.listUsers(actor.tenantId)).find((item) => item.userId === request.params.userId);
    if (!target) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
    return security.identityPolicyStore.assignMvpPolicy({ tenantId: actor.tenantId, targetUserId: request.params.userId, assignedBy: actor.userId });
  });
  app.delete<{ Params: { userId: string } }>("/v1/admin/users/:userId/policy", async (request, reply) => {
    const actor = requirePermission(request, "policy.manage");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const target = (await security.identityPolicyStore.listUsers(actor.tenantId)).find((item) => item.userId === request.params.userId);
    if (!target) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
    const current = await security.identityPolicyStore.getEffectivePolicy(request.params.userId);
    const revoked = await security.identityPolicyStore.revokeMvpPolicy({ tenantId: actor.tenantId, targetUserId: request.params.userId, revokedBy: actor.userId });
    if (revoked && current) {
      const targetIdentity: IdentityContext = {
        tenantId: actor.tenantId,
        subjectId: request.params.userId,
        audience: "lemmacomputer-control",
      };
      const runtime = runtimePolicyFor(
        current,
        undefined,
        undefined,
        assignedAgentIds(current.document as Record<string, unknown>),
      );
      const workspaces = await store.listCurrent(targetIdentity);
      await Promise.all(workspaces.map((workspace) => (
        service.revokePolicyGrant(workspace.id, runtime).catch(() => undefined)
      )));
    }
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: { code: "POLICY_ASSIGNMENT_NOT_FOUND", message: "Active policy assignment not found", correlationId: request.id, retryable: false } });
  });
  app.post<{ Body: { revisionNote?: string } }>("/v1/admin/policy/versions", async (request) => {
    const actor = requirePermission(request, "policy.manage");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const note = z.object({ revisionNote: z.string().min(3).max(160) }).parse(request.body ?? {});
    return security.identityPolicyStore.createMvpPolicyVersion({ tenantId: actor.tenantId, createdBy: actor.userId, revisionNote: note.revisionNote });
  });
  app.get("/v1/admin/egress-security-groups", async (request) => {
    const actor = requirePermission(request, "policy.manage");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    return { securityGroups: await security.identityPolicyStore.listEgressSecurityGroups(actor.tenantId, actor.userId) };
  });
  app.post("/v1/admin/egress-security-groups", async (request, reply) => {
    const actor = requirePermission(request, "policy.manage");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const input = saveEgressSecurityGroupSchema.parse(request.body ?? {});
    const currentVersions = await security.identityPolicyStore.listEgressSecurityGroups(actor.tenantId, actor.userId);
    const currentGroup = input.securityGroupId
      ? currentVersions.find((candidate) => candidate.securityGroupId === input.securityGroupId)
      : undefined;
    if (currentGroup?.defaultFor) {
      throw new LemmaComputerError(
        "EGRESS_SYSTEM_DEFAULT_IMMUTABLE",
        "Workspace type defaults are fixed; create a custom security group for destination exceptions",
        409,
      );
    }
    const nextDefaultAction = currentGroup?.defaultFor === "managed"
      ? "deny" as const
      : currentGroup?.defaultFor === "internet"
        ? "allow-public-http-https" as const
        : input.defaultAction;
    const effectiveRuleAction = nextDefaultAction === "allow-public-http-https" ? "deny" : "allow";
    const ineffectiveRule = input.rules.find((rule) => rule.action !== effectiveRuleAction);
    if (ineffectiveRule) {
      throw new LemmaComputerError(
        "EGRESS_RULE_HAS_NO_EFFECT",
        nextDefaultAction === "allow-public-http-https"
          ? "Public-web security groups accept blocked destinations only"
          : "Approved-destinations security groups accept approved destinations only",
        400,
      );
    }
    if (input.securityGroupId) {
      const currentAssignments = await security.identityPolicyStore.listWorkspaceEgressSecurityGroupAssignments?.({
        tenantId: actor.tenantId,
        securityGroupId: input.securityGroupId,
      }) ?? [];
      for (const assignment of currentAssignments) {
        const targetIdentity = identityContextSchema.parse({
          tenantId: actor.tenantId,
          subjectId: assignment.subjectId,
          audience: "lemmacomputer-control",
        });
        const settings = await store.getSandboxSettings?.(targetIdentity, assignment.grantId);
        const profileId = settings?.profileId ?? "claude-desktop-standard-v1";
        if (nextDefaultAction !== requiredEgressDefaultActionForProfile(profileId)) {
          throw new LemmaComputerError(
            "EGRESS_SECURITY_GROUP_IN_USE",
            "Change the workspaces using this security group before changing its default behavior",
            409,
          );
        }
      }
    }
    const saved = await security.identityPolicyStore.saveEgressSecurityGroup({
      tenantId: actor.tenantId,
      updatedBy: actor.userId,
      ...input,
    });
    const assignments = await security.identityPolicyStore.listWorkspaceEgressSecurityGroupAssignments?.({
      tenantId: actor.tenantId,
      securityGroupId: saved.securityGroupId,
    }) ?? [];
    const refreshed = await Promise.allSettled(assignments.map(async (assignment) => {
      const owner = await security.identityPolicyStore!.getPrincipal(assignment.subjectId);
      if (!owner || owner.tenantId !== actor.tenantId) return false;
      const effective = await security.identityPolicyStore!.getEffectivePolicy(owner.userId);
      if (!effective) return false;
      const { policy } = await policyForGrant(owner, effective, assignment.grantId);
      return service.refreshEgressPolicy(owner.identity, policy, assignment.grantId);
    }));
    return reply.code(201).send({
      ...saved,
      workspaceProxies: {
        refreshed: refreshed.filter((result) => result.status === "fulfilled" && result.value).length,
        failed: refreshed.filter((result) => result.status === "rejected").length,
      },
    });
  });
  app.delete<{ Params: { securityGroupId: string } }>("/v1/admin/egress-security-groups/:securityGroupId", async (request, reply) => {
    const actor = requirePermission(request, "policy.manage");
    if (!security.identityPolicyStore?.archiveEgressSecurityGroup) {
      throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Network security group storage is unavailable", 503);
    }
    const securityGroupId = z.string().min(1).max(128).parse(request.params.securityGroupId);
    const currentVersions = await security.identityPolicyStore.listEgressSecurityGroups(actor.tenantId, actor.userId);
    const currentGroup = currentVersions.find((candidate) => candidate.securityGroupId === securityGroupId);
    if (!currentGroup) {
      return reply.code(404).send({ error: { code: "EGRESS_SECURITY_GROUP_NOT_FOUND", message: "Network security group not found", correlationId: request.id, retryable: false } });
    }
    if (currentGroup.defaultFor) {
      throw new LemmaComputerError("EGRESS_SYSTEM_DEFAULT_IMMUTABLE", "Workspace type defaults cannot be deleted", 409);
    }
    const assignments = await security.identityPolicyStore.listWorkspaceEgressSecurityGroupAssignments?.({
      tenantId: actor.tenantId,
      securityGroupId,
    }) ?? [];
    if (assignments.length) {
      throw new LemmaComputerError("EGRESS_SECURITY_GROUP_IN_USE", "Detach this security group from every workspace before deleting it", 409);
    }
    const archived = await security.identityPolicyStore.archiveEgressSecurityGroup({
      tenantId: actor.tenantId,
      securityGroupId,
      archivedBy: actor.userId,
    });
    return archived
      ? reply.code(204).send()
      : reply.code(404).send({ error: { code: "EGRESS_SECURITY_GROUP_NOT_FOUND", message: "Network security group not found", correlationId: request.id, retryable: false } });
  });
  app.post<{ Params: { grantId: string } }>("/v1/admin/workspaces/:grantId/egress-security-group", async (request) => {
    const actor = principal(request);
    const input = assignEgressSecurityGroupSchema.parse(request.body ?? {});
    const grantId = z.string().min(1).max(128).parse(request.params.grantId);
    await requireWorkspaceGrantPermission(request, "policy.manage", actor.identity, grantId);
    if (!security.identityPolicyStore?.assignWorkspaceEgressSecurityGroup) {
      throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Workspace firewall storage is unavailable", 503);
    }
    const effective = await security.identityPolicyStore.getEffectivePolicy(actor.userId);
    const profileId = await workspaceProfileIdFor(actor, effective, grantId);
    const versions = await security.identityPolicyStore.listEgressSecurityGroups(actor.tenantId, actor.userId);
    const selectedVersion = versions.find((candidate) => candidate.id === input.securityGroupVersionId);
    const selectedGroup = selectedVersion
      ? versions.find((candidate) => candidate.securityGroupId === selectedVersion.securityGroupId) ?? selectedVersion
      : undefined;
    if (!selectedGroup) throw new LemmaComputerError("EGRESS_SECURITY_GROUP_NOT_FOUND", "Network security group not found", 404);
    assertEgressGroupMatchesProfile(selectedGroup, profileId);
    const assigned = await security.identityPolicyStore.assignWorkspaceEgressSecurityGroup({
      tenantId: actor.tenantId,
      subjectId: actor.userId,
      grantId,
      assignedBy: actor.userId,
      securityGroupVersionId: input.securityGroupVersionId,
    });
    if (effective) {
      const { policy } = await policyForGrant(actor, effective, grantId);
      await service.refreshEgressPolicy(actor.identity, policy, grantId);
    }
    return assigned;
  });
  app.delete<{ Params: { grantId: string } }>("/v1/admin/workspaces/:grantId/egress-security-group", async (request) => {
    const actor = principal(request);
    const grantId = z.string().min(1).max(128).parse(request.params.grantId);
    await requireWorkspaceGrantPermission(request, "policy.manage", actor.identity, grantId);
    if (!security.identityPolicyStore?.clearWorkspaceEgressSecurityGroup) {
      throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Workspace firewall storage is unavailable", 503);
    }
    await security.identityPolicyStore.clearWorkspaceEgressSecurityGroup({
      tenantId: actor.tenantId,
      subjectId: actor.userId,
      grantId,
    });
    const effective = await security.identityPolicyStore.getEffectivePolicy(actor.userId);
    const profileId = await workspaceProfileIdFor(actor, effective, grantId);
    const inherited = await workspaceEgressFor(actor, effective, grantId, profileId);
    if (effective) {
      const { policy } = await policyForGrant(actor, effective, grantId);
      await service.refreshEgressPolicy(actor.identity, policy, grantId);
    }
    return inherited;
  });
  app.get("/v1/admin/mcp-policy", async (request) => {
    const actor = requirePermission(request, "policy.manage");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const users = await security.identityPolicyStore.listUsers(actor.tenantId);
    const workspaceOwners = new Set((await store.listTenantCurrent(actor.tenantId)).map((workspace) => workspace.subjectId));
    const policyAuthority = resolveConnectorPolicyApplication(users.map((user) => ({
      userId: user.userId,
      status: user.status,
      policy: user.effectivePolicy ? {
        policyVersionId: user.effectivePolicy.policyVersionId,
        version: user.effectivePolicy.version,
        documentHash: user.effectivePolicy.documentHash,
      } : null,
    })));
    const policyApplication = resolveConnectorPolicyApplication(users
      .filter((user) => workspaceOwners.has(user.userId))
      .map((user) => ({
        userId: user.userId,
        status: user.status,
        policy: user.effectivePolicy ? {
          policyVersionId: user.effectivePolicy.policyVersionId,
          version: user.effectivePolicy.version,
          documentHash: user.effectivePolicy.documentHash,
        } : null,
      })), {
        currentVersion: policyAuthority.currentVersion,
        conflict: policyAuthority.state === "conflict",
      });
    // A unique version/hash makes every matching assignment content-equivalent.
    // Sorting by user id is only a deterministic way to obtain that verified
    // document; it never decides which member's version becomes current.
    const effective = policyAuthority.currentVersion
      ? users
          .filter((user) => user.effectivePolicy
            && user.effectivePolicy.version === policyAuthority.currentVersion!.version
            && user.effectivePolicy.documentHash === policyAuthority.currentVersion!.documentHash)
          .sort((left, right) => left.userId.localeCompare(right.userId))[0]?.effectivePolicy ?? null
      : null;
    const runtime = effective ? runtimePolicyFor(effective) : null;
    return {
      serverName: "lemmacomputer_ms365",
      version: effective?.version ?? 1,
      documentHash: effective?.documentHash ?? "0".repeat(64),
      policyApplication,
      tools: Object.entries(m365CapabilityDefinitions).map(([name, definition]) => ({
        name,
        displayName: definition.displayName,
        description: definition.description,
        service: definition.service,
        risk: definition.risk,
        decision: runtime?.toolPolicies[name] ?? (policyAuthority.state === "empty" ? definition.mode : "deny"),
      })),
    };
  });
  app.put("/v1/admin/mcp-policy", async (request) => {
    const actor = requirePermission(request, "policy.manage");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const input = saveMcpToolPolicySchema.parse(request.body ?? {});
    const expected = Object.keys(m365CapabilityDefinitions).sort();
    if (Object.keys(input.tools).sort().join("\0") !== expected.join("\0")) throw new LemmaComputerError("INVALID_TOOL_POLICY", "A decision is required for every assigned Microsoft 365 tool", 400);
    const savedPolicy = await security.identityPolicyStore.updateMvpToolPolicy({ tenantId: actor.tenantId, updatedBy: actor.userId, tools: input.tools });
    const delivery = await refreshTenantWorkspaceConnectionGrants(actor.tenantId);
    return {
      ...savedPolicy,
      workspaceGrants: { refreshed: delivery.refreshed, failed: delivery.failed },
    };
  });
  app.get("/v1/admin/provider-settings", async (request) => {
    const actor = principal(request);
    if (!hasAnyPermissionGrant(actor, "provider.manage")) {
      throw new LemmaComputerError("FORBIDDEN", "Your organization role does not allow this action", 403);
    }
    const { providers } = await requireProviderSettings().list(actor);
    const visible = providers.filter((provider) => allowsPermission(actor, "provider.manage", {
      type: "provider",
      resourceId: provider.provider,
    }));
    return { providers: visible };
  });
  app.put<{ Params: { provider: string } }>("/v1/admin/provider-settings/:provider", async (request) => {
    const provider = providerNameSchema.parse(request.params.provider);
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: provider });
    const input = provider === "bedrock"
      ? { provider, ...saveBedrockProviderApiKeySchema.parse(request.body ?? {}) }
      : provider === "openai"
      ? { provider, ...saveOpenAiProviderApiKeySchema.parse(request.body ?? {}) }
      : provider === "anthropic"
      ? { provider, ...saveAnthropicProviderApiKeySchema.parse(request.body ?? {}) }
      : { provider, ...saveGlmProviderApiKeySchema.parse(request.body ?? {}) };
    return { provider: await requireProviderSettings().configure(actor, input) };
  });
  app.post<{ Params: { provider: string } }>("/v1/admin/provider-settings/:provider/test", async (request) => {
    const provider = providerNameSchema.parse(request.params.provider);
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: provider });
    return { provider: await requireProviderSettings().test(actor, provider) };
  });
  app.post<{ Params: { provider: string } }>("/v1/admin/provider-settings/:provider/disable", async (request) => {
    const provider = providerNameSchema.parse(request.params.provider);
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: provider });
    const disabled = await requireProviderSettings().disable(actor, provider);
    return {
      provider: disabled.provider,
      workspaceGrants: disabled.workspaceGrants,
      restartRequired: disabled.workspaceGrants.revoked > 0 || disabled.workspaceGrants.failed > 0,
    };
  });
  app.post<{ Params: { provider: string } }>("/v1/admin/provider-settings/:provider/reconcile", async (request) => {
    const provider = providerNameSchema.parse(request.params.provider);
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: provider });
    const reconciled = await requireProviderSettings().reconcile(actor, provider);
    return {
      provider: reconciled.provider,
      workspaceGrants: reconciled.workspaceGrants,
      restartRequired: reconciled.workspaceGrants.revoked > 0 || reconciled.workspaceGrants.failed > 0,
    };
  });
  app.delete<{ Params: { provider: string } }>("/v1/admin/provider-settings/:provider", async (request) => {
    const provider = providerNameSchema.parse(request.params.provider);
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: provider });
    const currentMapping = await security.routingStore?.latestMappingVersion(actor.tenantId) ?? null;
    const retainedDeployments = currentMapping?.deployments.filter((deployment) => deployment.provider !== provider) ?? [];
    const removesPublishedRoutes = Boolean(currentMapping?.deployments.some((deployment) => deployment.provider === provider));
    const removed = await requireProviderSettings().remove(actor, provider);
    const mapping = removesPublishedRoutes
      ? await security.routingStore!.createMappingVersion({
          tenantId: actor.tenantId,
          revisionNote: `Disconnect ${provider} provider and remove its organization routes`,
          createdBy: actor.userId,
          deployments: retainedDeployments.map((deployment) => ({
            serviceClass: deployment.serviceClass,
            provider: deployment.provider,
            ...(deployment.providerAccountId ? { providerAccountId: deployment.providerAccountId } : {}),
            providerModel: deployment.providerModel,
            providerDeployment: deployment.providerDeployment,
            ...(deployment.region ? { region: deployment.region } : {}),
            ...(deployment.providerServiceTier ? { providerServiceTier: deployment.providerServiceTier } : {}),
            ...(deployment.rateCardId ? { rateCardId: deployment.rateCardId } : {}),
            capabilities: deployment.capabilities,
            approved: deployment.approved,
            evaluationPassed: deployment.evaluationPassed,
          })),
        })
      : currentMapping;
    return {
      deleted: true,
      mapping,
      workspaceGrants: removed.workspaceGrants,
      restartRequired: removed.workspaceGrants.revoked > 0 || removed.workspaceGrants.failed > 0,
    };
  });
  app.get("/v1/connections", async (request) => {
    const actor = principal(request);
    const { connections: catalog, connectionProjectionChanged } = await requireConnections().list(actor.identity, false);
    if (connectionProjectionChanged) await refreshOwnedWorkspaceConnectionGrants(actor);
    return { connections: catalog.map((connector) => {
      const canAdministerConnector = allowsPermission(actor, "provider.manage", {
        type: "provider",
        resourceId: connector.id,
      });
      return {
        ...connector,
        canAdministerConnector,
        canManageConnection: connector.canManageConnection || canAdministerConnector,
      };
    }) };
  });
  app.get("/v1/admin/connectors", async (request) => {
    const actor = principal(request);
    if (!hasAnyPermissionGrant(actor, "provider.manage")) {
      throw new LemmaComputerError("FORBIDDEN", "Your organization role does not allow this action", 403);
    }
    const result = await requireConnections().adminList(actor.identity);
    return { connectors: result.connectors.filter((connector) => allowsPermission(actor, "provider.manage", {
      type: "provider",
      resourceId: connector.id,
    })) };
  });
  app.get("/v1/admin/connectors/microsoft-365/sharepoint-sites", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: "microsoft-365" });
    return requireConnections().listMicrosoft365SharePointSites(actor.identity);
  });
  app.post("/v1/admin/connectors/microsoft-365/sharepoint-sites", async (request, reply) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: "microsoft-365" });
    const input = z.strictObject({
      displayName: z.string().trim().min(1).max(120),
      siteUrl: z.string().trim().min(12).max(1000),
    }).parse(request.body ?? {});
    const site = await requireConnections().createMicrosoft365SharePointSite(actor.identity, actor.userId, input);
    return reply.code(201).send({ site });
  });
  app.post<{ Params: { siteId: string } }>("/v1/admin/connectors/microsoft-365/sharepoint-sites/:siteId/verify", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: "microsoft-365" });
    const siteId = z.uuid().parse(request.params.siteId);
    const site = await requireConnections().verifyMicrosoft365SharePointSite(actor.identity, siteId);
    return { site };
  });
  app.post<{ Params: { siteId: string } }>("/v1/admin/connectors/microsoft-365/sharepoint-sites/:siteId/grant", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: "microsoft-365" });
    const siteId = z.uuid().parse(request.params.siteId);
    const site = await requireConnections().grantMicrosoft365SharePointSite(actor.identity, siteId);
    return { site };
  });
  app.delete<{ Params: { siteId: string } }>("/v1/admin/connectors/microsoft-365/sharepoint-sites/:siteId", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: "microsoft-365" });
    return requireConnections().deleteMicrosoft365SharePointSite(actor.identity, z.uuid().parse(request.params.siteId));
  });
  app.get<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/effective-policy", async (request) => {
    const connectorId = request.params.connectorId;
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: connectorId });
    if (connectorId === "microsoft-365" && !security.identityPolicyStore) {
      throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    }
    const [policyOverview, users] = await Promise.all([
      requireProtectedWorkspacePolicy().overview(actor.tenantId),
      security.identityPolicyStore
        ? security.identityPolicyStore.listUsers(actor.tenantId)
        : Promise.resolve([]),
    ]);
    const currentWorkspaces = await store.listTenantCurrent(actor.tenantId);
    const currentWorkspacesById = new Map(currentWorkspaces.map((workspace) => [workspace.id, workspace]));
    const workspaceOwners = new Set(currentWorkspaces.map((workspace) => workspace.subjectId));
    const organizationPolicy = policyOverview.organizationPolicyVersions[0] ?? null;
    const policyAuthority = connectorId === "microsoft-365"
      ? resolveConnectorPolicyApplication(users.map((user) => ({
          userId: user.userId,
          status: user.status,
          policy: user.effectivePolicy ? {
            policyVersionId: user.effectivePolicy.policyVersionId,
            version: user.effectivePolicy.version,
            documentHash: user.effectivePolicy.documentHash,
          } : null,
        })))
      : undefined;
    const policyApplication = connectorId === "microsoft-365"
      ? resolveConnectorPolicyApplication(users
          .filter((user) => workspaceOwners.has(user.userId))
          .map((user) => ({
            userId: user.userId,
            status: user.status,
            policy: user.effectivePolicy ? {
              policyVersionId: user.effectivePolicy.policyVersionId,
              version: user.effectivePolicy.version,
              documentHash: user.effectivePolicy.documentHash,
            } : null,
          })), {
            currentVersion: policyAuthority?.currentVersion ?? null,
            conflict: policyAuthority?.state === "conflict",
          })
      : undefined;
    const effective = policyAuthority?.currentVersion
      ? users
          .filter((user) => user.effectivePolicy
            && user.effectivePolicy.version === policyAuthority.currentVersion!.version
            && user.effectivePolicy.documentHash === policyAuthority.currentVersion!.documentHash)
          .sort((left, right) => left.userId.localeCompare(right.userId))[0]?.effectivePolicy ?? null
      : null;
    const runtime = effective ? runtimePolicyFor(effective) : null;
    const configuredToolPolicies = connectorId === "microsoft-365"
      ? Object.fromEntries(Object.entries(m365CapabilityDefinitions).map(([name, definition]) => [
          name,
          runtime?.toolPolicies[name] ?? (policyAuthority?.state === "empty" ? definition.mode : "deny"),
        ]))
      : undefined;
    const snapshot = await requireConnections().connectorPolicyAdministrationSnapshot(actor.identity, connectorId, {
      configuredToolPolicies,
      ...(connectorId === "microsoft-365" ? {
        toolDisplayNames: Object.fromEntries(Object.entries(m365CapabilityDefinitions).map(([name, definition]) => [name, definition.displayName])),
      } : {}),
      reviewMode: connectorId === "microsoft-365" ? "product_owned" : "provider_definition_hash",
    });
    const latestDelivery = await security.connectorRegistryStore?.latestPolicyDelivery(actor.tenantId, connectorId) ?? null;
    const usersById = new Map(users.map((user) => [user.userId, user]));
    const deliveryByMember = new Map<string, Array<{
      workspaceId: string;
      ownerSubjectId: string;
      grantId: string;
      workspaceState: WorkspaceState;
      outcome: "refreshed" | "failed" | "applies_on_next_start" | "applied_on_start";
      failureCode: string | null;
    }>>();
    const observedDeliveryWorkspaces = new Set<string>();
    for (const receipt of latestDelivery?.receipts ?? []) {
      if (observedDeliveryWorkspaces.has(receipt.workspaceId)) continue;
      observedDeliveryWorkspaces.add(receipt.workspaceId);
      const currentWorkspace = currentWorkspacesById.get(receipt.workspaceId);
      if (!currentWorkspace) continue;
      const current = deliveryByMember.get(receipt.ownerSubjectId) ?? [];
      current.push({
        workspaceId: receipt.workspaceId,
        ownerSubjectId: receipt.ownerSubjectId,
        grantId: receipt.grantId,
        workspaceState: currentWorkspace.state,
        outcome: receipt.outcome === "applies_on_next_start"
          && ["ready", "open"].includes(currentWorkspace.state)
          && currentWorkspace.updatedAt >= receipt.occurredAt
          ? "applied_on_start"
          : receipt.outcome,
        failureCode: receipt.failureCode,
      });
      deliveryByMember.set(receipt.ownerSubjectId, current);
    }
    const policy = resolveEffectiveConnectorPolicy({
      organizationPolicy: organizationPolicy ? {
        policyVersionId: organizationPolicy.policyVersionId,
        version: organizationPolicy.version,
        documentHash: organizationPolicy.documentHash,
        connectors: organizationPolicy.constraints.connectors,
      } : null,
      ...(policyApplication ? { policyApplication } : {}),
      ...snapshot,
    });
    return {
      policy: {
        ...policy,
        delivery: latestDelivery ? {
          changeEventId: latestDelivery.event.id,
          policyVersion: latestDelivery.event.newVersion,
          changedAt: latestDelivery.event.occurredAt.toISOString(),
          changedBy: latestDelivery.event.actorUserId,
          members: [...deliveryByMember.values()].map((receipts) => {
            const first = receipts[0]!;
            const user = usersById.get(first.ownerSubjectId);
            return {
              userId: first.ownerSubjectId,
              displayName: user?.displayName ?? "Former member",
              email: user?.email ?? null,
              workspaces: receipts.map((receipt) => ({
                workspaceId: receipt.workspaceId,
                grantId: receipt.grantId,
                state: receipt.workspaceState,
                delivery: receipt.outcome,
                failureCode: receipt.failureCode,
              })),
            };
          }),
        } : null,
      },
    };
  });
  app.post<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/policy-delivery/retry", async (request) => {
    const connectorId = request.params.connectorId;
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: connectorId });
    const latest = await security.connectorRegistryStore?.latestPolicyDelivery(actor.tenantId, connectorId) ?? null;
    if (!latest) {
      throw new LemmaComputerError("CONNECTOR_POLICY_DELIVERY_NOT_FOUND", "Save the connector policy before retrying workspace delivery.", 409);
    }
    return {
      workspaceGrants: await refreshTenantWorkspaceConnectionGrants(actor.tenantId, latest.event.id),
    };
  });
  app.post("/v1/admin/connectors/discover", async (request) => {
    const actor = requirePermission(request, "provider.manage");
    return requireConnections().discoverConnector(actor.identity, createConnectorSchema.parse(request.body ?? {}));
  });
  app.post("/v1/admin/connectors", async (request, reply) => {
    const actor = requirePermission(request, "provider.manage");
    const connector = await requireConnections().createConnector(
      actor.identity,
      actor.userId,
      createConnectorSchema.parse(request.body ?? {}),
    );
    return reply.code(201).send({ connector });
  });
  app.get<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/tool-policy", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: request.params.connectorId });
    return requireConnections().connectorToolPolicy(actor.identity, request.params.connectorId);
  });
  app.put<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/tool-policy", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: request.params.connectorId });
    const input = saveHostedConnectorToolPolicySchema.parse(request.body ?? {});
    const saved = await requireConnections().saveConnectorToolPolicy(
      actor.identity,
      actor.userId,
      request.params.connectorId,
      input.tools,
      input.expectedDocumentHash,
      input.expectedAccessPolicyVersion,
      randomUUID(),
    );
    return {
      ...saved,
      workspaceGrants: await refreshTenantWorkspaceConnectionGrants(actor.tenantId, saved.policyChange.id),
    };
  });
  app.put<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/access-policy", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: request.params.connectorId });
    const input = z.strictObject({
      enabled: z.boolean(),
      membersCanManage: z.boolean(),
      expectedVersion: z.number().int().positive(),
    }).parse(request.body ?? {});
    const saved = await requireConnections().updateAccessPolicy(
      actor.identity,
      actor.userId,
      request.params.connectorId,
      { ...input, correlationId: randomUUID() },
    );
    return {
      ...saved,
      workspaceGrants: await refreshTenantWorkspaceConnectionGrants(actor.tenantId, saved.policyChange.id),
    };
  });
  app.put<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/credentials", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: request.params.connectorId });
    const input = z.strictObject({
      clientId: z.string().trim().min(1).max(512),
      clientSecret: z.string().min(1).max(2048),
    }).parse(request.body ?? {});
    const connector = await requireConnections().saveConnectorCredentials(
      actor.identity,
      actor.userId,
      request.params.connectorId,
      input,
    );
    // Everyone in the tenant has to authorize against the new application, so
    // no workspace may keep a grant projected from the previous one.
    await refreshTenantWorkspaceConnectionGrants(actor.tenantId);
    return { connector };
  });
  app.delete<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/credentials", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: request.params.connectorId });
    const connector = await requireConnections().removeConnectorCredentials(actor.identity, request.params.connectorId);
    await refreshTenantWorkspaceConnectionGrants(actor.tenantId);
    return { connector };
  });
  app.put<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/icon", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: request.params.connectorId });
    const input = connectorIconSchema.parse(request.body ?? {});
    return { connector: await requireConnections().updateConnectorIcon(actor.identity, request.params.connectorId, input.iconDataUrl) };
  });
  app.delete<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: request.params.connectorId });
    const result = await requireConnections().deleteConnector(actor.identity, request.params.connectorId);
    await refreshTenantWorkspaceConnectionGrants(actor.tenantId);
    return result;
  });
  app.get<{ Params: { connectorId: string } }>("/v1/connections/:connectorId", async (request) => {
    const actor = principal(request);
    const status = await requireConnections().status(actor.identity, request.params.connectorId);
    await refreshOwnedWorkspaceConnectionGrants(actor);
    return status;
  });
  app.get<{ Params: { connectorId: string } }>("/v1/connections/:connectorId/authorize", async (request, reply) => {
    const actor = principal(request);
    const started = await requireConnections().start(actor.identity, request.params.connectorId, allowsPermission(actor, "provider.manage", {
      type: "provider", resourceId: request.params.connectorId,
    }));
    if (started.cookies.length) reply.header("set-cookie", started.cookies);
    return reply.code(302).header("location", started.location).send();
  });
  app.get<{ Params: { connectorId: string }; Querystring: { state?: string; code?: string; error?: string; error_description?: string } }>("/v1/connections/:connectorId/callback", async (request, reply) => {
    const service = requireConnections();
    try {
      const actor = principal(request);
      await service.complete(actor.identity, request.params.connectorId, {
        state: request.query.state,
        code: request.query.code,
        error: request.query.error,
        errorDescription: request.query.error_description,
      }, allowsPermission(actor, "provider.manage", { type: "provider", resourceId: request.params.connectorId }));
      await refreshOwnedWorkspaceConnectionGrants(actor);
      return reply.code(303).header("location", service.resultUrl(request.params.connectorId, "connected")).send();
    } catch (error) {
      const reason = error instanceof LemmaComputerError ? error.code : "MCP_CONNECTION_FAILED";
      return reply.code(303).header("location", service.resultUrl(request.params.connectorId, "error", reason)).send();
    }
  });
  app.get<{ Params: { connectorId: string } }>("/v1/connections/:connectorId/admin-consent", async (request) => {
    // Any member may request the link. The point of Flow B is that the person
    // who cannot finish the connection themselves can hand their administrator
    // something actionable, rather than reaching a page they cannot act on.
    const actor = principal(request);
    return requireConnections().adminConsentLink(actor.identity, request.params.connectorId, actor.userId);
  });
  app.delete<{ Params: { connectorId: string } }>("/v1/connections/:connectorId/admin-consent", async (request) => {
    const actor = requirePermission(request, "provider.manage", { type: "provider", resourceId: request.params.connectorId });
    return { connector: await requireConnections().forgetAdminConsent(actor.identity, request.params.connectorId) };
  });
  app.get<{
    Params: { connectorId: string };
    Querystring: { state?: string; tenant?: string; admin_consent?: string; error?: string; error_description?: string };
  }>("/v1/connections/:connectorId/admin-consent/callback", async (request, reply) => {
    // The administrator arriving here has no LemmaComputer session and often no
    // account, so the signed state is the only binding to an organization and
    // the reply has to be a page they can read rather than a redirect into an
    // application they cannot sign into.
    const result = await requireConnections().completeAdminConsent(request.params.connectorId, request.query);
    return reply
      .code(result.outcome === "granted" ? 200 : 400)
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(adminConsentPage(result));
  });
  app.delete<{ Params: { connectorId: string } }>("/v1/connections/:connectorId", async (request) => {
    const actor = principal(request);
    const result = await requireConnections().disconnect(actor.identity, request.params.connectorId, allowsPermission(actor, "provider.manage", {
      type: "provider", resourceId: request.params.connectorId,
    }));
    await refreshOwnedWorkspaceConnectionGrants(actor);
    return result;
  });
  app.get("/v1/credentials", async (request) => {
    await requirePolicy(request);
    return requireChannelBroker().listCredentials(identity(request));
  });
  app.post("/v1/credentials/telegram/intake-grants", async (request, reply) => {
    await requirePolicy(request);
    z.object({}).strict().parse(request.body ?? {});
    const intake = requireTelegramTokenIntake();
    const credentialId = randomUUID();
    const issued = intake.grantIssuer.issue({
      identity: identity(request),
      action: "create",
      credentialId,
      idempotencyKey: telegramIntakeIdempotency(request.headers),
      ttlSeconds: intake.ttlSeconds,
    });
    return reply.code(201).send(telegramTokenIntakeGrantSchema.parse({
      grant: issued.token,
      grantId: issued.grantId,
      credentialId,
      action: "create",
      expiresAt: issued.expiresAt.toISOString(),
      intakeUrl: intake.intakeUrl,
      encryption: {
        algorithm: "RSA-OAEP-256+A256GCM",
        keyId: "telegram-intake-rsa-oaep-256-v1",
        publicKeySpkiBase64: intake.encryptionPublicKeySpkiBase64,
      },
    }));
  });
  app.post("/v1/credentials/telegram", async (request, reply) => {
    await requirePolicy(request);
    if (telegramRawTokenInputMode === "reject") {
      throw new LemmaComputerError("TELEGRAM_RAW_TOKEN_INPUT_REJECTED", "Broker-only Telegram credential intake is required", 410);
    }
    const input = saveTelegramCredentialSchema.parse(request.body ?? {});
    return reply.code(201).send(await requireChannelBroker().saveCredential(identity(request), input));
  });
  app.post<{ Params: { credentialId: string } }>("/v1/credentials/:credentialId/telegram/intake-grants", async (request, reply) => {
    await requirePolicy(request);
    z.object({}).strict().parse(request.body ?? {});
    const credentialId = z.uuid().parse(request.params.credentialId);
    const intake = requireTelegramTokenIntake();
    const issued = intake.grantIssuer.issue({
      identity: identity(request),
      action: "rotate",
      credentialId,
      idempotencyKey: telegramIntakeIdempotency(request.headers),
      ttlSeconds: intake.ttlSeconds,
    });
    return reply.code(201).send(telegramTokenIntakeGrantSchema.parse({
      grant: issued.token,
      grantId: issued.grantId,
      credentialId,
      action: "rotate",
      expiresAt: issued.expiresAt.toISOString(),
      intakeUrl: intake.intakeUrl,
      encryption: {
        algorithm: "RSA-OAEP-256+A256GCM",
        keyId: "telegram-intake-rsa-oaep-256-v1",
        publicKeySpkiBase64: intake.encryptionPublicKeySpkiBase64,
      },
    }));
  });
  app.put<{ Params: { credentialId: string } }>("/v1/credentials/:credentialId/telegram", async (request) => {
    await requirePolicy(request);
    if (telegramRawTokenInputMode === "reject") {
      throw new LemmaComputerError("TELEGRAM_RAW_TOKEN_INPUT_REJECTED", "Broker-only Telegram credential intake is required", 410);
    }
    const credentialId = z.uuid().parse(request.params.credentialId);
    const input = saveTelegramCredentialSchema.parse(request.body ?? {});
    return requireChannelBroker().saveCredential(identity(request), input, credentialId);
  });
  app.delete<{ Params: { credentialId: string } }>("/v1/credentials/:credentialId", async (request, reply) => {
    await requirePolicy(request);
    await requireChannelBroker().deleteCredential(identity(request), z.uuid().parse(request.params.credentialId));
    return reply.code(204).send();
  });
  app.get<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/channels/telegram", async (request) => {
    const workspaceId = z.uuid().parse(request.params.workspaceId);
    await requireWorkspacePolicy(request, workspaceId);
    return await requireChannelBroker().status(identity(request), workspaceId) ?? telegramChannelConnectionStatusSchema.parse({
      state: "not_configured",
      connectionId: null,
      workspaceId,
      credentialId: null,
      allowedUserIds: [],
      allowedUserCount: 0,
      defaultAgentId: null,
      allowAgentSwitch: false,
      botUsername: null,
      tokenVersion: null,
      updatedAt: null,
    });
  });
  app.put<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/channels/telegram", async (request) => {
    const workspaceId = z.uuid().parse(request.params.workspaceId);
    requireOwnedWorkspaceManagement(request, workspaceId);
    const input = saveTelegramChannelConnectionSchema.parse({ ...(request.body as object ?? {}), workspaceId });
    const { policy } = await requireWorkspacePolicy(request, workspaceId);
    if (!assignedChatAgentIds(policy).includes(input.defaultAgentId)) {
      throw new LemmaComputerError("CHAT_AGENT_NOT_SELECTED", "The default messaging agent is not selected for this workspace", 409);
    }
    return requireChannelBroker().save(identity(request), input);
  });
  app.delete<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/channels/telegram", async (request, reply) => {
    const workspaceId = z.uuid().parse(request.params.workspaceId);
    requireOwnedWorkspaceManagement(request, workspaceId);
    await requireWorkspacePolicy(request, workspaceId);
    await requireChannelBroker().disconnect(identity(request), workspaceId);
    return reply.code(204).send();
  });
  const sandboxSettingsFor = async (
    actor: SessionPrincipal,
    effective: EffectivePolicy | null,
    grantId: string,
    includeAdministratorOptions: boolean,
  ) => {
    const document = (effective?.document ?? {}) as Record<string, unknown>;
    const assignedProfiles = Array.isArray(document.workspaceProfiles)
      ? document.workspaceProfiles.filter((item): item is string => typeof item === "string")
      : typeof document.workspaceProfile === "string" ? [document.workspaceProfile] : [testRuntimePolicy.workspaceProfile];
    const assignedModels = Array.isArray(document.modelAliases)
      ? document.modelAliases.filter((item): item is string => typeof item === "string")
      : [testRuntimePolicy.modelAlias];
    const availableAgentIds = assignedAgentIds(document);
    const availableProfiles = sandboxProfiles.filter((profile) => assignedProfiles.includes(profile.id));
    const assignedApplications = assignedApplicationIds(document);
    const availableApplications = sandboxApplications.filter((application) => assignedApplications.includes(application.id));
    const publishedServiceClasses = await publishedWorkspaceServiceClassesFor(actor.tenantId);
    const governedRoutingAvailable = Boolean(publishedServiceClasses?.length);
    const policyServiceClasses = assignedWorkspaceServiceClasses(document);
    const assignedServiceClasses = publishedServiceClasses === null
      ? policyServiceClasses
      : policyServiceClasses.filter((serviceClass) => publishedServiceClasses.includes(serviceClass));
    const governedRoutingEnabled = publishedServiceClasses !== null;
    const availableModels = sandboxModels.filter((model) => governedRoutingEnabled
      ? governedRoutingAvailable && model.alias === "lemmacomputer-auto"
      : assignedModels.includes(model.alias));
    const availableAgents = ownedAgentCatalog.filter((agent) => availableAgentIds.includes(agent.id));
    if (!availableProfiles.length) throw new LemmaComputerError("POLICY_INVALID", "The active policy has no supported sandbox profile", 500);
    const saved = await store.getSandboxSettings?.(actor.identity, grantId);
    const savedProfile = saved ? sandboxProfiles.find((profile) => profile.id === saved.profileId) : undefined;
    const selectedProfile = savedProfile ?? availableProfiles[0]!;
    const profileId = selectedProfile.id;
    const applicationIds = saved?.applicationIds.filter((id) => availableApplications.some((application) => application.id === id));
    const selectableServiceClasses = assignedServiceClasses.length
      ? assignedServiceClasses
      : policyServiceClasses;
    const requestedServiceClass = explicitWorkspaceServiceClass(
      saved?.requestedServiceClass ?? document.defaultServiceClass,
      selectableServiceClasses,
    );
    if (!requestedServiceClass) throw new LemmaComputerError("POLICY_INVALID", "The active policy has no supported Phase 0.5 model tier", 500);
    const agentIds = assignedServiceClasses.length
      ? saved?.agentIds.filter((id) => availableAgents.some((agent) => agent.id === id))
      : [];
    const selectedApplicationIds = saved ? applicationIds ?? [] : defaultApplicationIds(document, assignedApplications);
    const selectedAgentIds = assignedServiceClasses.length
      ? saved ? agentIds ?? [] : defaultAgentIds(document, availableAgentIds)
      : [];
    if (selectedAgentIds.length > 0 && !availableModels.length) {
      throw new LemmaComputerError("POLICY_INVALID", "The active policy has AI agents but no supported model route", 500);
    }
    const modelAlias = selectedAgentIds.length === 0
      ? null
      : governedRoutingAvailable
        ? "lemmacomputer-auto"
        : saved?.modelAlias && availableModels.some((model) => model.alias === saved.modelAlias)
          ? saved.modelAlias
          : availableModels[0]!.alias;
    const workspaceEgress = await workspaceEgressFor(actor, effective, grantId, profileId);
    const profileCurrentlyAllowed = availableProfiles.some((profile) => profile.id === profileId);
    const runtime = effective && profileCurrentlyAllowed
      ? runtimePolicyFor(
          effective,
          modelAlias,
          profileId,
          selectedAgentIds,
          selectedApplicationIds,
          workspaceEgress,
          governedRoutingAvailable ? ["lemmacomputer-auto"] : [],
      )
      : undefined;
    const egress = runtime?.egress ?? (workspaceEgress ? runtimeEgressForSecurityGroup(workspaceEgress) : undefined);
    const availableSecurityGroups = includeAdministratorOptions && security.identityPolicyStore?.listEgressSecurityGroups
      ? (await security.identityPolicyStore.listEgressSecurityGroups(actor.tenantId, actor.userId))
          .map((securityGroup) => restrictWorkspaceEgress(actor, effective, securityGroup)!)
      : undefined;
    const configuration = sandboxConfigurationSchema.parse({
      schemaVersion: 1,
      profileId,
      executionMode: selectedProfile.executionMode,
      egressMode: runtime?.egressMode ?? selectedProfile.egressMode,
      applicationIds: selectedApplicationIds,
      agentIds: selectedAgentIds,
      modelAlias,
      requestedServiceClass,
      egress: egress ?? null,
    });
    const current = await store.getCurrent(actor.identity, grantId);
    const telegram = current && channelBroker
      ? await channelBroker.status(actor.identity, current.id)
      : null;
    return sandboxSettingsSchema.parse({
      grantId,
      profileId,
      applicationIds: selectedApplicationIds,
      modelAlias,
      requestedServiceClass,
      routePreferenceMigrationRequired: Boolean(saved && (
        saved.agentIds.length !== selectedAgentIds.length
        || saved.agentIds.some((id, index) => id !== selectedAgentIds[index])
        || (selectedAgentIds.length > 0 && governedRoutingAvailable && saved.modelAlias !== "lemmacomputer-auto")
        || saved.requestedServiceClass !== requestedServiceClass
      )),
      profile: selectedProfile,
      availableProfiles,
      availableApplications,
      availableModels,
      availableServiceClasses: governedRoutingAvailable
        ? workspaceServiceClasses.filter((serviceClass) => assignedServiceClasses.includes(serviceClass.value))
        : workspaceServiceClasses.filter((serviceClass) => serviceClass.value === "balanced" && assignedServiceClasses.includes(serviceClass.value)),
      agentIds: selectedAgentIds,
      availableAgents,
      ...(workspaceEgress ? { securityGroup: workspaceEgress } : {}),
      ...(availableSecurityGroups ? { availableSecurityGroups } : {}),
      ...(egress ? { egress } : {}),
      manifest: workspaceManifest(configuration, telegram),
      updatedAt: saved?.updatedAt.toISOString() ?? null,
    });
  };
  const saveSandboxSettingsFor = async (
    actor: SessionPrincipal,
    effective: EffectivePolicy | null,
    input: z.infer<typeof saveSandboxSettingsSchema>,
    includeAdministratorOptions: boolean,
  ) => {
    if (!store.saveSandboxSettings) throw new LemmaComputerError("SANDBOX_SETTINGS_NOT_CONFIGURED", "Sandbox settings storage is unavailable", 503, true);
    const document = (effective?.document ?? {}) as Record<string, unknown>;
    const profiles = Array.isArray(document.workspaceProfiles) ? document.workspaceProfiles : [document.workspaceProfile ?? testRuntimePolicy.workspaceProfile];
    const applications = assignedApplicationIds(document);
    const models = Array.isArray(document.modelAliases) ? document.modelAliases : [testRuntimePolicy.modelAlias];
    const publishedServiceClasses = await publishedWorkspaceServiceClassesFor(actor.tenantId);
    const governedRoutingEnabled = publishedServiceClasses !== null;
    const governedRoutingAvailable = Boolean(publishedServiceClasses?.length);
    const policyServiceClasses = assignedWorkspaceServiceClasses(document);
    const serviceClasses = publishedServiceClasses === null
      ? policyServiceClasses
      : policyServiceClasses.filter((serviceClass) => publishedServiceClasses.includes(serviceClass));
    const modelAlias = input.agentIds.length === 0
      ? null
      : governedRoutingEnabled
        ? governedRoutingAvailable ? "lemmacomputer-auto" : null
        : input.modelAlias;
    const agents = assignedAgentIds(document);
    if (!profiles.includes(input.profileId)) throw new LemmaComputerError("PROFILE_NOT_ASSIGNED", "That sandbox profile is not assigned by your organization", 403);
    if (input.applicationIds.some((id) => !applications.includes(id))) throw new LemmaComputerError("APPLICATION_NOT_ASSIGNED", "That sandbox application is not assigned by your organization", 403);
    if (input.agentIds.length > 0 && !serviceClasses.length) {
      throw new LemmaComputerError("MODEL_ROUTES_NOT_PUBLISHED", "No organization model routes have been published for this workspace", 409);
    }
    if (input.agentIds.length > 0 && (!modelAlias || (!governedRoutingEnabled && !models.includes(modelAlias)))) {
      throw new LemmaComputerError("MODEL_NOT_ASSIGNED", "That model route is not assigned by your organization", 403);
    }
    if (input.agentIds.some((id) => !agents.includes(id))) throw new LemmaComputerError("AGENT_NOT_ASSIGNED", "That workspace agent is not assigned by your organization", 403);
    if (input.requestedServiceClass === "auto" || (input.agentIds.length > 0 && !serviceClasses.includes(input.requestedServiceClass))) throw new LemmaComputerError("SERVICE_CLASS_NOT_ASSIGNED", "That service class is not assigned by your organization", 403);
    const previousSettings = await store.getSandboxSettings?.(actor.identity, input.grantId);
    const previousProfileId = previousSettings?.profileId ?? input.profileId;
    const previousEgress = await security.identityPolicyStore?.getWorkspaceEgressSecurityGroup?.({
      tenantId: actor.tenantId,
      subjectId: actor.userId,
      grantId: input.grantId,
      profileId: previousProfileId,
    });
    const changingProfileWithCustomNetworkAccess = previousSettings?.profileId !== undefined
      && previousSettings.profileId !== input.profileId
      && previousEgress?.assignmentSource === "custom";
    if (changingProfileWithCustomNetworkAccess && !includeAdministratorOptions) {
      throw new LemmaComputerError(
        "NETWORK_ACCESS_ADMIN_REQUIRED",
        "An administrator must reset the custom network access before changing this workspace type",
        403,
      );
    }
    const current = await store.getCurrent(actor.identity, input.grantId);
    if (current && !["not_created", "stopped", "failed"].includes(current.state)) throw new LemmaComputerError("WORKSPACE_MUST_BE_STOPPED", "Stop the workspace before changing its profile or model route", 409, true);
    await store.saveSandboxSettings(actor.identity, {
      grantId: input.grantId,
      profileId: input.profileId as SandboxProfileId,
      applicationIds: input.applicationIds,
      modelAlias: modelAlias as SandboxModelAlias | null,
      requestedServiceClass: input.requestedServiceClass,
      agentIds: input.agentIds,
    });
    if (changingProfileWithCustomNetworkAccess) {
      await security.identityPolicyStore?.clearWorkspaceEgressSecurityGroup?.({
        tenantId: actor.tenantId,
        subjectId: actor.userId,
        grantId: input.grantId,
      });
    }
    return sandboxSettingsFor(actor, effective, input.grantId, includeAdministratorOptions);
  };
  const administratorTarget = async (actor: SessionPrincipal, userId: string) => {
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const target = (await security.identityPolicyStore.listUsers(actor.tenantId)).find((item) => item.userId === userId);
    if (!target) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
    const identity = identityContextSchema.parse({
      tenantId: actor.tenantId,
      subjectId: target.userId,
      audience: "lemmacomputer-control",
    });
    const principal: SessionPrincipal = {
      userId: target.userId,
      tenantId: actor.tenantId,
      email: target.email,
      displayName: target.displayName,
      tenantDisplayName: actor.tenantDisplayName,
      tenantKind: actor.tenantKind,
      roles: target.roles,
      identity,
    };
    return { target, principal };
  };
  const administratorWorkspaceReference = async (
    actor: SessionPrincipal,
    userId: string,
    workspaceReference: string,
    permission: "workspace.manage" | "policy.manage",
  ) => {
    const targetIdentity = identityContextSchema.parse({
      tenantId: actor.tenantId,
      subjectId: userId,
      audience: "lemmacomputer-control",
    });
    const organizationAllowed = allowsPermission(actor, permission);
    const workspace = await store.getOwned(targetIdentity, workspaceReference)
      ?? await store.getCurrent(targetIdentity, workspaceReference);
    if (!workspace) {
      if (!organizationAllowed) throw new LemmaComputerError("FORBIDDEN", "Your organization role does not allow this action", 403);
      throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    }
    if (!organizationAllowed && !allowsPermission(actor, permission, { type: "workspace", resourceId: workspace.id })) {
      throw new LemmaComputerError("FORBIDDEN", "Your organization role does not allow this action", 403);
    }
    return workspace;
  };
  const workspaceAdministrationCommandView = (command: Awaited<ReturnType<WorkspaceStore["completeWorkspaceAdministrationCommand"]>>, replayed: boolean) => ({
    id: command.id,
    action: command.action,
    status: command.status,
    replayed,
    resultWorkspaceState: command.resultWorkspaceState,
    failureCode: command.failureCode,
    failureRetryable: command.failureRetryable,
    requestedAt: command.requestedAt.toISOString(),
    completedAt: command.completedAt?.toISOString() ?? null,
  });
  const administratorWorkspaceCommand = async (
    request: { params: { userId: string; workspaceId: string; action: string }; headers: Record<string, unknown>; id: string },
    reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  ) => {
    const actor = principal(request);
    const action = z.enum(["start", "restart", "stop", "terminate_runtime"]).parse(request.params.action);
    const targetIdentity = identityContextSchema.parse({
      tenantId: actor.tenantId,
      subjectId: request.params.userId,
      audience: "lemmacomputer-control",
    });
    let workspace = await store.getOwned(targetIdentity, request.params.workspaceId);
    const workspaceScope = { type: "workspace" as const, resourceId: request.params.workspaceId };
    if (!workspace || !allowsPermission(actor, "workspace.manage", workspaceScope)) {
      throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    }
    const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
    if (!target.effectivePolicy) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    const { effective: targetEffective } = await effectivePolicyFor(targetPrincipal, target.effectivePolicy);
    if (!targetEffective) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    const { policy } = await policyForGrant(targetPrincipal, targetEffective, workspace.grantId);
    const key = idempotency(request.headers);
    const idempotencyKeyHash = createHash("sha256").update(key).digest("hex");
    const requestHash = createHash("sha256")
      .update(`${actor.tenantId}\0${actor.userId}\0${target.userId}\0${workspace.id}\0${action}`)
      .digest("hex");
    const begun = await store.beginWorkspaceAdministrationCommand({
      tenantId: actor.tenantId,
      workspaceId: workspace.id,
      ownerSubjectId: target.userId,
      actorUserId: actor.userId,
      action,
      idempotencyKeyHash,
      requestHash,
      correlationId: request.id,
      requestedAt: new Date(),
    });
    if (begun.replayed) {
      if (begun.command.status === "failed") {
        throw new LemmaComputerError(
          begun.command.failureCode ?? "WORKSPACE_COMMAND_FAILED",
          "The workspace command previously failed",
          begun.command.failureHttpStatus ?? 500,
          begun.command.failureRetryable ?? false,
        );
      }
      if (begun.command.status === "succeeded") {
        workspace = await store.getOwned(targetIdentity, workspace.id) ?? workspace;
        return {
          command: workspaceAdministrationCommandView(begun.command, true),
          workspace: { id: workspace.id, state: workspace.state, failureCode: workspace.failureCode, updatedAt: workspace.updatedAt.toISOString() },
        };
      }
      workspace = await store.getOwned(targetIdentity, workspace.id) ?? workspace;
      const reachedTerminalState = action === "start"
        ? ["provisioning", "restarting", "ready", "open"].includes(workspace.state)
        : action === "stop"
          ? workspace.state === "stopped"
          : workspace.updatedAt >= begun.command.requestedAt && (
            action === "restart"
              ? ["provisioning", "restarting", "ready", "open"].includes(workspace.state)
              : workspace.state === "stopped"
          );
      if (reachedTerminalState) {
        const completed = await store.completeWorkspaceAdministrationCommand({
          tenantId: actor.tenantId,
          commandId: begun.command.id,
          status: "succeeded",
          workspaceState: workspace.state,
          completedAt: new Date(),
        });
        return {
          command: workspaceAdministrationCommandView(completed, true),
          workspace: { id: workspace.id, state: workspace.state, failureCode: workspace.failureCode, updatedAt: workspace.updatedAt.toISOString() },
        };
      }
      return reply.code(202).send({
        command: workspaceAdministrationCommandView(begun.command, true),
        workspace: { id: workspace.id, state: workspace.state, failureCode: workspace.failureCode, updatedAt: workspace.updatedAt.toISOString() },
      });
    }
    try {
      if (action === "start") {
        if (!["ready", "open"].includes(workspace.state)) {
          await assertProviderConfiguration(targetPrincipal, policy);
          if (workspace.state === "not_created") {
            await service.create(targetIdentity, policy, workspace.grantId, key, request.id);
          } else {
            await service.restart(targetIdentity, policy, workspace.id, request.id);
          }
        }
      } else if (action === "restart") {
        await assertProviderConfiguration(targetPrincipal, policy);
        await service.restart(targetIdentity, policy, workspace.id, request.id);
        await security.agentInstanceStore?.endActiveForWorkspace({
          tenantId: actor.tenantId,
          ownerSubjectId: target.userId,
          workspaceId: workspace.id,
          reason: "workspace_restarted",
        });
      } else if (action === "stop") {
        await service.stop(targetIdentity, policy, workspace.id);
        await security.agentInstanceStore?.endActiveForWorkspace({
          tenantId: actor.tenantId,
          ownerSubjectId: target.userId,
          workspaceId: workspace.id,
          reason: "workspace_stopped",
        });
      } else {
        await service.terminateRuntime(targetIdentity, policy, workspace.id);
        await security.agentInstanceStore?.endActiveForWorkspace({
          tenantId: actor.tenantId,
          ownerSubjectId: target.userId,
          workspaceId: workspace.id,
          reason: "workspace_terminated",
        });
      }
      workspace = await store.getOwned(targetIdentity, workspace.id) ?? workspace;
      const completed = await store.completeWorkspaceAdministrationCommand({
        tenantId: actor.tenantId,
        commandId: begun.command.id,
        status: "succeeded",
        workspaceState: workspace.state,
        completedAt: new Date(),
      });
      return {
        command: workspaceAdministrationCommandView(completed, false),
        workspace: { id: workspace.id, state: workspace.state, failureCode: workspace.failureCode, updatedAt: workspace.updatedAt.toISOString() },
      };
    } catch (error) {
      workspace = await store.getOwned(targetIdentity, workspace.id) ?? workspace;
      const failure = error instanceof LemmaComputerError
        ? error
        : new LemmaComputerError("WORKSPACE_COMMAND_FAILED", "The workspace command failed", 500, true);
      await store.completeWorkspaceAdministrationCommand({
        tenantId: actor.tenantId,
        commandId: begun.command.id,
        status: "failed",
        workspaceState: workspace.state,
        failureCode: failure.code,
        failureHttpStatus: failure.statusCode,
        failureRetryable: failure.retryable,
        completedAt: new Date(),
      });
      throw error;
    }
  };
  app.post<{ Params: { userId: string; workspaceId: string; action: string } }>(
    "/v1/admin/users/:userId/workspaces/:workspaceId/runtime/:action",
    administratorWorkspaceCommand,
  );
  app.get<{ Params: { userId: string }; Querystring: { grantId?: string } }>(
    "/v1/admin/users/:userId/sandbox-settings",
    async (request, reply) => {
      const actor = principal(request);
      const grantId = z.string().min(1).max(128).parse(request.query.grantId ?? "personal");
      const targetIdentity = identityContextSchema.parse({ tenantId: actor.tenantId, subjectId: request.params.userId, audience: "lemmacomputer-control" });
      await requireWorkspaceGrantPermission(request, "workspace.manage", targetIdentity, grantId);
      const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
      if (!target.effectivePolicy) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
      const { effective: targetEffective } = await effectivePolicyFor(targetPrincipal, target.effectivePolicy);
      reply.header("cache-control", "no-store");
      return sandboxSettingsFor(
        targetPrincipal,
        targetEffective,
        grantId,
        await allowsWorkspaceGrantPermission(actor, "policy.manage", targetIdentity, grantId),
      );
    },
  );
  app.get<{ Params: { userId: string; workspaceId: string } }>(
    "/v1/admin/users/:userId/workspaces/:workspaceId/sandbox-settings",
    async (request, reply) => {
      const actor = principal(request);
      const workspace = await administratorWorkspaceReference(
        actor,
        request.params.userId,
        request.params.workspaceId,
        "workspace.manage",
      );
      const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
      if (!target.effectivePolicy) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
      const { effective: targetEffective } = await effectivePolicyFor(targetPrincipal, target.effectivePolicy);
      reply.header("cache-control", "no-store");
      return sandboxSettingsFor(
        targetPrincipal,
        targetEffective,
        workspace.grantId,
        allowsPermission(actor, "policy.manage")
          || allowsPermission(actor, "policy.manage", { type: "workspace", resourceId: workspace.id }),
      );
    },
  );
  app.put<{ Params: { userId: string } }>("/v1/admin/users/:userId/sandbox-settings", async (request) => {
    const actor = principal(request);
    const input = saveSandboxSettingsSchema.parse(request.body ?? {});
    const targetIdentity = identityContextSchema.parse({ tenantId: actor.tenantId, subjectId: request.params.userId, audience: "lemmacomputer-control" });
    await requireWorkspaceGrantPermission(request, "workspace.manage", targetIdentity, input.grantId);
    const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
    if (!target.effectivePolicy) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    const { effective: targetEffective } = await effectivePolicyFor(targetPrincipal, target.effectivePolicy);
    return saveSandboxSettingsFor(
      targetPrincipal,
      targetEffective,
      input,
      await allowsWorkspaceGrantPermission(actor, "policy.manage", targetIdentity, input.grantId),
    );
  });
  app.post<{ Params: { userId: string; grantId: string } }>(
    "/v1/admin/users/:userId/workspaces/:grantId/egress-security-group",
    async (request) => {
      const actor = principal(request);
      const input = assignEgressSecurityGroupSchema.parse(request.body ?? {});
      const workspaceReference = z.string().min(1).max(128).parse(request.params.grantId);
      const workspace = await administratorWorkspaceReference(
        actor,
        request.params.userId,
        workspaceReference,
        "policy.manage",
      );
      if (!security.identityPolicyStore?.assignWorkspaceEgressSecurityGroup) {
        throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Workspace firewall storage is unavailable", 503);
      }
      const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
      const grantId = workspace.grantId;
      const profileId = await workspaceProfileIdFor(targetPrincipal, target.effectivePolicy, grantId);
      const versions = await security.identityPolicyStore.listEgressSecurityGroups(actor.tenantId, actor.userId);
      const selectedVersion = versions.find((candidate) => candidate.id === input.securityGroupVersionId);
      const selectedGroup = selectedVersion
        ? versions.find((candidate) => candidate.securityGroupId === selectedVersion.securityGroupId) ?? selectedVersion
        : undefined;
      if (!selectedGroup) throw new LemmaComputerError("EGRESS_SECURITY_GROUP_NOT_FOUND", "Network security group not found", 404);
      assertEgressGroupMatchesProfile(selectedGroup, profileId);
      const assigned = await security.identityPolicyStore.assignWorkspaceEgressSecurityGroup({
        tenantId: actor.tenantId,
        subjectId: target.userId,
        grantId,
        assignedBy: actor.userId,
        securityGroupVersionId: input.securityGroupVersionId,
      });
      if (target.effectivePolicy) {
        const { policy } = await policyForGrant(targetPrincipal, target.effectivePolicy, grantId);
        await service.refreshEgressPolicy(targetPrincipal.identity, policy, grantId);
      }
      return assigned;
    },
  );
  app.delete<{ Params: { userId: string; grantId: string } }>(
    "/v1/admin/users/:userId/workspaces/:grantId/egress-security-group",
    async (request) => {
      const actor = principal(request);
      const workspaceReference = z.string().min(1).max(128).parse(request.params.grantId);
      const workspace = await administratorWorkspaceReference(
        actor,
        request.params.userId,
        workspaceReference,
        "policy.manage",
      );
      if (!security.identityPolicyStore?.clearWorkspaceEgressSecurityGroup) {
        throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Workspace firewall storage is unavailable", 503);
      }
      const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
      const grantId = workspace.grantId;
      await security.identityPolicyStore.clearWorkspaceEgressSecurityGroup({
        tenantId: actor.tenantId,
        subjectId: target.userId,
        grantId,
      });
      const profileId = await workspaceProfileIdFor(targetPrincipal, target.effectivePolicy, grantId);
      const inherited = await workspaceEgressFor(targetPrincipal, target.effectivePolicy, grantId, profileId);
      if (target.effectivePolicy) {
        const { policy } = await policyForGrant(targetPrincipal, target.effectivePolicy, grantId);
        await service.refreshEgressPolicy(targetPrincipal.identity, policy, grantId);
      }
      return inherited;
    },
  );
  app.get<{ Querystring: { grantId?: string } }>("/v1/sandbox-settings", async (request) => {
    const { principal: actor, effective } = await assignedPolicy(request);
    const grantId = z.string().min(1).max(128).parse(request.query.grantId ?? "personal");
    return sandboxSettingsFor(
      actor,
      effective,
      grantId,
      await allowsWorkspaceGrantPermission(actor, "policy.manage", actor.identity, grantId),
    );
  });
  app.put("/v1/sandbox-settings", async (request) => {
    const input = saveSandboxSettingsSchema.parse(request.body ?? {});
    const { principal: actor, effective } = await assignedPolicy(request);
    return saveSandboxSettingsFor(
      actor,
      effective,
      input,
      await allowsWorkspaceGrantPermission(actor, "policy.manage", actor.identity, input.grantId),
    );
  });
  app.post("/v1/openvtc/enrollment-challenges", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return reply.code(201).header("cache-control", "no-store").send(await security.openVtc.createEnrollmentChallenge(identity(request)));
  });
  app.post("/v1/openvtc/approvers", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    const input = z.object({ challengeId: z.uuid(), document: z.unknown() }).strict().parse(request.body ?? {});
    return reply.code(201).header("cache-control", "no-store").send(await security.openVtc.enroll(identity(request), input.challengeId, input.document));
  });
  app.get<{ Querystring: { approverDid?: string } }>("/v1/openvtc/approvers/current", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return reply.header("cache-control", "no-store").send(await security.openVtc.status(identity(request), request.query.approverDid));
  });
  app.delete<{ Querystring: { approverDid?: string } }>("/v1/openvtc/approvers/current", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return await security.openVtc.revoke(identity(request), request.query.approverDid) ? reply.code(204).send() : reply.code(404).send({ error: { code: "OPENVTC_APPROVER_NOT_FOUND", message: "No active browser approver is enrolled", correlationId: request.id, retryable: false } });
  });
  app.get<{ Querystring: { approverDid?: string } }>("/v1/openvtc/approvals/pending", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    const document = await security.openVtc.inboxForIdentity(identity(request), request.query.approverDid);
    reply.header("cache-control", "no-store");
    return document ? reply.send(document) : reply.code(204).send();
  });
  app.get("/v1/openvtc/companion/config", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return reply.header("cache-control", "no-store").send(security.openVtc.companionConfig());
  });
  app.get<{ Querystring: { cursor?: string; limit?: string } }>("/v1/openvtc/companion/activity", async (request, reply) => {
    const query = z.object({
      cursor: z.string().min(1).max(512).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }).strict().parse(request.query);
    return reply.header("cache-control", "no-store").send(await operations.companionActivity(identity(request), query));
  });
  app.get<{ Params: { operationId: string } }>("/v1/openvtc/companion/activity/:operationId", async (request, reply) => {
    const operationId = z.uuid().parse(request.params.operationId);
    return reply.header("cache-control", "no-store").send(await operations.companionActivityDetail(identity(request), operationId));
  });
  app.get("/v1/openvtc/companions", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return reply.header("cache-control", "no-store").send(await security.openVtc.companions(identity(request)));
  });
  app.put("/v1/openvtc/companions/subscription", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    const input = z.object({
      version: z.literal(COMPANION_PUSH_PROTOCOL),
      approverDid: z.string().startsWith("did:key:z").max(200),
      installationId: z.uuid(),
      browserFamily: z.enum(["chrome", "edge", "firefox", "safari", "other"]),
      platform: z.enum(["windows", "macos", "linux", "android", "ios", "other"]),
      notificationPermission: z.literal("granted"),
      subscription: z.object({
        endpoint: z.url().refine((value) => value.startsWith("https://"), "Push endpoint must use HTTPS"),
        expirationTime: z.number().int().positive().nullable(),
        keys: z.object({
          p256dh: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
          auth: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
        }).strict(),
      }).strict(),
    }).strict().parse(request.body ?? {});
    return reply.code(201).header("cache-control", "no-store").send(await security.openVtc.subscribeCompanion(identity(request), input));
  });
  app.delete<{ Params: { companionId: string } }>("/v1/openvtc/companions/:companionId", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return await security.openVtc.revokeCompanion(identity(request), request.params.companionId)
      ? reply.code(204).send()
      : reply.code(404).send({ error: { code: "OPENVTC_COMPANION_NOT_FOUND", message: "Companion browser not found", correlationId: request.id, retryable: false } });
  });
  app.post<{ Params: { companionId: string } }>("/v1/openvtc/companions/:companionId/test", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return reply.header("cache-control", "no-store").send(await security.openVtc.testCompanion(identity(request), request.params.companionId));
  });
  app.get("/v1/openvtc/inbox", async (request, reply) => {
    if (!security.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    const document = await security.openVtc.inbox(browserAgentToken(request.headers.authorization));
    reply.header("cache-control", "no-store");
    return document ? reply.send(document) : reply.code(204).send();
  });
  app.post("/trust-tasks", async (request, reply) => {
    const operation = await operations.applyOpenVtcDecision(browserAgentToken(request.headers.authorization), request.body, request.id);
    return reply.code(200).header("cache-control", "no-store").send({ accepted: true, operation });
  });
  app.get("/v1/workspaces/current", async (request, reply) => {
    const owner = identity(request);
    const existing = await store.getCurrent(owner, "personal");
    if (!existing) return reply.code(404).send({ error: { code: "WORKSPACE_NOT_FOUND", message: "Workspace not found", correlationId: request.id, retryable: false } });
    const { principal: actor, effective } = await assignedPolicy(request);
    const { policy } = await policyForGrant(actor, effective, existing.grantId);
    const current = await service.current(owner, policy, existing.grantId);
    if (current) requirePermission(request, "workspace.use", { type: "workspace", resourceId: current.id });
    return current ? reply.send(current) : reply.code(404).send({ error: { code: "WORKSPACE_NOT_FOUND", message: "Workspace not found", correlationId: request.id, retryable: false } });
  });
  app.get("/v1/workspaces", async (request) => {
    const { principal: actor, effective } = await assignedPolicy(request);
    const workspaces = await service.list(actor.identity, async (grantId) => (await policyForGrant(actor, effective, grantId)).policy);
    return { workspaces: workspaces.filter((workspace) => allowsPermission(actor, "workspace.use", {
      type: "workspace",
      resourceId: workspace.id,
    })) };
  });
  app.post("/v1/workspaces", async (request, reply) => {
    requirePermission(request, "workspace.create");
    const input = createWorkspaceSchema.parse(request.body ?? {});
    const { principal: actor, effective } = await assignedPolicy(request);
    const { policy } = await policyForGrant(actor, effective, input.grantId);
    await assertProviderConfiguration(actor, policy);
    const workspace = await service.create(identity(request), policy, input.grantId, idempotency(request.headers), request.id);
    return reply.code(201).send(workspace);
  });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/open", async (request) => {
    const actor = principal(request);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    await assertProviderConfiguration(actor, policy);
    return service.open(actor.identity, policy, request.params.workspaceId);
  });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/restart", async (request) => {
    requireOwnedWorkspaceManagement(request, request.params.workspaceId);
    const actor = principal(request);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    await assertProviderConfiguration(actor, policy);
    const result = await service.restart(actor.identity, policy, request.params.workspaceId, request.id);
    await security.agentInstanceStore?.endActiveForWorkspace({ tenantId: actor.tenantId, ownerSubjectId: actor.identity.subjectId, workspaceId: request.params.workspaceId, reason: "workspace_restarted" });
    return result;
  });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/stop", async (request) => {
    requireOwnedWorkspaceManagement(request, request.params.workspaceId);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const owner = identity(request);
    const result = await service.stop(owner, policy, request.params.workspaceId);
    await security.agentInstanceStore?.endActiveForWorkspace({ tenantId: owner.tenantId, ownerSubjectId: owner.subjectId, workspaceId: request.params.workspaceId, reason: "workspace_stopped" });
    return result;
  });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/gateway/test", async (request) => {
    requireOwnedWorkspaceManagement(request, request.params.workspaceId);
    const actor = principal(request);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    await assertProviderConfiguration(actor, policy);
    return service.testGateway(actor.identity, policy, request.params.workspaceId);
  });
  app.get<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/chat/agents", async (request, reply) => {
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const owner = identity(request);
    const serviceClassOptions = await chatServiceClassOptionsFor(owner, policy);
    const assigned = await service.agentChatAgents(owner, policy, request.params.workspaceId);
    const running = ["ready", "open"].includes(assigned.state);
    const agents = await Promise.all(assigned.accesses.map(async (access) => {
      if (!running) {
        return {
          catalogId: access.catalogId,
          displayName: access.displayName,
          state: "offline",
          reasonCode: "WORKSPACE_NOT_READY",
        };
      }
      try {
        await agentChat.health(access);
        return {
          catalogId: access.catalogId,
          displayName: access.displayName,
          state: "ready",
          reasonCode: "CHAT_AGENT_READY",
          reasoningEffortsByServiceClass: await reasoningEffortsFor(owner, policy, access.catalogId),
        };
      } catch (error) {
        if (!(error instanceof LemmaComputerError) || error.code !== "CHAT_RUNTIME_UNAVAILABLE") throw error;
        return {
          catalogId: access.catalogId,
          displayName: access.displayName,
          state: "offline",
          reasonCode: error.code,
        };
      }
    }));
    return reply.header("cache-control", "no-store").send({ workspaceId: request.params.workspaceId, serviceClassOptions, agents });
  });
  app.get<{ Params: { workspaceId: string; catalogId: string } }>("/v1/workspaces/:workspaceId/chat/agents/:catalogId/status", async (request, reply) => {
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    try {
      const access = await service.agentChatAccess(identity(request), policy, request.params.workspaceId, catalogId);
      await agentChat.health(access);
      return reply.header("cache-control", "no-store").send({
        workspaceId: request.params.workspaceId,
        catalogId,
        displayName: access.displayName,
        state: "ready",
        reasonCode: "CHAT_AGENT_READY",
      });
    } catch (error) {
      if (!(error instanceof LemmaComputerError)) throw error;
      if (error.code === "CHAT_AGENT_NOT_SELECTED") {
        return reply.header("cache-control", "no-store").send({
          workspaceId: request.params.workspaceId,
          catalogId,
          state: "unavailable",
          reasonCode: error.code,
        });
      }
      if (error.code === "WORKSPACE_NOT_READY" || error.code === "CHAT_RUNTIME_UNAVAILABLE") {
        return reply.header("cache-control", "no-store").send({
          workspaceId: request.params.workspaceId,
          catalogId,
          state: "offline",
          reasonCode: error.code,
        });
      }
      throw error;
    }
  });
  const chatSessionView = (session: ChatConversationRecord) => ({
    id: session.id,
    workspaceId: session.workspaceId,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    reasoningEffort: session.reasoningEffort,
    agentCatalogId: session.defaultAgentCatalogId,
    parentConversationId: session.parentConversationId,
    forkedFromMessageId: session.forkedFromMessageId,
  });
  app.get<{ Querystring: { cursor?: string; limit?: string } }>("/v1/chat/sessions", async (request, reply) => {
    const owner = identity(request);
    const limit = z.coerce.number().int().min(1).max(50).catch(20).parse(request.query.limit);
    const cursor = request.query.cursor ? chatSessionIdSchema.parse(request.query.cursor) : undefined;
    const page = await requireDurableChat().store.listOwnedConversations(owner, { cursor, limit });
    return reply.header("cache-control", "no-store").send({
      sessions: page.conversations.map((session) => ({
        ...chatSessionView(session),
        workspaceGrantId: session.workspaceGrantId,
        workspaceDeleted: session.workspaceDeletedAt !== null,
      })),
      nextCursor: page.nextCursor,
    });
  });
  app.get<{ Params: { sessionId: string } }>("/v1/chat/sessions/:sessionId/messages", async (request, reply) => {
    const sessionId = chatSessionIdSchema.parse(request.params.sessionId);
    const owner = identity(request);
    const conversation = await requireDurableChat().store.getConversation(owner, sessionId);
    if (!conversation) throw new LemmaComputerError("CHAT_CONVERSATION_NOT_FOUND", "Conversation not found", 404);
    const messages = await reconcileChatMessages(
      await requireDurableChat().store.listMessages(owner, sessionId),
      async (operationId) => {
        try {
          const operation = await operations.get(owner, operationId);
          return { state: operation.state, safeSummary: operation.safeSummary };
        } catch (error) {
          if (error instanceof LemmaComputerError && error.code === "OPERATION_NOT_FOUND") return undefined;
          throw error;
        }
      },
    );
    return reply.header("cache-control", "no-store").send({ messages });
  });
  app.get<{ Querystring: { cursor?: string; limit?: string; query?: string } }>("/v1/chat/artifacts", async (request, reply) => {
    const owner = identity(request);
    const limit = z.coerce.number().int().min(1).max(50).catch(20).parse(request.query.limit);
    const query = z.string().trim().max(120).catch("").parse(request.query.query);
    const cursor = request.query.cursor
      ? z.string().regex(/^artifact-[a-f0-9]{32}$/).parse(request.query.cursor)
      : undefined;
    const page = await requireDurableChat().store.listOwnedArtifacts(owner, { cursor, limit, query });
    return reply.header("cache-control", "no-store").send({
      artifacts: page.artifacts.map((saved) => ({
        id: saved.artifact.id,
        revisionId: saved.revision.id,
        conversationId: saved.artifact.conversationId,
        conversationTitle: saved.conversationTitle,
        agentCatalogId: saved.conversationAgentCatalogId,
        workspaceId: saved.artifact.workspaceId,
        workspaceGrantId: saved.workspaceGrantId,
        workspaceDeleted: saved.workspaceDeletedAt !== null,
        displayName: saved.artifact.displayName,
        mediaType: saved.revision.mediaType,
        byteLength: saved.revision.byteLength,
        direction: saved.artifact.direction,
        createdAt: saved.revision.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    });
  });
  app.get<{ Params: { workspaceId: string; catalogId: string }; Querystring: { cursor?: string; limit?: string } }>("/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions", async (request, reply) => {
    chatAgentCatalogIdSchema.parse(request.params.catalogId);
    await requireWorkspacePolicy(request, request.params.workspaceId);
    const owner = identity(request);
    const limit = z.coerce.number().int().min(1).max(50).catch(20).parse(request.query.limit);
    const cursor = request.query.cursor ? chatSessionIdSchema.parse(request.query.cursor) : undefined;
    const page = await requireDurableChat().store.listConversations(owner, request.params.workspaceId, { cursor, limit });
    const sessions = page.conversations.map(chatSessionView);
    return reply.header("cache-control", "no-store").send({ sessions, nextCursor: page.nextCursor });
  });
  app.post<{ Params: { workspaceId: string; catalogId: string } }>("/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions", async (request, reply) => {
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const input = createChatSessionSchema.parse(request.body ?? {});
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const owner = identity(request);
    await requireChatServiceClass(owner, input.requestedServiceClass, policy);
    await requireReasoningEffort(owner, policy, catalogId, input.requestedServiceClass, input.reasoningEffort);
    if (!assignedChatAgentIds(policy).includes(catalogId)) {
      throw new LemmaComputerError("CHAT_AGENT_NOT_SELECTED", "That chat agent is not selected for this workspace", 409);
    }
    const session = await requireDurableChat().store.createConversation({
      identity: owner,
      workspaceId: request.params.workspaceId,
      defaultAgentCatalogId: catalogId,
      title: input.title,
      requestedServiceClass: input.requestedServiceClass,
      reasoningEffort: input.reasoningEffort,
    });
    return reply.code(201).header("cache-control", "no-store").send(chatSessionView(session));
  });
  app.get<{ Params: { workspaceId: string; catalogId: string; sessionId: string } }>("/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/messages", async (request, reply) => {
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const sessionId = chatSessionIdSchema.parse(request.params.sessionId);
    await requireWorkspacePolicy(request, request.params.workspaceId);
    const owner = identity(request);
    const conversation = await requireDurableChat().store.getConversation(owner, sessionId);
    if (!conversation || conversation.workspaceId !== request.params.workspaceId) {
      throw new LemmaComputerError("CHAT_CONVERSATION_NOT_FOUND", "Conversation not found", 404);
    }
    const messages = await reconcileChatMessages(
      await requireDurableChat().store.listMessages(owner, sessionId),
      async (operationId) => {
        try {
          const operation = await operations.get(owner, operationId);
          return { state: operation.state, safeSummary: operation.safeSummary };
        } catch (error) {
          if (error instanceof LemmaComputerError && error.code === "OPERATION_NOT_FOUND") return undefined;
          throw error;
        }
      },
    );
    return reply.header("cache-control", "no-store").send({ messages });
  });
  app.post<{ Params: { workspaceId: string; sessionId: string } }>(
    "/v1/workspaces/:workspaceId/chat/sessions/:sessionId/forks",
    async (request, reply) => {
      const input = z.strictObject({
        fromMessageId: chatPartIdSchema,
        agentCatalogId: chatAgentCatalogIdSchema,
        requestedServiceClass: z.enum(["lite", "balanced", "pro"]),
        reasoningEffort: z.enum(["auto", "low", "medium", "high"]).optional(),
      }).parse(request.body ?? {});
      const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
      if (!assignedChatAgentIds(policy).includes(input.agentCatalogId)) {
        throw new LemmaComputerError("CHAT_AGENT_NOT_SELECTED", "That chat agent is not selected for this workspace", 409);
      }
      const owner = identity(request);
      await requireChatServiceClass(owner, input.requestedServiceClass, policy);
      await requireReasoningEffort(owner, policy, input.agentCatalogId, input.requestedServiceClass, input.reasoningEffort);
      const source = await requireDurableChat().store.getConversation(owner, request.params.sessionId);
      if (!source) {
        throw new LemmaComputerError("CHAT_CONVERSATION_NOT_FOUND", "Conversation not found", 404);
      }
      const fork = await requireDurableChat().store.forkConversation({
        identity: owner,
        conversationId: source.id,
        fromMessageId: input.fromMessageId,
        targetWorkspaceId: request.params.workspaceId,
        defaultAgentCatalogId: input.agentCatalogId,
        requestedServiceClass: input.requestedServiceClass,
        reasoningEffort: input.reasoningEffort,
      });
      return reply.code(201).header("cache-control", "no-store").send(chatSessionView(fork));
    },
  );
  app.get<{ Params: { artifactId: string }; Querystring: { revision?: string } }>(
    "/v1/chat/artifacts/:artifactId/content",
    async (request, reply) => {
      const artifactId = z.string().regex(/^artifact-[a-f0-9]{32}$/).parse(request.params.artifactId);
      const revisionId = request.query.revision
        ? z.string().regex(/^revision-[a-f0-9]{32}$/).parse(request.query.revision)
        : undefined;
      const saved = await requireDurableChat().service.readArtifact(identity(request), artifactId, revisionId);
      return reply
        .header("cache-control", "private, no-store")
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(saved.artifact.displayName)}`)
        .header("x-content-type-options", "nosniff")
        .header("x-lemmacomputer-artifact-sha256", saved.revision.sha256)
        .type(saved.revision.mediaType)
        .send(saved.bytes);
    },
  );
  const activityScope = async (request: {
    params: { workspaceId: string; catalogId: string; sessionId: string; turnId: string };
  }) => {
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const sessionId = chatSessionIdSchema.parse(request.params.sessionId);
    const turnId = chatPartIdSchema.parse(request.params.turnId);
    const owner = identity(request);
    await requireWorkspacePolicy(request, request.params.workspaceId);
    const scope: ActivityEventScope = {
      workspaceId: request.params.workspaceId,
      agentCatalogId: catalogId,
      sessionId,
      turnId,
    };
    return { owner, scope };
  };
  app.get<{
    Params: { workspaceId: string; catalogId: string; sessionId: string; turnId: string };
    Querystring: { after?: string; limit?: string };
  }>(
    "/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/turns/:turnId/activity",
    async (request, reply) => {
      const { owner, scope } = await activityScope(request);
      const after = z.coerce.number().int().min(-1).max(100_000).catch(-1).parse(request.query.after);
      const limit = z.coerce.number().int().min(1).max(500).catch(200).parse(request.query.limit);
      return reply.header("cache-control", "no-store").send(await activityEvents.replay(owner, scope, after, limit));
    },
  );
  app.get<{
    Params: { workspaceId: string; catalogId: string; sessionId: string; turnId: string };
    Querystring: { after?: string };
  }>(
    "/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/turns/:turnId/activity/stream",
    async (request, reply) => {
      const { owner, scope } = await activityScope(request);
      const expected = principal(request);
      const customerHeaders = fromNodeHeaders(request.raw.headers);
      const customerProductAuthentication = security.customerProductAuthentication;
      const authorize = security.testIdentityMode
        ? undefined
        : async () => {
            const current = customerProductAuthentication
              ? await customerProductAuthentication.resolve(customerHeaders).then((resolution) => (
                  resolution.status === "authorized" ? resolution.principal : null
                ))
              : null;
            if (!current
              || current.userId !== expected.userId
              || current.tenantId !== expected.tenantId
              || current.membershipId !== expected.membershipId
              || current.accountUserId !== expected.accountUserId) {
              throw new LemmaComputerError(
                "ACTIVITY_STREAM_REVOKED",
                "Activity stream access is no longer active",
                403,
              );
            }
          };
      const lastEventId = Array.isArray(request.headers["last-event-id"])
        ? request.headers["last-event-id"][0]
        : request.headers["last-event-id"];
      const after = z.coerce.number().int().min(-1).max(100_000).catch(-1).parse(request.query.after ?? lastEventId);
      await activityEvents.replay(owner, scope, after, 1);
      const abort = new AbortController();
      request.raw.once("aborted", () => abort.abort("browser-disconnected"));
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) abort.abort("browser-disconnected");
      });
      async function* frames() {
        for await (const event of activityEvents.subscribe(owner, scope, after, abort.signal, authorize)) {
          yield activitySseFrame(event);
        }
      }
      return reply
        .header("cache-control", "no-store")
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("x-accel-buffering", "no")
        .send(Readable.from(frames()));
    },
  );
  app.delete<{ Params: { workspaceId: string; catalogId: string; sessionId: string } }>(
    "/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/turns/active",
    async (request, reply) => {
      const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
      const sessionId = chatSessionIdSchema.parse(request.params.sessionId);
      const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
      const access = await service.agentChatAccess(
        identity(request), policy, request.params.workspaceId, catalogId,
      );
      await agentChat.cancelTurn(access, sessionId);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { workspaceId: string; catalogId: string; sessionId: string } }>(
    "/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/messages",
    { bodyLimit: 24 * 1024 * 1024 },
    async (request, reply) => {
    const launchIdempotencyKey = idempotency(request.headers);
    if (callerSuppliedAgentInstanceId(request.body)) {
      throw new LemmaComputerError(
        "AGENT_INSTANCE_ID_FORBIDDEN",
        "Agent instance identities are issued only by the trusted Control launch boundary",
        400,
      );
    }
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const sessionId = chatSessionIdSchema.parse(request.params.sessionId);
    const input = sendChatTurnSchema.parse(request.body ?? {});
    if (input.message.metadata.agentCatalogId !== catalogId) {
      throw new LemmaComputerError("CHAT_AGENT_MISMATCH", "The submitted message does not belong to the selected agent", 409);
    }
    const { policy, workspace } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const owner = identity(request);
    await requireChatServiceClass(owner, input.requestedServiceClass, policy);
    await requireReasoningEffort(
      owner,
      policy,
      catalogId,
      input.requestedServiceClass,
      input.reasoningEffort,
    );
    const includesImage = input.message.parts.some(
      (part) => part.type === "file" && part.mediaType.startsWith("image/"),
    );
    if (includesImage) {
      if (!gateway) {
        throw new LemmaComputerError(
          "MODEL_CAPABILITY_UNAVAILABLE",
          "The selected model route's image capability could not be verified",
          503,
          true,
        );
      }
      if (!policy.modelAlias) {
        throw new LemmaComputerError(
          "WORKSPACE_AI_NOT_SELECTED",
          "This workspace does not have an AI agent or model route selected",
          409,
        );
      }
      const capabilities = await gateway.modelCapabilities(policy.modelAlias);
      if (!capabilities.vision) {
        throw new LemmaComputerError(
          "MODEL_IMAGE_INPUT_UNSUPPORTED",
          "The selected workspace model does not support image input. Choose a vision-capable model or remove the image.",
          422,
        );
      }
    }
    const durable = requireDurableChat();
    const conversation = await durable.store.getConversation(owner, sessionId);
    if (!conversation || conversation.workspaceId !== request.params.workspaceId) {
      throw new LemmaComputerError("CHAT_CONVERSATION_NOT_FOUND", "Conversation not found", 404);
    }
    if (conversation.defaultAgentCatalogId !== catalogId) {
      throw new LemmaComputerError("CHAT_AGENT_MISMATCH", "Continue with another agent by creating an explicit conversation fork", 409);
    }
    const history = await durable.store.listMessages(owner, sessionId);
    const access = await service.agentChatAccess(owner, policy, request.params.workspaceId, catalogId);
    const persistedUser = await durable.service.persistUserMessage({
      identity: owner,
      conversation,
      access,
      message: input.message,
    });
    const vendorSessionId = await durable.store.getVendorSession(owner, sessionId, catalogId) ?? undefined;
    const processLifecycle = await agentProcesses.beginBrowserChat({
      identity: owner,
      workspace,
      policy,
      catalogId,
      logicalAgentId: access.agentId,
      sessionId,
      idempotencyKey: launchIdempotencyKey,
    });
    const mapper = new AgentUiStreamMapper(catalogId);
    const accumulator = new AgentMessageAccumulator(catalogId);
    const chunks: ReturnType<AgentUiStreamMapper["chunks"]>[number][] = [];
    const waiters = new Set<() => void>();
    let pumpDone = false;
    let pumpError: unknown;
    const notify = () => {
      for (const waiter of waiters) waiter();
      waiters.clear();
    };
    const pump = async () => {
      let lastEvent: AgentChatEvent | undefined;
      let processStarted = false;
      let processEnded = false;
      const agentInstanceId = processLifecycle.identity.state === "verified"
        ? processLifecycle.identity.agentInstanceId
        : undefined;
      try {
        const usageTaskBinding = issueUsageTaskBinding(
          owner, request.params.workspaceId, access.agentId, "chat", input.message.id, sessionId,
          undefined, input.requestedServiceClass, agentInstanceId,
          input.reasoningEffort, policy.maximumReasoningEffort,
        );
        for await (const event of agentChat.streamTurn(
          access, sessionId, persistedUser.runtimeMessage, undefined, usageTaskBinding, agentInstanceId,
          input.reasoningEffort, history, vendorSessionId,
        )) {
          if (event.type === "turn-start") {
            await processLifecycle.markRunning(event.turnId);
            await durable.store.beginRun({
              identity: owner,
              conversationId: sessionId,
              turnId: event.turnId,
              effectiveAgentCatalogId: catalogId,
              requestedServiceClass: input.requestedServiceClass,
              reasoningEffort: input.reasoningEffort,
              policyVersionId: policy.policyVersionId,
              policyVersion: policy.policyVersion,
              policyHash: policy.policyHash,
              workspaceId: request.params.workspaceId,
              workspaceNodeId: access.workspaceNodeId,
              accessGeneration: access.accessGeneration,
              agentInstanceId,
            });
            processStarted = true;
          }
          let projected: AgentChatEvent = event.type === "artifact"
            ? await durable.service.persistGeneratedArtifact({
                identity: owner,
                conversation,
                access,
                client: agentChat,
                event,
              })
            : event;
          if (event.type === "approval") {
            try {
              const operation = await operations.get(owner, event.operationId);
              projected = {
                ...event,
                summary: chatApprovalSummary(event.state, operation.safeSummary),
              };
            } catch (error) {
              if (!(error instanceof LemmaComputerError && error.code === "OPERATION_NOT_FOUND")) throw error;
            }
          }
          await activityEvents.recordAgentEvent({
            identity: owner,
            ...(agentInstanceId ? { agentInstanceId } : {}),
            workspaceId: request.params.workspaceId,
            agentCatalogId: catalogId,
            sessionId,
            displayName: access.displayName,
            event: projected,
          });
          lastEvent = projected;
          accumulator.apply(projected);
          const checkpoint = accumulator.snapshot();
          if (checkpoint) {
            await durable.store.upsertMessage(owner, sessionId, checkpoint);
            await durable.service.bindMessageArtifacts(owner, sessionId, checkpoint);
          }
          chunks.push(...mapper.chunks(projected));
          if (event.type === "turn-finish") {
            if (event.vendorSessionId) {
              await durable.store.setVendorSession(owner, sessionId, catalogId, event.vendorSessionId);
            }
            await durable.store.finishRun(owner, sessionId, event.turnId, {
              status: event.state,
              assistantMessageId: checkpoint?.id,
              ...(event.state === "failed" ? { failureCode: "AGENT_TURN_FAILED" } : {}),
              completedAt: new Date(event.completedAt),
            });
            await processLifecycle.end(event.state === "failed" ? "provider_failed" : "process_exited");
            processEnded = true;
          }
          notify();
        }
      } catch (error) {
        pumpError = error;
        if (!processEnded) {
          try {
            await processLifecycle.end(processStarted ? "provider_failed" : "launch_failed");
          } catch (lifecycleError) {
            // Compliance evidence is part of the launch contract. A failure to
            // record it must surface rather than being hidden by the upstream
            // process error that triggered lifecycle closure.
            pumpError = lifecycleError;
          }
        }
        if (lastEvent && lastEvent.type !== "turn-finish") {
          const completedAt = new Date().toISOString();
          const terminal = {
            version: 1 as const,
            sequence: lastEvent.sequence + 1,
            sessionId,
            turnId: lastEvent.turnId,
            type: "turn-finish" as const,
            state: "failed" as const,
            message: "The agent stream ended before completion",
            completedAt,
          };
          await activityEvents.recordAgentEvent({
            identity: owner,
            ...(agentInstanceId ? { agentInstanceId } : {}),
            workspaceId: request.params.workspaceId,
            agentCatalogId: catalogId,
            sessionId,
            displayName: access.displayName,
            event: terminal,
          }).catch(() => undefined);
          try {
            accumulator.apply(terminal);
            const checkpoint = accumulator.snapshot();
            if (checkpoint) {
              await durable.store.upsertMessage(owner, sessionId, checkpoint);
              await durable.service.bindMessageArtifacts(owner, sessionId, checkpoint);
            }
            if (processStarted) {
              await durable.store.finishRun(owner, sessionId, terminal.turnId, {
                status: "failed",
                assistantMessageId: checkpoint?.id,
                failureCode: error instanceof LemmaComputerError ? error.code : "AGENT_STREAM_FAILED",
                completedAt: new Date(completedAt),
              });
            }
          } catch (persistenceError) {
            pumpError = persistenceError;
          }
        }
      } finally {
        pumpDone = true;
        notify();
      }
    };
    void pump();
    const stream = createUIMessageStream<ChatUiMessage>({
      execute: async ({ writer }) => {
        let cursor = 0;
        while (true) {
          while (cursor < chunks.length) writer.write(chunks[cursor++]!);
          if (pumpDone) {
            if (pumpError) throw pumpError;
            return;
          }
          await new Promise<void>((resolve) => waiters.add(resolve));
        }
      },
      onError: (error) => error instanceof LemmaComputerError
        ? error.message
        : "The selected workspace agent could not complete this turn.",
    });
    const response = createUIMessageStreamResponse({ stream });
    response.headers.forEach((value, name) => reply.header(name, value));
    return reply.send(Readable.fromWeb(response.body! as never));
    },
  );
  app.get<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/deletion-impact", async (request, reply) => {
    requireOwnedWorkspaceManagement(request, request.params.workspaceId);
    await requireWorkspacePolicy(request, request.params.workspaceId);
    return reply.header("cache-control", "no-store").send(await service.deletionImpact(identity(request), request.params.workspaceId));
  });
  app.delete<{ Params: { workspaceId: string }; Body: unknown }>("/v1/workspaces/:workspaceId", async (request, reply) => {
    requireOwnedWorkspaceManagement(request, request.params.workspaceId);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const input = deleteWorkspaceSchema.parse(request.body ?? {});
    await service.delete(identity(request), policy, request.params.workspaceId, input.contentDisposition);
    const owner = identity(request);
    await security.agentInstanceStore?.endActiveForWorkspace({ tenantId: owner.tenantId, ownerSubjectId: owner.subjectId, workspaceId: request.params.workspaceId, reason: "workspace_terminated" });
    return reply.code(204).send();
  });
  app.get("/v1/skills", async (request, reply) => {
    await requirePolicy(request);
    return reply.header("cache-control", "no-store").send({ skills: reviewedAgentSkillCatalog });
  });
  app.get("/v1/sites", async (request, reply) => {
    await requirePolicy(request);
    return reply.header("cache-control", "no-store").send(await requireSites().list(identity(request)));
  });
  app.get<{ Params: { siteId: string } }>("/v1/sites/:siteId/preview", async (request, reply) => {
    await requirePolicy(request);
    return reply.header("cache-control", "no-store").send(await requireSites().preview(identity(request), request.params.siteId));
  });
  app.get<{ Params: { siteId: string } }>("/v1/sites/:siteId/content", async (request, reply) => {
    await requirePolicy(request);
    const { html } = await requireSites().preview(identity(request), request.params.siteId);
    return reply
      .headers({
        "cache-control": "no-store",
        "content-security-policy": "sandbox allow-scripts; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
        "cross-origin-opener-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      })
      .type("text/html; charset=utf-8")
      .send(html);
  });
  app.delete<{ Params: { siteId: string } }>("/v1/sites/:siteId", async (request, reply) => {
    await requirePolicy(request);
    await requireSites().delete(identity(request), request.params.siteId);
    return reply.code(204).send();
  });
  app.get("/v1/schedules", async (request) => {
    await assignedPolicy(request);
    return requireSchedules().list(identity(request));
  });
  app.post("/v1/schedules", async (request, reply) => {
    await assignedPolicy(request);
    const created = await requireSchedules().create(identity(request), createScheduleSchema.parse(request.body ?? {}));
    return reply.code(201).send(created);
  });
  app.patch<{ Params: { scheduleId: string } }>("/v1/schedules/:scheduleId", async (request) => {
    await assignedPolicy(request);
    return requireSchedules().update(identity(request), z.uuid().parse(request.params.scheduleId), updateScheduleSchema.parse(request.body ?? {}));
  });
  app.delete<{ Params: { scheduleId: string } }>("/v1/schedules/:scheduleId", async (request, reply) => {
    await assignedPolicy(request);
    await requireSchedules().remove(identity(request), z.uuid().parse(request.params.scheduleId));
    return reply.code(204).send();
  });
  app.get<{ Params: { scheduleId: string }; Querystring: { limit?: string } }>("/v1/schedules/:scheduleId/runs", async (request) => {
    await assignedPolicy(request);
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(request.query.limit);
    return requireSchedules().runs(identity(request), z.uuid().parse(request.params.scheduleId), limit);
  });
  app.post<{ Params: { scheduleId: string } }>("/v1/schedules/:scheduleId/run", async (request, reply) => {
    await assignedPolicy(request);
    const run = await requireSchedules().runNow(identity(request), z.uuid().parse(request.params.scheduleId));
    return reply.code(202).send(run);
  });
  app.get("/v1/operations/recent", async (request, reply) => {
    await requirePolicy(request);
    const operation = await operations.recent(identity(request));
    return operation ? reply.send(operation) : reply.code(204).send();
  });
  app.get("/v1/operations", async (request) => {
    await requirePolicy(request);
    return { operations: await operations.history(identity(request)) };
  });
  app.post("/v1/operations/delete-file", async (request, reply) => {
    const input = createDeleteFileOperationSchema.parse(request.body ?? {});
    await requirePolicy(request);
    const operation = await operations.createDeleteFile(identity(request), input.workspaceId, input.path, idempotency(request.headers), request.id);
    return reply.code(201).send(operation);
  });
  app.get<{ Params: { operationId: string } }>("/v1/operations/:operationId", async (request) => { await requirePolicy(request); return operations.get(identity(request), request.params.operationId); });
  app.get<{ Params: { operationId: string } }>("/v1/operations/:operationId/audit", async (request) => { await requirePolicy(request); return operations.audit(identity(request), request.params.operationId); });
  app.post<{ Params: { operationId: string } }>("/v1/operations/:operationId/fixture-decision", async (request) => {
    idempotency(request.headers);
    const input = fixtureApprovalSchema.parse(request.body ?? {});
    await requirePolicy(request);
    return operations.decideWithFixture(identity(request), request.params.operationId, input.decision, request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const validation = errorName === "ZodError";
    const known = error instanceof LemmaComputerError ? error : validation ? new LemmaComputerError("INVALID_REQUEST", "The request is invalid", 400) : new LemmaComputerError("INTERNAL_ERROR", "The request could not be completed", 500, true);
    request.log.error({ err: { name: errorName, code: known.code } }, "control request failed");
    reply.code(known.statusCode).send({ error: { code: known.code, message: known.message, correlationId: request.id, retryable: known.retryable } });
  });

  let grantRenewalTimer: NodeJS.Timeout | undefined;
  let grantRenewalRunning = false;
  const renewRunningGrants = async () => {
    if (
      grantRenewalRunning
      || !security.grantRenewal
      || !security.identityPolicyStore
      || !gateway
    ) return;
    grantRenewalRunning = true;
    try {
      const users = await security.identityPolicyStore.listUsers(security.grantRenewal.tenantId);
      const results = await Promise.allSettled(users.map(async (user) => {
        if (!user.effectivePolicy) return false;
        const actor = await security.identityPolicyStore!.getPrincipal(user.userId);
        if (!actor || actor.tenantId !== security.grantRenewal!.tenantId) return false;
        const { policy } = await policyForGrant(actor, user.effectivePolicy);
        return service.refreshPolicyGrant(actor.identity, policy);
      }));
      app.log.info({
        event: "workspace_grant_renewal",
        renewed: results.filter((result) => result.status === "fulfilled" && result.value).length,
        skipped: results.filter((result) => result.status === "fulfilled" && !result.value).length,
        failed: results.filter((result) => result.status === "rejected").length,
      }, "workspace gateway grants reconciled");
    } finally {
      grantRenewalRunning = false;
    }
  };
  if (security.grantRenewal && security.identityPolicyStore && gateway) {
    app.addHook("onReady", async () => {
      await renewRunningGrants();
      grantRenewalTimer = setInterval(() => { void renewRunningGrants(); }, security.grantRenewal!.intervalMs);
      grantRenewalTimer.unref();
    });
    app.addHook("onClose", async () => {
      if (grantRenewalTimer) clearInterval(grantRenewalTimer);
    });
  }
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const env = envSchema.parse(process.env);
  const store = PostgresWorkspaceStore.fromConnectionString(env.DATABASE_URL);
  await store.assertSchemaCompatible();
  const chatStore = PostgresChatStore.fromConnectionString(env.DATABASE_URL);
  let artifactStore: ArtifactStore;
  if (env.ARTIFACT_STORE_BACKEND === "filesystem") {
    if (!env.ARTIFACT_FILESYSTEM_ROOT) throw new Error("Filesystem artifact storage requires ARTIFACT_FILESYSTEM_ROOT");
    if (env.LEMMACOMPUTER_INSTALLATION_KIND === "hosted") throw new Error("Hosted deployments require S3 artifact storage");
    artifactStore = new FilesystemArtifactStore(env.ARTIFACT_FILESYSTEM_ROOT);
  } else {
    if (!env.ARTIFACT_S3_BUCKET || !env.ARTIFACT_S3_REGION) throw new Error("S3 artifact storage requires bucket and region");
    artifactStore = new S3ArtifactStore({
      bucket: env.ARTIFACT_S3_BUCKET,
      region: env.ARTIFACT_S3_REGION,
      ...(env.ARTIFACT_S3_ENDPOINT ? { endpoint: env.ARTIFACT_S3_ENDPOINT } : {}),
      forcePathStyle: env.ARTIFACT_S3_FORCE_PATH_STYLE === "true",
      ...(env.ARTIFACT_S3_KMS_KEY_ID ? { kmsKeyId: env.ARTIFACT_S3_KMS_KEY_ID } : {}),
    });
  }
  const authenticationSchema = await PostgresAuthenticationStore.fromConnectionString(env.AUTH_DATABASE_URL);
  try {
    await authenticationSchema.assertSchemaCompatible();
  } finally {
    await authenticationSchema.close();
  }
  const googleConfigured = Boolean(env.GOOGLE_AUTH_CLIENT_ID || env.GOOGLE_AUTH_CLIENT_SECRET);
  if (googleConfigured && !(env.GOOGLE_AUTH_CLIENT_ID && env.GOOGLE_AUTH_CLIENT_SECRET)) {
    throw new Error("Google customer authentication client ID and secret must be configured together");
  }
  const microsoftConfigured = Boolean(env.MICROSOFT_AUTH_CLIENT_ID || env.MICROSOFT_AUTH_CLIENT_SECRET);
  if (microsoftConfigured && !(env.MICROSOFT_AUTH_CLIENT_ID && env.MICROSOFT_AUTH_CLIENT_SECRET)) {
    throw new Error("Microsoft customer authentication client ID and secret must be configured together");
  }
  const authenticationPool = new postgres.Pool({ connectionString: env.AUTH_DATABASE_URL });
  const publicWebOrigin = new URL(env.PUBLIC_WEB_URL).origin;
  const customerAuthenticationSecrets = parseVersionedBetterAuthSecrets(env.BETTER_AUTH_SECRETS);
  let platformAuthenticationPool: postgres.Pool | undefined;
  let platformAuthentication: PlatformAuthentication | undefined;
  let platformOperatorBootstrap: PlatformOperatorBootstrap | undefined;
  if (env.LEMMACOMPUTER_INSTALLATION_KIND !== "customer-managed") {
    if (!env.PLATFORM_AUTH_DATABASE_URL || !env.PLATFORM_BETTER_AUTH_SECRETS) {
      throw new Error("Platform authentication requires its isolated database and Better Auth secrets");
    }
    if (env.LEMMACOMPUTER_INSTALLATION_KIND === "hosted" && !env.PLATFORM_AUTH_BOOTSTRAP_EMAIL) {
      throw new Error("Hosted platform authentication requires an explicit bootstrap operator email");
    }
    const platformAuthenticationSchema = await PostgresAuthenticationStore.fromConnectionString(env.PLATFORM_AUTH_DATABASE_URL);
    try {
      await platformAuthenticationSchema.assertSchemaCompatible();
    } finally {
      await platformAuthenticationSchema.close();
    }
    platformAuthenticationPool = new postgres.Pool({ connectionString: env.PLATFORM_AUTH_DATABASE_URL });
    platformAuthentication = createPlatformAuthentication({
      database: platformAuthenticationPool,
      baseUrl: publicWebOrigin,
      trustedOrigins: [publicWebOrigin],
      versionedSecrets: parseVersionedBetterAuthSecrets(env.PLATFORM_BETTER_AUTH_SECRETS),
      installationKind: env.LEMMACOMPUTER_INSTALLATION_KIND,
      passkey: { rpId: new URL(publicWebOrigin).hostname, origin: publicWebOrigin },
    });
    platformOperatorBootstrap = env.LEMMACOMPUTER_INSTALLATION_KIND === "worktree"
      ? worktreePlatformOperatorBootstrap(env.PLATFORM_AUTH_BOOTSTRAP_SECRET!)
      : {
          mode: "hosted",
          email: env.PLATFORM_AUTH_BOOTSTRAP_EMAIL!,
          displayName: env.PLATFORM_AUTH_BOOTSTRAP_DISPLAY_NAME,
          secret: env.PLATFORM_AUTH_BOOTSTRAP_SECRET,
        };
  }
  const transactionalEmail = createTransactionalEmailAdapter({
    transport: env.AUTH_EMAIL_TRANSPORT,
    installationKind: env.LEMMACOMPUTER_INSTALLATION_KIND,
    runtimeEnvironment: env.RUNTIME_ENVIRONMENT,
    postmarkServerToken: env.POSTMARK_SERVER_TOKEN,
    postmarkFrom: env.POSTMARK_FROM,
    postmarkMessageStream: env.POSTMARK_MESSAGE_STREAM,
  });
  const customerAuthenticationOptions = {
    database: authenticationPool,
    baseUrl: publicWebOrigin,
    trustedOrigins: [publicWebOrigin],
    ssoTrustedOrigins: env.CUSTOMER_SSO_TRUSTED_IDP_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
    versionedSecrets: customerAuthenticationSecrets,
    installationKind: env.LEMMACOMPUTER_INSTALLATION_KIND,
    trustedProxyCidrs: env.BETTER_AUTH_TRUSTED_PROXY_CIDRS.split(",").map((value) => value.trim()).filter(Boolean),
    email: transactionalEmail,
    passkey: { rpId: new URL(publicWebOrigin).hostname, origin: publicWebOrigin },
    socialProviders: {
      google: env.GOOGLE_AUTH_CLIENT_ID && env.GOOGLE_AUTH_CLIENT_SECRET
        ? { clientId: env.GOOGLE_AUTH_CLIENT_ID, clientSecret: env.GOOGLE_AUTH_CLIENT_SECRET }
        : undefined,
      microsoft: env.MICROSOFT_AUTH_CLIENT_ID && env.MICROSOFT_AUTH_CLIENT_SECRET
        ? { clientId: env.MICROSOFT_AUTH_CLIENT_ID, clientSecret: env.MICROSOFT_AUTH_CLIENT_SECRET, tenantId: env.MICROSOFT_AUTH_TENANT_ID }
        : undefined,
    },
  } satisfies Parameters<typeof createCustomerAuthentication>[0];
  const customerAuthentication = createCustomerAuthentication(customerAuthenticationOptions);
  const customerSsoAuthentication = createCustomerSsoAuthentication(customerAuthenticationOptions);
  const connectorRegistryStore = PostgresConnectorRegistryStore.fromConnectionString(env.DATABASE_URL);
  const providerSettingsStore = PostgresProviderSettingsStore.fromConnectionString(env.DATABASE_URL);
  const scheduleStore = PostgresScheduleStore.fromConnectionString(env.DATABASE_URL);
  const siteStore = PostgresSiteStore.fromConnectionString(env.DATABASE_URL);
  const teamStore = PostgresTeamStore.fromConnectionString(env.DATABASE_URL);
  const usageLedgerStore = PostgresUsageLedgerStore.fromConnectionString(env.DATABASE_URL);
  const spendObservabilityStore = PostgresSpendObservabilityStore.fromConnectionString(env.DATABASE_URL);
  const identityPolicyStore = PostgresIdentityPolicyStore.fromConnectionString(env.DATABASE_URL);
  const agentInstanceStore = PostgresAgentInstanceStore.fromConnectionString(env.DATABASE_URL);
  const toolAuditStore = PostgresToolAuditStore.fromConnectionString(env.DATABASE_URL);
  await toolAuditStore.ensureMonthlyPartitions();
  const protectedWorkspacePolicyStore = PostgresProtectedWorkspacePolicyStore.fromConnectionString(env.DATABASE_URL);
  const protectedWorkspacePolicy = new ProtectedWorkspacePolicyAdministrationService(protectedWorkspacePolicyStore);
  const customerProductAuthentication = new CustomerProductAuthenticationService(
    createBetterAuthSessionReader(customerAuthentication),
    identityPolicyStore,
    () => new Date(),
    { installationKind: env.LEMMACOMPUTER_INSTALLATION_KIND },
  );
  const tenantSsoAdministration = new TenantSsoAdministrationService(
    createBetterAuthTenantSsoAuthenticationAdministration(customerSsoAuthentication),
    identityPolicyStore as Required<Pick<IdentityPolicyStore,
      "listOrganizationSsoConnections" | "findEnforcedOrganizationSsoConnectionByDomain"
      | "createOrganizationSsoConnection" | "transitionOrganizationSsoConnection"
      | "prepareOrganizationSsoConfigurationChange">>,
  );
  const budgetStore=PostgresTeamBudgetStore.fromConnectionString(env.DATABASE_URL);
  const routingStore=PostgresRoutingStore.fromConnectionString(env.DATABASE_URL);
  await identityPolicyStore.upgradeLegacyWorkspaceProfiles();
  const gatewayValues = [env.LITELLM_ADMIN_URL, env.LITELLM_WORKSPACE_URL, env.LITELLM_MASTER_KEY, env.LITELLM_CREDENTIAL_SECRET];
  if (gatewayValues.some(Boolean) && !gatewayValues.every(Boolean)) throw new Error("All LiteLLM gateway settings must be configured together");
  const liteLlmAdminTls = assertHostedLiteLlmAdminSecurity({
    installationKind: env.LEMMACOMPUTER_INSTALLATION_KIND,
    adminUrl: env.LITELLM_ADMIN_URL,
    credentialSecret: env.LITELLM_CREDENTIAL_SECRET,
    sessionSecret: customerAuthenticationSecrets[0]!.value,
    workspaceIngressSecret: env.WORKSPACE_INGRESS_SECRET,
    caBase64: env.LITELLM_ADMIN_TLS_CA_B64,
    clientCertificateBase64: env.LITELLM_ADMIN_TLS_CLIENT_CERT_B64,
    clientKeyBase64: env.LITELLM_ADMIN_TLS_CLIENT_KEY_B64,
    serverName: env.LITELLM_ADMIN_TLS_SERVER_NAME,
  });
  const liteLlmAdminFetch = liteLlmAdminTls ? createMutualTlsFetch(liteLlmAdminTls) : undefined;
  const gateway = env.LITELLM_ADMIN_URL && env.LITELLM_WORKSPACE_URL && env.LITELLM_MASTER_KEY && env.LITELLM_CREDENTIAL_SECRET
    ? new LiteLLMGatewayAdapter({
        adminUrl: env.LITELLM_ADMIN_URL,
        workspaceUrl: env.LITELLM_WORKSPACE_URL,
        masterKey: env.LITELLM_MASTER_KEY,
        credentialSecret: env.LITELLM_CREDENTIAL_SECRET,
        adminFetch: liteLlmAdminFetch,
      })
    : undefined;
  const providerAdministration = env.LITELLM_ADMIN_URL && env.LITELLM_MASTER_KEY && env.LITELLM_CREDENTIAL_SECRET
    ? new LiteLLMProviderAdministration({
        adminUrl: env.LITELLM_ADMIN_URL,
        masterKey: env.LITELLM_MASTER_KEY,
        credentialSecret: env.LITELLM_CREDENTIAL_SECRET,
        adminFetch: liteLlmAdminFetch,
      })
    : undefined;
  const channelBrokerValues = [env.CHANNEL_BROKER_URL, env.CHANNEL_BROKER_INTERNAL_TOKEN];
  if (channelBrokerValues.some(Boolean) && !channelBrokerValues.every(Boolean)) {
    throw new Error("All channel broker settings must be configured together");
  }
  const channelBrokerClient = env.CHANNEL_BROKER_URL && env.CHANNEL_BROKER_INTERNAL_TOKEN
    ? new HttpChannelBrokerManagementClient(env.CHANNEL_BROKER_URL, env.CHANNEL_BROKER_INTERNAL_TOKEN)
    : undefined;
  const budgetProjector=env.LITELLM_ADMIN_URL&&env.LITELLM_MASTER_KEY?new LiteLlmTeamBudgetProjector({adminUrl:env.LITELLM_ADMIN_URL,masterKey:env.LITELLM_MASTER_KEY,fetch:liteLlmAdminFetch}):undefined;
  const telegramTokenIntakeValues = [env.TELEGRAM_INTAKE_GRANT_PRIVATE_KEY_B64, env.TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64];
  if (telegramTokenIntakeValues.some(Boolean) && !telegramTokenIntakeValues.every(Boolean)) {
    throw new Error("Telegram intake signing and encryption keys must be configured together");
  }
  if (env.LEMMACOMPUTER_INSTALLATION_KIND === "hosted" && !telegramTokenIntakeValues.every(Boolean)) {
    throw new Error("Hosted deployments require broker-only Telegram credential intake keys");
  }
  const telegramRawTokenInputMode = env.TELEGRAM_RAW_TOKEN_INPUT_MODE ?? (env.LEMMACOMPUTER_INSTALLATION_KIND === "hosted" ? "reject" : "legacy");
  const telegramTokenIntake = env.TELEGRAM_INTAKE_GRANT_PRIVATE_KEY_B64 && env.TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64
    ? {
        grantIssuer: new TelegramTokenIntakeGrantIssuer(env.TELEGRAM_INTAKE_GRANT_PRIVATE_KEY_B64),
        encryptionPublicKeySpkiBase64: env.TELEGRAM_INTAKE_ENCRYPTION_PUBLIC_KEY_B64,
        intakeUrl: env.TELEGRAM_INTAKE_URL,
        ttlSeconds: env.TELEGRAM_INTAKE_GRANT_TTL_SECONDS,
      }
    : undefined;
  const webPushValues = [env.WEB_PUSH_VAPID_SUBJECT, env.WEB_PUSH_VAPID_PUBLIC_KEY, env.WEB_PUSH_VAPID_PRIVATE_KEY, env.WEB_PUSH_SUBSCRIPTION_SECRET];
  if (webPushValues.some(Boolean) && !webPushValues.every(Boolean)) throw new Error("All Web Push settings must be configured together");
  const pushProvider = env.WEB_PUSH_VAPID_SUBJECT && env.WEB_PUSH_VAPID_PUBLIC_KEY
    && env.WEB_PUSH_VAPID_PRIVATE_KEY && env.WEB_PUSH_SUBSCRIPTION_SECRET
    ? new WebPushProvider({
        subject: env.WEB_PUSH_VAPID_SUBJECT,
        publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY,
        privateKey: env.WEB_PUSH_VAPID_PRIVATE_KEY,
        subscriptionSecret: env.WEB_PUSH_SUBSCRIPTION_SECRET,
      })
    : undefined;
  if (Boolean(env.OPENVTC_CONSENT_URL) !== Boolean(env.OPENVTC_CONSENT_TOKEN)) {
    throw new Error("OPENVTC_CONSENT_URL and OPENVTC_CONSENT_TOKEN must be configured together");
  }
  const openVtc = env.OPENVTC_CONSENT_URL && env.OPENVTC_CONSENT_TOKEN
    ? new OpenVtcApprovalCoordinator(
        store,
        await HttpOpenVtcConsentClient.connect(env.OPENVTC_CONSENT_URL, env.OPENVTC_CONSENT_TOKEN),
        pushProvider,
      )
    : undefined;
  if (!env.LITELLM_WORKSPACE_URL) throw new Error("LITELLM_WORKSPACE_URL is required for signed policy enforcement");
  const policyVerificationKeys = policyVerificationKeySetSchema.parse(JSON.parse(
    Buffer.from(env.POLICY_VERIFICATION_KEYS_B64, "base64").toString("utf8"),
  ));
  await store.registerPolicyVerificationKeys(policyVerificationKeys.keys);
  const policyBundleAuthority = new PolicyBundleAuthority(
    new PolicyBundleSigner({
      keyId: env.POLICY_SIGNING_KEY_ID,
      privateKeyPkcs8Base64: env.POLICY_SIGNING_PRIVATE_KEY_B64,
    }),
    policyVerificationKeys,
    {
      modelGateway: env.LITELLM_WORKSPACE_URL,
      mcpControl: env.AGENT_BRIDGE_URL,
    },
    env.POLICY_BUNDLE_TTL_SECONDS,
  );
  if (Boolean(env.WORKSPACE_INGRESS_PUBLIC_URL) !== Boolean(env.WORKSPACE_INGRESS_SECRET)) {
    throw new Error("WORKSPACE_INGRESS_PUBLIC_URL and WORKSPACE_INGRESS_SECRET must be configured together");
  }
  const workspaceIngress = env.WORKSPACE_INGRESS_PUBLIC_URL && env.WORKSPACE_INGRESS_SECRET
    ? {
        publicUrl: env.WORKSPACE_INGRESS_PUBLIC_URL,
        authority: new WorkspaceIngressAuthority(
          env.WORKSPACE_INGRESS_SECRET,
          env.WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS,
          env.WORKSPACE_INGRESS_SESSION_TTL_SECONDS,
        ),
      }
    : undefined;
  const platformOperatorStore = env.LEMMACOMPUTER_INSTALLATION_KIND !== "customer-managed"
    ? PostgresPlatformOperatorStore.fromConnectionString(env.DATABASE_URL)
    : undefined;
  const platformBetterAuthService = platformOperatorStore
    && platformAuthentication
    && platformAuthenticationPool
    && platformOperatorBootstrap
    ? new BetterAuthPlatformOperatorAuthenticationService(
        platformAuthentication,
        platformAuthenticationPool,
        platformOperatorStore,
        publicWebOrigin,
        platformOperatorBootstrap,
      )
    : undefined;
  await platformBetterAuthService?.initializeBootstrapOperator();
  const platformOperatorAuthentication = platformBetterAuthService;
  const controllerTlsClientValues = [
    env.CONTROLLER_TLS_CA_B64,
    env.CONTROLLER_TLS_CLIENT_CERT_B64,
    env.CONTROLLER_TLS_CLIENT_KEY_B64,
  ];
  if (env.LEMMACOMPUTER_INSTALLATION_KIND === "hosted" && env.WORKSPACE_NODE_TOPOLOGY !== "remote") {
    throw new Error("Hosted deployments require remote workspace-node topology");
  }
  if (env.WORKSPACE_NODE_TOPOLOGY === "remote" && !controllerTlsClientValues.every(Boolean)) {
    throw new Error("Remote workspace-node connections require mutual TLS client configuration");
  }
  const placementRoutedController = usesPlacementRoutedController({
    installationKind: env.LEMMACOMPUTER_INSTALLATION_KIND,
    workspaceNodeTopology: env.WORKSPACE_NODE_TOPOLOGY,
  });
  if (
    !placementRoutedController
    && env.CONTROLLER_URL.startsWith("https:")
    && ![...controllerTlsClientValues, env.CONTROLLER_TLS_SERVER_NAME].every(Boolean)
  ) {
    throw new Error("HTTPS workspace-node connections require complete mutual TLS client configuration");
  }
  const controller: ControllerClient = placementRoutedController
    ? new RoutedControllerClient(platformOperatorStore!, (node) => new HttpControllerClient(
        node.endpointUrl,
        env.CONTROLLER_INTERNAL_TOKEN,
        createMutualTlsFetch({
          ca: Buffer.from(env.CONTROLLER_TLS_CA_B64!, "base64").toString("utf8"),
          clientCertificate: Buffer.from(env.CONTROLLER_TLS_CLIENT_CERT_B64!, "base64").toString("utf8"),
          clientKey: Buffer.from(env.CONTROLLER_TLS_CLIENT_KEY_B64!, "base64").toString("utf8"),
          serverName: node.tlsServerName,
        }),
        env.CONTROLLER_REQUEST_TIMEOUT_MS,
      ))
    : new HttpControllerClient(
        env.CONTROLLER_URL,
        env.CONTROLLER_INTERNAL_TOKEN,
        env.CONTROLLER_URL.startsWith("https:")
          ? createMutualTlsFetch({
              ca: Buffer.from(env.CONTROLLER_TLS_CA_B64!, "base64").toString("utf8"),
              clientCertificate: Buffer.from(env.CONTROLLER_TLS_CLIENT_CERT_B64!, "base64").toString("utf8"),
              clientKey: Buffer.from(env.CONTROLLER_TLS_CLIENT_KEY_B64!, "base64").toString("utf8"),
              serverName: env.CONTROLLER_TLS_SERVER_NAME!,
            })
          : fetch,
        env.CONTROLLER_REQUEST_TIMEOUT_MS,
      );
  const platformSecurityAlertDispatcher = platformOperatorStore
    && env.PLATFORM_SECURITY_ALERT_WEBHOOK_URL
    && env.PLATFORM_SECURITY_ALERT_WEBHOOK_SECRET
    ? new PlatformSecurityAlertDispatcher(
        platformOperatorStore,
        new SignedWebhookPlatformSecurityAlertAdapter(
          env.PLATFORM_SECURITY_ALERT_WEBHOOK_URL,
          env.PLATFORM_SECURITY_ALERT_WEBHOOK_SECRET,
        ),
      )
    : undefined;
  const platformTenantCleanupDispatcher = platformOperatorStore
    ? new PlatformTenantCleanupDispatcher(
        platformOperatorStore,
        new ControlPlaneTenantCleanupAdapter(controller, gateway),
      )
    : undefined;
  await agentInstanceStore.reconcileAbandoned(new Date(Date.now() - 5 * 60_000));
  await toolAuditStore.reconcileUnconfirmed(new Date(Date.now() - 5 * 60_000));
  const agentInstanceReconciliationTimer = setInterval(() => {
    void agentInstanceStore.reconcileAbandoned(new Date(Date.now() - 5 * 60_000)).catch(() => undefined);
    void toolAuditStore.reconcileUnconfirmed(new Date(Date.now() - 5 * 60_000)).catch(() => undefined);
  }, 60_000);
  agentInstanceReconciliationTimer.unref();
  const app = createControlServer(
    store,
    controller,
    env.WEB_PROXY_TOKEN,
    gateway,
    env.FIXTURE_APPROVAL_SECRET,
    {
      publicWebUrl: env.PUBLIC_WEB_URL,
      authorizationOrigin: env.M365_AUTHORIZATION_ORIGIN,
      liteLlmPublicUrl: env.LITELLM_PUBLIC_URL,
      agentBridgeUrl: env.AGENT_BRIDGE_URL,
      installationKind: env.LEMMACOMPUTER_INSTALLATION_KIND,
      hostedCustomConnectorEgressOrigins: env.HOSTED_MCP_EGRESS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
      configuredStaticMcpClients: env.CONFIGURED_STATIC_MCP_CLIENTS
        .split(",").map((group) => group.trim()).filter(isStaticCredentialGroup),
      ...(env.M365_CLIENT_ID && env.CONNECTOR_CONSENT_SECRET
        ? { microsoftAdminConsent: { clientId: env.M365_CLIENT_ID, consentSecret: env.CONNECTOR_CONSENT_SECRET } }
        : {}),
      ...(env.M365_TENANT_ID && env.M365_CLIENT_ID && env.M365_SITE_ADMIN_CLIENT_ID && env.M365_SITE_ADMIN_CLIENT_SECRET
        ? {
          microsoftSharePointSitePermissions: new MicrosoftSharePointSitePermissionClient({
            fallbackProviderTenantId: env.M365_TENANT_ID,
            administrationClientId: env.M365_SITE_ADMIN_CLIENT_ID,
            administrationClientSecret: env.M365_SITE_ADMIN_CLIENT_SECRET,
          }),
          microsoftSharePointConnectorClientId: env.M365_CLIENT_ID,
        }
        : {}),
    },
    {
      identityPolicyStore,
      protectedWorkspacePolicy,
      connectorRegistryStore,
      providerSettingsStore,
      providerAdministration,
      mcpPolicyToken: env.CONTROLLER_INTERNAL_TOKEN,
      mcpEgressProxyToken: env.MCP_EGRESS_PROXY_TOKEN,
      agentBridgeSecret: env.AGENT_BRIDGE_SECRET,
      agentBridgeGrantTtlSeconds: env.AGENT_BRIDGE_GRANT_TTL_SECONDS,
      customerAuthentication,
      customerSsoAuthentication,
      customerProductAuthentication,
      tenantSsoAdministration,
      invitationDelivery: {
        mode: env.INVITATION_DELIVERY_MODE,
        email: transactionalEmail,
      },
      developmentEmailCapture:
        env.LEMMACOMPUTER_INSTALLATION_KIND === "worktree"
        && env.RUNTIME_ENVIRONMENT === "development"
        && transactionalEmail instanceof CaptureTransactionalEmailAdapter
          ? transactionalEmail
          : undefined,
      closeCustomerAuthentication: () => authenticationPool.end(),
      platformAuthentication,
      platformBetterAuthService,
      closePlatformAuthentication: platformAuthenticationPool ? () => platformAuthenticationPool!.end() : undefined,
      platformOperatorAuthentication,
      platformOperatorStore,
      platformSecurityAlertDispatcher,
      platformTenantCleanupDispatcher,
      platformOperatorApprovalConfigured: env.PLATFORM_SUPPORT_APPROVAL_REQUIRED === "true",
      openVtc,
      egressGrantSecret: env.EGRESS_GRANT_SECRET,
      workspaceAccessAuthorization: {
        url: env.AGENT_BRIDGE_URL,
        token: env.CONTROLLER_INTERNAL_TOKEN,
      },
      policyBundleAuthority,
      agentChatSecret: env.AGENT_CHAT_SECRET,
      chatStore,
      artifactStore,
      requireArtifactNodePlacement: env.LEMMACOMPUTER_INSTALLATION_KIND === "hosted",
      requireCanonicalChatPersistence: true,
      agentInstanceStore,
      toolAuditStore,
      channelBrokerClient,
      channelBrokerInternalToken: env.CHANNEL_BROKER_INTERNAL_TOKEN,
      telegramTokenIntake,
      telegramRawTokenInputMode,
      scheduleStore,
      siteStore,
      teamStore,
      usageLedgerStore,
      usageAdmissionHook:new BudgetUsageAttemptAdmission(budgetStore),
      usageInternalToken: env.AI_USAGE_INTERNAL_TOKEN,
      usageTaskBindingSecret: env.AI_USAGE_TASK_BINDING_SECRET,
      budgetStore,
      routingStore,
      budgetProjector,
      spendObservabilityStore,
      schedulerInternalToken: env.SCHEDULER_INTERNAL_TOKEN,
      schedulePromptSecret: env.SCHEDULE_PROMPT_SECRET,
      workspaceIngress,
      grantRenewal: {
        tenantId: env.BOOTSTRAP_TENANT_ID,
        intervalMs: env.GATEWAY_GRANT_RENEWAL_INTERVAL_SECONDS * 1000,
      },
    },
  );
  const pushRetryTimer = pushProvider && openVtc
    ? setInterval(() => { void openVtc.flushCompanionPushQueue().catch(() => undefined); }, 5_000)
    : undefined;
  pushRetryTimer?.unref();
  if (openVtc) await openVtc.flushCompanionPushQueue().catch(() => undefined);
  platformSecurityAlertDispatcher?.start();
  platformTenantCleanupDispatcher?.start();
  app.addHook("onClose", async () => {
    await platformSecurityAlertDispatcher?.stop();
    await platformTenantCleanupDispatcher?.stop();
    if (pushRetryTimer) clearInterval(pushRetryTimer);
    clearInterval(agentInstanceReconciliationTimer);
    await store.close();
    await chatStore.close();
    await connectorRegistryStore.close();
    await providerSettingsStore.close();
    await scheduleStore.close();
    await siteStore.close();
    await teamStore.close();
    await usageLedgerStore.close();
    await budgetStore.close();
    await routingStore.close();
    await spendObservabilityStore.close();
    await identityPolicyStore.close();
    await agentInstanceStore.close();
    await toolAuditStore.close();
    await protectedWorkspacePolicyStore.close();
    await platformOperatorStore?.close();
  });
  await app.listen({ host: env.CONTROL_HOST, port: env.CONTROL_PORT });
}
