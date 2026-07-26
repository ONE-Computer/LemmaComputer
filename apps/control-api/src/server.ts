import { randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { LogController } from "fastify";
import { assignEgressSecurityGroupSchema, channelRouteSchema, channelTurnRequestSchema, channelTurnResponseSchema, chatAgentCatalogIdSchema, chatSessionIdSchema, createChatSessionSchema, createScheduleSchema, executeScheduleRunSchema, OneComputerError, createDeleteFileOperationSchema, createWorkspaceSchema, fixtureApprovalSchema, identityContextSchema, mcpPolicyRequestSchema, ownedAgentCatalog, policyVerificationKeySetSchema, saveEgressSecurityGroupSchema, saveMcpToolPolicySchema, saveTelegramChannelConnectionSchema, saveTelegramCredentialSchema, sandboxApplicationSchema, sandboxConfigurationSchema, sandboxProfileSchema, sandboxSettingsSchema, saveSandboxSettingsSchema, sendChatTurnSchema, telegramChannelConnectionStatusSchema, updateScheduleSchema, workspaceManifestAgentIdFor, workspaceManifestChatAgentIdFor, workspaceManifestSchema, type AgentCatalogId, type ChannelRoute, type ChatUiMessage, type IdentityContext, type RuntimePolicy, type SandboxApplicationId, type SandboxModelAlias, type SandboxProfileId, type SandboxConfiguration, type TelegramChannelConnectionStatus, type WorkspaceManifest } from "@onecomputer/contracts";
import { LiteLLMGatewayAdapter, type GatewayClient, type GovernedToolExecutor, type OAuthConnectionGateway } from "@onecomputer/litellm-adapter";
import { PolicyBundleSigner } from "@onecomputer/policy-integrity";
import { PostgresConnectorRegistryStore, PostgresIdentityPolicyStore, PostgresScheduleStore, PostgresWorkspaceStore, runtimePolicyFor, type ChannelStore, type ConnectorRegistryStore, type EffectivePolicy, type GovernanceStore, type IdentityPolicyStore, type ScheduleStore, type SessionPrincipal, type WorkspaceStore } from "@onecomputer/workspace-store";
import { WorkspaceIngressAuthority } from "@onecomputer/workspace-ingress-auth";
import { z } from "zod";
import { FixtureApprovalAuthority, GovernedOperationService } from "./operations.js";
import { McpConnectionService } from "./connections.js";
import { EgressProxyGrantAuthority, HttpControllerClient, PolicyBundleAuthority, WorkspaceService, type ControllerClient } from "./service.js";
import { EntraAuthenticationService, isAdministrator, testPrincipalFromHeaders } from "./auth.js";
import { McpPolicyService, m365CapabilityDefinitions, resumableUploadCapability } from "./mcp-policy.js";
import { OpenVtcApprovalCoordinator } from "./openvtc.js";
import { HttpOpenVtcConsentClient } from "./openvtc-consent-client.js";
import { AgentBridgeAuthority, type AgentBridgeIdentity } from "./agent-bridge.js";
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
    client: "ONEComputer managed workspace",
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
    client: "ONEComputer qualification CLI",
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
    client: "ONEComputer open workspace",
    clientVersion: "disposable-open-v1",
    persistence: "persistent-home",
    network: "gateway-only",
    resources: { cpus: 2, memoryGiB: workspaceMemoryGiB },
  }),
] as const;

const sandboxModels = [
  { alias: "onecomputer-claude", displayName: "Claude", provider: "Anthropic" },
  { alias: "onecomputer-openai", displayName: "OpenAI", provider: "OpenAI" },
  { alias: "onecomputer-glm", displayName: "GLM", provider: "Z.ai" },
  { alias: "onecomputer-assistant", displayName: "Standard route (legacy)", provider: "OpenAI" },
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
  category: z.enum(["Productivity", "Developer tools", "Communication", "Data and analytics", "Other"]),
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

const envSchema = z.object({
  CONTROL_HOST: z.string().default("127.0.0.1"),
  CONTROL_PORT: z.coerce.number().int().positive().default(4100),
  WEB_PROXY_TOKEN: z.string().min(24),
  CONTROLLER_URL: z.string().url().default("http://127.0.0.1:4101"),
  CONTROLLER_INTERNAL_TOKEN: z.string().min(24),
  DATABASE_URL: z.string().min(1),
  LITELLM_ADMIN_URL: z.string().url().optional(),
  LITELLM_WORKSPACE_URL: z.string().url().optional(),
  LITELLM_MASTER_KEY: z.string().min(24).optional(),
  LITELLM_CREDENTIAL_SECRET: z.string().min(32).optional(),
  LITELLM_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:4174"),
  M365_AUTHORIZATION_ORIGIN: z.string().url().default("http://localhost:4311"),
  AGENT_BRIDGE_URL: z.string().url().default("http://onecomputer-control:4100"),
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
  SESSION_SECRET: z.string().min(32),
  WORKSPACE_INGRESS_PUBLIC_URL: optionalEnvString(),
  WORKSPACE_INGRESS_SECRET: optionalEnvString(32),
  WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  WORKSPACE_INGRESS_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
  EGRESS_GRANT_SECRET: z.string().min(32).optional(),
  AGENT_CHAT_SECRET: z.string().min(32),
  CHANNEL_BROKER_URL: optionalEnvString(),
  CHANNEL_BROKER_INTERNAL_TOKEN: optionalEnvString(32),
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
  ADMINISTRATOR_EMAILS: z.string().min(1).default("mike@metech.dev"),
});

const sameSecret = (received: string | undefined, expected: string) => {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createControlServer(
  store: WorkspaceStore & GovernanceStore & Partial<ChannelStore>,
  controller: ControllerClient,
  proxyToken: string,
  gateway?: GatewayClient & Partial<GovernedToolExecutor>,
  fixtureApprovalSecret = "local-test-fixture-approval-secret-32-characters",
  connectionOptions: { publicWebUrl?: string; authorizationOrigin?: string; liteLlmPublicUrl?: string; agentBridgeUrl?: string } = {},
  security: {
    authentication?: AuthenticationBoundary;
    identityPolicyStore?: IdentityPolicyStore;
    mcpPolicyToken?: string;
    testIdentityMode?: boolean;
    openVtc?: OpenVtcApprovalCoordinator;
    egressGrantSecret?: string;
    policyBundleAuthority?: PolicyBundleAuthority;
    agentChatSecret?: string;
    agentChatClient?: AgentChatClient;
    channelBrokerClient?: ChannelBrokerManagementClient;
    channelBrokerInternalToken?: string;
    scheduleStore?: ScheduleStore;
    schedulerInternalToken?: string;
    schedulePromptSecret?: string;
    connectorRegistryStore?: ConnectorRegistryStore;
    workspaceIngress?: {
      publicUrl: string;
      authority: WorkspaceIngressAuthority;
    };
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
    agentProfile: "onecomputer-default-agent",
    applications: ["firefox"],
    networkProfile: "controlled-egress-v1",
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_fixture",
    allowedTools: ["search_files"],
    toolPolicies: { search_files: "allow" },
  };
  const app = Fastify({
    logger: { redact: ["req.headers.x-onecomputer-proxy-token", "req.headers.x-onecomputer-mcp-policy-token", "req.headers.authorization", "req.body", "*.arguments", "*.launchUrl"] },
    logController: new LogController({
      disableRequestLogging: (request) => /^\/v1\/connections\/[^/]+\/callback/.test(request.url) || request.url.startsWith("/v1/auth/callback"),
    }),
    bodyLimit: 32 * 1024,
  });
  const agentBridgeAuthority = new AgentBridgeAuthority(security.mcpPolicyToken ?? proxyToken);
  const agentChatAuthority = security.agentChatSecret ? new AgentChatAuthority(security.agentChatSecret) : undefined;
  const agentChat = security.agentChatClient ?? new HttpAgentChatClient();
  const channelBroker = security.channelBrokerClient;
  const service = new WorkspaceService(store, controller, gateway, {
    baseUrl: connectionOptions.agentBridgeUrl ?? "http://onecomputer-control:4100",
    issue: (identity, workspaceId, policy) => agentBridgeAuthority.issue(identity, workspaceId, policy),
  }, security.egressGrantSecret ? new EgressProxyGrantAuthority(security.egressGrantSecret) : undefined, security.policyBundleAuthority, agentChatAuthority, security.workspaceIngress);
  const executor: GovernedToolExecutor = gateway?.executeGovernedTool
    ? { executeGovernedTool: (input) => gateway.executeGovernedTool!(input) }
    : { executeGovernedTool: async () => { throw new OneComputerError("GATEWAY_NOT_CONFIGURED", "The governed tool gateway is not configured", 503, true); } };
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
  }) : undefined;
  const mcpPolicy = security.identityPolicyStore ? new McpPolicyService(
    security.identityPolicyStore,
    store,
    operations,
    connections ? (actor, serverName, toolName) => connections.hostedToolPolicy(actor, serverName, toolName) : undefined,
  ) : undefined;
  const requireConnections = () => {
    if (!connections) throw new OneComputerError("MCP_CONNECTIONS_NOT_CONFIGURED", "MCP connections are not configured", 503, true);
    return connections;
  };
  const requireChannelBroker = () => {
    if (!channelBroker) throw new OneComputerError("CHANNEL_BROKER_NOT_CONFIGURED", "Messaging connections are not configured", 503, true);
    return channelBroker;
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
  if (!security.authentication && !security.testIdentityMode) {
    throw new Error("Control requires Entra authentication; test identity mode must be enabled explicitly in tests");
  }
  const principals = new WeakMap<object, SessionPrincipal>();
  const agentPrincipals = new WeakMap<object, AgentBridgeIdentity>();

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    if (request.url === "/v1/openvtc/inbox" || request.url === "/trust-tasks") return;
    if (request.url.startsWith("/internal/v1/channels/")) {
      if (!security.channelBrokerInternalToken || !sameSecret(
        request.headers["x-onecomputer-channel-token"] as string | undefined,
        security.channelBrokerInternalToken,
      )) {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Channel broker authentication is required", correlationId: request.id, retryable: false } });
      }
      return;
    }
    if (request.url.startsWith("/internal/v1/schedules/")) {
      if (!security.schedulerInternalToken || !sameSecret(
        request.headers["x-onecomputer-scheduler-token"] as string | undefined,
        security.schedulerInternalToken,
      )) {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Scheduler authentication is required", correlationId: request.id, retryable: false } });
      }
      return;
    }
    if (
      request.url.startsWith("/internal/v1/agent/operations/")
      || request.url.startsWith("/internal/v1/agent/uploads")
      || request.url.startsWith("/internal/v1/agent/deletions")
    ) {
      const authorization = request.headers.authorization;
      const value = Array.isArray(authorization) ? authorization[0] : authorization;
      const match = typeof value === "string" ? /^Bearer (.+)$/.exec(value) : null;
      if (!match) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Agent bridge authentication is required", correlationId: request.id, retryable: false } });
      agentPrincipals.set(request, agentBridgeAuthority.verify(match[1]!));
      return;
    }
    if (request.url === "/internal/v1/mcp/authorize") {
      if (!sameSecret(request.headers["x-onecomputer-mcp-policy-token"] as string | undefined, security.mcpPolicyToken ?? proxyToken)) {
        return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Internal policy authentication is required", correlationId: request.id, retryable: false } });
      }
      return;
    }
    if (!sameSecret(request.headers["x-onecomputer-proxy-token"] as string | undefined, proxyToken)) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication is required", correlationId: request.id, retryable: false } });
    }
    if (request.url.startsWith("/v1/auth/login") || request.url.startsWith("/v1/auth/callback")) return;
    const principal = security.testIdentityMode
      ? testPrincipalFromHeaders(request.headers)
      : await security.authentication!.authenticate(request.headers.cookie);
    if (!principal) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in with your work account", correlationId: request.id, retryable: false } });
    }
    principals.set(request, principal);
  });

  const principal = (request: object) => {
    const value = principals.get(request);
    if (!value) throw new OneComputerError("UNAUTHENTICATED", "Sign in with your work account", 401);
    return value;
  };
  const identity = (request: object) => identityContextSchema.parse(principal(request).identity);
  const requireAdministrator = (request: object) => {
    const value = principal(request);
    if (!isAdministrator(value)) throw new OneComputerError("FORBIDDEN", "Administrator access is required", 403);
    return value;
  };
  const assignedPolicy = async (request: object) => {
    const value = principal(request);
    const effective = security.identityPolicyStore ? await security.identityPolicyStore.getEffectivePolicy(value.userId) : null;
    if (security.identityPolicyStore && !effective) throw new OneComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    return { principal: value, effective };
  };
  const workspaceEgressFor = async (value: SessionPrincipal, effective: EffectivePolicy | null, grantId: string) => (
    await security.identityPolicyStore?.getWorkspaceEgressSecurityGroup?.({
      tenantId: value.tenantId,
      subjectId: value.userId,
      grantId,
    }) ?? effective?.egressSecurityGroup ?? null
  );
  const policyForGrant = async (value: SessionPrincipal, effective: EffectivePolicy | null, grantId = "personal") => {
    let policy = testRuntimePolicy;
    if (effective) {
      const saved = await store.getSandboxSettings?.(value.identity, grantId);
      const workspaceEgress = await workspaceEgressFor(value, effective, grantId);
      const document = effective.document as Record<string, unknown>;
      const availableAgentIds = assignedAgentIds(document);
      policy = runtimePolicyFor(
        effective,
        saved?.modelAlias,
        saved?.profileId,
        saved?.agentIds ?? defaultAgentIds(document, availableAgentIds),
        saved?.applicationIds ?? defaultApplicationIds(document),
        workspaceEgress,
      );
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
        await service.revokePolicyGrant(workspace.id, policy).catch(() => undefined);
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
  const requirePolicy = async (request: object) => {
    const { principal: value, effective } = await assignedPolicy(request);
    return policyForGrant(value, effective);
  };
  const requireWorkspacePolicy = async (request: object, workspaceId: string) => {
    const { principal: value, effective } = await assignedPolicy(request);
    const workspace = await store.getOwned(value.identity, workspaceId);
    if (!workspace) throw new OneComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    return policyForGrant(value, effective, workspace.grantId);
  };
  const channelPolicy = async (channelIdentity: IdentityContext, workspaceId: string) => {
    const workspace = await store.getOwned(channelIdentity, workspaceId);
    if (!workspace) throw new OneComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    let actor: SessionPrincipal;
    let effective: EffectivePolicy | null;
    if (security.identityPolicyStore) {
      const resolved = await security.identityPolicyStore.getPrincipal(channelIdentity.subjectId);
      if (!resolved || resolved.tenantId !== channelIdentity.tenantId) {
        throw new OneComputerError("CHANNEL_IDENTITY_NOT_FOUND", "The channel owner is unavailable", 403);
      }
      actor = resolved;
      effective = await security.identityPolicyStore.getEffectivePolicy(resolved.userId);
      if (!effective) throw new OneComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
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
      throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503, true);
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
            throw new OneComputerError("CHAT_AGENT_NOT_SELECTED", "That agent is not selected for this workspace", 409);
          }
        },
        async (owner, workspaceId, catalogId) => {
          const { policy } = await channelPolicy(owner, workspaceId);
          return service.agentChatAccess(owner, policy, workspaceId, catalogId);
        },
      )
    : undefined;
  const requireSchedules = () => {
    if (!schedules) throw new OneComputerError("SCHEDULER_NOT_CONFIGURED", "Scheduling is unavailable", 503, true);
    return schedules;
  };
  const verifiedChannelRoute = async (route: ChannelRoute, enforceSelectedRoute: boolean) => {
    if (!store.getOwnedChannelConnection) {
      throw new OneComputerError("CHANNEL_STORE_NOT_CONFIGURED", "Channel storage is unavailable", 503, true);
    }
    const connection = await store.getOwnedChannelConnection(route.identity, "telegram", route.workspaceId);
    if (
      !connection
      || connection.id !== route.connectionId
      || connection.workspaceId !== route.workspaceId
      || !connection.allowedUserIds.includes(route.externalSenderId)
    ) {
      throw new OneComputerError("CHANNEL_ROUTE_REJECTED", "The channel route is not authorized", 403);
    }
    if (enforceSelectedRoute) {
      const selected = await store.getChannelSenderAgent?.(connection.id, route.externalSenderId)
        ?? connection.defaultAgentId;
      if (selected !== route.agentCatalogId) {
        throw new OneComputerError("CHANNEL_AGENT_MISMATCH", "The channel agent route changed", 409);
      }
    }
    const { policy } = await channelPolicy(route.identity, route.workspaceId);
    if (!assignedChatAgentIds(policy).includes(route.agentCatalogId)) {
      throw new OneComputerError("CHAT_AGENT_NOT_SELECTED", "That chat agent is not selected for this workspace", 409);
    }
    return {
      policy,
      access: await service.agentChatAccess(route.identity, policy, route.workspaceId, route.agentCatalogId),
    };
  };
  const idempotency = (headers: Record<string, unknown>) => {
    const key = headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 128) throw new OneComputerError("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required", 400);
    return key;
  };
  const browserAgentToken = (authorization: string | string[] | undefined) => {
    const value = Array.isArray(authorization) ? authorization[0] : authorization;
    const match = typeof value === "string" ? /^Bearer (ocvta_[A-Za-z0-9_-]{43})$/.exec(value) : null;
    if (!match) throw new OneComputerError("UNAUTHENTICATED", "Browser agent authentication is required", 401);
    return match[1];
  };

  app.get("/healthz", async () => ({ status: "ok" }));
  app.post("/internal/v1/mcp/authorize", { bodyLimit: 6 * 1024 * 1024 }, async (request) => {
    if (!mcpPolicy) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "MCP policy storage is unavailable", 503, true);
    return mcpPolicy.authorize(mcpPolicyRequestSchema.parse(request.body ?? {}), request.id);
  });
  app.post("/internal/v1/channels/routes/validate", async (request, reply) => {
    const route = channelRouteSchema.parse(request.body ?? {});
    const { access } = await verifiedChannelRoute(route, false);
    await agentChat.health(access);
    return reply.code(204).send();
  });
  app.post("/internal/v1/channels/turns", async (request) => {
    const input = channelTurnRequestSchema.parse(request.body ?? {});
    const { access } = await verifiedChannelRoute(input, true);
    if (!store.claimChannelUpdate || !await store.claimChannelUpdate(
      input.connectionId,
      input.updateId,
      input.externalSenderId,
    )) {
      throw new OneComputerError("CHANNEL_UPDATE_REPLAYED", "The channel update was already dispatched", 409);
    }
    const session = input.sessionId
      ? { id: input.sessionId }
      : await agentChat.createSession(access, `Telegram ${input.externalSenderId}`);
    const message: ChatUiMessage = {
      id: randomUUID(),
      role: "user",
      metadata: {
        agentCatalogId: input.agentCatalogId,
        state: "completed",
        createdAt: new Date().toISOString(),
      },
      parts: [{ type: "text", text: input.text }],
    };
    let text = "";
    const notices: string[] = [];
    for await (const event of agentChat.streamTurn(access, session.id, message)) {
      if (event.type === "text-delta") {
        text += event.delta;
        if (text.length > 16_000) throw new OneComputerError("CHANNEL_RESPONSE_TOO_LARGE", "The channel response exceeded its limit", 502);
      }
      if (event.type === "approval" && !notices.includes(event.summary)) {
        notices.push(`${event.summary} Open ONEComputer to review this protected action.`);
      }
      if (event.type === "turn-finish" && event.state === "failed" && !text) {
        throw new OneComputerError("CHANNEL_TURN_FAILED", event.message ?? "The agent could not complete the message", 502, true);
      }
    }
    return channelTurnResponseSchema.parse({ sessionId: session.id, text, notices });
  });
  app.post("/internal/v1/schedules/runs/execute", async (request) => {
    const input = executeScheduleRunSchema.parse(request.body ?? {});
    return requireSchedules().executeClaimed(input.runId, input.leaseToken);
  });
  app.get<{ Params: { operationId: string } }>("/internal/v1/agent/operations/:operationId", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new OneComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    return operations.getForAgent(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "onecomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId },
    );
  });
  app.post("/internal/v1/agent/uploads", async (request, reply) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new OneComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({
      driveId: z.string().trim().min(1).max(512),
      driveItemId: z.string().trim().min(1).max(512),
      fileName: z.string().trim().min(1).max(255),
      size: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      idempotencyKey: z.string().min(16).max(128),
    }).parse(request.body ?? {});
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "onecomputer-control" as const };
    const { policy } = await channelPolicy(owner, actor.workspaceId);
    const allowedAgentIds = new Set([policy.agentId, ...(policy.agents?.map((agent) => agent.agentId) ?? [])]);
    if (
      actor.policyHash !== policy.policyHash
      || !allowedAgentIds.has(actor.agentId)
      || !policy.allowedTools.includes("upload-file-content")
      || policy.toolPolicies["upload-file-content"] !== "approval_required"
    ) {
      throw new OneComputerError("MCP_POLICY_BINDING_MISMATCH", "The upload is not assigned to this workspace agent", 403);
    }
    const operation = await operations.createMicrosoft365Operation(
      owner,
      actor.workspaceId,
      {
        capabilityId: resumableUploadCapability.capabilityId,
        schemaId: resumableUploadCapability.schemaId,
        serverName: "onecomputer_ms365",
        toolName: "create-upload-session",
        arguments: {
          driveId: input.driveId,
          driveItemId: input.driveItemId,
          body: { item: { "@microsoft.graph.conflictBehavior": "replace" } },
          onecomputerFile: { name: input.fileName, size: input.size, sha256: input.sha256 },
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
    if (!actor) throw new OneComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({
      driveId: z.string().trim().min(1).max(512),
      driveItemId: z.string().trim().min(1).max(512),
      resourceName: z.string().trim().min(1).max(255),
      "If-Match": z.string().trim().min(1).max(512),
      idempotencyKey: z.string().min(16).max(128),
    }).parse(request.body ?? {});
    const owner = { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "onecomputer-control" as const };
    const { policy } = await channelPolicy(owner, actor.workspaceId);
    const allowedAgentIds = new Set([policy.agentId, ...(policy.agents?.map((agent) => agent.agentId) ?? [])]);
    if (
      actor.policyHash !== policy.policyHash
      || !allowedAgentIds.has(actor.agentId)
      || !policy.allowedTools.includes("delete-onedrive-file")
      || policy.toolPolicies["delete-onedrive-file"] !== "approval_required"
    ) {
      throw new OneComputerError("MCP_POLICY_BINDING_MISMATCH", "OneDrive deletion is not assigned to this workspace agent", 403);
    }
    const capability = m365CapabilityDefinitions["delete-onedrive-file"];
    const operation = await operations.createMicrosoft365Operation(
      owner,
      actor.workspaceId,
      {
        capabilityId: capability.capabilityId,
        schemaId: capability.schemaId,
        serverName: "onecomputer_ms365",
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
    if (!actor) throw new OneComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    return operations.beginResumableUpload(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "onecomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId },
      request.id,
    );
  });
  app.post<{ Params: { operationId: string } }>("/internal/v1/agent/uploads/:operationId/complete", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new OneComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({ leaseId: z.uuid() }).parse(request.body ?? {});
    return operations.completeResumableUpload(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "onecomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId },
      input.leaseId,
      request.id,
    );
  });
  app.post<{ Params: { operationId: string } }>("/internal/v1/agent/uploads/:operationId/fail", async (request) => {
    const actor = agentPrincipals.get(request);
    if (!actor) throw new OneComputerError("UNAUTHENTICATED", "Agent bridge authentication is required", 401);
    const input = z.strictObject({ leaseId: z.uuid() }).parse(request.body ?? {});
    return operations.failResumableUpload(
      { tenantId: actor.tenantId, subjectId: actor.subjectId, audience: "onecomputer-control" },
      request.params.operationId,
      { workspaceId: actor.workspaceId, agentId: actor.agentId },
      input.leaseId,
      request.id,
    );
  });
  app.get<{ Querystring: { return?: string } }>("/v1/auth/login", async (request, reply) => {
    if (!security.authentication) throw new OneComputerError("AUTH_NOT_CONFIGURED", "Microsoft sign-in is not configured", 503);
    const started = await security.authentication.begin(request.query.return);
    return reply.code(302).header("set-cookie", started.cookie).header("location", started.location).send();
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/v1/auth/callback", async (request, reply) => {
    if (!security.authentication) throw new OneComputerError("AUTH_NOT_CONFIGURED", "Microsoft sign-in is not configured", 503);
    try {
      const completed = await security.authentication.complete({ ...request.query, cookie: request.headers.cookie });
      reply.header("set-cookie", [completed.cookie, completed.clearStateCookie]);
      return reply.code(303).header("location", completed.returnPath).send();
    } catch (error) {
      const reason = error instanceof OneComputerError ? error.code : "OIDC_FAILED";
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
  app.get("/v1/admin/users", async (request) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const users = await security.identityPolicyStore.listUsers(actor.tenantId);
    return {
      users: await Promise.all(users.map(async (user) => {
        const targetIdentity = identityContextSchema.parse({
          tenantId: actor.tenantId,
          subjectId: user.userId,
          audience: "onecomputer-control",
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
  app.patch<{ Params: { userId: string } }>("/v1/admin/users/:userId/status", async (request) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const input = z.strictObject({ status: z.enum(["active", "disabled"]) }).parse(request.body ?? {});
    if (request.params.userId === actor.userId && input.status === "disabled") {
      throw new OneComputerError("ADMIN_SELF_DISABLE_FORBIDDEN", "You cannot suspend your own administrator account", 409);
    }
    const target = (await security.identityPolicyStore.listUsers(actor.tenantId)).find((item) => item.userId === request.params.userId);
    if (!target) throw new OneComputerError("USER_NOT_FOUND", "User not found", 404);
    const targetIdentity = identityContextSchema.parse({
      tenantId: actor.tenantId,
      subjectId: target.userId,
      audience: "onecomputer-control",
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
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const revokedSessions = await security.identityPolicyStore.revokeUserSessions({
      tenantId: actor.tenantId,
      targetUserId: request.params.userId,
      revokedBy: actor.userId,
    });
    return { userId: request.params.userId, revokedSessions };
  });
  app.post<{ Params: { userId: string } }>("/v1/admin/users/:userId/policy", async (request) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const target = (await security.identityPolicyStore.listUsers(actor.tenantId)).find((item) => item.userId === request.params.userId);
    if (!target) throw new OneComputerError("USER_NOT_FOUND", "User not found", 404);
    return security.identityPolicyStore.assignMvpPolicy({ tenantId: actor.tenantId, targetUserId: request.params.userId, assignedBy: actor.userId });
  });
  app.delete<{ Params: { userId: string } }>("/v1/admin/users/:userId/policy", async (request, reply) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const target = (await security.identityPolicyStore.listUsers(actor.tenantId)).find((item) => item.userId === request.params.userId);
    if (!target) throw new OneComputerError("USER_NOT_FOUND", "User not found", 404);
    const current = await security.identityPolicyStore.getEffectivePolicy(request.params.userId);
    const revoked = await security.identityPolicyStore.revokeMvpPolicy({ tenantId: actor.tenantId, targetUserId: request.params.userId, revokedBy: actor.userId });
    if (revoked && current && gateway) {
      const targetIdentity: IdentityContext = {
        tenantId: actor.tenantId,
        subjectId: request.params.userId,
        audience: "onecomputer-control",
      };
      const runtime = runtimePolicyFor(
        current,
        undefined,
        undefined,
        assignedAgentIds(current.document as Record<string, unknown>),
      );
      const agentIds = runtime.agents?.map((agent) => agent.agentId) ?? [runtime.agentId];
      const workspaces = await store.listCurrent(targetIdentity);
      await Promise.all(workspaces.flatMap((workspace) => (
        agentIds.map((agentId) => gateway.revoke(workspace.id, agentId).catch(() => undefined))
      )));
    }
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: { code: "POLICY_ASSIGNMENT_NOT_FOUND", message: "Active policy assignment not found", correlationId: request.id, retryable: false } });
  });
  app.post<{ Body: { revisionNote?: string } }>("/v1/admin/policy/versions", async (request) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const note = z.object({ revisionNote: z.string().min(3).max(160) }).parse(request.body ?? {});
    return security.identityPolicyStore.createMvpPolicyVersion({ tenantId: actor.tenantId, createdBy: actor.userId, revisionNote: note.revisionNote });
  });
  app.get("/v1/admin/egress-security-groups", async (request) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    return { securityGroups: await security.identityPolicyStore.listEgressSecurityGroups(actor.tenantId, actor.userId) };
  });
  app.post("/v1/admin/egress-security-groups", async (request, reply) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
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
      throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Workspace firewall storage is unavailable", 503);
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
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const users = await security.identityPolicyStore.listUsers(actor.tenantId);
    const effective = users.map((user) => user.effectivePolicy).find(Boolean) ?? null;
    const runtime = effective ? runtimePolicyFor(effective) : null;
    return {
      serverName: "onecomputer_ms365",
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
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const input = saveMcpToolPolicySchema.parse(request.body ?? {});
    const expected = Object.keys(m365CapabilityDefinitions).sort();
    if (Object.keys(input.tools).sort().join("\0") !== expected.join("\0")) throw new OneComputerError("INVALID_TOOL_POLICY", "A decision is required for every assigned Microsoft 365 tool", 400);
    const savedPolicy = await security.identityPolicyStore.updateMvpToolPolicy({ tenantId: actor.tenantId, updatedBy: actor.userId, tools: input.tools });
    const users = await security.identityPolicyStore.listUsers(actor.tenantId);
    const refreshes = await Promise.allSettled(users.map(async (user) => {
      if (!user.effectivePolicy) return false;
      const userIdentity = identityContextSchema.parse({
        tenantId: actor.tenantId,
        subjectId: user.userId,
        audience: "onecomputer-control",
      });
      const settings = await store.getSandboxSettings?.(userIdentity, "personal");
      const document = user.effectivePolicy.document as Record<string, unknown>;
      const availableAgentIds = assignedAgentIds(document);
      return service.refreshPolicyGrant(
        userIdentity,
        runtimePolicyFor(
          user.effectivePolicy,
          settings?.modelAlias,
          settings?.profileId,
          settings?.agentIds ?? defaultAgentIds(document, availableAgentIds),
          settings?.applicationIds ?? defaultApplicationIds(document),
        ),
      );
    }));
    return {
      ...savedPolicy,
      workspaceGrants: {
        refreshed: refreshes.filter((result) => result.status === "fulfilled" && result.value).length,
        failed: refreshes.filter((result) => result.status === "rejected").length,
      },
    };
  });
  app.get("/v1/connections", async (request) => {
    const actor = principal(request);
    return requireConnections().list(actor.identity, isAdministrator(actor));
  });
  app.get("/v1/admin/connectors", async (request) => {
    const actor = requireAdministrator(request);
    return requireConnections().adminList(actor.identity);
  });
  app.post("/v1/admin/connectors/discover", async (request) => {
    requireAdministrator(request);
    return requireConnections().discoverConnector(createConnectorSchema.parse(request.body ?? {}));
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
    const input = saveMcpToolPolicySchema.parse(request.body ?? {});
    const saved = await requireConnections().saveConnectorToolPolicy(actor.identity, request.params.connectorId, input.tools);
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
  app.get<{ Params: { connectorId: string } }>("/v1/connections/:connectorId", async (request) => (
    requireConnections().status(identity(request), request.params.connectorId)
  ));
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
      const reason = error instanceof OneComputerError ? error.code : "MCP_CONNECTION_FAILED";
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
  app.post("/v1/credentials/telegram", async (request, reply) => {
    await requirePolicy(request);
    const input = saveTelegramCredentialSchema.parse(request.body ?? {});
    return reply.code(201).send(await requireChannelBroker().saveCredential(identity(request), input));
  });
  app.put<{ Params: { credentialId: string } }>("/v1/credentials/:credentialId/telegram", async (request) => {
    await requirePolicy(request);
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
      throw new OneComputerError("CHAT_AGENT_NOT_SELECTED", "The default messaging agent is not selected for this workspace", 409);
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
    const availableModels = sandboxModels.filter((model) => assignedModels.includes(model.alias));
    const availableAgents = ownedAgentCatalog.filter((agent) => availableAgentIds.includes(agent.id));
    if (!availableProfiles.length || !availableModels.length || !availableAgents.length) throw new OneComputerError("POLICY_INVALID", "The active policy has no supported sandbox profile, model route, or agent", 500);
    if (!availableApplications.length) throw new OneComputerError("POLICY_INVALID", "The active policy has no supported sandbox applications", 500);
    const saved = await store.getSandboxSettings?.(actor.identity, grantId);
    const profileId = saved && availableProfiles.some((profile) => profile.id === saved.profileId) ? saved.profileId : availableProfiles[0]!.id;
    const applicationIds = saved?.applicationIds?.filter((id) => availableApplications.some((application) => application.id === id));
    const modelAlias = saved && availableModels.some((model) => model.alias === saved.modelAlias) ? saved.modelAlias : availableModels[0]!.alias;
    const agentIds = saved?.agentIds?.filter((id) => availableAgents.some((agent) => agent.id === id));
    const selectedApplicationIds = applicationIds?.length ? applicationIds : defaultApplicationIds(document, assignedApplications);
    const selectedAgentIds = agentIds?.length ? agentIds : defaultAgentIds(document, availableAgentIds);
    const workspaceEgress = await workspaceEgressFor(actor, effective, grantId);
    const runtime = effective
      ? runtimePolicyFor(effective, modelAlias, profileId, selectedAgentIds, selectedApplicationIds, workspaceEgress)
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
      profile: availableProfiles.find((profile) => profile.id === profileId),
      availableProfiles,
      availableApplications,
      availableModels,
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
    if (!store.saveSandboxSettings) throw new OneComputerError("SANDBOX_SETTINGS_NOT_CONFIGURED", "Sandbox settings storage is unavailable", 503, true);
    const document = (effective?.document ?? {}) as Record<string, unknown>;
    const profiles = Array.isArray(document.workspaceProfiles) ? document.workspaceProfiles : [document.workspaceProfile ?? testRuntimePolicy.workspaceProfile];
    const applications = assignedApplicationIds(document);
    const models = Array.isArray(document.modelAliases) ? document.modelAliases : [testRuntimePolicy.modelAlias];
    const agents = Array.isArray(document.agents) ? document.agents : ownedAgentCatalog.map((agent) => agent.id);
    if (!profiles.includes(input.profileId)) throw new OneComputerError("PROFILE_NOT_ASSIGNED", "That sandbox profile is not assigned by your organization", 403);
    if (input.applicationIds.some((id) => !applications.includes(id))) throw new OneComputerError("APPLICATION_NOT_ASSIGNED", "That sandbox application is not assigned by your organization", 403);
    if (!models.includes(input.modelAlias)) throw new OneComputerError("MODEL_NOT_ASSIGNED", "That model route is not assigned by your organization", 403);
    if (input.agentIds.some((id) => !agents.includes(id))) throw new OneComputerError("AGENT_NOT_ASSIGNED", "That workspace agent is not assigned by your organization", 403);
    const current = await store.getCurrent(actor.identity, input.grantId);
    if (current && !["not_created", "stopped", "failed"].includes(current.state)) throw new OneComputerError("WORKSPACE_MUST_BE_STOPPED", "Stop the workspace before changing its profile or model route", 409, true);
    await store.saveSandboxSettings(actor.identity, {
      grantId: input.grantId,
      profileId: input.profileId as SandboxProfileId,
      applicationIds: input.applicationIds,
      modelAlias: input.modelAlias as SandboxModelAlias,
      agentIds: input.agentIds,
    });
    return sandboxSettingsFor(actor, effective, input.grantId, includeAdministratorOptions);
  };
  const administratorTarget = async (actor: SessionPrincipal, userId: string) => {
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const target = (await security.identityPolicyStore.listUsers(actor.tenantId)).find((item) => item.userId === userId);
    if (!target) throw new OneComputerError("USER_NOT_FOUND", "User not found", 404);
    const identity = identityContextSchema.parse({
      tenantId: actor.tenantId,
      subjectId: target.userId,
      audience: "onecomputer-control",
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
      if (!target.effectivePolicy) throw new OneComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
      const grantId = z.string().min(1).max(128).parse(request.query.grantId ?? "personal");
      return sandboxSettingsFor(targetPrincipal, target.effectivePolicy, grantId, true);
    },
  );
  app.put<{ Params: { userId: string } }>("/v1/admin/users/:userId/sandbox-settings", async (request) => {
    const actor = requireAdministrator(request);
    const input = saveSandboxSettingsSchema.parse(request.body ?? {});
    const { target, principal: targetPrincipal } = await administratorTarget(actor, request.params.userId);
    if (!target.effectivePolicy) throw new OneComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    return saveSandboxSettingsFor(targetPrincipal, target.effectivePolicy, input, true);
  });
  app.post<{ Params: { userId: string; grantId: string } }>(
    "/v1/admin/users/:userId/workspaces/:grantId/egress-security-group",
    async (request) => {
      const actor = requireAdministrator(request);
      if (!security.identityPolicyStore?.assignWorkspaceEgressSecurityGroup) {
        throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Workspace firewall storage is unavailable", 503);
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
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return reply.code(201).header("cache-control", "no-store").send(await security.openVtc.createEnrollmentChallenge(identity(request)));
  });
  app.post("/v1/openvtc/approvers", async (request, reply) => {
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    const input = z.object({ challengeId: z.uuid(), document: z.unknown() }).strict().parse(request.body ?? {});
    return reply.code(201).header("cache-control", "no-store").send(await security.openVtc.enroll(identity(request), input.challengeId, input.document));
  });
  app.get<{ Querystring: { approverDid?: string } }>("/v1/openvtc/approvers/current", async (request, reply) => {
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return reply.header("cache-control", "no-store").send(await security.openVtc.status(identity(request), request.query.approverDid));
  });
  app.delete<{ Querystring: { approverDid?: string } }>("/v1/openvtc/approvers/current", async (request, reply) => {
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return await security.openVtc.revoke(identity(request), request.query.approverDid) ? reply.code(204).send() : reply.code(404).send({ error: { code: "OPENVTC_APPROVER_NOT_FOUND", message: "No active browser approver is enrolled", correlationId: request.id, retryable: false } });
  });
  app.get<{ Querystring: { approverDid?: string } }>("/v1/openvtc/approvals/pending", async (request, reply) => {
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    const document = await security.openVtc.inboxForIdentity(identity(request), request.query.approverDid);
    reply.header("cache-control", "no-store");
    return document ? reply.send(document) : reply.code(204).send();
  });
  app.get("/v1/openvtc/companion/config", async (request, reply) => {
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
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
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return reply.header("cache-control", "no-store").send(await security.openVtc.companions(identity(request)));
  });
  app.put("/v1/openvtc/companions/subscription", async (request, reply) => {
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
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
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return await security.openVtc.revokeCompanion(identity(request), request.params.companionId)
      ? reply.code(204).send()
      : reply.code(404).send({ error: { code: "OPENVTC_COMPANION_NOT_FOUND", message: "Companion browser not found", correlationId: request.id, retryable: false } });
  });
  app.post<{ Params: { companionId: string } }>("/v1/openvtc/companions/:companionId/test", async (request, reply) => {
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    return reply.header("cache-control", "no-store").send(await security.openVtc.testCompanion(identity(request), request.params.companionId));
  });
  app.get("/v1/openvtc/inbox", async (request, reply) => {
    if (!security.openVtc) throw new OneComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
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
    const workspace = await service.create(identity(request), policy, input.grantId, idempotency(request.headers), request.id);
    return reply.code(201).send(workspace);
  });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/open", async (request) => { const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId); return service.open(identity(request), policy, request.params.workspaceId); });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/restart", async (request) => { const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId); return service.restart(identity(request), policy, request.params.workspaceId, request.id); });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/stop", async (request) => { const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId); return service.stop(identity(request), policy, request.params.workspaceId); });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/gateway/test", async (request) => { const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId); return service.testGateway(identity(request), policy, request.params.workspaceId); });
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
        if (!(error instanceof OneComputerError) || error.code !== "CHAT_RUNTIME_UNAVAILABLE") throw error;
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
      if (!(error instanceof OneComputerError)) throw error;
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
          if (error instanceof OneComputerError && error.code === "OPERATION_NOT_FOUND") return undefined;
          throw error;
        }
      },
    );
    return reply.header("cache-control", "no-store").send({ messages });
  });
  app.post<{ Params: { workspaceId: string; catalogId: string; sessionId: string } }>(
    "/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/messages",
    { bodyLimit: 24 * 1024 * 1024 },
    async (request, reply) => {
    idempotency(request.headers);
    const catalogId = chatAgentCatalogIdSchema.parse(request.params.catalogId);
    const sessionId = chatSessionIdSchema.parse(request.params.sessionId);
    const input = sendChatTurnSchema.parse(request.body ?? {});
    if (input.message.metadata.agentCatalogId !== catalogId) {
      throw new OneComputerError("CHAT_AGENT_MISMATCH", "The submitted message does not belong to the selected agent", 409);
    }
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const includesImage = input.message.parts.some(
      (part) => part.type === "file" && part.mediaType.startsWith("image/"),
    );
    if (includesImage) {
      if (!gateway) {
        throw new OneComputerError(
          "MODEL_CAPABILITY_UNAVAILABLE",
          "The selected model route's image capability could not be verified",
          503,
          true,
        );
      }
      const capabilities = await gateway.modelCapabilities(policy.modelAlias);
      if (!capabilities.vision) {
        throw new OneComputerError(
          "MODEL_IMAGE_INPUT_UNSUPPORTED",
          "The selected workspace model does not support image input. Choose a vision-capable model or remove the image.",
          422,
        );
      }
    }
    const owner = identity(request);
    const access = await service.agentChatAccess(owner, policy, request.params.workspaceId, catalogId);
    const abort = new AbortController();
    request.raw.once("aborted", () => abort.abort("browser-disconnected"));
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) abort.abort("browser-disconnected");
    });
    const mapper = new AgentUiStreamMapper(catalogId);
    const stream = createUIMessageStream<ChatUiMessage>({
      execute: async ({ writer }) => {
        for await (const event of agentChat.streamTurn(access, sessionId, input.message, abort.signal)) {
          let projected = event;
          if (event.type === "approval") {
            try {
              const operation = await operations.get(owner, event.operationId);
              projected = {
                ...event,
                summary: chatApprovalSummary(event.state, operation.safeSummary),
              };
            } catch (error) {
              if (!(error instanceof OneComputerError && error.code === "OPERATION_NOT_FOUND")) throw error;
            }
          }
          for (const chunk of mapper.chunks(projected)) writer.write(chunk);
        }
      },
      onError: (error) => error instanceof OneComputerError
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
    const known = error instanceof OneComputerError ? error : validation ? new OneComputerError("INVALID_REQUEST", "The request is invalid", 400) : new OneComputerError("INTERNAL_ERROR", "The request could not be completed", 500, true);
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
  await store.migrate();
  const connectorRegistryStore = PostgresConnectorRegistryStore.fromConnectionString(env.DATABASE_URL);
  const scheduleStore = PostgresScheduleStore.fromConnectionString(env.DATABASE_URL);
  const identityPolicyStore = PostgresIdentityPolicyStore.fromConnectionString(env.DATABASE_URL);
  await identityPolicyStore.upgradeLegacyWorkspaceProfiles();
  const gatewayValues = [env.LITELLM_ADMIN_URL, env.LITELLM_WORKSPACE_URL, env.LITELLM_MASTER_KEY, env.LITELLM_CREDENTIAL_SECRET];
  if (gatewayValues.some(Boolean) && !gatewayValues.every(Boolean)) throw new Error("All LiteLLM gateway settings must be configured together");
  const gateway = env.LITELLM_ADMIN_URL && env.LITELLM_WORKSPACE_URL && env.LITELLM_MASTER_KEY && env.LITELLM_CREDENTIAL_SECRET
    ? new LiteLLMGatewayAdapter({
        adminUrl: env.LITELLM_ADMIN_URL,
        workspaceUrl: env.LITELLM_WORKSPACE_URL,
        masterKey: env.LITELLM_MASTER_KEY,
        credentialSecret: env.LITELLM_CREDENTIAL_SECRET,
      })
    : undefined;
  const channelBrokerValues = [env.CHANNEL_BROKER_URL, env.CHANNEL_BROKER_INTERNAL_TOKEN];
  if (channelBrokerValues.some(Boolean) && !channelBrokerValues.every(Boolean)) {
    throw new Error("All channel broker settings must be configured together");
  }
  const channelBrokerClient = env.CHANNEL_BROKER_URL && env.CHANNEL_BROKER_INTERNAL_TOKEN
    ? new HttpChannelBrokerManagementClient(env.CHANNEL_BROKER_URL, env.CHANNEL_BROKER_INTERNAL_TOKEN)
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
  const app = createControlServer(
    store,
    new HttpControllerClient(env.CONTROLLER_URL, env.CONTROLLER_INTERNAL_TOKEN),
    env.WEB_PROXY_TOKEN,
    gateway,
    env.FIXTURE_APPROVAL_SECRET,
    { publicWebUrl: env.PUBLIC_WEB_URL, authorizationOrigin: env.M365_AUTHORIZATION_ORIGIN, liteLlmPublicUrl: env.LITELLM_PUBLIC_URL, agentBridgeUrl: env.AGENT_BRIDGE_URL },
    {
      identityPolicyStore,
      connectorRegistryStore,
      mcpPolicyToken: env.CONTROLLER_INTERNAL_TOKEN,
      authentication: new EntraAuthenticationService(identityPolicyStore, {
        tenantId: env.ENTRA_TENANT_ID,
        clientId: env.ENTRA_CLIENT_ID,
        clientSecret: env.ENTRA_CLIENT_SECRET,
        publicWebUrl: env.PUBLIC_WEB_URL,
        sessionSecret: env.SESSION_SECRET,
        bootstrapOwnedTenantId: env.BOOTSTRAP_TENANT_ID,
        bootstrapOwnedUserId: env.BOOTSTRAP_USER_ID,
        tenantDisplayName: env.TENANT_DISPLAY_NAME,
        administratorEmails: env.ADMINISTRATOR_EMAILS.split(",").map((item) => item.trim()).filter(Boolean),
      }),
      openVtc,
      egressGrantSecret: env.EGRESS_GRANT_SECRET,
      policyBundleAuthority,
      agentChatSecret: env.AGENT_CHAT_SECRET,
      channelBrokerClient,
      channelBrokerInternalToken: env.CHANNEL_BROKER_INTERNAL_TOKEN,
      scheduleStore,
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
    await scheduleStore.close();
    await identityPolicyStore.close();
  });
  await app.listen({ host: env.CONTROL_HOST, port: env.CONTROL_PORT });
}
