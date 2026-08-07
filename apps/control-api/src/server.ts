import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { LogController } from "fastify";
import { anthropicProviderModelIdSchema, assignEgressSecurityGroupSchema, assignTeamMembershipSchema, bedrockApiKeyModelProfileIdSchema, bedrockApiKeyRegionSchema, channelArtifactDownloadRequestSchema, channelArtifactMaxBytes, channelRouteSchema, channelTurnRequestSchema, channelTurnResponseSchema, channelTurnStreamEventSchema, chatAgentCatalogIdSchema, chatPartIdSchema, chatSessionIdSchema, createChatSessionSchema, createScheduleSchema, createTeamSchema, executeScheduleRunSchema, glmProviderModelIdSchema, LemmaComputerError, TelegramTokenIntakeGrantIssuer, createDeleteFileOperationSchema, createWorkspaceSchema, fixtureApprovalSchema, identityContextSchema, mcpPolicyRequestSchema, openAiProviderModelIdSchema, ownedAgentCatalog, providerEmissionsRegionSchema, reviewedAgentSkillCatalog, policyVerificationKeySetSchema, saveEgressSecurityGroupSchema, saveHostedConnectorToolPolicySchema, saveMcpToolPolicySchema, saveTelegramChannelConnectionSchema, saveTelegramCredentialSchema, telegramTokenIntakePath, telegramTokenIntakeGrantSchema, sandboxApplicationSchema, sandboxConfigurationSchema, sandboxProfileSchema, sandboxSettingsSchema, saveSandboxSettingsSchema, sendChatTurnSchema, setDefaultSpendingTeamSchema, telegramChannelConnectionStatusSchema, updateScheduleSchema, updateTeamSchema, workspaceManifestAgentIdFor, workspaceManifestChatAgentIdFor, workspaceManifestSchema, type AgentCatalogId, type AgentChatEvent, type ChannelRoute, type ChatUiMessage, type IdentityContext, type RuntimePolicy, type SandboxApplicationId, type SandboxModelAlias, type SandboxProfileId, type SandboxConfiguration, type TelegramChannelConnectionStatus, type WorkspaceManifest } from "@lemmacomputer/contracts";
import { createMutualTlsFetch, LiteLLMGatewayAdapter, LiteLLMProviderAdministration, LiteLlmTeamBudgetProjector, managedProviderForAlias, type GatewayClient, type GovernedToolExecutor, type ManagedProviderName, type OAuthConnectionGateway, type ProviderAdministrationGateway } from "@lemmacomputer/litellm-adapter";
import {RoutingDecisionBindingAuthority} from "@lemmacomputer/model-router";
import { PolicyBundleSigner } from "@lemmacomputer/policy-integrity";
import { hasOrganizationPermission, PostgresConnectorRegistryStore, PostgresIdentityPolicyStore, PostgresProviderSettingsStore, PostgresRoutingStore, PostgresScheduleStore, PostgresSiteStore, PostgresTeamBudgetStore, PostgresTeamStore, PostgresWorkspaceStore, runtimePolicyFor, type ActivityEventScope, type ActivityStore, type ChannelStore, type ConnectorRegistryStore, type EffectivePolicy, type GovernanceStore, type IdentityPolicyStore, type OrganizationPermission, type ProviderSettingsStore, type RoutingStore, type ScheduleStore, type SessionPrincipal, type SiteStore, type TeamBudgetStore, type TeamStore, type WorkspaceStore } from "@lemmacomputer/workspace-store";
import { WorkspaceIngressAuthority } from "@lemmacomputer/workspace-ingress-auth";
import { PostgresSpendObservabilityStore, SpendReadLimitError, spendReportCsv, type SpendObservabilityStore } from "@lemmacomputer/workspace-store";
import { z } from "zod";
import { BudgetUsageAttemptAdmission, PostgresUsageLedgerStore, type RateAmount, type UsageAttemptAdmissionHook } from "@lemmacomputer/workspace-store";
import { FixtureApprovalAuthority, GovernedOperationService } from "./operations.js";
import { McpConnectionService } from "./connections.js";
import { ProviderSettingsService } from "./provider-settings.js";
import { EgressProxyGrantAuthority, HttpControllerClient, PolicyBundleAuthority, WorkspaceService, type ControllerClient } from "./service.js";
import { EntraAuthenticationService, ExternalIdAuthenticationService, isAdministrator, testPrincipalFromHeaders } from "./auth.js";
import { McpPolicyService, m365CapabilityDefinitions, resumableUploadCapability } from "./mcp-policy.js";
import { OpenVtcApprovalCoordinator } from "./openvtc.js";
import { HttpOpenVtcConsentClient } from "./openvtc-consent-client.js";
import { AgentBridgeAuthority, agentBridgeAudience, type AgentBridgeIdentity, type AgentBridgeScope } from "./agent-bridge.js";
import { COMPANION_PUSH_PROTOCOL, WebPushProvider } from "./web-push.js";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  AgentChatAuthority,
  AgentUiStreamMapper,
  HttpAgentChatClient,
  assignedChatAgentIds,
  chatApprovalSummary,
  reconcileChatMessages,
  type AgentChatClient,
} from "./agent-chat.js";
import { HttpChannelBrokerManagementClient, type ChannelBrokerManagementClient } from "./channel-broker.js";
import { SchedulePromptVault, ScheduleService } from "./schedules.js";
import { BudgetUsageEventRecordedHook, budgetOverrideSchema, saveTeamBudgetSchema, TeamBudgetAdministrationService } from "./budgets.js";
import { ActivityEventService, activitySseFrame } from "./activity.js";
import { SitesService } from "./sites.js";
import { UsageLedgerService,UsageTaskBindingAuthority,adminRateCardSchema,adminReconciliationSchema,adminUsageQuerySchema,decodeUsageCursor,encodeUsageCursor,internalUsageAdmissionSchema,internalUsageCompletionSchema } from "./usage-ledger.js";
import { assertHostedLiteLlmAdminSecurity } from "./litellm-admin-security.js";
import {RoutingAdministrationService,RoutingExecutionService,changeRoutingRolloutSchema,createRoutingMappingSchema,internalRoutingDecisionSchema,internalRoutingObservationSchema,saveRoutingPolicySchema,saveRoutingReviewSchema} from "./routing.js";

import { paginateSpendReport, parseSpendQuery, parseUnpricedUsageAcknowledgement } from "./spend-observability.js";
type AuthenticationBoundary = Pick<EntraAuthenticationService, "begin" | "complete" | "authenticate" | "logout">;

const workspaceMemoryGiB = 4;

const sandboxProfiles = [
  sandboxProfileSchema.parse({
    id: "claude-desktop-standard-v1",
    version: 1,
    displayName: "Managed workspace",
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
    displayName: "Disposable open workspace",
    description: "A flexible workspace with local coding tools and public web access inside the isolated Kasm boundary.",
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
  { value: "auto", displayName: "Auto", description: "LemmaComputer chooses the best eligible tier for each task." },
  { value: "lite", displayName: "Lite", description: "Fast, economical work." },
  { value: "balanced", displayName: "Balanced", description: "Everyday reasoning and tool use." },
  { value: "pro", displayName: "Pro", description: "Highest capability for complex work." },
] as const;

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
    version: "150.0.7871.186",
    description: "Pinned Chrome browser locked to the governed egress proxy.",
  }),
] as const;

const assignedApplicationIds = (document: Record<string, unknown>): SandboxApplicationId[] => {
  const configured = Array.isArray(document.applications)
    ? document.applications.filter((item): item is SandboxApplicationId => sandboxApplications.some((application) => application.id === item))
    : ["firefox"] as SandboxApplicationId[];
  return configured.length ? configured : ["firefox"];
};

const defaultApplicationIds = (document: Record<string, unknown>, assigned = assignedApplicationIds(document)): SandboxApplicationId[] => {
  const configured = Array.isArray(document.defaultApplications)
    ? document.defaultApplications.filter((item): item is SandboxApplicationId => assigned.includes(item as SandboxApplicationId))
    : assigned;
  return configured.length ? configured : [assigned[0]!];
};

const assignedAgentIds = (document: Record<string, unknown>): AgentCatalogId[] => {
  const configured = Array.isArray(document.agents)
    ? document.agents.filter((item): item is AgentCatalogId => ownedAgentCatalog.some((agent) => agent.id === item))
    : [{
      "claude-cli-managed-v1": "claude-cli",
      "codex-cli-managed-v1": "codex-cli",
      "hermes-claw-managed-v1": "hermes-claw",
    }[String(document.agentProfile)] ?? "claude-desktop"] as AgentCatalogId[];
  return configured.length ? configured : ["claude-desktop"];
};

const defaultAgentIds = (document: Record<string, unknown>, assigned = assignedAgentIds(document)): AgentCatalogId[] => {
  const configured = Array.isArray(document.defaultAgents)
    ? document.defaultAgents.filter((item): item is AgentCatalogId => assigned.includes(item as AgentCatalogId))
    : assigned;
  return configured.length ? configured : [assigned[0]!];
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
  CONTROLLER_INTERNAL_TOKEN: z.string().min(24),
  DATABASE_URL: z.string().min(1),
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
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:4174"),
  M365_AUTHORIZATION_ORIGIN: z.string().url().default("http://localhost:4311"),
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
  ENTRA_TENANT_ID: z.string().min(1),
  ENTRA_CLIENT_ID: z.string().min(1),
  ENTRA_CLIENT_SECRET: z.string().min(1),
  EXTERNAL_ID_TENANT_ID: optionalEnvString(),
  EXTERNAL_ID_TENANT_SUBDOMAIN: optionalEnvString(),
  EXTERNAL_ID_CLIENT_ID: optionalEnvString(),
  EXTERNAL_ID_CLIENT_SECRET: optionalEnvString(),
  SESSION_SECRET: z.string().min(32),
  AI_USAGE_INTERNAL_TOKEN: z.string().min(32),
  AI_USAGE_TASK_BINDING_SECRET: z.string().min(32),
  WORKSPACE_INGRESS_PUBLIC_URL: optionalEnvString(),
  WORKSPACE_INGRESS_SECRET: optionalEnvString(32),
  WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  WORKSPACE_INGRESS_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
  EGRESS_GRANT_SECRET: z.string().min(32).optional(),
  AGENT_CHAT_SECRET: z.string().min(32),
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
  BOOTSTRAP_USER_ID: z.string().min(1).default("alex-morgan"),
  TENANT_DISPLAY_NAME: z.string().min(1).default("ME TECH"),
  BOOTSTRAP_OWNER_OBJECT_IDS: z.string().min(1),
});

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
  if (method === "GET" && path === "/internal/v1/agent/mcp-discovery-plan") return "agent:mcp-discovery";
  if (method === "POST" && path === "/internal/v1/agent/sites") return "agent:sites";
  if (method === "GET" && /^\/internal\/v1\/agent\/operations\/[^/]+$/.test(path)) return "agent:operations:read";
  if (method === "POST" && (
    path === "/internal/v1/agent/uploads"
    || /^\/internal\/v1\/agent\/uploads\/[^/]+\/(?:begin|complete|fail)$/.test(path)
  )) return "agent:uploads";
  if (method === "POST" && path === "/internal/v1/agent/deletions") return "agent:deletions";
  return null;
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
  } = {},
  security: {
    authentication?: AuthenticationBoundary;
    externalIdAuthentication?: AuthenticationBoundary;
    identityPolicyStore?: IdentityPolicyStore;
    mcpPolicyToken?: string;
    mcpEgressProxyToken?: string;
    agentBridgeSecret?: string;
    agentBridgeGrantTtlSeconds?: number;
    testIdentityMode?: boolean;
    openVtc?: OpenVtcApprovalCoordinator;
    egressGrantSecret?: string;
    policyBundleAuthority?: PolicyBundleAuthority;
    agentChatSecret?: string;
    agentChatClient?: AgentChatClient;
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
    logger: { redact: ["req.headers.x-lemmacomputer-proxy-token", "req.headers.x-lemmacomputer-mcp-policy-token", "req.headers.x-lemmacomputer-ai-usage-token", "req.headers.authorization", "req.body", "*.arguments", "*.launchUrl"] },
    logController: new LogController({
      disableRequestLogging: (request) => /^\/v1\/connections\/[^/]+\/callback/.test(request.url)
        || request.url.startsWith("/v1/auth/"),
    }),
    bodyLimit: 32 * 1024,
    routerOptions: { maxParamLength: 2048 },
  });
  if (!security.authentication && !security.testIdentityMode) {
    throw new Error("Control requires Entra authentication; test identity mode must be enabled explicitly in tests");
  }
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
    ? new UsageLedgerService(security.usageLedgerStore, security.teamStore, usageBindings, security.usageAdmissionHook, usageRecordedHook)
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
  ) => usageBindings?.issue({
    tenantId: owner.tenantId, subjectId: owner.subjectId, workspaceId, agentId,
    contextKind, taskId, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}),
    requestedServiceClass,
  });
  const budgets=security.budgetStore?new TeamBudgetAdministrationService(security.budgetStore,security.budgetProjector):undefined;
  const requireBudgets=()=>{if(!budgets)throw new LemmaComputerError("BUDGETS_NOT_CONFIGURED","Team budget administration is unavailable",503,true);return budgets;};
  const routingExecution=security.routingStore&&security.teamStore&&usageBindings?new RoutingExecutionService(security.routingStore,security.teamStore,new RoutingDecisionBindingAuthority(security.usageTaskBindingSecret!),usageBindings,security.budgetStore):undefined;
  const routing=security.routingStore?new RoutingAdministrationService(security.routingStore):undefined;
  const requireRouting=()=>{if(!routing)throw new LemmaComputerError("ROUTING_NOT_CONFIGURED","Model routing administration is unavailable",503,true);return routing;};
  const channelBroker = security.channelBrokerClient;
  const telegramRawTokenInputMode = security.telegramRawTokenInputMode ?? "legacy";
  const requireSpendObservability = (request: object) => {
    const actor = principal(request);
    if (!hasOrganizationPermission(actor, "usage.read")) {
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
      workspaceGeneration: workspace.bridgeGrantGeneration,
    }),
  }, security.egressGrantSecret ? new EgressProxyGrantAuthority(security.egressGrantSecret) : undefined, security.policyBundleAuthority, agentChatAuthority, security.workspaceIngress);
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
    connections ? (actor, serverName, toolName) => connections.hostedToolPolicy(actor, serverName, toolName) : undefined,
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
    for (const modelAlias of new Set([policy.modelAlias, ...(policy.agents?.map((agent) => agent.modelAlias) ?? [])])) {
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
      const workspace = await store.getOwned({
        tenantId: actor.tenantId,
        subjectId: actor.subjectId,
        audience: "lemmacomputer-control",
      }, actor.workspaceId);
      if (!workspace || workspace.bridgeGrantGeneration !== actor.workspaceGeneration) {
        throw new LemmaComputerError("AGENT_BRIDGE_GRANT_REVOKED", "Agent bridge authentication is no longer active", 403);
      }
      // Connector discovery is part of workspace bootstrap: Hermes resolves
      // its MCP tool catalogue before the controller can mark the sandbox
      // ready. Keep every mutating/operational bridge scope ready-only, while
      // allowing this read-only, generation-bound projection during the two
      // states that actively create a replacement runtime.
      const activeStates = agentBridgeScope === "agent:mcp-discovery"
        ? ["provisioning", "restarting", "ready", "open"]
        : ["ready", "open"];
      if (!activeStates.includes(workspace.state)) {
        throw new LemmaComputerError("WORKSPACE_NOT_READY", "The workspace is not active for agent bridge access", 403);
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
    if (requestPath.startsWith("/v1/auth/login") || requestPath.startsWith("/v1/auth/callback")
      || requestPath.startsWith("/v1/auth/external-id/")) return;
    const principal = security.testIdentityMode
      ? testPrincipalFromHeaders(request.headers)
      : await security.authentication!.authenticate(request.headers.cookie);
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
  const identity = (request: object) => identityContextSchema.parse(principal(request).identity);
  const requirePermission = (request: object, permission: OrganizationPermission) => {
    const value = principal(request);
    if (!hasOrganizationPermission(value, permission)) {
      throw new LemmaComputerError("FORBIDDEN", "Your organization role does not allow this action", 403);
    }
    return value;
  };
  const requireAdministrator = (request: object) => requirePermission(request, "organization.manage_settings");
  const assignedPolicy = async (request: object) => {
    const value = principal(request);
    const effective = security.identityPolicyStore ? await security.identityPolicyStore.getEffectivePolicy(value.userId) : null;
    if (security.identityPolicyStore && !effective) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    return { principal: value, effective };
  };
  const workspaceEgressFor = async (value: SessionPrincipal, effective: EffectivePolicy | null, grantId: string) => (
    await security.identityPolicyStore?.getWorkspaceEgressSecurityGroup?.({
      tenantId: value.tenantId,
      subjectId: value.userId,
      grantId,
    }) ?? effective?.egressSecurityGroup ?? null
  );
  const governedRoutingAvailableFor = async (tenantId: string) => {
    const routeMapping = await security.routingStore?.latestMappingVersion(tenantId);
    return ["lite", "balanced", "pro"].every((serviceClass) => (
      routeMapping?.deployments.some((deployment) => deployment.serviceClass === serviceClass)
    ));
  };
  const policyForGrant = async (value: SessionPrincipal, effective: EffectivePolicy | null, grantId = "personal") => {
    let policy = testRuntimePolicy;
    if (effective) {
      const saved = await store.getSandboxSettings?.(value.identity, grantId);
      const workspaceEgress = await workspaceEgressFor(value, effective, grantId);
      const governedRoutingAvailable = await governedRoutingAvailableFor(value.tenantId);
      const document = effective.document as Record<string, unknown>;
      const availableAgentIds = assignedAgentIds(document);
      policy = {
        ...runtimePolicyFor(
          effective,
          saved?.modelAlias,
          saved?.profileId,
          saved?.agentIds ?? defaultAgentIds(document, availableAgentIds),
          saved?.applicationIds ?? defaultApplicationIds(document),
          workspaceEgress,
          governedRoutingAvailable ? ["lemmacomputer-auto"] : [],
        ),
        requestedServiceClass: saved?.requestedServiceClass ?? "auto",
      };
    }
    return {
      principal: value,
      policy: connections ? await connections.projectConnectedConnectors(value.identity, policy) : policy,
    };
  };
  const refreshOwnedWorkspaceConnectionGrants = async (value: SessionPrincipal) => {
    const effective = security.identityPolicyStore ? await security.identityPolicyStore.getEffectivePolicy(value.userId) : null;
    const workspaces = await store.listCurrent(value.identity);
    const results = await Promise.allSettled(workspaces.map(async (workspace) => {
      const { policy } = await policyForGrant(value, effective, workspace.grantId);
      try {
        return await service.refreshPolicyGrant(value.identity, policy, workspace.grantId);
      } catch (error) {
        // A connector/model gateway refresh failure must fail closed at the
        // gateway without revoking unrelated workspace-to-Control capabilities
        // such as Sites, governed uploads, or operation status.
        await service.revokeGatewayGrants(workspace.id, policy).catch(() => undefined);
        throw error;
      }
    }));
    return {
      refreshed: results.filter((result) => result.status === "fulfilled" && result.value).length,
      failed: results.filter((result) => result.status === "rejected").length,
    };
  };
  const refreshTenantWorkspaceConnectionGrants = async (tenantId: string) => {
    if (!security.identityPolicyStore) return { refreshed: 0, failed: 0 };
    const users = await security.identityPolicyStore.listUsers(tenantId);
    const results = await Promise.allSettled(users.map(async (user) => {
      if (user.status === "disabled") return { refreshed: 0, failed: 0 };
      const owner = await security.identityPolicyStore!.getPrincipal(user.userId);
      if (!owner || owner.tenantId !== tenantId) return { refreshed: 0, failed: 0 };
      return refreshOwnedWorkspaceConnectionGrants(owner);
    }));
    return results.reduce((summary, result) => {
      if (result.status === "rejected") return { ...summary, failed: summary.failed + 1 };
      return {
        refreshed: summary.refreshed + result.value.refreshed,
        failed: summary.failed + result.value.failed,
      };
    }, { refreshed: 0, failed: 0 });
  };
  const usesManagedProvider = (policy: RuntimePolicy, provider: ManagedProviderName) => (
    [policy.modelAlias, ...(policy.agents?.map((agent) => agent.modelAlias) ?? [])]
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
    const { principal: value, effective } = await assignedPolicy(request);
    return policyForGrant(value, effective);
  };
  const requireWorkspacePolicy = async (request: object, workspaceId: string) => {
    const { principal: value, effective } = await assignedPolicy(request);
    const workspace = await store.getOwned(value.identity, workspaceId);
    if (!workspace) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    return policyForGrant(value, effective, workspace.grantId);
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
        roles: ["employee"],
        identity: channelIdentity,
      };
      effective = null;
    } else {
      throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503, true);
    }
    return policyForGrant(actor, effective, workspace.grantId);
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
        ({ identity: owner, workspaceId, agentId, taskId, sessionId, turnId }) => issueUsageTaskBinding(
          owner, workspaceId, agentId, "schedule", taskId, sessionId, turnId,
        ),
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
    const { policy } = await channelPolicy(route.identity, route.workspaceId);
    if (!assignedChatAgentIds(policy).includes(route.agentCatalogId)) {
      throw new LemmaComputerError("CHAT_AGENT_NOT_SELECTED", "That chat agent is not selected for this workspace", 409);
    }
    return {
      policy,
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
    return mcpPolicy.authorize(mcpPolicyRequestSchema.parse(request.body ?? {}), request.id);
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
    const { access } = await verifiedChannelRoute(input, true);
    if (!store.claimChannelUpdate || !await store.claimChannelUpdate(
      input.connectionId,
      input.updateId,
      input.externalSenderId,
    )) {
      throw new LemmaComputerError("CHANNEL_UPDATE_REPLAYED", "The channel update was already dispatched", 409);
    }
    const session = input.sessionId
      ? { id: input.sessionId }
      : await agentChat.createSession(access, `Telegram ${input.externalSenderId}`);
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
    const frame = (event: unknown) => `${JSON.stringify(channelTurnStreamEventSchema.parse(event))}\n`;
    const stream = async function*() {
      let text = "";
      const notices: string[] = [];
      const artifacts: Array<{ artifactId: string; mediaType: string; filename: string; byteLength: number; sha256: string }> = [];
      let state: "needs_input" | "completed" | "cancelled" | "failed" = "failed";
      try {
        const usageTaskBinding = issueUsageTaskBinding(
          input.identity, input.workspaceId, access.agentId, "channel",
          `channel:${input.connectionId}:${input.updateId}`, session.id,
        );
        for await (const event of agentChat.streamTurn(
          access, session.id, message, undefined, usageTaskBinding,
        )) {
          if (event.type === "progress") {
            yield frame({ type: "heartbeat" });
          }
          if (event.type === "text-delta") {
            text += event.delta;
            if (text.length > 16_000) {
              throw new LemmaComputerError("CHANNEL_RESPONSE_TOO_LARGE", "The channel response exceeded its limit", 502);
            }
            yield frame({ type: "text-delta", delta: event.delta });
          }
          if (event.type === "artifact") {
            artifacts.push({ artifactId: event.artifactId, mediaType: event.mediaType, filename: event.filename,
              byteLength: event.byteLength, sha256: event.sha256 });
          }
          if (event.type === "notice" && !notices.includes(event.message)) {
            notices.push(event.message);
            yield frame({ type: "notice", notice: event.message });
          }
          if (event.type === "approval") {
            let summary = event.summary;
            try {
              const operation = await operations.get(input.identity, event.operationId);
              summary = chatApprovalSummary(event.state, operation.safeSummary);
            } catch (error) {
              if (!(error instanceof LemmaComputerError && error.code === "OPERATION_NOT_FOUND")) throw error;
            }
            const notice = `${summary.replace(/[.!?]+$/, "")}. Open LemmaComputer to review this protected action.`;
            if (!notices.includes(notice)) {
              notices.push(notice);
              yield frame({ type: "notice", notice });
            }
          }
          if (event.type === "turn-finish") {
            state = event.state;
            if (event.state === "failed" && !text) {
              yield frame({
                type: "error",
                code: "CHANNEL_TURN_FAILED",
                message: event.message ?? "The agent could not complete the message",
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
    const { access } = await verifiedChannelRoute(input, false);
    const data = await agentChat.downloadArtifact(access, input.artifact.artifactId);
    if (data.length !== input.artifact.byteLength || createHash("sha256").update(data).digest("hex") !== input.artifact.sha256) {
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
    return {
      servers: policy.activeMcpServers ?? policy.mcpServers ?? [policy.mcpServer],
      projectionHash: policy.connectionProjectionHash ?? null,
    };
  });
  app.post("/internal/v1/agent/usage-bindings", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({
      requestedServiceClass: z.enum(["auto", "lite", "balanced", "pro"]),
      taskId: z.string().min(1).max(256),
    }).parse(request.body ?? {});
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" as const };
    const { policy } = await channelPolicy(owner, actor.workspaceId);
    const allowedAgentIds = new Set([policy.agentId, ...(policy.agents?.map((agent) => agent.agentId) ?? [])]);
    if (!allowedAgentIds.has(actor.agentId)) {
      throw new LemmaComputerError("AI_USAGE_TASK_BINDING_MISMATCH", "The route preference is not assigned to this workspace agent", 403);
    }
    const binding = issueUsageTaskBinding(owner, actor.workspaceId, actor.agentId, "background", input.taskId, undefined, undefined, input.requestedServiceClass);
    if (!binding) throw new LemmaComputerError("AI_USAGE_NOT_CONFIGURED", "AI usage governance is unavailable", 503, true);
    return { binding };
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
    return operations.getForAgent(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId },
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
    );
    return reply.code(201).send(operation);
  });
  app.post<{ Params: { operationId: string } }>("/internal/v1/agent/uploads/:operationId/begin", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    return operations.beginResumableUpload(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId },
      request.id,
    );
  });
  app.post<{ Params: { operationId: string } }>("/internal/v1/agent/uploads/:operationId/complete", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({ leaseId: z.uuid() }).parse(request.body ?? {});
    return operations.completeResumableUpload(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId },
      input.leaseId,
      request.id,
    );
  });
  app.post<{ Params: { operationId: string } }>("/internal/v1/agent/uploads/:operationId/fail", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new LemmaComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({ leaseId: z.uuid() }).parse(request.body ?? {});
    return operations.failResumableUpload(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "lemmacomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId },
      input.leaseId,
      request.id,
    );
  });
  app.get<{ Querystring: { return?: string } }>("/v1/auth/login", async (request, reply) => {
    if (connectionOptions.installationKind === "hosted") {
      if (!security.externalIdAuthentication) throw new LemmaComputerError("AUTH_NOT_CONFIGURED", "Hosted sign-in is not configured", 503);
      const started = await security.externalIdAuthentication.begin(request.query.return);
      return reply.code(302).header("set-cookie", started.cookie).header("location", started.location).send();
    }
    if (!security.authentication) throw new LemmaComputerError("AUTH_NOT_CONFIGURED", "Microsoft sign-in is not configured", 503);
    const started = await security.authentication.begin(request.query.return);
    return reply.code(302).header("set-cookie", started.cookie).header("location", started.location).send();
  });
  app.post<{ Body: { invitation?: string; return?: string } }>("/v1/auth/external-id/invitation", async (request, reply) => {
    if (connectionOptions.installationKind !== "hosted" || !security.externalIdAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "This sign-in method is unavailable", 404);
    }
    try {
      const input = z.strictObject({ invitation: z.string().min(20).max(512), return: z.string().optional() }).parse(request.body ?? {});
      const started = await security.externalIdAuthentication.begin(input.return, input.invitation);
      return reply.header("set-cookie", started.cookie).send({ location: started.location });
    } catch {
      throw new LemmaComputerError("EXTERNAL_ID_SIGNIN_FAILED", "This sign-in could not be started", 403);
    }
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/v1/auth/external-id/callback", async (request, reply) => {
    if (connectionOptions.installationKind !== "hosted" || !security.externalIdAuthentication) {
      throw new LemmaComputerError("AUTH_PROVIDER_NOT_AVAILABLE", "This sign-in method is unavailable", 404);
    }
    try {
      const completed = await security.externalIdAuthentication.complete({ ...request.query, cookie: request.headers.cookie });
      reply.header("set-cookie", [completed.cookie, completed.clearStateCookie]);
      return reply.code(303).header("location", completed.returnPath).send();
    } catch (error) {
      request.log.warn({ code: error instanceof LemmaComputerError ? error.code : "EXTERNAL_ID_FAILED" }, "External ID callback rejected");
      return reply.code(303).header("location", "/?signin=error&reason=EXTERNAL_ID_SIGNIN_FAILED").send();
    }
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/v1/auth/callback", async (request, reply) => {
    if (!security.authentication) throw new LemmaComputerError("AUTH_NOT_CONFIGURED", "Microsoft sign-in is not configured", 503);
    try {
      const completed = await security.authentication.complete({ ...request.query, cookie: request.headers.cookie });
      reply.header("set-cookie", [completed.cookie, completed.clearStateCookie]);
      return reply.code(303).header("location", completed.returnPath).send();
    } catch (error) {
      const reason = error instanceof LemmaComputerError ? error.code : "OIDC_FAILED";
      request.log.warn({
        err: {
          name: error instanceof Error ? error.name : "UnknownError",
          code: reason,
          message: error instanceof Error ? error.message : "Unknown OIDC callback error",
        },
      }, "OIDC callback rejected");
      return reply.code(303).header("location", `/?signin=error&reason=${encodeURIComponent(reason)}`).send();
    }
  });
  app.get("/v1/auth/session", async (request) => {
    const current = principal(request);
    const effectivePolicy = security.identityPolicyStore ? await security.identityPolicyStore.getEffectivePolicy(current.userId) : null;
    return { user: { id: current.userId, email: current.email, displayName: current.displayName }, tenant: { id: current.tenantId, displayName: current.tenantDisplayName }, roles: current.roles, effectivePolicy };
  });
  app.post("/v1/auth/logout", async (request, reply) => {
    if (!security.authentication) return reply.code(204).send();
    return reply.code(204).header("set-cookie", await security.authentication.logout(request.headers.cookie)).send();
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
    };
  };
  app.get("/v1/admin/ai-usage/events", async (request, reply) => {
    const actor = requirePermission(request, "usage.read");
    const result = await requireUsageLedger().store.listUsageEvents(usageQueryFor(actor.tenantId, request.query));
    reply.header("cache-control", "no-store");
    return { events: result.events, nextCursor: encodeUsageCursor(result.nextCursor) };
  });
  app.get("/v1/admin/ai-usage/totals", async (request, reply) => {
    const actor = requirePermission(request, "usage.read");
    const query = usageQueryFor(actor.tenantId, request.query);
    const { limit: _limit, cursor: _cursor, ...totalsQuery } = query;
    reply.header("cache-control", "no-store");
    return { totals: await requireUsageLedger().store.providerCostTotals(totalsQuery) };
  });
  app.get("/v1/admin/ai-usage/export.csv", async (request, reply) => {
    const actor = requirePermission(request, "usage.read");
    const query = usageQueryFor(actor.tenantId, request.query);
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
  app.get("/v1/admin/ai-usage/rate-cards", async (request, reply) => {
    const actor = requirePermission(request, "usage.read");
    reply.header("cache-control", "no-store");
    return { rateCards: await requireUsageLedger().store.listRateCards(actor.tenantId) };
  });
  app.post("/v1/admin/ai-usage/rate-cards", async (request, reply) => {
    const actor = requirePermission(request, "usage.manage");
    const input = adminRateCardSchema.parse(request.body ?? {});
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
    const actor = requireAdministrator(request);
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
    const actor = requireAdministrator(request);
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
    const actor = requireAdministrator(request);
    const team = await requireTeams().getTeam(actor.tenantId, z.uuid().parse(request.params.teamId));
    if (!team) throw new LemmaComputerError("TEAM_NOT_FOUND", "Team not found", 404);
    return { team };
  });
  app.patch<{ Params: { teamId: string } }>("/v1/admin/teams/:teamId", async (request) => {
    const actor = requireAdministrator(request);
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
    const actor = requireAdministrator(request);
    return {
      team: await requireTeams().archiveTeam({
        tenantId: actor.tenantId,
        teamId: z.uuid().parse(request.params.teamId),
        archivedBy: actor.userId,
      }),
    };
  });
  app.post<{ Params: { teamId: string } }>("/v1/admin/teams/:teamId/memberships", async (request, reply) => {
    const actor = requireAdministrator(request);
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
    const actor = requireAdministrator(request);
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
    const actor = requireAdministrator(request);
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
    const actor = requireAdministrator(request);
    return { events: await requireTeams().listAuditEvents(actor.tenantId) };
  });
  app.get<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/budget",async(request)=>{
    const actor=requireAdministrator(request);return{status:await requireBudgets().get(actor,z.uuid().parse(request.params.teamId))};
  });
  app.put<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/budget",async(request)=>{
    const actor=requireAdministrator(request);return requireBudgets().save(actor,z.uuid().parse(request.params.teamId),saveTeamBudgetSchema.parse(request.body??{}));
  });
  app.post<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/budget/override",async(request)=>{
    const actor=requireAdministrator(request);return requireBudgets().override(actor,z.uuid().parse(request.params.teamId),budgetOverrideSchema.parse(request.body??{}));
  });
  app.post<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/budget/reconcile",async(request)=>{
    const actor=requireAdministrator(request);return{reconciliation:await requireBudgets().sync(actor,z.uuid().parse(request.params.teamId))};
  });
  app.get("/v1/admin/routing/mappings/latest",async(request,reply)=>{
    const actor=requireAdministrator(request);
    reply.header("cache-control","no-store");
    return {mapping:await requireRouting().latestMapping(actor)};
  });
  app.post("/v1/admin/routing/mappings",async(request,reply)=>{
    const actor=requireAdministrator(request);const mapping=await requireRouting().createMapping(actor,createRoutingMappingSchema.parse(request.body??{}));
    reply.header("cache-control","no-store");return reply.code(201).send({mapping});
  });
  app.get<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/routing",async(request)=>{const actor=requireAdministrator(request);return requireRouting().settings(actor,z.uuid().parse(request.params.teamId));});
  app.put<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/routing/policy",async(request)=>{const actor=requireAdministrator(request);return requireRouting().savePolicy(actor,z.uuid().parse(request.params.teamId),saveRoutingPolicySchema.parse(request.body??{}));});
  app.post<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/routing/reviews",async(request,reply)=>{const actor=requireAdministrator(request);const review=await requireRouting().review(actor,z.uuid().parse(request.params.teamId),saveRoutingReviewSchema.parse(request.body??{}));return reply.code(201).send({review});});
  app.post<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/routing/rollout",async(request,reply)=>{const actor=requireAdministrator(request);const rollout=await requireRouting().rollout(actor,z.uuid().parse(request.params.teamId),changeRoutingRolloutSchema.parse(request.body??{}));return reply.code(201).send({rollout});});
  app.post<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/routing/kill-switch",async(request,reply)=>{
    const actor=requireAdministrator(request);const body=z.strictObject({reason:z.string().trim().min(8).max(1000)}).parse(request.body??{});const rollout=await requireRouting().killSwitch(actor,z.uuid().parse(request.params.teamId),body.reason);return reply.code(201).send({rollout});
  });
  app.get<{Params:{teamId:string}}>("/v1/admin/teams/:teamId/routing/shadow-report",async(request)=>{const actor=requireAdministrator(request);return requireRouting().report(actor,z.uuid().parse(request.params.teamId));});
  app.get<{Params:{decisionId:string}}>("/v1/admin/routing/decisions/:decisionId",async(request,reply)=>{const actor=requireAdministrator(request);const decision=await requireRouting().decision(actor,z.uuid().parse(request.params.decisionId));if(!decision)return reply.code(404).send({error:{code:"ROUTING_DECISION_NOT_FOUND",message:"Routing decision not found",correlationId:request.id,retryable:false}});return decision;});
  app.get("/v1/admin/users", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const users = await security.identityPolicyStore.listUsers(actor.tenantId);
    const governedRoutingAvailable = await governedRoutingAvailableFor(actor.tenantId);
    return {
      users: await Promise.all(users.map(async (user) => {
        const targetIdentity = identityContextSchema.parse({
          tenantId: actor.tenantId,
          subjectId: user.userId,
          audience: "lemmacomputer-control",
        });
        const workspaces = await store.listCurrent(targetIdentity);
        return {
          ...user,
          workspaces: await Promise.all(workspaces.map(async (workspace) => {
            const settings = await store.getSandboxSettings?.(targetIdentity, workspace.grantId);
            const workspaceEgress = await workspaceEgressFor({
              ...actor,
              userId: user.userId,
              identity: targetIdentity,
            }, user.effectivePolicy, workspace.grantId);
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
  app.get("/v1/admin/memberships", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    const membershipStore = security.identityPolicyStore;
    if (!membershipStore?.listOrganizationMemberships) {
      throw new LemmaComputerError("MEMBERSHIP_ADMIN_NOT_CONFIGURED", "Organization access administration is unavailable", 503, true);
    }
    return { memberships: await membershipStore.listOrganizationMemberships(actor.tenantId) };
  });
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
    if (input.role !== "member") requirePermission(request, "organization.manage_roles");
    if (input.role === "owner") requirePermission(request, "organization.transfer_ownership");
    const invitationStore = security.identityPolicyStore;
    if (!invitationStore?.createOrganizationInvitation) {
      throw new LemmaComputerError("INVITATION_ADMIN_NOT_CONFIGURED", "Organization invitation administration is unavailable", 503, true);
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
    return reply.code(result.replayed ? 200 : 201).send({
      invitation: result.invitation,
      replayed: result.replayed,
      acceptancePath: result.replayed ? null : `/invite?token=${encodeURIComponent(token)}`,
    });
  });
  app.post<{ Params: { invitationId: string } }>("/v1/admin/invitations/:invitationId/resend", async (request) => {
    const actor = requirePermission(request, "organization.manage_members");
    const invitationStore = security.identityPolicyStore;
    if (!invitationStore?.resendOrganizationInvitation) {
      throw new LemmaComputerError("INVITATION_ADMIN_NOT_CONFIGURED", "Organization invitation administration is unavailable", 503, true);
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
    return {
      invitation: result.invitation,
      replayed: result.replayed,
      acceptancePath: result.replayed ? null : `/invite?token=${encodeURIComponent(token)}`,
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
    if (input.role === "owner") requirePermission(request, "organization.transfer_ownership");
    if (request.params.userId === actor.userId && (input.status === "suspended" || input.status === "revoked")) {
      throw new LemmaComputerError("ADMIN_SELF_DISABLE_FORBIDDEN", "You cannot suspend your own administrator account", 409);
    }
    const membershipStore = security.identityPolicyStore;
    if (!membershipStore?.changeOrganizationMembership) {
      throw new LemmaComputerError("MEMBERSHIP_ADMIN_NOT_CONFIGURED", "Organization access administration is unavailable", 503, true);
    }
    const target = (await membershipStore.listUsers(actor.tenantId)).find((item) => item.userId === request.params.userId);
    if (!target) throw new LemmaComputerError("MEMBERSHIP_NOT_FOUND", "Membership not found", 404);
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
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const note = z.object({ revisionNote: z.string().min(3).max(160) }).parse(request.body ?? {});
    return security.identityPolicyStore.createMvpPolicyVersion({ tenantId: actor.tenantId, createdBy: actor.userId, revisionNote: note.revisionNote });
  });
  app.get("/v1/admin/egress-security-groups", async (request) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    return { securityGroups: await security.identityPolicyStore.listEgressSecurityGroups(actor.tenantId, actor.userId) };
  });
  app.post("/v1/admin/egress-security-groups", async (request, reply) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const input = saveEgressSecurityGroupSchema.parse(request.body ?? {});
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
  app.post<{ Params: { grantId: string } }>("/v1/admin/workspaces/:grantId/egress-security-group", async (request) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore?.assignWorkspaceEgressSecurityGroup) {
      throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Workspace firewall storage is unavailable", 503);
    }
    const input = assignEgressSecurityGroupSchema.parse(request.body ?? {});
    const grantId = z.string().min(1).max(128).parse(request.params.grantId);
    const assigned = await security.identityPolicyStore.assignWorkspaceEgressSecurityGroup({
      tenantId: actor.tenantId,
      subjectId: actor.userId,
      grantId,
      assignedBy: actor.userId,
      securityGroupVersionId: input.securityGroupVersionId,
    });
    const effective = await security.identityPolicyStore.getEffectivePolicy(actor.userId);
    if (effective) {
      const { policy } = await policyForGrant(actor, effective, grantId);
      await service.refreshEgressPolicy(actor.identity, policy, grantId);
    }
    return assigned;
  });
  app.get("/v1/admin/mcp-policy", async (request) => {
    const actor = requirePermission(request, "policy.manage");
    if (!security.identityPolicyStore) throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const users = await security.identityPolicyStore.listUsers(actor.tenantId);
    const effective = users.map((user) => user.effectivePolicy).find(Boolean) ?? null;
    const runtime = effective ? runtimePolicyFor(effective) : null;
    return {
      serverName: "lemmacomputer_ms365",
      version: effective?.version ?? 1,
      documentHash: effective?.documentHash ?? "0".repeat(64),
      tools: Object.entries(m365CapabilityDefinitions).map(([name, definition]) => ({
        name,
        displayName: definition.displayName,
        description: definition.description,
        service: definition.service,
        risk: definition.risk,
        decision: runtime?.toolPolicies[name] ?? definition.mode,
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
    const workspaceGrants = await refreshTenantWorkspaceConnectionGrants(actor.tenantId);
    return {
      ...savedPolicy,
      workspaceGrants,
    };
  });
  app.get("/v1/admin/provider-settings", async (request) => {
    const actor = requirePermission(request, "provider.manage");
    return requireProviderSettings().list(actor);
  });
  app.put<{ Params: { provider: string } }>("/v1/admin/provider-settings/:provider", async (request) => {
    const actor = requirePermission(request, "provider.manage");
    const provider = providerNameSchema.parse(request.params.provider);
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
    const actor = requirePermission(request, "provider.manage");
    const provider = providerNameSchema.parse(request.params.provider);
    return { provider: await requireProviderSettings().test(actor, provider) };
  });
  app.post<{ Params: { provider: string } }>("/v1/admin/provider-settings/:provider/disable", async (request) => {
    const actor = requirePermission(request, "provider.manage");
    const provider = providerNameSchema.parse(request.params.provider);
    const disabled = await requireProviderSettings().disable(actor, provider);
    return {
      provider: disabled.provider,
      workspaceGrants: disabled.workspaceGrants,
      restartRequired: disabled.workspaceGrants.revoked > 0 || disabled.workspaceGrants.failed > 0,
    };
  });
  app.post<{ Params: { provider: string } }>("/v1/admin/provider-settings/:provider/reconcile", async (request) => {
    const actor = requirePermission(request, "provider.manage");
    const provider = providerNameSchema.parse(request.params.provider);
    const reconciled = await requireProviderSettings().reconcile(actor, provider);
    return {
      provider: reconciled.provider,
      workspaceGrants: reconciled.workspaceGrants,
      restartRequired: reconciled.workspaceGrants.revoked > 0 || reconciled.workspaceGrants.failed > 0,
    };
  });
  app.delete<{ Params: { provider: string } }>("/v1/admin/provider-settings/:provider", async (request) => {
    const actor = requirePermission(request, "provider.manage");
    const provider = providerNameSchema.parse(request.params.provider);
    const removed = await requireProviderSettings().remove(actor, provider);
    return {
      deleted: true,
      workspaceGrants: removed.workspaceGrants,
      restartRequired: removed.workspaceGrants.revoked > 0 || removed.workspaceGrants.failed > 0,
    };
  });
  app.get("/v1/connections", async (request) => {
    const actor = principal(request);
    const { connections: catalog, connectionProjectionChanged } = await requireConnections().list(actor.identity, isAdministrator(actor));
    if (connectionProjectionChanged) await refreshOwnedWorkspaceConnectionGrants(actor);
    return { connections: catalog };
  });
  app.get("/v1/admin/connectors", async (request) => {
    const actor = requireAdministrator(request);
    return requireConnections().adminList(actor.identity);
  });
  app.post("/v1/admin/connectors/discover", async (request) => {
    const actor = requireAdministrator(request);
    return requireConnections().discoverConnector(actor.identity, createConnectorSchema.parse(request.body ?? {}));
  });
  app.post("/v1/admin/connectors", async (request, reply) => {
    const actor = requireAdministrator(request);
    const connector = await requireConnections().createConnector(
      actor.identity,
      actor.userId,
      createConnectorSchema.parse(request.body ?? {}),
    );
    return reply.code(201).send({ connector });
  });
  app.get<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/tool-policy", async (request) => {
    const actor = requireAdministrator(request);
    return requireConnections().connectorToolPolicy(actor.identity, request.params.connectorId);
  });
  app.put<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/tool-policy", async (request) => {
    const actor = requireAdministrator(request);
    const input = saveHostedConnectorToolPolicySchema.parse(request.body ?? {});
    const saved = await requireConnections().saveConnectorToolPolicy(
      actor.identity,
      request.params.connectorId,
      input.tools,
      input.expectedDocumentHash,
    );
    return { ...saved, workspaceGrants: await refreshTenantWorkspaceConnectionGrants(actor.tenantId) };
  });
  app.put<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/access-policy", async (request) => {
    const actor = requireAdministrator(request);
    const input = z.strictObject({
      enabled: z.boolean(),
      membersCanManage: z.boolean(),
    }).parse(request.body ?? {});
    const connector = await requireConnections().updateAccessPolicy(
      actor.identity,
      actor.userId,
      request.params.connectorId,
      input,
    );
    return { connector, workspaceGrants: await refreshTenantWorkspaceConnectionGrants(actor.tenantId) };
  });
  app.put<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId/icon", async (request) => {
    const actor = requireAdministrator(request);
    const input = connectorIconSchema.parse(request.body ?? {});
    return { connector: await requireConnections().updateConnectorIcon(actor.identity, request.params.connectorId, input.iconDataUrl) };
  });
  app.delete<{ Params: { connectorId: string } }>("/v1/admin/connectors/:connectorId", async (request) => {
    const actor = requireAdministrator(request);
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
    const started = await requireConnections().start(actor.identity, request.params.connectorId, isAdministrator(actor));
    if (started.cookies.length) reply.header("set-cookie", started.cookies);
    return reply.code(302).header("location", started.location).send();
  });
  app.get<{ Params: { connectorId: string }; Querystring: { state?: string; code?: string; error?: string } }>("/v1/connections/:connectorId/callback", async (request, reply) => {
    const service = requireConnections();
    try {
      const actor = principal(request);
      await service.complete(actor.identity, request.params.connectorId, {
        state: request.query.state,
        code: request.query.code,
        error: request.query.error,
      }, isAdministrator(actor));
      await refreshOwnedWorkspaceConnectionGrants(actor);
      return reply.code(303).header("location", service.resultUrl(request.params.connectorId, "connected")).send();
    } catch (error) {
      const reason = error instanceof LemmaComputerError ? error.code : "MCP_CONNECTION_FAILED";
      return reply.code(303).header("location", service.resultUrl(request.params.connectorId, "error", reason)).send();
    }
  });
  app.delete<{ Params: { connectorId: string } }>("/v1/connections/:connectorId", async (request) => {
    const actor = principal(request);
    const result = await requireConnections().disconnect(actor.identity, request.params.connectorId, isAdministrator(actor));
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
    const input = saveTelegramChannelConnectionSchema.parse({ ...(request.body as object ?? {}), workspaceId });
    const { policy } = await requireWorkspacePolicy(request, workspaceId);
    if (!assignedChatAgentIds(policy).includes(input.defaultAgentId)) {
      throw new LemmaComputerError("CHAT_AGENT_NOT_SELECTED", "The default messaging agent is not selected for this workspace", 409);
    }
    return requireChannelBroker().save(identity(request), input);
  });
  app.delete<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/channels/telegram", async (request, reply) => {
    const workspaceId = z.uuid().parse(request.params.workspaceId);
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
    const governedRoutingAvailable = await governedRoutingAvailableFor(actor.tenantId);
    const availableModels = sandboxModels.filter((model) => governedRoutingAvailable ? model.alias === "lemmacomputer-auto" : assignedModels.includes(model.alias));
    const availableAgents = ownedAgentCatalog.filter((agent) => availableAgentIds.includes(agent.id));
    if (!availableProfiles.length || !availableModels.length || !availableAgents.length) throw new LemmaComputerError("POLICY_INVALID", "The active policy has no supported sandbox profile, model route, or agent", 500);
    if (!availableApplications.length) throw new LemmaComputerError("POLICY_INVALID", "The active policy has no supported sandbox applications", 500);
    const saved = await store.getSandboxSettings?.(actor.identity, grantId);
    const profileId = saved && availableProfiles.some((profile) => profile.id === saved.profileId) ? saved.profileId : availableProfiles[0]!.id;
    const applicationIds = saved?.applicationIds?.filter((id) => availableApplications.some((application) => application.id === id));
    const modelAlias = governedRoutingAvailable ? "lemmacomputer-auto" : saved && availableModels.some((model) => model.alias === saved.modelAlias) ? saved.modelAlias : availableModels[0]!.alias;
    const requestedServiceClass = governedRoutingAvailable ? saved?.requestedServiceClass ?? "auto" : "auto";
    const agentIds = saved?.agentIds?.filter((id) => availableAgents.some((agent) => agent.id === id));
    const selectedApplicationIds = applicationIds?.length ? applicationIds : defaultApplicationIds(document, assignedApplications);
    const selectedAgentIds = agentIds?.length ? agentIds : defaultAgentIds(document, availableAgentIds);
    const workspaceEgress = await workspaceEgressFor(actor, effective, grantId);
    const runtime = effective
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
    const egress = runtime?.egress;
    const availableSecurityGroups = includeAdministratorOptions && security.identityPolicyStore?.listEgressSecurityGroups
      ? await security.identityPolicyStore.listEgressSecurityGroups(actor.tenantId, actor.userId)
      : undefined;
    const configuration = sandboxConfigurationSchema.parse({
      schemaVersion: 1,
      profileId,
      executionMode: availableProfiles.find((profile) => profile.id === profileId)!.executionMode,
      egressMode: runtime?.egressMode ?? availableProfiles.find((profile) => profile.id === profileId)!.egressMode,
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
      routePreferenceMigrationRequired: governedRoutingAvailable && saved?.modelAlias !== "lemmacomputer-auto",
      profile: availableProfiles.find((profile) => profile.id === profileId),
      availableProfiles,
      availableApplications,
      availableModels,
      availableServiceClasses: governedRoutingAvailable ? workspaceServiceClasses : workspaceServiceClasses.slice(0, 1),
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
    const governedRoutingAvailable = await governedRoutingAvailableFor(actor.tenantId);
    const modelAlias = governedRoutingAvailable ? "lemmacomputer-auto" : input.modelAlias;
    const agents = Array.isArray(document.agents) ? document.agents : ownedAgentCatalog.map((agent) => agent.id);
    if (!profiles.includes(input.profileId)) throw new LemmaComputerError("PROFILE_NOT_ASSIGNED", "That sandbox profile is not assigned by your organization", 403);
    if (input.applicationIds.some((id) => !applications.includes(id))) throw new LemmaComputerError("APPLICATION_NOT_ASSIGNED", "That sandbox application is not assigned by your organization", 403);
    if (!modelAlias || (!governedRoutingAvailable && !models.includes(modelAlias))) throw new LemmaComputerError("MODEL_NOT_ASSIGNED", "That model route is not assigned by your organization", 403);
    if (input.agentIds.some((id) => !agents.includes(id))) throw new LemmaComputerError("AGENT_NOT_ASSIGNED", "That workspace agent is not assigned by your organization", 403);
    const current = await store.getCurrent(actor.identity, input.grantId);
    if (current && !["not_created", "stopped", "failed"].includes(current.state)) throw new LemmaComputerError("WORKSPACE_MUST_BE_STOPPED", "Stop the workspace before changing its profile or model route", 409, true);
    await store.saveSandboxSettings(actor.identity, {
      grantId: input.grantId,
      profileId: input.profileId as SandboxProfileId,
      applicationIds: input.applicationIds,
      modelAlias: modelAlias as SandboxModelAlias,
      requestedServiceClass: input.requestedServiceClass,
      agentIds: input.agentIds,
    });
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
      roles: target.roles,
      identity,
    };
    return { target, principal };
  };
  app.get<{ Params: { userId: string }; Querystring: { grantId?: string } }>(
    "/v1/admin/users/:userId/sandbox-settings",
    async (request) => {
      const actor = requireAdministrator(request);
      const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
      if (!target.effectivePolicy) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
      const grantId = z.string().min(1).max(128).parse(request.query.grantId ?? "personal");
      return sandboxSettingsFor(targetPrincipal, target.effectivePolicy, grantId, true);
    },
  );
  app.put<{ Params: { userId: string } }>("/v1/admin/users/:userId/sandbox-settings", async (request) => {
    const actor = requireAdministrator(request);
    const input = saveSandboxSettingsSchema.parse(request.body ?? {});
    const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
    if (!target.effectivePolicy) throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    return saveSandboxSettingsFor(targetPrincipal, target.effectivePolicy, input, true);
  });
  app.post<{ Params: { userId: string; grantId: string } }>(
    "/v1/admin/users/:userId/workspaces/:grantId/egress-security-group",
    async (request) => {
      const actor = requireAdministrator(request);
      if (!security.identityPolicyStore?.assignWorkspaceEgressSecurityGroup) {
        throw new LemmaComputerError("POLICY_STORE_NOT_CONFIGURED", "Workspace firewall storage is unavailable", 503);
      }
      const input = assignEgressSecurityGroupSchema.parse(request.body ?? {});
      const grantId = z.string().min(1).max(128).parse(request.params.grantId);
      const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
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
  app.get<{ Querystring: { grantId?: string } }>("/v1/sandbox-settings", async (request) => {
    const { principal: actor, effective } = await assignedPolicy(request);
    const grantId = z.string().min(1).max(128).parse(request.query.grantId ?? "personal");
    return sandboxSettingsFor(actor, effective, grantId, actor.roles.includes("administrator"));
  });
  app.put("/v1/sandbox-settings", async (request) => {
    const input = saveSandboxSettingsSchema.parse(request.body ?? {});
    const { principal: actor, effective } = await assignedPolicy(request);
    return saveSandboxSettingsFor(actor, effective, input, actor.roles.includes("administrator"));
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
    const { policy } = await requirePolicy(request);
    const current = await service.current(identity(request), policy, "personal");
    return current ? reply.send(current) : reply.code(404).send({ error: { code: "WORKSPACE_NOT_FOUND", message: "Workspace not found", correlationId: request.id, retryable: false } });
  });
  app.get("/v1/workspaces", async (request) => {
    const { principal: actor, effective } = await assignedPolicy(request);
    return { workspaces: await service.list(actor.identity, async (grantId) => (await policyForGrant(actor, effective, grantId)).policy) };
  });
  app.post("/v1/workspaces", async (request, reply) => {
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
    const actor = principal(request);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    await assertProviderConfiguration(actor, policy);
    return service.restart(actor.identity, policy, request.params.workspaceId, request.id);
  });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/stop", async (request) => { const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId); return service.stop(identity(request), policy, request.params.workspaceId); });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/gateway/test", async (request) => {
    const actor = principal(request);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    await assertProviderConfiguration(actor, policy);
    return service.testGateway(actor.identity, policy, request.params.workspaceId);
  });
  app.get<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/chat/agents", async (request, reply) => {
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const assigned = await service.agentChatAgents(identity(request), policy, request.params.workspaceId);
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
    return reply.header("cache-control", "no-store").send({ workspaceId: request.params.workspaceId, agents });
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
  app.get<{ Params: { workspaceId: string; catalogId: string }; Querystring: { cursor?: string; limit?: string } }>("/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions", async (request, reply) => {
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const access = await service.agentChatAccess(identity(request), policy, request.params.workspaceId, catalogId);
    const limit = z.coerce.number().int().min(1).max(50).catch(20).parse(request.query.limit);
    const cursor = request.query.cursor ? chatSessionIdSchema.parse(request.query.cursor) : undefined;
    const page = await agentChat.listSessions(access, { cursor, limit });
    const sessions = page.sessions.map((session) => ({ ...session, agentCatalogId: catalogId }));
    return reply.header("cache-control", "no-store").send({ sessions, nextCursor: page.nextCursor });
  });
  app.post<{ Params: { workspaceId: string; catalogId: string } }>("/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions", async (request, reply) => {
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const input = createChatSessionSchema.parse(request.body ?? {});
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const access = await service.agentChatAccess(identity(request), policy, request.params.workspaceId, catalogId);
    const session = await agentChat.createSession(access, input.title);
    return reply.code(201).header("cache-control", "no-store").send({ ...session, agentCatalogId: catalogId });
  });
  app.get<{ Params: { workspaceId: string; catalogId: string; sessionId: string } }>("/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/messages", async (request, reply) => {
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const sessionId = chatSessionIdSchema.parse(request.params.sessionId);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const owner = identity(request);
    const access = await service.agentChatAccess(owner, policy, request.params.workspaceId, catalogId);
    const messages = await reconcileChatMessages(
      await agentChat.listMessages(access, sessionId),
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
        for await (const event of activityEvents.subscribe(owner, scope, after, abort.signal)) {
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
    idempotency(request.headers);
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const sessionId = chatSessionIdSchema.parse(request.params.sessionId);
    const input = sendChatTurnSchema.parse(request.body ?? {});
    if (input.message.metadata.agentCatalogId !== catalogId) {
      throw new LemmaComputerError("CHAT_AGENT_MISMATCH", "The submitted message does not belong to the selected agent", 409);
    }
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
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
      const capabilities = await gateway.modelCapabilities(policy.modelAlias);
      if (!capabilities.vision) {
        throw new LemmaComputerError(
          "MODEL_IMAGE_INPUT_UNSUPPORTED",
          "The selected workspace model does not support image input. Choose a vision-capable model or remove the image.",
          422,
        );
      }
    }
    const owner = identity(request);
    const access = await service.agentChatAccess(owner, policy, request.params.workspaceId, catalogId);
    const mapper = new AgentUiStreamMapper(catalogId);
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
      try {
        const usageTaskBinding = issueUsageTaskBinding(
          owner, request.params.workspaceId, access.agentId, "chat", input.message.id, sessionId,
          undefined, input.requestedServiceClass,
        );
        for await (const event of agentChat.streamTurn(access, sessionId, input.message, undefined, usageTaskBinding)) {
          let projected = event;
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
            workspaceId: request.params.workspaceId,
            agentCatalogId: catalogId,
            sessionId,
            displayName: access.displayName,
            event: projected,
          });
          lastEvent = projected;
          chunks.push(...mapper.chunks(projected));
          notify();
        }
      } catch (error) {
        pumpError = error;
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
            workspaceId: request.params.workspaceId,
            agentCatalogId: catalogId,
            sessionId,
            displayName: access.displayName,
            event: terminal,
          }).catch(() => undefined);
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
  app.delete<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId", async (request, reply) => {
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    await service.delete(identity(request), policy, request.params.workspaceId);
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
  const connectorRegistryStore = PostgresConnectorRegistryStore.fromConnectionString(env.DATABASE_URL);
  const providerSettingsStore = PostgresProviderSettingsStore.fromConnectionString(env.DATABASE_URL);
  const scheduleStore = PostgresScheduleStore.fromConnectionString(env.DATABASE_URL);
  const siteStore = PostgresSiteStore.fromConnectionString(env.DATABASE_URL);
  const teamStore = PostgresTeamStore.fromConnectionString(env.DATABASE_URL);
  const usageLedgerStore = PostgresUsageLedgerStore.fromConnectionString(env.DATABASE_URL);
  const spendObservabilityStore = PostgresSpendObservabilityStore.fromConnectionString(env.DATABASE_URL);
  const identityPolicyStore = PostgresIdentityPolicyStore.fromConnectionString(env.DATABASE_URL);
  const budgetStore=PostgresTeamBudgetStore.fromConnectionString(env.DATABASE_URL);
  const routingStore=PostgresRoutingStore.fromConnectionString(env.DATABASE_URL);
  await identityPolicyStore.upgradeLegacyWorkspaceProfiles();
  const gatewayValues = [env.LITELLM_ADMIN_URL, env.LITELLM_WORKSPACE_URL, env.LITELLM_MASTER_KEY, env.LITELLM_CREDENTIAL_SECRET];
  if (gatewayValues.some(Boolean) && !gatewayValues.every(Boolean)) throw new Error("All LiteLLM gateway settings must be configured together");
  const liteLlmAdminTls = assertHostedLiteLlmAdminSecurity({
    installationKind: env.LEMMACOMPUTER_INSTALLATION_KIND,
    adminUrl: env.LITELLM_ADMIN_URL,
    credentialSecret: env.LITELLM_CREDENTIAL_SECRET,
    sessionSecret: env.SESSION_SECRET,
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
  const workforceAuthentication = new EntraAuthenticationService(identityPolicyStore, {
    tenantId: env.ENTRA_TENANT_ID,
    clientId: env.ENTRA_CLIENT_ID,
    clientSecret: env.ENTRA_CLIENT_SECRET,
    publicWebUrl: env.PUBLIC_WEB_URL,
    sessionSecret: env.SESSION_SECRET,
    bootstrapOwnedTenantId: env.BOOTSTRAP_TENANT_ID,
    bootstrapOwnedUserId: env.BOOTSTRAP_USER_ID,
    tenantDisplayName: env.TENANT_DISPLAY_NAME,
    bootstrapOwnerObjectIds: env.BOOTSTRAP_OWNER_OBJECT_IDS.split(",").map((item) => item.trim()).filter(Boolean),
    membershipAdmissionMode: env.LEMMACOMPUTER_INSTALLATION_KIND === "hosted"
      ? "existing-membership-only"
      : "directory-jit",
  });
  const externalIdAuthentication = env.LEMMACOMPUTER_INSTALLATION_KIND === "hosted"
    && env.EXTERNAL_ID_TENANT_ID && env.EXTERNAL_ID_TENANT_SUBDOMAIN
    && env.EXTERNAL_ID_CLIENT_ID && env.EXTERNAL_ID_CLIENT_SECRET
    ? new ExternalIdAuthenticationService(identityPolicyStore, {
        tenantId: env.EXTERNAL_ID_TENANT_ID,
        tenantSubdomain: env.EXTERNAL_ID_TENANT_SUBDOMAIN,
        clientId: env.EXTERNAL_ID_CLIENT_ID,
        clientSecret: env.EXTERNAL_ID_CLIENT_SECRET,
        publicWebUrl: env.PUBLIC_WEB_URL,
        sessionSecret: env.SESSION_SECRET,
        bootstrapOwnedTenantId: env.BOOTSTRAP_TENANT_ID,
        bootstrapOwnedUserId: env.BOOTSTRAP_USER_ID,
        tenantDisplayName: env.TENANT_DISPLAY_NAME,
        bootstrapOwnerObjectIds: [],
      })
    : undefined;
  const app = createControlServer(
    store,
    new HttpControllerClient(env.CONTROLLER_URL, env.CONTROLLER_INTERNAL_TOKEN),
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
    },
    {
      identityPolicyStore,
      connectorRegistryStore,
      providerSettingsStore,
      providerAdministration,
      mcpPolicyToken: env.CONTROLLER_INTERNAL_TOKEN,
      mcpEgressProxyToken: env.MCP_EGRESS_PROXY_TOKEN,
      agentBridgeSecret: env.AGENT_BRIDGE_SECRET,
      agentBridgeGrantTtlSeconds: env.AGENT_BRIDGE_GRANT_TTL_SECONDS,
      authentication: env.LEMMACOMPUTER_INSTALLATION_KIND === "hosted" && externalIdAuthentication
        ? externalIdAuthentication
        : workforceAuthentication,
      externalIdAuthentication,
      openVtc,
      egressGrantSecret: env.EGRESS_GRANT_SECRET,
      policyBundleAuthority,
      agentChatSecret: env.AGENT_CHAT_SECRET,
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
  app.addHook("onClose", async () => {
    if (pushRetryTimer) clearInterval(pushRetryTimer);
    await store.close();
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
  });
  await app.listen({ host: env.CONTROL_HOST, port: env.CONTROL_PORT });
}
