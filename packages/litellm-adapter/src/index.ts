import { createHash, createHmac } from "node:crypto";
import { OneComputerError, type IdentityContext, type OwnedJson, type RuntimePolicy } from "@onecomputer/contracts";

export type GatewayGrant = {
  baseUrl: string;
  credential: string;
  modelAlias: string;
  expiresAt: string;
};

export type GatewayReadiness = {
  models: "ready" | "failed";
  tools: "ready" | "failed";
  modelRoute?: GatewayModelRoute;
};

export type GatewayModelCapabilities = {
  vision: boolean;
};

export type GatewayModelRoute = {
  alias: string;
  status: "ready" | "failed";
  fallback: "none";
  capabilities: GatewayModelCapabilities;
  budget: {
    limitUsd: number;
    spentUsd: number;
    remainingUsd: number;
    duration: "30d";
    resetsAt: string | null;
  };
  limits: {
    requestsPerMinute: number;
    tokensPerMinute: number;
    maxParallelRequests: number;
  };
};

export type GatewayTestResult = {
  model: string;
  availability: "ready";
  modelRoute: GatewayModelRoute;
  tools: Array<{ name: string; description: string }>;
  apiBaseUrl: string;
  mcpUrl: string;
};

export interface GatewayClient {
  ensureGrant(input: { workspaceId: string; identity: IdentityContext; agentId?: string; policy?: RuntimePolicy }): Promise<GatewayGrant>;
  modelCapabilities(modelAlias: string): Promise<GatewayModelCapabilities>;
  readiness(workspaceId: string, agentId?: string, policy?: RuntimePolicy): Promise<GatewayReadiness>;
  test(workspaceId: string, agentId?: string, policy?: RuntimePolicy): Promise<GatewayTestResult>;
  revoke(workspaceId: string, agentId?: string): Promise<void>;
}

export type OAuthConnectionStatus = {
  state: "disconnected" | "connected" | "expired";
  connectedAt: string | null;
  expiresAt: string | null;
  account: {
    displayName: string | null;
    email: string | null;
    userPrincipalName: string | null;
  } | null;
};

export interface OAuthConnectionGateway {
  beginUserOAuthConnection(input: {
    identity: IdentityContext;
    serverName: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    authorizationOrigins?: string[];
    authorizationOrigin?: string;
  }): Promise<{ location: string; cookies: string[] }>;
  completeUserOAuthConnection(input: {
    identity: IdentityContext;
    serverName: string;
    code: string;
    codeVerifier: string;
  }): Promise<OAuthConnectionStatus>;
  userOAuthConnectionStatus(identity: IdentityContext, serverName: string): Promise<OAuthConnectionStatus>;
  disconnectUserOAuthConnection(identity: IdentityContext, serverName: string): Promise<OAuthConnectionStatus>;
  userOAuthConnectionTools(identity: IdentityContext, serverName: string): Promise<string[]>;
}

export type McpConnectorRegistrationInput = {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  url: string;
  scopes: string[];
  clientId?: string;
  clientSecret?: string;
};

export interface McpConnectorAdministrationGateway {
  discoverOAuthMcpServer(input: Omit<McpConnectorRegistrationInput, "serverId" | "serverName"> & { callbackUrl: string }): Promise<{
    authorizationOrigin: string;
    dynamicClientRegistration: boolean;
  }>;
  ensureOAuthMcpServers(inputs: McpConnectorRegistrationInput[]): Promise<void>;
  registerOAuthMcpServer(input: McpConnectorRegistrationInput): Promise<void>;
  removeMcpServer(serverId: string): Promise<void>;
}

export type GovernedToolExecutionInput = {
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  operationId: string;
  operationDigest: string;
  leaseId: string;
  agentId?: string;
  serverName: string;
  toolName: string;
  arguments: OwnedJson;
};

export type GovernedToolExecutionResult = {
  upstreamReference: string;
  resultSummary: string;
  result: OwnedJson;
};

export interface GovernedToolExecutor {
  executeGovernedTool(input: GovernedToolExecutionInput): Promise<GovernedToolExecutionResult>;
}

type LiteLLMConfig = {
  adminUrl: string;
  workspaceUrl: string;
  masterKey: string;
  credentialSecret: string;
  modelAlias?: string;
  mcpServer?: string;
  allowedTools?: string[];
  requestTimeoutMs?: number;
  workspaceGrantTtlMs?: number;
  workspaceGrantRenewalMs?: number;
  connectionGrantTtlMs?: number;
};

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};
const WORKSPACE_MAX_BUDGET_USD = 1;
const WORKSPACE_BUDGET_DURATION = "30d" as const;
const WORKSPACE_RPM_LIMIT = 30;
// Claude Desktop can submit a large managed-system prompt before the user's
// first message. Keep the workspace budget authoritative, but do not mistake
// that initial context for abusive request volume.
const WORKSPACE_TPM_LIMIT = 500_000;
// Claude Desktop overlaps its streaming model request, managed MCP calls, and
// short-lived background work. A limit of four caused healthy agent sessions
// to deadlock into LiteLLM's retry loop. Keep the 30 RPM and budget controls,
// while allowing that burst to complete.
const WORKSPACE_MAX_PARALLEL_REQUESTS = 30;

const desktopTransportAliases: Record<string, string> = {
  "onecomputer-claude": "claude-sonnet-4-6",
  "onecomputer-openai": "claude-opus-4-6",
  "onecomputer-glm": "claude-sonnet-4-5",
};

const desktopModelAlias = (modelAlias: string, policy?: RuntimePolicy) => {
  if (!["claude-desktop-managed-v1", "claude-cli-managed-v1"].includes(policy?.agentProfile ?? "")) return modelAlias;
  const transportAlias = desktopTransportAliases[modelAlias];
  if (!transportAlias) throw new OneComputerError("DESKTOP_MODEL_ROUTE_INVALID", "The selected model has no Claude Desktop transport route", 500);
  return transportAlias;
};

export class LiteLLMGatewayAdapter implements GatewayClient, GovernedToolExecutor, OAuthConnectionGateway, McpConnectorAdministrationGateway {
  private readonly adminUrl: string;
  private readonly workspaceUrl: string;
  private readonly modelAlias: string;
  private readonly mcpServer: string;
  private readonly allowedTools: string[];
  private readonly timeoutMs: number;
  private readonly workspaceGrantTtlMs: number;
  private readonly workspaceGrantRenewalMs: number;
  private readonly connectionGrantTtlMs: number;
  private readonly workspaceGrantStates = new Map<string, { expiresAt: number; projection: string }>();
  private readonly modelCapabilityStates = new Map<string, { expiresAt: number; capabilities: GatewayModelCapabilities }>();
  private readonly oauthClientRegistrationStates = new Map<string, Promise<string>>();

  constructor(private readonly config: LiteLLMConfig) {
    this.adminUrl = config.adminUrl.replace(/\/$/, "");
    this.workspaceUrl = config.workspaceUrl.replace(/\/$/, "");
    this.modelAlias = config.modelAlias ?? "onecomputer-assistant";
    this.mcpServer = config.mcpServer ?? "onecomputer_fixture";
    this.allowedTools = config.allowedTools ?? ["search_files"];
    this.timeoutMs = config.requestTimeoutMs ?? 15_000;
    this.workspaceGrantTtlMs = config.workspaceGrantTtlMs ?? 8 * 60 * 60 * 1000;
    this.workspaceGrantRenewalMs = config.workspaceGrantRenewalMs ?? 60 * 60 * 1000;
    this.connectionGrantTtlMs = config.connectionGrantTtlMs ?? 15 * 60 * 1000;
  }

  userIdFor(identity: IdentityContext) {
    const digest = createHash("sha256")
      .update(`onecomputer:litellm:user:${identity.tenantId}:${identity.subjectId}`)
      .digest("base64url");
    return `oc-user-${digest}`;
  }

  agentIdFor(workspaceId: string, agentId?: string) {
    const digest = createHash("sha256")
      .update(`onecomputer:litellm:agent:${workspaceId}:${agentId ?? "default"}`)
      .digest("base64url");
    return `oc-agent-${digest}`;
  }

  credentialFor(workspaceId: string, agentId?: string) {
    const digest = createHmac("sha256", this.config.credentialSecret)
      .update(agentId
        ? `onecomputer:litellm:workspace:${workspaceId}:agent:${agentId}`
        : `onecomputer:litellm:workspace:${workspaceId}`)
      .digest("base64url");
    return `sk-ocw-${digest}`;
  }

  connectionCredentialFor(identity: IdentityContext, serverName: string) {
    const digest = createHmac("sha256", this.config.credentialSecret)
      .update(`onecomputer:litellm:connection:${identity.tenantId}:${identity.subjectId}:${serverName}`)
      .digest("base64url");
    return `sk-occ-${digest}`;
  }

  async beginUserOAuthConnection(input: {
    identity: IdentityContext;
    serverName: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    authorizationOrigins?: string[];
    authorizationOrigin?: string;
  }) {
    const grant = await this.ensureConnectionGrant(input.identity, input.serverName);
    const query = new URLSearchParams({
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
    });
    const authorize = async () => {
      try {
        return await fetch(`${this.adminUrl}/v1/mcp/server/oauth/${encodeURIComponent(grant.serverId)}/authorize?${query}`, {
          method: "GET",
          headers: { authorization: `Bearer ${grant.credential}` },
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new OneComputerError("GATEWAY_UNAVAILABLE", "The MCP connection service is unavailable", 503, true);
      }
    };
    let response = await authorize();
    if (await this.missingOAuthClient(response)) {
      await response.body?.cancel().catch(() => undefined);
      await this.registerDynamicOAuthClient(grant.serverId);
      response = await authorize();
    }
    if (response.status < 300 || response.status >= 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new OneComputerError("MCP_AUTHORIZATION_REJECTED", "Connector authorization could not be started", 502, true);
    }
    const location = response.headers.get("location");
    if (!location) throw new OneComputerError("MCP_AUTHORIZATION_INVALID", "The connector authorization response was invalid", 502, true);
    let authorizationUrl: URL;
    let expectedOrigins: string[];
    try {
      authorizationUrl = new URL(location);
      const configuredOrigins = input.authorizationOrigins
        ?? (input.authorizationOrigin ? [input.authorizationOrigin] : []);
      expectedOrigins = configuredOrigins.map((origin) => new URL(origin).origin);
    } catch {
      throw new OneComputerError("MCP_AUTHORIZATION_INVALID", "The connector authorization response was invalid", 502, true);
    }
    if (!expectedOrigins.includes(authorizationUrl.origin)) {
      throw new OneComputerError("MCP_AUTHORIZATION_ORIGIN_MISMATCH", "The connector authorization origin was not approved", 502);
    }
    const cookieHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    const cookies = cookieHeaders.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
    return { location: authorizationUrl.toString(), cookies };
  }

  private async missingOAuthClient(response: Response) {
    if (response.status !== 400) return false;
    const payload = asObject(await response.clone().json().catch(() => ({})));
    return asObject(payload.detail).error === "missing_client_id";
  }

  private async registerDynamicOAuthClient(serverId: string) {
    const pending = this.oauthClientRegistrationStates.get(serverId);
    if (pending) return pending;
    const registration = (async () => {
      const result = await this.adminCall(`/v1/mcp/server/oauth/${encodeURIComponent(serverId)}/register`, {
        method: "POST",
        body: {
          client_name: "ONEComputer",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      }, true);
      if (!result.ok) throw this.upstreamError("MCP_OAUTH_REGISTRATION_FAILED", result.status, result.payload);
      const registrationPayload = asObject(result.payload);
      const clientId = registrationPayload.client_id;
      if (typeof clientId !== "string" || !clientId) {
        throw new OneComputerError("MCP_OAUTH_REGISTRATION_FAILED", "The connector did not register an OAuth client", 502, true);
      }
      if (clientId === serverId && registrationPayload.client_secret === "dummy") {
        throw new OneComputerError(
          "MCP_OAUTH_CLIENT_REQUIRED",
          "This connector requires provider app credentials",
          400,
        );
      }
      return clientId;
    })();
    this.oauthClientRegistrationStates.set(serverId, registration);
    try {
      return await registration;
    } finally {
      if (this.oauthClientRegistrationStates.get(serverId) === registration) {
        this.oauthClientRegistrationStates.delete(serverId);
      }
    }
  }

  async completeUserOAuthConnection(input: {
    identity: IdentityContext;
    serverName: string;
    code: string;
    codeVerifier: string;
  }): Promise<OAuthConnectionStatus> {
    const grant = await this.ensureConnectionGrant(input.identity, input.serverName);
    try {
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.codeVerifier,
      });
      let response: Response;
      try {
        response = await fetch(`${this.adminUrl}/v1/mcp/server/oauth/${encodeURIComponent(grant.serverId)}/token`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${grant.credential}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new OneComputerError("GATEWAY_UNAVAILABLE", "The MCP connection service is unavailable", 503, true);
      }
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        throw new OneComputerError("MCP_TOKEN_EXCHANGE_FAILED", "The connector did not complete the connection", 502, true);
      }
      return await this.readConnectionStatus(grant.credential, grant.serverId, input.serverName);
    } finally {
      await this.deleteConnectionGrant(grant.credential).catch(() => undefined);
    }
  }

  async userOAuthConnectionStatus(identity: IdentityContext, serverName: string): Promise<OAuthConnectionStatus> {
    const grant = await this.ensureConnectionGrant(identity, serverName);
    try {
      return await this.readConnectionStatus(grant.credential, grant.serverId, serverName);
    } finally {
      await this.deleteConnectionGrant(grant.credential).catch(() => undefined);
    }
  }

  async disconnectUserOAuthConnection(identity: IdentityContext, serverName: string): Promise<OAuthConnectionStatus> {
    const grant = await this.ensureConnectionGrant(identity, serverName);
    try {
      const result = await this.dataCall(`/v1/mcp/server/${encodeURIComponent(grant.serverId)}/oauth-user-credential`, grant.credential, { method: "DELETE" });
      if (!result.ok && result.status !== 404) throw this.upstreamError("MCP_DISCONNECT_FAILED", result.status, result.payload);
      return { state: "disconnected", connectedAt: null, expiresAt: null, account: null };
    } finally {
      await this.deleteConnectionGrant(grant.credential).catch(() => undefined);
    }
  }

  async userOAuthConnectionTools(identity: IdentityContext, serverName: string) {
    const grant = await this.ensureConnectionGrant(identity, serverName);
    try {
      const status = await this.readConnectionStatus(grant.credential, grant.serverId, serverName);
      if (status.state !== "connected") return [];
      const result = await this.dataCall("/mcp-rest/tools/list", grant.credential);
      if (!result.ok) throw this.upstreamError("MCP_TOOL_DISCOVERY_FAILED", result.status, result.payload);
      const tools = Array.isArray(asObject(result.payload).tools) ? asObject(result.payload).tools as unknown[] : [];
      return [...new Set(tools.map(asObject)
        .filter((tool) => {
          const info = asObject(tool.mcp_info);
          return !info.server_id || info.server_id === grant.serverId;
        })
        .map((tool) => typeof tool.name === "string" ? tool.name : "")
        .filter(Boolean))].sort();
    } finally {
      await this.deleteConnectionGrant(grant.credential).catch(() => undefined);
    }
  }

  async discoverOAuthMcpServer(input: Omit<McpConnectorRegistrationInput, "serverId" | "serverName"> & { callbackUrl: string }) {
    const temporaryId = `onecomputer-discovery-${createHash("sha256").update(`${input.url}:${Date.now()}`).digest("hex").slice(0, 20)}`;
    const payload = this.mcpRegistrationPayload({
      ...input,
      serverId: temporaryId,
      serverName: temporaryId,
    });
    const created = await this.adminCall("/v1/mcp/server/oauth/session", { method: "POST", body: payload }, true);
    if (!created.ok) throw this.upstreamError("MCP_DISCOVERY_FAILED", created.status, created.payload);
    const dynamicClientId = input.clientId ? undefined : await this.registerDynamicOAuthClient(temporaryId);
    const query = new URLSearchParams({
      redirect_uri: input.callbackUrl,
      state: "onecomputer-discovery",
      code_challenge: createHash("sha256").update(temporaryId).digest("base64url"),
      code_challenge_method: "S256",
      response_type: "code",
    });
    if (dynamicClientId) query.set("client_id", dynamicClientId);
    let response: Response;
    try {
      response = await fetch(`${this.adminUrl}/v1/mcp/server/oauth/${encodeURIComponent(temporaryId)}/authorize?${query}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.masterKey}` },
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OneComputerError("MCP_DISCOVERY_FAILED", "The connector could not be reached", 502, true);
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 300 || response.status >= 400 || !location) {
      throw new OneComputerError("MCP_DISCOVERY_FAILED", "The connector did not expose a compatible OAuth flow", 400);
    }
    let authorizationUrl: URL;
    try {
      authorizationUrl = new URL(location);
    } catch {
      throw new OneComputerError("MCP_DISCOVERY_FAILED", "The connector returned an invalid authorization address", 400);
    }
    return {
      authorizationOrigin: authorizationUrl.origin,
      dynamicClientRegistration: !input.clientId,
    };
  }

  async registerOAuthMcpServer(input: McpConnectorRegistrationInput) {
    const result = await this.adminCall("/v1/mcp/server", {
      method: "POST",
      body: this.mcpRegistrationPayload(input),
    }, true);
    if (!result.ok) throw this.upstreamError("MCP_REGISTRATION_FAILED", result.status, result.payload);
  }

  async ensureOAuthMcpServers(inputs: McpConnectorRegistrationInput[]) {
    const listed = await this.adminCall("/v1/mcp/server", { method: "GET" });
    const servers = Array.isArray(listed.payload) ? listed.payload.map(asObject) : [];
    for (const input of inputs) {
      const exact = servers.find((server) => server.server_id === input.serverId);
      if (exact) {
        if (exact.server_name !== input.serverName || exact.url !== input.url) {
          throw new OneComputerError("MCP_REGISTRATION_CONFLICT", `The ${input.name} connector registration does not match the approved catalog`, 409);
        }
        continue;
      }
      const nameConflict = servers.find((server) => server.server_name === input.serverName);
      if (nameConflict) {
        throw new OneComputerError("MCP_REGISTRATION_CONFLICT", `The ${input.name} connector name is already registered`, 409);
      }
      await this.registerOAuthMcpServer(input);
      servers.push({
        server_id: input.serverId,
        server_name: input.serverName,
        url: input.url,
      });
    }
  }

  async removeMcpServer(serverId: string) {
    const result = await this.adminCall(`/v1/mcp/server/${encodeURIComponent(serverId)}`, { method: "DELETE" }, true);
    if (!result.ok && result.status !== 404) throw this.upstreamError("MCP_REMOVAL_FAILED", result.status, result.payload);
  }

  private mcpRegistrationPayload(input: McpConnectorRegistrationInput): JsonObject {
    return {
      server_id: input.serverId,
      server_name: input.serverName,
      alias: input.serverName,
      description: input.description,
      transport: "http",
      auth_type: "oauth2",
      oauth2_flow: "authorization_code",
      url: input.url,
      credentials: {
        ...(input.clientId ? { client_id: input.clientId } : {}),
        ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
        scopes: input.scopes,
      },
      allow_all_keys: false,
      available_on_public_internet: true,
      delegate_auth_to_upstream: false,
    };
  }

  private async resolveMcpServer(serverName: string) {
    const result = await this.adminCall("/v1/mcp/server", { method: "GET" });
    const servers = Array.isArray(result.payload) ? result.payload : [];
    const server = servers.map(asObject).find((item) => item.server_name === serverName);
    const serverId = server?.server_id;
    if (typeof serverId !== "string" || !serverId) {
      throw new OneComputerError("MCP_CONNECTION_NOT_REGISTERED", "The connector is not registered in LiteLLM", 503, true);
    }
    return serverId;
  }

  private async ensureConnectionGrant(identity: IdentityContext, serverName: string) {
    const serverId = await this.resolveMcpServer(serverName);
    const credential = this.connectionCredentialFor(identity, serverName);
    const userId = this.userIdFor(identity);
    const serverDigest = createHash("sha256").update(serverName).digest("base64url").slice(0, 12);
    const keyAlias = `onecomputer-connection-${userId}-${serverDigest}`;
    const credentialRoute = `/v1/mcp/server/${serverId}/oauth-user-credential`;
    const accountLookup = serverName === "onecomputer_ms365";
    const allowedRoutes = [
      `/v1/mcp/server/oauth/${serverId}/authorize`,
      `/v1/mcp/server/oauth/${serverId}/token`,
      credentialRoute,
      `${credentialRoute}/status`,
      "/mcp-rest/tools/list",
      ...(accountLookup ? ["/mcp-rest/tools/call"] : []),
    ];
    const durationSeconds = Math.max(60, Math.ceil(this.connectionGrantTtlMs / 1_000));
    const grant = {
      key: credential,
      key_alias: keyAlias,
      key_type: "default",
      user_id: userId,
      duration: `${durationSeconds}s`,
      models: [],
      max_budget: 0.01,
      rpm_limit: 12,
      allowed_routes: allowedRoutes,
      metadata: {
        onecomputer_tenant_id: identity.tenantId,
        onecomputer_subject_id: identity.subjectId,
        onecomputer_gateway_user_id: userId,
        onecomputer_connection_credential: true,
        onecomputer_connection_server: serverName,
        onecomputer_connection_account_lookup: accountLookup,
      },
      object_permission: {
        mcp_servers: [serverName],
        mcp_tool_permissions: { [serverName]: accountLookup ? ["get-current-user"] : [] },
      },
    };
    const generated = await this.adminCall("/key/generate", { method: "POST", body: grant }, true);
    if (!generated.ok) {
      const existing = await this.adminCall(`/key/list?return_full_object=true&key_alias=${encodeURIComponent(keyAlias)}`, { method: "GET" }, true);
      const keys = Array.isArray(asObject(existing.payload).keys) ? asObject(existing.payload).keys as unknown[] : [];
      const tokenHash = createHash("sha256").update(credential).digest("hex");
      const current = keys.map(asObject).find((key) => key.token === tokenHash);
      const metadata = asObject(current?.metadata);
      const identityMatches = current?.user_id === userId
        && metadata.onecomputer_tenant_id === identity.tenantId
        && metadata.onecomputer_subject_id === identity.subjectId
        && metadata.onecomputer_connection_credential === true
        && metadata.onecomputer_connection_server === serverName
        && metadata.onecomputer_connection_account_lookup === accountLookup;
      if (!identityMatches) {
        await this.deleteConnectionGrant(credential);
        const replaced = await this.adminCall("/key/generate", { method: "POST", body: grant }, true);
        if (!replaced.ok) throw this.upstreamError("MCP_CONNECTION_IDENTITY_MISMATCH", replaced.status, replaced.payload);
      } else {
        const updated = await this.adminCall("/key/update", { method: "POST", body: grant }, true);
        if (!updated.ok) throw this.upstreamError("MCP_CONNECTION_GRANT_FAILED", updated.status, updated.payload);
      }
    }
    return { credential, serverId };
  }

  private async readConnectionStatus(credential: string, serverId: string, serverName: string): Promise<OAuthConnectionStatus> {
    const result = await this.dataCall(`/v1/mcp/server/${encodeURIComponent(serverId)}/oauth-user-credential/status`, credential);
    if (!result.ok) throw this.upstreamError("MCP_CONNECTION_STATUS_FAILED", result.status, result.payload);
    const payload = asObject(result.payload);
    const hasCredential = payload.has_credential === true;
    const isExpired = payload.is_expired === true;
    const state = !hasCredential ? "disconnected" : isExpired ? "expired" : "connected";
    const account = state === "connected" && serverName === "onecomputer_ms365"
      ? await this.readConnectionAccount(credential, serverId).catch(() => null)
      : null;
    return {
      state,
      connectedAt: typeof payload.connected_at === "string" ? payload.connected_at : null,
      expiresAt: typeof payload.expires_at === "string" ? payload.expires_at : null,
      account,
    };
  }

  private async readConnectionAccount(credential: string, serverId: string): Promise<NonNullable<OAuthConnectionStatus["account"]>> {
    const called = await this.dataCall("/mcp-rest/tools/call", credential, {
      method: "POST",
      body: {
        server_id: serverId,
        name: "get-current-user",
        arguments: { $select: "displayName,mail,userPrincipalName" },
      },
    });
    if (!called.ok) throw this.upstreamError("MCP_ACCOUNT_LOOKUP_FAILED", called.status, called.payload);
    const payload = asObject(called.payload);
    if (payload.isError === true) throw new OneComputerError("MCP_ACCOUNT_LOOKUP_FAILED", "Connector account details are unavailable", 502, true);
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = content.map(asObject).find((item) => item.type === "text" && typeof item.text === "string")?.text;
    if (typeof text !== "string") throw new OneComputerError("MCP_ACCOUNT_LOOKUP_FAILED", "Connector account details are unavailable", 502, true);
    let profile: JsonObject;
    try {
      profile = asObject(JSON.parse(text));
    } catch {
      throw new OneComputerError("MCP_ACCOUNT_LOOKUP_FAILED", "Connector account details are unavailable", 502, true);
    }
    const safeString = (value: unknown) => typeof value === "string" && value.trim()
      ? value.trim().slice(0, 320)
      : null;
    const account = {
      displayName: safeString(profile.displayName),
      email: safeString(profile.mail),
      userPrincipalName: safeString(profile.userPrincipalName),
    };
    if (!account.displayName && !account.email && !account.userPrincipalName) {
      throw new OneComputerError("MCP_ACCOUNT_LOOKUP_FAILED", "Connector account details are unavailable", 502, true);
    }
    return account;
  }

  private async deleteConnectionGrant(credential: string) {
    const result = await this.adminCall("/key/delete", { method: "POST", body: { keys: [credential] } }, true);
    if (!result.ok && result.status !== 404) throw this.upstreamError("MCP_CONNECTION_GRANT_REVOKE_FAILED", result.status, result.payload);
  }

  private executionCredential(operationId: string, leaseId: string) {
    const digest = createHmac("sha256", this.config.credentialSecret)
      .update(`onecomputer:litellm:execution:${operationId}:${leaseId}`)
      .digest("base64url");
    return `sk-oce-${digest}`;
  }

  async ensureGrant(input: { workspaceId: string; identity: IdentityContext; agentId?: string; policy?: RuntimePolicy }): Promise<GatewayGrant> {
    const agentId = input.policy?.agentId ?? input.agentId;
    const modelAlias = input.policy?.modelAlias ?? this.modelAlias;
    const gatewayModelAlias = desktopModelAlias(modelAlias, input.policy);
    const mcpServer = input.policy?.mcpServer ?? this.mcpServer;
    const allowedTools = input.policy?.allowedTools ?? this.allowedTools;
    const mcpServers = input.policy?.mcpServers ?? [mcpServer];
    const mcpToolPermissions = input.policy?.mcpToolPermissions ?? { [mcpServer]: allowedTools };
    const projection = JSON.stringify({
      agentId,
      modelAlias,
      gatewayModelAlias,
      mcpServer,
      allowedTools,
      mcpServers,
      mcpToolPermissions,
      connectionProjectionHash: input.policy?.connectionProjectionHash ?? null,
      policyVersionId: input.policy?.policyVersionId ?? null,
      policyHash: input.policy?.policyHash ?? null,
    });
    const credential = this.credentialFor(input.workspaceId, agentId);
    const gatewayUserId = this.userIdFor(input.identity);
    const gatewayAgentId = this.agentIdFor(input.workspaceId, agentId);
    const cached = this.workspaceGrantStates.get(credential);
    if (cached && cached.projection === projection && cached.expiresAt > Date.now() + this.workspaceGrantRenewalMs) {
      return { baseUrl: this.workspaceUrl, credential, modelAlias: gatewayModelAlias, expiresAt: new Date(cached.expiresAt).toISOString() };
    }
    const expiresAt = new Date(Date.now() + this.workspaceGrantTtlMs);
    const durationSeconds = Math.max(60, Math.ceil(this.workspaceGrantTtlMs / 1_000));
    const grant = {
      key: credential,
      key_alias: `onecomputer-agent-${gatewayAgentId}`,
      key_type: "llm_api",
      user_id: gatewayUserId,
      agent_id: gatewayAgentId,
      duration: `${durationSeconds}s`,
      models: [gatewayModelAlias],
      max_budget: WORKSPACE_MAX_BUDGET_USD,
      budget_duration: WORKSPACE_BUDGET_DURATION,
      rpm_limit: WORKSPACE_RPM_LIMIT,
      tpm_limit: WORKSPACE_TPM_LIMIT,
      max_parallel_requests: WORKSPACE_MAX_PARALLEL_REQUESTS,
      metadata: {
        onecomputer_workspace_id: input.workspaceId,
        onecomputer_tenant_id: input.identity.tenantId,
        onecomputer_subject_id: input.identity.subjectId,
        onecomputer_agent_id: agentId ?? `workspace-default:${input.workspaceId}`,
        onecomputer_policy_model_alias: modelAlias,
        onecomputer_client_model_alias: gatewayModelAlias,
        ...(input.policy ? {
          onecomputer_policy_version_id: input.policy.policyVersionId,
          onecomputer_policy_version: input.policy.policyVersion,
          onecomputer_policy_hash: input.policy.policyHash,
        } : {}),
        onecomputer_gateway_user_id: gatewayUserId,
        onecomputer_gateway_agent_id: gatewayAgentId,
      },
      object_permission: {
        mcp_servers: mcpServers,
        mcp_tool_permissions: mcpToolPermissions,
      },
    };

    const generated = await this.adminCall("/key/generate", { method: "POST", body: grant }, true);
    if (!generated.ok) {
      const existing = await this.adminCall(`/key/list?return_full_object=true&key_alias=${encodeURIComponent(grant.key_alias)}`, { method: "GET" }, true);
      const keys = Array.isArray(asObject(existing.payload).keys) ? asObject(existing.payload).keys as unknown[] : [];
      const tokenHash = createHash("sha256").update(credential).digest("hex");
      const current = keys.map(asObject).find((key) => key.token === tokenHash);
      const metadata = asObject(current?.metadata);
      const identityMatches = current?.user_id === gatewayUserId
        && current?.agent_id === gatewayAgentId
        && metadata.onecomputer_tenant_id === input.identity.tenantId
        && metadata.onecomputer_subject_id === input.identity.subjectId
        && metadata.onecomputer_workspace_id === input.workspaceId
        && metadata.onecomputer_agent_id === (agentId ?? `workspace-default:${input.workspaceId}`)
        && (!input.policy || (metadata.onecomputer_policy_version_id === input.policy.policyVersionId
          && metadata.onecomputer_policy_hash === input.policy.policyHash));
      if (!identityMatches) {
        await this.adminCall("/key/delete", { method: "POST", body: { keys: [credential] } }, true);
        const replaced = await this.adminCall("/key/generate", { method: "POST", body: grant }, true);
        if (!replaced.ok) throw this.upstreamError("GATEWAY_GRANT_IDENTITY_MISMATCH", replaced.status, replaced.payload);
      } else {
        const updated = await this.adminCall("/key/update", { method: "POST", body: grant });
        if (!updated.ok) throw this.upstreamError("GATEWAY_GRANT_FAILED", updated.status, updated.payload);
      }
    }
    this.workspaceGrantStates.set(credential, { expiresAt: expiresAt.getTime(), projection });
    return { baseUrl: this.workspaceUrl, credential, modelAlias: gatewayModelAlias, expiresAt: expiresAt.toISOString() };
  }

  async readiness(workspaceId: string, agentId?: string, policy?: RuntimePolicy): Promise<GatewayReadiness> {
    const effectiveAgentId = policy?.agentId ?? agentId;
    const modelAlias = policy?.modelAlias ?? this.modelAlias;
    const gatewayModelAlias = desktopModelAlias(modelAlias, policy);
    const allowedTools = policy?.allowedTools ?? this.allowedTools;
    const credential = this.credentialFor(workspaceId, effectiveAgentId);
    const [models, tools, modelRoute] = await Promise.all([
      this.dataCall("/v1/models", credential),
      this.dataCall("/mcp-rest/tools/list", credential),
      this.modelRoute(credential, workspaceId, effectiveAgentId, modelAlias),
    ]);
    if (!models.ok || !tools.ok) this.workspaceGrantStates.delete(credential);
    const modelIds = Array.isArray(asObject(models.payload).data)
      ? (asObject(models.payload).data as unknown[]).map((item) => String(asObject(item).id ?? ""))
      : [];
    const toolNames = Array.isArray(asObject(tools.payload).tools)
      ? (asObject(tools.payload).tools as unknown[]).map((item) => String(asObject(item).name ?? ""))
      : [];
    return {
      models: models.ok && modelIds.includes(gatewayModelAlias) ? "ready" : "failed",
      tools: tools.ok && allowedTools.length === toolNames.length && allowedTools.every((tool) => toolNames.includes(tool)) ? "ready" : "failed",
      modelRoute: {
        ...modelRoute,
        status: models.ok && modelIds.includes(gatewayModelAlias) ? "ready" : "failed",
      },
    };
  }

  async modelCapabilities(modelAlias: string): Promise<GatewayModelCapabilities> {
    const cached = this.modelCapabilityStates.get(modelAlias);
    if (cached && cached.expiresAt > Date.now()) return cached.capabilities;
    const result = await this.adminCall("/model/info", { method: "GET" });
    const models = Array.isArray(asObject(result.payload).data)
      ? asObject(result.payload).data as unknown[]
      : [];
    const selected = models.map(asObject).find((item) => item.model_name === modelAlias);
    const supportsVision = asObject(selected?.model_info).supports_vision;
    if (typeof supportsVision !== "boolean") {
      throw new OneComputerError(
        "MODEL_CAPABILITY_UNAVAILABLE",
        "The selected model route does not declare whether it supports image input",
        503,
        true,
      );
    }
    const capabilities = { vision: supportsVision };
    this.modelCapabilityStates.set(modelAlias, {
      expiresAt: Date.now() + 60_000,
      capabilities,
    });
    return capabilities;
  }

  private async modelRoute(credential: string, workspaceId: string, agentId: string | undefined, modelAlias: string): Promise<GatewayModelRoute> {
    const keyAlias = `onecomputer-agent-${this.agentIdFor(workspaceId, agentId)}`;
    const [result, capabilities] = await Promise.all([
      this.adminCall(`/key/list?return_full_object=true&key_alias=${encodeURIComponent(keyAlias)}`, { method: "GET" }),
      this.modelCapabilities(modelAlias),
    ]);
    const keys = Array.isArray(asObject(result.payload).keys) ? asObject(result.payload).keys as unknown[] : [];
    const tokenHash = createHash("sha256").update(credential).digest("hex");
    const key = keys.map(asObject).find((item) => item.token === tokenHash);
    if (!key) throw new OneComputerError("GATEWAY_USAGE_UNAVAILABLE", "The model route usage state is unavailable", 502, true);
    const numberOr = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
    const limitUsd = numberOr(key.max_budget, WORKSPACE_MAX_BUDGET_USD);
    const spentUsd = Math.max(0, numberOr(key.spend, 0));
    return {
      alias: modelAlias,
      status: "ready",
      fallback: "none",
      capabilities,
      budget: {
        limitUsd,
        spentUsd,
        remainingUsd: Math.max(0, limitUsd - spentUsd),
        duration: WORKSPACE_BUDGET_DURATION,
        resetsAt: typeof key.budget_reset_at === "string" ? key.budget_reset_at : null,
      },
      limits: {
        requestsPerMinute: numberOr(key.rpm_limit, WORKSPACE_RPM_LIMIT),
        tokensPerMinute: numberOr(key.tpm_limit, WORKSPACE_TPM_LIMIT),
        maxParallelRequests: numberOr(key.max_parallel_requests, WORKSPACE_MAX_PARALLEL_REQUESTS),
      },
    };
  }

  async test(workspaceId: string, agentId?: string, policy?: RuntimePolicy): Promise<GatewayTestResult> {
    const effectiveAgentId = policy?.agentId ?? agentId;
    const modelAlias = policy?.modelAlias ?? this.modelAlias;
    const credential = this.credentialFor(workspaceId, effectiveAgentId);
    const [readiness, toolList] = await Promise.all([
      this.readiness(workspaceId, effectiveAgentId, policy),
      this.dataCall("/mcp-rest/tools/list", credential),
    ]);
    if (readiness.models !== "ready" || !readiness.modelRoute) throw new OneComputerError("MODEL_ROUTE_FAILED", "The assigned model route is unavailable", 502, true);
    if (!toolList.ok) throw this.upstreamError("MCP_DISCOVERY_FAILED", toolList.status, toolList.payload);
    const tools = Array.isArray(asObject(toolList.payload).tools)
      ? (asObject(toolList.payload).tools as unknown[]).map((item) => {
          const tool = asObject(item);
          return { name: String(tool.name ?? ""), description: String(tool.description ?? "") };
        }).filter((tool) => tool.name.length > 0)
      : [];
    return {
      model: modelAlias,
      availability: "ready",
      modelRoute: readiness.modelRoute,
      tools,
      apiBaseUrl: `${this.workspaceUrl}/v1`,
      mcpUrl: `${this.workspaceUrl}/mcp`,
    };
  }

  async executeGovernedTool(input: GovernedToolExecutionInput): Promise<GovernedToolExecutionResult> {
    const credential = this.executionCredential(input.operationId, input.leaseId);
    const gatewayUserId = this.userIdFor({ tenantId: input.tenantId, subjectId: input.subjectId, audience: "onecomputer-control" });
    const gatewayAgentId = this.agentIdFor(input.workspaceId, input.agentId);
    const grant = await this.adminCall("/key/generate", {
      method: "POST",
      body: {
        key: credential,
        key_alias: `onecomputer-execution-${input.operationId}`,
        key_type: "llm_api",
        user_id: gatewayUserId,
        agent_id: gatewayAgentId,
        duration: "60s",
        models: [],
        max_budget: 0.01,
        rpm_limit: 4,
        metadata: {
          onecomputer_tenant_id: input.tenantId,
          onecomputer_subject_id: input.subjectId,
          onecomputer_workspace_id: input.workspaceId,
          onecomputer_agent_id: input.agentId ?? `workspace-default:${input.workspaceId}`,
          onecomputer_gateway_user_id: gatewayUserId,
          onecomputer_gateway_agent_id: gatewayAgentId,
          onecomputer_operation_id: input.operationId,
          onecomputer_operation_digest: input.operationDigest,
          onecomputer_lease_id: input.leaseId,
        },
        object_permission: {
          mcp_servers: [input.serverName],
          mcp_tool_permissions: { [input.serverName]: [input.toolName] },
        },
      },
    });
    if (!grant.ok) throw this.upstreamError("GATEWAY_EXECUTION_GRANT_FAILED", grant.status, grant.payload);
    try {
      const availableTools = await this.dataCall("/mcp-rest/tools/list", credential);
      if (!availableTools.ok) throw this.upstreamError("GATEWAY_EXECUTION_DISCOVERY_FAILED", availableTools.status, availableTools.payload);
      const tools = Array.isArray(asObject(availableTools.payload).tools) ? asObject(availableTools.payload).tools as unknown[] : [];
      const selectedTool = tools.map(asObject).find((tool) => tool.name === input.toolName);
      const serverId = asObject(selectedTool?.mcp_info).server_id;
      if (typeof serverId !== "string" || !serverId) {
        throw new OneComputerError("GATEWAY_EXECUTION_TOOL_NOT_ASSIGNED", "The exact governed tool is not assigned to this execution", 403);
      }
      const called = await this.dataCall("/mcp-rest/tools/call", credential, {
        method: "POST",
        body: { server_id: serverId, name: input.toolName, arguments: input.arguments as JsonObject },
      });
      if (!called.ok) throw this.upstreamError("GATEWAY_TOOL_EXECUTION_FAILED", called.status, called.payload);
      const payload = asObject(called.payload);
      const content = Array.isArray(payload.content) ? payload.content : [];
      const firstText = content.map(asObject).find((item) => item.type === "text" && typeof item.text === "string")?.text;
      if (payload.isError === true) {
        const failureSummary = typeof firstText === "string" && firstText.trim()
          ? firstText.trim().slice(0, 240)
          : "The governed Microsoft 365 tool reported a failure";
        throw new OneComputerError("UPSTREAM_TOOL_FAILED", failureSummary, 502, true);
      }
      const resultSummary = typeof firstText === "string" ? firstText.slice(0, 240) : "The governed tool completed successfully.";
      return {
        upstreamReference: `mcp:${input.operationId}`,
        resultSummary,
        result: JSON.parse(JSON.stringify(called.payload)) as OwnedJson,
      };
    } finally {
      await this.adminCall("/key/delete", { method: "POST", body: { keys: [credential] } }, true).catch(() => undefined);
    }
  }

  async revoke(workspaceId: string, agentId?: string) {
    const credential = this.credentialFor(workspaceId, agentId);
    const result = await this.adminCall("/key/delete", {
      method: "POST",
      body: { keys: [credential] },
    }, true);
    this.workspaceGrantStates.delete(credential);
    if (!result.ok && result.status !== 404) throw this.upstreamError("GATEWAY_REVOKE_FAILED", result.status, result.payload);
  }

  private async adminCall(path: string, init: { method: string; body?: JsonObject }, tolerateFailure = false) {
    const result = await this.call(`${this.adminUrl}${path}`, this.config.masterKey, init);
    if (!result.ok && !tolerateFailure) throw this.upstreamError("GATEWAY_ADMIN_FAILED", result.status, result.payload);
    return result;
  }

  private async dataCall(path: string, credential: string, init: { method?: string; body?: JsonObject } = {}) {
    return this.call(`${this.adminUrl}${path}`, credential, { method: init.method ?? "GET", body: init.body });
  }

  private async call(url: string, token: string, init: { method: string; body?: JsonObject }) {
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { ok: response.ok, status: response.status, payload: await response.json().catch(() => ({})) };
    } catch {
      throw new OneComputerError("GATEWAY_UNAVAILABLE", "The model gateway is unavailable", 503, true);
    }
  }

  private upstreamError(code: string, status: number, payload: unknown) {
    const detail = asObject(asObject(payload).detail);
    const error = asObject(payload).error;
    const message = typeof error === "string"
      ? error
      : typeof detail.error === "string"
        ? detail.error
        : "The model gateway rejected the request";
    return new OneComputerError(code, message, status >= 500 ? 502 : status, status >= 500);
  }
}
