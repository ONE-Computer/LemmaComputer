import { timingSafeEqual } from "node:crypto";
import Fastify, { LogController } from "fastify";
import { assignEgressSecurityGroupSchema, OneComputerError, createDeleteFileOperationSchema, createHermesChatSessionSchema, createWorkspaceSchema, fixtureApprovalSchema, hermesChatSessionIdSchema, identityContextSchema, mcpPolicyRequestSchema, ownedAgentCatalog, policyVerificationKeySetSchema, saveEgressSecurityGroupSchema, saveMcpToolPolicySchema, sandboxApplicationSchema, sandboxProfileSchema, sandboxSettingsSchema, saveSandboxSettingsSchema, sendHermesChatMessageSchema, type AgentCatalogId, type RuntimePolicy, type SandboxApplicationId, type SandboxModelAlias, type SandboxProfileId } from "@onecomputer/contracts";
import { LiteLLMGatewayAdapter, type GatewayClient, type GovernedToolExecutor, type OAuthConnectionGateway } from "@onecomputer/litellm-adapter";
import { Ed25519DidKeySigner } from "@onecomputer/openvtc-adapter";
import { PolicyBundleSigner } from "@onecomputer/policy-integrity";
import { PostgresIdentityPolicyStore, PostgresWorkspaceStore, runtimePolicyFor, type EffectivePolicy, type GovernanceStore, type IdentityPolicyStore, type SessionPrincipal, type WorkspaceStore } from "@onecomputer/workspace-store";
import { z } from "zod";
import { FixtureApprovalAuthority, GovernedOperationService } from "./operations.js";
import { Microsoft365ConnectionService } from "./connections.js";
import { EgressProxyGrantAuthority, HttpControllerClient, PolicyBundleAuthority, WorkspaceService, type ControllerClient } from "./service.js";
import { EntraAuthenticationService, isAdministrator, testPrincipalFromHeaders } from "./auth.js";
import { McpPolicyService, m365CapabilityDefinitions } from "./mcp-policy.js";
import { OpenVtcApprovalCoordinator } from "./openvtc.js";
import { AgentBridgeAuthority, type AgentBridgeIdentity } from "./agent-bridge.js";
import { COMPANION_PUSH_PROTOCOL, WebPushProvider } from "./web-push.js";
import { HermesApiAuthority, HttpHermesChatClient, type HermesChatClient } from "./hermes-chat.js";

type AuthenticationBoundary = Pick<EntraAuthenticationService, "begin" | "complete" | "authenticate" | "logout">;

const sandboxProfiles = [
  sandboxProfileSchema.parse({
    id: "claude-desktop-standard-v1",
    version: 1,
    displayName: "Claude Desktop",
    description: "A managed Claude Desktop chat workspace routed only through the ONEComputer AI gateway.",
    client: "Claude Desktop",
    clientVersion: "1.22209.3",
    persistence: "persistent-home",
    network: "gateway-only",
    resources: { cpus: 2, memoryGiB: 3 },
  }),
  sandboxProfileSchema.parse({
    id: "kasm-persistent-standard",
    version: 1,
    displayName: "Qualification workspace (legacy)",
    description: "The earlier CLI qualification image retained only for pinned policy compatibility.",
    client: "ONEComputer qualification CLI",
    clientVersion: "issue-006",
    persistence: "persistent-home",
    network: "gateway-only",
    resources: { cpus: 2, memoryGiB: 3 },
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
    : document.agentProfile === "hermes-claw-managed-v1"
      ? ["hermes-claw"] as AgentCatalogId[]
      : ["claude-desktop"] as AgentCatalogId[];
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
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:4174"),
  M365_AUTHORIZATION_ORIGIN: z.string().url().default("http://localhost:4311"),
  AGENT_BRIDGE_URL: z.string().url().default("http://onecomputer-control:4100"),
  FIXTURE_APPROVAL_SECRET: z.string().min(32).default("local-disabled-fixture-approval-secret-32-chars"),
  OPENVTC_EXECUTOR_PRIVATE_KEY_B64: z.string().min(1).optional(),
  WEB_PUSH_VAPID_SUBJECT: optionalEnvString(),
  WEB_PUSH_VAPID_PUBLIC_KEY: optionalEnvString(),
  WEB_PUSH_VAPID_PRIVATE_KEY: optionalEnvString(),
  WEB_PUSH_SUBSCRIPTION_SECRET: optionalEnvString(32),
  ENTRA_TENANT_ID: z.string().min(1),
  ENTRA_CLIENT_ID: z.string().min(1),
  ENTRA_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  EGRESS_GRANT_SECRET: z.string().min(32).optional(),
  HERMES_API_SECRET: z.string().min(32),
  POLICY_SIGNING_KEY_ID: z.string().regex(/^psk_[a-z0-9][a-z0-9_-]{2,63}$/),
  POLICY_SIGNING_PRIVATE_KEY_B64: z.string().min(40),
  POLICY_VERIFICATION_KEYS_B64: z.string().min(32),
  POLICY_BUNDLE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
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
  store: WorkspaceStore & GovernanceStore,
  controller: ControllerClient,
  proxyToken: string,
  gateway?: GatewayClient & Partial<GovernedToolExecutor>,
  fixtureApprovalSecret = "local-test-fixture-approval-secret-32-characters",
  connectionOptions: { publicWebUrl?: string; authorizationOrigin?: string; agentBridgeUrl?: string } = {},
  security: {
    authentication?: AuthenticationBoundary;
    identityPolicyStore?: IdentityPolicyStore;
    mcpPolicyToken?: string;
    testIdentityMode?: boolean;
    openVtc?: OpenVtcApprovalCoordinator;
    egressGrantSecret?: string;
    policyBundleAuthority?: PolicyBundleAuthority;
    hermesApiSecret?: string;
    hermesChatClient?: HermesChatClient;
  } = {},
) {
  const testRuntimePolicy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "test-policy-v1",
    policyVersion: 1,
    policyHash: "0".repeat(64),
    workspaceProfile: "kasm-persistent-standard",
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
      disableRequestLogging: (request) => request.url.startsWith("/v1/connections/microsoft-365/callback") || request.url.startsWith("/v1/auth/callback"),
    }),
    bodyLimit: 32 * 1024,
  });
  const agentBridgeAuthority = new AgentBridgeAuthority(security.mcpPolicyToken ?? proxyToken);
  const hermesApiAuthority = security.hermesApiSecret ? new HermesApiAuthority(security.hermesApiSecret) : undefined;
  const hermesChat = security.hermesChatClient ?? new HttpHermesChatClient();
  const service = new WorkspaceService(store, controller, gateway, {
    baseUrl: connectionOptions.agentBridgeUrl ?? "http://onecomputer-control:4100",
    issue: (identity, workspaceId, policy) => agentBridgeAuthority.issue(identity, workspaceId, policy),
  }, security.egressGrantSecret ? new EgressProxyGrantAuthority(security.egressGrantSecret) : undefined, security.policyBundleAuthority, hermesApiAuthority);
  const executor: GovernedToolExecutor = gateway?.executeGovernedTool
    ? { executeGovernedTool: (input) => gateway.executeGovernedTool!(input) }
    : { executeGovernedTool: async () => { throw new OneComputerError("GATEWAY_NOT_CONFIGURED", "The governed tool gateway is not configured", 503, true); } };
  const operations = new GovernedOperationService(store, executor, new FixtureApprovalAuthority(fixtureApprovalSecret), undefined, security.openVtc);
  const mcpPolicy = security.identityPolicyStore ? new McpPolicyService(security.identityPolicyStore, store, operations) : undefined;
  const oauthGateway = gateway
    && typeof (gateway as Partial<OAuthConnectionGateway>).beginUserOAuthConnection === "function"
    && typeof (gateway as Partial<OAuthConnectionGateway>).completeUserOAuthConnection === "function"
    && typeof (gateway as Partial<OAuthConnectionGateway>).userOAuthConnectionStatus === "function"
    && typeof (gateway as Partial<OAuthConnectionGateway>).disconnectUserOAuthConnection === "function"
    ? gateway as GatewayClient & OAuthConnectionGateway
    : undefined;
  const connections = oauthGateway ? new Microsoft365ConnectionService(oauthGateway, {
    publicWebUrl: connectionOptions.publicWebUrl ?? "http://localhost:4174",
    authorizationOrigin: connectionOptions.authorizationOrigin ?? "http://localhost:4311",
  }) : undefined;
  const requireConnections = () => {
    if (!connections) throw new OneComputerError("M365_CONNECTION_NOT_CONFIGURED", "Microsoft 365 connections are not configured", 503, true);
    return connections;
  };
  if (!security.authentication && !security.testIdentityMode) {
    throw new Error("Control requires Entra authentication; test identity mode must be enabled explicitly in tests");
  }
  const principals = new WeakMap<object, SessionPrincipal>();
  const agentPrincipals = new WeakMap<object, AgentBridgeIdentity>();

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    if (request.url === "/v1/openvtc/inbox" || request.url === "/trust-tasks") return;
    if (request.url.startsWith("/internal/v1/agent/operations/")) {
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
  const policyForGrant = async (value: SessionPrincipal, effective: EffectivePolicy | null, grantId = "personal") => {
    if (!effective) return { principal: value, policy: testRuntimePolicy };
    const saved = await store.getSandboxSettings?.(value.identity, grantId);
    const document = effective.document as Record<string, unknown>;
    const availableAgentIds = assignedAgentIds(document);
    return { principal: value, policy: runtimePolicyFor(
      effective,
      saved?.modelAlias,
      saved?.profileId,
      saved?.agentIds ?? defaultAgentIds(document, availableAgentIds),
      saved?.applicationIds ?? defaultApplicationIds(document),
    ) };
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
  app.post("/internal/v1/mcp/authorize", async (request) => {
    if (!mcpPolicy) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "MCP policy storage is unavailable", 503, true);
    return mcpPolicy.authorize(mcpPolicyRequestSchema.parse(request.body ?? {}), request.id);
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
    return { users: await security.identityPolicyStore.listUsers(actor.tenantId) };
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
    if (revoked && current?.workspaceId && gateway) {
      await Promise.all([
        gateway.revoke(current.workspaceId).catch(() => undefined),
        gateway.revoke(current.workspaceId, current.agentId).catch(() => undefined),
      ]);
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
    return reply.code(201).send(saved);
  });
  app.post<{ Params: { userId: string } }>("/v1/admin/users/:userId/egress-security-group", async (request) => {
    const actor = requireAdministrator(request);
    if (!security.identityPolicyStore) throw new OneComputerError("POLICY_STORE_NOT_CONFIGURED", "Policy storage is unavailable", 503);
    const input = assignEgressSecurityGroupSchema.parse(request.body ?? {});
    const targetIdentity = identityContextSchema.parse({
      tenantId: actor.tenantId,
      subjectId: request.params.userId,
      audience: "onecomputer-control",
    });
    const workspace = await store.getCurrent(targetIdentity, "personal");
    if (workspace && !["not_created", "stopped", "failed"].includes(workspace.state)) {
      throw new OneComputerError("WORKSPACE_MUST_BE_STOPPED", "Stop the workspace before changing its egress firewall", 409, true);
    }
    return security.identityPolicyStore.assignEgressSecurityGroup({
      tenantId: actor.tenantId,
      targetUserId: request.params.userId,
      assignedBy: actor.userId,
      securityGroupVersionId: input.securityGroupVersionId,
    });
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
  app.get("/v1/connections/microsoft-365", async (request) => requireConnections().status(identity(request)));
  app.get("/v1/connections/microsoft-365/authorize", async (request, reply) => {
    const started = await requireConnections().start(identity(request));
    if (started.cookies.length) reply.header("set-cookie", started.cookies);
    return reply.code(302).header("location", started.location).send();
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/v1/connections/microsoft-365/callback", async (request, reply) => {
    const service = requireConnections();
    try {
      await service.complete(identity(request), {
        state: request.query.state,
        code: request.query.code,
        error: request.query.error,
      });
      return reply.code(303).header("location", service.resultUrl("connected")).send();
    } catch (error) {
      const reason = error instanceof OneComputerError ? error.code : "M365_CONNECTION_FAILED";
      return reply.code(303).header("location", service.resultUrl("error", reason)).send();
    }
  });
  app.delete("/v1/connections/microsoft-365", async (request) => requireConnections().disconnect(identity(request)));
  app.get<{ Querystring: { grantId?: string } }>("/v1/sandbox-settings", async (request) => {
    const { principal: actor, effective } = await assignedPolicy(request);
    const grantId = z.string().min(1).max(128).parse(request.query.grantId ?? "personal");
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
    const egress = effective?.egressSecurityGroup
      ? runtimePolicyFor(effective, modelAlias, profileId, selectedAgentIds, selectedApplicationIds).egress
      : undefined;
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
      ...(egress ? { egress } : {}),
      configuration: {
        schemaVersion: 1,
        profileId,
        applicationIds: selectedApplicationIds,
        agentIds: selectedAgentIds,
        modelAlias,
        egress: egress ?? null,
      },
      updatedAt: saved?.updatedAt.toISOString() ?? null,
    });
  });
  app.put("/v1/sandbox-settings", async (request) => {
    if (!store.saveSandboxSettings) throw new OneComputerError("SANDBOX_SETTINGS_NOT_CONFIGURED", "Sandbox settings storage is unavailable", 503, true);
    const input = saveSandboxSettingsSchema.parse(request.body ?? {});
    const { principal: actor, effective } = await assignedPolicy(request);
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
    const profile = sandboxProfiles.find((item) => item.id === input.profileId)!;
    return sandboxSettingsSchema.parse({
      ...input,
      profile,
      availableProfiles: sandboxProfiles.filter((item) => profiles.includes(item.id)),
      availableApplications: sandboxApplications.filter((item) => applications.includes(item.id)),
      availableModels: sandboxModels.filter((item) => models.includes(item.alias)),
      agentIds: input.agentIds,
      availableAgents: ownedAgentCatalog.filter((item) => agents.includes(item.id)),
      ...(effective?.egressSecurityGroup ? { egress: runtimePolicyFor(effective, input.modelAlias, input.profileId, input.agentIds, input.applicationIds).egress } : {}),
      configuration: {
        schemaVersion: 1,
        profileId: input.profileId,
        applicationIds: input.applicationIds,
        agentIds: input.agentIds,
        modelAlias: input.modelAlias,
        egress: effective?.egressSecurityGroup ? runtimePolicyFor(effective, input.modelAlias, input.profileId, input.agentIds, input.applicationIds).egress ?? null : null,
      },
      updatedAt: new Date().toISOString(),
    });
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
    await security.identityPolicyStore?.bindWorkspaceIdentity(actor.userId, workspace.id);
    return reply.code(201).send(workspace);
  });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/open", async (request) => { const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId); return service.open(identity(request), policy, request.params.workspaceId); });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/restart", async (request) => { const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId); return service.restart(identity(request), policy, request.params.workspaceId, request.id); });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/stop", async (request) => { const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId); return service.stop(identity(request), policy, request.params.workspaceId); });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/gateway/test", async (request) => { const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId); return service.testGateway(identity(request), policy, request.params.workspaceId); });
  app.get<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/chat/status", async (request, reply) => {
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    try {
      const access = await service.hermesChatAccess(identity(request), policy, request.params.workspaceId);
      await hermesChat.health(access);
      return reply.header("cache-control", "no-store").send({
        workspaceId: request.params.workspaceId,
        state: "ready",
        reasonCode: "HERMES_CHAT_READY",
      });
    } catch (error) {
      if (!(error instanceof OneComputerError)) throw error;
      if (error.code === "HERMES_NOT_SELECTED") {
        return reply.header("cache-control", "no-store").send({
          workspaceId: request.params.workspaceId,
          state: "unavailable",
          reasonCode: error.code,
        });
      }
      if (error.code === "WORKSPACE_NOT_READY" || error.code === "HERMES_UNAVAILABLE") {
        return reply.header("cache-control", "no-store").send({
          workspaceId: request.params.workspaceId,
          state: "offline",
          reasonCode: error.code,
        });
      }
      throw error;
    }
  });
  app.get<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/chat/sessions", async (request, reply) => {
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const access = await service.hermesChatAccess(identity(request), policy, request.params.workspaceId);
    return reply.header("cache-control", "no-store").send({ sessions: await hermesChat.listSessions(access) });
  });
  app.post<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId/chat/sessions", async (request, reply) => {
    const input = createHermesChatSessionSchema.parse(request.body ?? {});
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const access = await service.hermesChatAccess(identity(request), policy, request.params.workspaceId);
    return reply.code(201).header("cache-control", "no-store").send(await hermesChat.createSession(access, input.title));
  });
  app.get<{ Params: { workspaceId: string; sessionId: string } }>("/v1/workspaces/:workspaceId/chat/sessions/:sessionId/messages", async (request, reply) => {
    const sessionId = hermesChatSessionIdSchema.parse(request.params.sessionId);
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const access = await service.hermesChatAccess(identity(request), policy, request.params.workspaceId);
    return reply.header("cache-control", "no-store").send({ messages: await hermesChat.listMessages(access, sessionId) });
  });
  app.post<{ Params: { workspaceId: string; sessionId: string } }>("/v1/workspaces/:workspaceId/chat/sessions/:sessionId/messages", async (request, reply) => {
    const sessionId = hermesChatSessionIdSchema.parse(request.params.sessionId);
    const input = sendHermesChatMessageSchema.parse(request.body ?? {});
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    const access = await service.hermesChatAccess(identity(request), policy, request.params.workspaceId);
    return reply.header("cache-control", "no-store").send({ message: await hermesChat.sendMessage(access, sessionId, input.message) });
  });
  app.delete<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId", async (request, reply) => {
    const { policy } = await requireWorkspacePolicy(request, request.params.workspaceId);
    await service.delete(identity(request), policy, request.params.workspaceId);
    return reply.code(204).send();
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
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const env = envSchema.parse(process.env);
  const store = PostgresWorkspaceStore.fromConnectionString(env.DATABASE_URL);
  await store.migrate();
  const identityPolicyStore = PostgresIdentityPolicyStore.fromConnectionString(env.DATABASE_URL);
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
  const openVtc = env.OPENVTC_EXECUTOR_PRIVATE_KEY_B64
    ? new OpenVtcApprovalCoordinator(store, Ed25519DidKeySigner.fromPkcs8Base64(env.OPENVTC_EXECUTOR_PRIVATE_KEY_B64), pushProvider)
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
  const app = createControlServer(
    store,
    new HttpControllerClient(env.CONTROLLER_URL, env.CONTROLLER_INTERNAL_TOKEN),
    env.WEB_PROXY_TOKEN,
    gateway,
    env.FIXTURE_APPROVAL_SECRET,
    { publicWebUrl: env.PUBLIC_WEB_URL, authorizationOrigin: env.M365_AUTHORIZATION_ORIGIN, agentBridgeUrl: env.AGENT_BRIDGE_URL },
    {
      identityPolicyStore,
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
      hermesApiSecret: env.HERMES_API_SECRET,
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
    await identityPolicyStore.close();
  });
  await app.listen({ host: env.CONTROL_HOST, port: env.CONTROL_PORT });
}
