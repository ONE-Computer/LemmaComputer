import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  approvedBedrockApiKeyModelProfiles,
  bedrockApiKeyRouteAlias,
  bedrockApiKeyRouteConfigurationSchema,
  LemmaComputerError,
  type BedrockApiKeyRouteConfiguration,
  type BedrockApiKeyModelProfile,
  type IdentityContext,
  type OwnedJson,
  type RuntimePolicy,
} from "@lemmacomputer/contracts";
import { managedProviderForAlias, managedProviderModels, tenantManagedModelAccessGroup } from "./provider-settings.js";
import type { FetchLike } from "./mtls-fetch.js";
export * from "./provider-settings.js";
export * from "./budget-projection.js";
export * from "./mtls-fetch.js";

export type GatewayGrant = {
  baseUrl: string;
  credential: string;
  modelAlias: string;
  transportModelAlias: string;
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
  limits: {
    requestsPerMinute: number;
    tokensPerMinute: number | null;
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
  ensureGrant(input: { workspaceId: string; accessGeneration: number; identity: IdentityContext; agentId?: string; policy?: RuntimePolicy }): Promise<GatewayGrant>;
  modelCapabilities(modelAlias: string): Promise<GatewayModelCapabilities>;
  readiness(workspaceId: string, agentId?: string, policy?: RuntimePolicy, accessGeneration?: number): Promise<GatewayReadiness>;
  test(workspaceId: string, agentId?: string, policy?: RuntimePolicy, accessGeneration?: number): Promise<GatewayTestResult>;
  revoke(workspaceId: string, agentId?: string): Promise<void>;
  revokeWorkspace(workspaceId: string, accessGeneration?: number): Promise<void>;
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

// A tool review is bound to this digest, not solely to the provider-chosen
// tool name. `definitionHash` is SHA-256 over a canonical form of every raw
// `/mcp-rest/tools/list` field except LiteLLM's transport-only `mcp_info`.
export type OAuthConnectionTool = {
  name: string;
  definitionHash: string;
  description?: string;
  /**
   * Bounded, redacted current-definition context for an administrator. It is
   * display-only; `definitionHash` remains the authorization binding.
   */
  definitionPreview?: string;
};

export type AnonymousOAuthConnectionToolDiscovery =
  | { state: "available"; tools: OAuthConnectionTool[] }
  | { state: "authorization_required" | "unavailable"; tools: [] };

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
  userOAuthConnectionTools(identity: IdentityContext, serverName: string): Promise<OAuthConnectionTool[]>;
  anonymousOAuthConnectionTools?(identity: IdentityContext, serverName: string): Promise<AnonymousOAuthConnectionToolDiscovery>;
  callUserOAuthConnectionTool?(
    identity: IdentityContext,
    serverName: string,
    toolName: string,
    argumentsValue: Record<string, OwnedJson>,
  ): Promise<OwnedJson>;
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
  /**
   * Control-owned classification consumed only by the pinned LiteLLM egress
   * extension. It is never accepted from a connector provider or browser.
   */
  egressProfile?: "strict_remote" | "internal";
};

export interface McpConnectorAdministrationGateway {
  discoverOAuthMcpServer(input: Omit<McpConnectorRegistrationInput, "serverId" | "serverName"> & { callbackUrl: string }): Promise<{
    authorizationOrigin: string;
    dynamicClientRegistration: boolean;
  }>;
  ensureOAuthMcpServers(inputs: McpConnectorRegistrationInput[]): Promise<void>;
  registerOAuthMcpServer(input: McpConnectorRegistrationInput): Promise<void>;
  replaceOAuthMcpServerCredentials(input: {
    serverId: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
  }): Promise<void>;
  syncOAuthMcpServerScopes(input: { serverId: string; scopes: string[] }): Promise<void>;
  removeMcpServer(serverId: string): Promise<void>;
}

// This interface is deliberately private to Control. The caller supplies an
// opaque credential name generated by the service; it is never a browser field.
export type BedrockApiKeyRouteProvisioningInput = BedrockApiKeyRouteConfiguration & {
  credentialName: string;
};

export type BedrockApiKeyRoute = {
  alias: typeof bedrockApiKeyRouteAlias;
  region: BedrockApiKeyRouteConfiguration["region"];
  modelProfileId: BedrockApiKeyRouteConfiguration["modelProfileId"];
  capabilities: BedrockApiKeyModelProfile["capabilities"];
  limits: BedrockApiKeyModelProfile["limits"];
  pricing: BedrockApiKeyModelProfile["pricing"];
};

export type BedrockApiKeyRouteSelection = Pick<BedrockApiKeyRouteConfiguration, "region" | "modelProfileId">;

export type BedrockApiKeyRouteTestResult = BedrockApiKeyRoute & {
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

export interface BedrockApiKeyRouteGateway {
  configureBedrockApiKeyRoute(input: BedrockApiKeyRouteProvisioningInput): Promise<BedrockApiKeyRoute>;
  testBedrockApiKeyRoute(input: BedrockApiKeyRouteSelection): Promise<BedrockApiKeyRouteTestResult>;
}

export type GovernedToolExecutionInput = {
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  accessGeneration: number;
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
  adminFetch?: FetchLike;
};

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};
const stringArray = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];
const canonicalToolDefinition = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LemmaComputerError("MCP_TOOL_DISCOVERY_INVALID", "The connector returned an invalid tool definition", 502, true);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalToolDefinition).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as JsonObject;
    return `{${Object.keys(record).sort().map((key) => {
      const item = record[key];
      if (item === undefined) throw new LemmaComputerError("MCP_TOOL_DISCOVERY_INVALID", "The connector returned an invalid tool definition", 502, true);
      return `${JSON.stringify(key)}:${canonicalToolDefinition(item)}`;
    }).join(",")}}`;
  }
  throw new LemmaComputerError("MCP_TOOL_DISCOVERY_INVALID", "The connector returned an invalid tool definition", 502, true);
};

const maxToolDefinitionPreviewLength = 6_144;
const maxToolDefinitionPreviewDepth = 12;
const maxToolDefinitionPreviewEntries = 64;
const maxToolDefinitionPreviewStringLength = 1_024;
const isSensitiveToolDefinitionField = (field: string) => /(?:api[-_]?key|authorization|credential|password|secret|token)/i.test(field);

/**
 * Tool definitions are supplied by a remote provider, so give reviewers a
 * useful but bounded representation. Transport metadata was removed before
 * this point; likely secrets are redacted rather than echoed into Control's
 * admin UI. The unredacted canonical definition is still what gets hashed.
 */
const redactToolDefinitionForPreview = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[invalid number]";
  if (typeof value === "string") {
    return value.length <= maxToolDefinitionPreviewStringLength
      ? value
      : `${value.slice(0, maxToolDefinitionPreviewStringLength)}…[truncated]`;
  }
  if (depth >= maxToolDefinitionPreviewDepth) return "[truncated: nesting limit]";
  if (Array.isArray(value)) {
    const entries = value.slice(0, maxToolDefinitionPreviewEntries)
      .map((entry) => redactToolDefinitionForPreview(entry, depth + 1));
    return value.length > maxToolDefinitionPreviewEntries ? [...entries, "[truncated: item limit]"] : entries;
  }
  if (value && typeof value === "object") {
    const source = value as JsonObject;
    const result: JsonObject = {};
    const keys = Object.keys(source).sort();
    for (const key of keys.slice(0, maxToolDefinitionPreviewEntries)) {
      result[key] = isSensitiveToolDefinitionField(key)
        ? "[redacted]"
        : redactToolDefinitionForPreview(source[key], depth + 1);
    }
    if (keys.length > maxToolDefinitionPreviewEntries) result._truncated = "[property limit]";
    return result;
  }
  return "[invalid value]";
};

const toolDefinitionPreview = (definition: JsonObject) => {
  const preview = canonicalToolDefinition(redactToolDefinitionForPreview(definition));
  return preview.length <= maxToolDefinitionPreviewLength
    ? preview
    : `${preview.slice(0, maxToolDefinitionPreviewLength)}…[truncated]`;
};

const oauthConnectionToolDescriptor = (tool: JsonObject): OAuthConnectionTool | null => {
  if (typeof tool.name !== "string" || !tool.name) return null;
  const definition = Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "mcp_info"));
  return {
    name: tool.name,
    definitionHash: createHash("sha256").update(canonicalToolDefinition(definition), "utf8").digest("hex"),
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    definitionPreview: toolDefinitionPreview(definition),
  };
};

const oauthConnectionToolsFromPayload = (payload: unknown, serverId: string) => {
  const tools = Array.isArray(asObject(payload).tools) ? asObject(payload).tools as unknown[] : [];
  const descriptors = new Map<string, OAuthConnectionTool>();
  for (const tool of tools.map(asObject)) {
    const info = asObject(tool.mcp_info);
    // `/mcp-rest/tools/list` can contain entries for more than one server. A
    // tool without an exact server identity is not attributable to the
    // connector and must never become reviewable or projectable.
    if (typeof info.server_id !== "string") {
      throw new LemmaComputerError(
        "MCP_TOOL_DISCOVERY_INVALID",
        "The connector returned a tool without its server identity. Reconnect and try again.",
        502,
        true,
      );
    }
    if (info.server_id !== serverId) continue;
    const descriptor = oauthConnectionToolDescriptor(tool);
    if (!descriptor) continue;
    const existing = descriptors.get(descriptor.name);
    if (existing && existing.definitionHash !== descriptor.definitionHash) {
      throw new LemmaComputerError(
        "MCP_TOOL_DISCOVERY_CONFLICT",
        "The connector returned conflicting definitions for a tool. Reconnect and try again.",
        502,
        true,
      );
    }
    descriptors.set(descriptor.name, descriptor);
  }
  return [...descriptors.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
};

const discoveryNeedsAuthorization = (status: number, payload: unknown) => {
  if (status === 401 || status === 403) return true;
  const record = asObject(payload);
  const text = [record.error, record.message, asObject(record.detail).error, asObject(record.detail).message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /(?:oauth|authori[sz]|credential|sign.?in|forbidden|unauthenticated)/i.test(text);
};
const sameStrings = (left: string[], right: string[]) => {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
};
const WORKSPACE_RPM_LIMIT = 30;
// Claude Desktop overlaps its streaming model request, managed MCP calls, and
// short-lived background work. A limit of four caused healthy agent sessions
// to deadlock into LiteLLM's retry loop. Keep the 30 RPM control while allowing
// that burst to complete.
const WORKSPACE_MAX_PARALLEL_REQUESTS = 30;

// LiteLLM stores this model in its database so Provider Settings can change the
// approved API-key route without changing config.yaml or restarting Compose.
const BEDROCK_MODEL_ID = "lemmacomputer-bedrock-api-key-v1";
const BEDROCK_CREDENTIAL_NAME = /^lemmacomputer-bedrock-[a-z0-9][a-z0-9-]{0,63}$/;
const BEDROCK_ROUTE_TIMEOUT_SECONDS = 60;
const BEDROCK_ROUTE_MAX_RETRIES = 2;

const desktopTransportAliases: Record<string, string> = {
  "lemmacomputer-auto": "claude-sonnet-4-6",
  "lemmacomputer-claude": "claude-sonnet-4-6",
  "lemmacomputer-openai": "claude-opus-4-6",
  "lemmacomputer-glm": "claude-sonnet-4-5",
  [bedrockApiKeyRouteAlias]: bedrockApiKeyRouteAlias,
};

const desktopModelAlias = (modelAlias: string, policy?: RuntimePolicy) => {
  if (!["claude-desktop-managed-v1", "claude-cli-managed-v1"].includes(policy?.agentProfile ?? "")) return modelAlias;
  const transportAlias = desktopTransportAliases[modelAlias];
  if (!transportAlias) throw new LemmaComputerError("DESKTOP_MODEL_ROUTE_INVALID", "The selected model has no Claude Desktop transport route", 500);
  return transportAlias;
};

export const workspaceModelGrantProjection = (tenantId: string, modelAlias: string, policy?: RuntimePolicy) => {
  const clientModelAlias = desktopModelAlias(modelAlias, policy);
  const transportModelAlias = modelAlias === "lemmacomputer-auto" ? "lemmacomputer-auto" : clientModelAlias;
  if (transportModelAlias === "lemmacomputer-auto") {
    return { clientModelAlias, transportModelAlias, providerAccessGroup: null, grantModels: ["lemmacomputer-auto"] };
  }
  const managedProvider = managedProviderForAlias(clientModelAlias);
  const providerAccessGroup = managedProvider ? tenantManagedModelAccessGroup(tenantId, clientModelAlias) : null;
  return { clientModelAlias, transportModelAlias, providerAccessGroup, grantModels: providerAccessGroup ? [providerAccessGroup] : [clientModelAlias] };
};

export class LiteLLMGatewayAdapter implements GatewayClient, GovernedToolExecutor, OAuthConnectionGateway, McpConnectorAdministrationGateway, BedrockApiKeyRouteGateway {
  private readonly adminUrl: string;
  private readonly workspaceUrl: string;
  private readonly modelAlias: string;
  private readonly mcpServer: string;
  private readonly allowedTools: string[];
  private readonly timeoutMs: number;
  private readonly workspaceGrantTtlMs: number;
  private readonly workspaceGrantRenewalMs: number;
  private readonly connectionGrantTtlMs: number;
  private readonly adminFetch: FetchLike;
  private readonly workspaceGrantStates = new Map<string, { expiresAt: number; projection: string; modelAlias: string; transportModelAlias: string; accessGeneration: number }>();
  private readonly modelCapabilityStates = new Map<string, { expiresAt: number; capabilities: GatewayModelCapabilities }>();
  private readonly oauthClientRegistrationStates = new Map<string, Promise<string | null>>();

  constructor(private readonly config: LiteLLMConfig) {
    this.adminUrl = config.adminUrl.replace(/\/$/, "");
    this.workspaceUrl = config.workspaceUrl.replace(/\/$/, "");
    this.modelAlias = config.modelAlias ?? "lemmacomputer-assistant";
    this.mcpServer = config.mcpServer ?? "lemmacomputer_fixture";
    this.allowedTools = config.allowedTools ?? ["search_files"];
    this.timeoutMs = config.requestTimeoutMs ?? 15_000;
    this.workspaceGrantTtlMs = config.workspaceGrantTtlMs ?? 8 * 60 * 60 * 1000;
    this.workspaceGrantRenewalMs = config.workspaceGrantRenewalMs ?? 60 * 60 * 1000;
    this.connectionGrantTtlMs = config.connectionGrantTtlMs ?? 15 * 60 * 1000;
    this.adminFetch = config.adminFetch ?? fetch;
  }

  userIdFor(identity: IdentityContext) {
    const digest = createHash("sha256")
      .update(`lemmacomputer:litellm:user:${identity.tenantId}:${identity.subjectId}`)
      .digest("base64url");
    return `oc-user-${digest}`;
  }

  agentIdFor(workspaceId: string, agentId?: string) {
    const digest = createHash("sha256")
      .update(`lemmacomputer:litellm:agent:${workspaceId}:${agentId ?? "default"}`)
      .digest("base64url");
    return `oc-agent-${digest}`;
  }

  credentialFor(workspaceId: string, agentId?: string, accessGeneration?: number) {
    const digest = createHmac("sha256", this.config.credentialSecret)
      .update((agentId
        ? `lemmacomputer:litellm:workspace:${workspaceId}:agent:${agentId}`
        : `lemmacomputer:litellm:workspace:${workspaceId}`) + (accessGeneration === undefined ? "" : `:generation:${accessGeneration}`))
      .digest("base64url");
    return `sk-ocw-${digest}`;
  }

  connectionCredentialFor(identity: IdentityContext, serverName: string, grantNonce: string) {
    const digest = createHmac("sha256", this.config.credentialSecret)
      .update(`lemmacomputer:litellm:connection:${identity.tenantId}:${identity.subjectId}:${serverName}:${grantNonce}`)
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
    try {
      const query = new URLSearchParams({
        redirect_uri: input.redirectUri,
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
        response_type: "code",
      });
      const authorize = async () => {
        try {
          return await this.adminFetch(`${this.adminUrl}/v1/mcp/server/oauth/${encodeURIComponent(grant.serverId)}/authorize?${query}`, {
            method: "GET",
            headers: { authorization: `Bearer ${grant.credential}` },
            redirect: "manual",
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch {
          throw new LemmaComputerError("GATEWAY_UNAVAILABLE", "The MCP connection service is unavailable", 503, true);
        }
      };
      // LiteLLM persists dynamic OAuth registrations. Reconcile it before every
      // browser redirect so a changed public proxy origin replaces a client that
      // was registered for an old callback. Static provider clients return the
      // documented dummy result and continue through their existing credentials.
      const reconciledClientId = await this.registerDynamicOAuthClient(grant.serverId);
      let response = await authorize();
      if (await this.missingOAuthClient(response)) {
        await response.body?.cancel().catch(() => undefined);
        if (!reconciledClientId) {
          throw new LemmaComputerError(
            "MCP_OAUTH_CLIENT_REQUIRED",
            "This connector requires provider app credentials",
            400,
          );
        }
        response = await authorize();
      }
      if (response.status < 300 || response.status >= 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new LemmaComputerError("MCP_AUTHORIZATION_REJECTED", "Connector authorization could not be started", 502, true);
      }
      const location = response.headers.get("location");
      if (!location) throw new LemmaComputerError("MCP_AUTHORIZATION_INVALID", "The connector authorization response was invalid", 502, true);
      let authorizationUrl: URL;
      let expectedOrigins: string[];
      try {
        authorizationUrl = new URL(location);
        const configuredOrigins = input.authorizationOrigins
          ?? (input.authorizationOrigin ? [input.authorizationOrigin] : []);
        expectedOrigins = configuredOrigins.map((origin) => new URL(origin).origin);
      } catch {
        throw new LemmaComputerError("MCP_AUTHORIZATION_INVALID", "The connector authorization response was invalid", 502, true);
      }
      if (!expectedOrigins.includes(authorizationUrl.origin)) {
        throw new LemmaComputerError("MCP_AUTHORIZATION_ORIGIN_MISMATCH", "The connector authorization origin was not approved", 502);
      }
      const cookieHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
      const cookies = cookieHeaders.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
      return { location: authorizationUrl.toString(), cookies };
    } finally {
      await this.deleteConnectionGrant(grant.keyAlias).catch(() => undefined);
    }
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
          client_name: "LemmaComputer",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      }, true);
      if (!result.ok) throw this.upstreamError("MCP_OAUTH_REGISTRATION_FAILED", result.status, result.payload);
      const registrationPayload = asObject(result.payload);
      const clientId = registrationPayload.client_id;
      if (typeof clientId !== "string" || !clientId) return null;
      if (clientId === serverId && registrationPayload.client_secret === "dummy") return null;
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
    const grant = await this.ensureConnectionGrant(input.identity, input.serverName, { accountLookup: true });
    try {
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.codeVerifier,
      });
      let response: Response;
      try {
        response = await this.adminFetch(`${this.adminUrl}/v1/mcp/server/oauth/${encodeURIComponent(grant.serverId)}/token`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${grant.credential}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new LemmaComputerError("GATEWAY_UNAVAILABLE", "The MCP connection service is unavailable", 503, true);
      }
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        throw new LemmaComputerError("MCP_TOKEN_EXCHANGE_FAILED", "The connector did not complete the connection", 502, true);
      }
      return await this.readConnectionStatus(grant.credential, grant.serverId, input.serverName, { includeAccount: true });
    } finally {
      await this.deleteConnectionGrant(grant.keyAlias).catch(() => undefined);
    }
  }

  async userOAuthConnectionStatus(identity: IdentityContext, serverName: string): Promise<OAuthConnectionStatus> {
    const includeAccount = serverName === "lemmacomputer_ms365";
    const grant = await this.ensureConnectionGrant(identity, serverName, { accountLookup: includeAccount });
    try {
      return await this.readConnectionStatus(grant.credential, grant.serverId, serverName, { includeAccount });
    } finally {
      await this.deleteConnectionGrant(grant.keyAlias).catch(() => undefined);
    }
  }

  async disconnectUserOAuthConnection(identity: IdentityContext, serverName: string): Promise<OAuthConnectionStatus> {
    const grant = await this.ensureConnectionGrant(identity, serverName);
    try {
      const result = await this.dataCall(`/v1/mcp/server/${encodeURIComponent(grant.serverId)}/oauth-user-credential`, grant.credential, { method: "DELETE" });
      if (!result.ok && result.status !== 404) throw this.upstreamError("MCP_DISCONNECT_FAILED", result.status, result.payload);
      return { state: "disconnected", connectedAt: null, expiresAt: null, account: null };
    } finally {
      await this.deleteConnectionGrant(grant.keyAlias).catch(() => undefined);
    }
  }

  async userOAuthConnectionTools(identity: IdentityContext, serverName: string): Promise<OAuthConnectionTool[]> {
    const grant = await this.ensureConnectionGrant(identity, serverName);
    try {
      const status = await this.readConnectionStatus(grant.credential, grant.serverId, serverName);
      // LiteLLM performs the stored OAuth refresh while resolving a workspace
      // credential for this safe discovery endpoint. Never execute an MCP tool
      // merely to renew a credential.
      if (status.state === "disconnected") return [];
      const result = await this.dataCall(
        `/mcp-rest/tools/list?mcp_server_name=${encodeURIComponent(serverName)}`,
        grant.credential,
      );
      if (!result.ok) throw this.upstreamError("MCP_TOOL_DISCOVERY_FAILED", result.status, result.payload, "The connector could not refresh its saved credentials. Reconnect and try again.");
      const refreshedStatus = status.state === "expired"
        ? await this.readConnectionStatus(grant.credential, grant.serverId, serverName)
        : status;
      // Fail closed if LiteLLM could not silently renew the connection. Callers
      // must not project stale tools into a new workspace grant.
      if (refreshedStatus.state !== "connected") return [];
      return oauthConnectionToolsFromPayload(result.payload, grant.serverId);
    } finally {
      await this.deleteConnectionGrant(grant.keyAlias).catch(() => undefined);
    }
  }

  async anonymousOAuthConnectionTools(identity: IdentityContext, serverName: string): Promise<AnonymousOAuthConnectionToolDiscovery> {
    // Never let a stale gateway credential for the requesting administrator
    // turn this into an authenticated request. The synthetic subject cannot
    // complete OAuth and exists only for this short-lived catalogue grant.
    const discoveryIdentity: IdentityContext = {
      ...identity,
      subjectId: `connector-catalog:${serverName}`,
    };
    const grant = await this.ensureConnectionGrant(discoveryIdentity, serverName);
    try {
      // This deliberately skips the per-user OAuth credential lookup. Some MCP
      // servers publish tools/list before sign-in; others protect the entire
      // endpoint. Both are valid, and an authorization challenge is an honest
      // discovery outcome rather than a connection failure.
      const result = await this.dataCall(
        `/mcp-rest/tools/list?mcp_server_name=${encodeURIComponent(serverName)}`,
        grant.credential,
      );
      if (!result.ok) {
        return {
          state: discoveryNeedsAuthorization(result.status, result.payload) ? "authorization_required" : "unavailable",
          tools: [],
        };
      }
      const payload = asObject(result.payload);
      if (typeof payload.error === "string" && payload.error) {
        return {
          state: discoveryNeedsAuthorization(result.status, payload) ? "authorization_required" : "unavailable",
          tools: [],
        };
      }
      return { state: "available", tools: oauthConnectionToolsFromPayload(payload, grant.serverId) };
    } finally {
      await this.deleteConnectionGrant(grant.keyAlias).catch(() => undefined);
    }
  }

  async discoverOAuthMcpServer(input: Omit<McpConnectorRegistrationInput, "serverId" | "serverName"> & { callbackUrl: string }) {
    const temporaryId = `lemmacomputer_discovery_${createHash("sha256").update(`${input.url}:${Date.now()}`).digest("hex").slice(0, 20)}`;
    const payload = this.mcpRegistrationPayload({
      ...input,
      serverId: temporaryId,
      serverName: temporaryId,
    });
    const created = await this.adminCall("/v1/mcp/server/oauth/session", { method: "POST", body: payload }, true);
    if (!created.ok) throw this.upstreamError("MCP_DISCOVERY_FAILED", created.status, created.payload);
    const dynamicClientId = input.clientId ? undefined : await this.registerDynamicOAuthClient(temporaryId);
    if (!input.clientId && !dynamicClientId) {
      throw new LemmaComputerError(
        "MCP_OAUTH_CLIENT_REQUIRED",
        "This connector requires provider app credentials",
        400,
      );
    }
    const query = new URLSearchParams({
      redirect_uri: input.callbackUrl,
      state: "lemmacomputer-discovery",
      code_challenge: createHash("sha256").update(temporaryId).digest("base64url"),
      code_challenge_method: "S256",
      response_type: "code",
    });
    if (dynamicClientId) query.set("client_id", dynamicClientId);
    let response: Response;
    try {
      response = await this.adminFetch(`${this.adminUrl}/v1/mcp/server/oauth/${encodeURIComponent(temporaryId)}/authorize?${query}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.masterKey}` },
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new LemmaComputerError("MCP_DISCOVERY_FAILED", "The connector could not be reached", 502, true);
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 300 || response.status >= 400 || !location) {
      throw new LemmaComputerError("MCP_DISCOVERY_FAILED", "The connector did not expose a compatible OAuth flow", 400);
    }
    let authorizationUrl: URL;
    try {
      authorizationUrl = new URL(location);
    } catch {
      throw new LemmaComputerError("MCP_DISCOVERY_FAILED", "The connector returned an invalid authorization address", 400);
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
        if (exact.url !== input.url) {
          throw new LemmaComputerError("MCP_REGISTRATION_CONFLICT", `The ${input.name} connector registration does not match the approved catalog`, 409);
        }
        // A matching server_id means this is Control's own row, so a differing
        // server_name is drift to repair rather than a conflict: tenant-owned
        // names are derived from the server id, and a record created before
        // that derivation still carries the old name. Renaming preserves the
        // row's stored credentials and every per-user OAuth token, because the
        // gateway purges tokens only when a mint-relevant field changes and the
        // name is not one of them.
        const needsRename = exact.server_name !== input.serverName;
        // Apply the Control-owned egress classification to records created by
        // an earlier release. Also rebuild records whose OAuth metadata was
        // unavailable during gateway startup. LiteLLM starts before Control's
        // dynamic egress authorizer, so startup-only discovery is not a safe
        // readiness boundary. A server-id-only update preserves credentials
        // while forcing the pinned gateway to rediscover and reload the row.
        const existingProfile = asObject(exact.mcp_info).lemmacomputer_egress_profile;
        const missingOAuthMetadata = typeof exact.authorization_url !== "string"
          || !exact.authorization_url
          || typeof exact.token_url !== "string"
          || !exact.token_url;
        const needsProfileRepair = Boolean(input.egressProfile && existingProfile !== input.egressProfile);
        if (needsRename || needsProfileRepair || missingOAuthMetadata) {
          const repair: JsonObject = { server_id: input.serverId };
          if (needsRename) {
            repair.server_name = input.serverName;
            repair.alias = input.serverName;
          }
          if (needsProfileRepair) {
            repair.mcp_info = { lemmacomputer_egress_profile: input.egressProfile! };
          }
          const updated = await this.adminCall("/v1/mcp/server", {
            method: "PUT",
            body: repair,
          }, true);
          if (!updated.ok) throw this.upstreamError("MCP_REGISTRATION_FAILED", updated.status, updated.payload);
        }
        continue;
      }
      const nameConflict = servers.find((server) => server.server_name === input.serverName);
      if (nameConflict) {
        throw new LemmaComputerError("MCP_REGISTRATION_CONFLICT", `The ${input.name} connector name is already registered`, 409);
      }
      await this.registerOAuthMcpServer(input);
      servers.push({
        server_id: input.serverId,
        server_name: input.serverName,
        url: input.url,
      });
    }
  }

  /**
   * Replaces the OAuth client a server row authenticates with. The gateway
   * treats the client id, secret, and scopes as token-minting identity, so it
   * purges every stored per-user token for the row: anyone connected through
   * the previous application has to authorize again against the new one.
   */
  async replaceOAuthMcpServerCredentials(input: {
    serverId: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
  }) {
    const result = await this.adminCall("/v1/mcp/server", {
      method: "PUT",
      body: {
        server_id: input.serverId,
        credentials: {
          client_id: input.clientId,
          client_secret: input.clientSecret,
          scopes: input.scopes,
        },
      },
    }, true);
    if (!result.ok) throw this.upstreamError("MCP_REGISTRATION_FAILED", result.status, result.payload);
  }

  /**
   * Updates only the scopes a server row requests. The gateway merges the
   * credential blob, preserving keys the update omits, so this corrects a row
   * whose scopes are stale without holding the client secret that Control
   * deliberately never stores. Scopes are part of the token-minting identity,
   * so the gateway purges stored per-user tokens and each person reauthorizes
   * for the corrected set.
   */
  async syncOAuthMcpServerScopes(input: { serverId: string; scopes: string[] }) {
    const result = await this.adminCall("/v1/mcp/server", {
      method: "PUT",
      body: { server_id: input.serverId, credentials: { scopes: input.scopes } },
    }, true);
    if (!result.ok) throw this.upstreamError("MCP_REGISTRATION_FAILED", result.status, result.payload);
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
      ...(input.egressProfile ? {
        mcp_info: { lemmacomputer_egress_profile: input.egressProfile },
      } : {}),
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
      throw new LemmaComputerError("MCP_CONNECTION_NOT_REGISTERED", "The connector is not registered in LiteLLM", 503, true);
    }
    return serverId;
  }

  private async ensureConnectionGrant(identity: IdentityContext, serverName: string, options: { accountLookup?: boolean; tools?: string[] } = {}) {
    const serverId = await this.resolveMcpServer(serverName);
    const grantNonce = randomBytes(12).toString("base64url");
    const credential = this.connectionCredentialFor(identity, serverName, grantNonce);
    const userId = this.userIdFor(identity);
    const serverDigest = createHash("sha256").update(serverName).digest("base64url").slice(0, 12);
    const keyAlias = `lemmacomputer-connection-${userId}-${serverDigest}-${grantNonce}`;
    const credentialRoute = `/v1/mcp/server/${serverId}/oauth-user-credential`;
    const accountLookup = options.accountLookup === true && serverName === "lemmacomputer_ms365";
    const requestedTools = options.tools ?? [];
    const verifiedTools = [...new Set(requestedTools)]
      .filter((tool) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tool));
    if (requestedTools.length !== verifiedTools.length) {
      throw new LemmaComputerError("MCP_CONNECTION_TOOL_INVALID", "The connector verification tool is invalid", 500);
    }
    const allowedTools = accountLookup ? ["get-current-user"] : verifiedTools;
    const canCallTools = allowedTools.length > 0;
    const allowedRoutes = [
      `/v1/mcp/server/oauth/${serverId}/authorize`,
      `/v1/mcp/server/oauth/${serverId}/token`,
      credentialRoute,
      `${credentialRoute}/status`,
      "/mcp-rest/tools/list",
      ...(accountLookup || canCallTools ? ["/mcp-rest/tools/call"] : []),
    ];
    const durationSeconds = Math.max(60, Math.ceil(this.connectionGrantTtlMs / 1_000));
    const grant = {
      key: credential,
      key_alias: keyAlias,
      key_type: "default",
      user_id: userId,
      duration: `${durationSeconds}s`,
      models: [],
      rpm_limit: 12,
      allowed_routes: allowedRoutes,
      metadata: {
        lemmacomputer_tenant_id: identity.tenantId,
        lemmacomputer_subject_id: identity.subjectId,
        lemmacomputer_gateway_user_id: userId,
        lemmacomputer_connection_credential: true,
        lemmacomputer_connection_server: serverName,
        lemmacomputer_connection_account_lookup: accountLookup,
        lemmacomputer_connection_verification_tools: allowedTools,
      },
      object_permission: {
        mcp_servers: [serverName],
        mcp_tool_permissions: { [serverName]: allowedTools },
      },
    };
    const generated = await this.adminCall("/key/generate", { method: "POST", body: grant }, true);
    if (!generated.ok) throw this.upstreamError("MCP_CONNECTION_GRANT_FAILED", generated.status, generated.payload);
    return { credential, serverId, keyAlias };
  }

  async callUserOAuthConnectionTool(
    identity: IdentityContext,
    serverName: string,
    toolName: string,
    argumentsValue: Record<string, OwnedJson>,
  ): Promise<OwnedJson> {
    const grant = await this.ensureConnectionGrant(identity, serverName, { tools: [toolName] });
    try {
      const status = await this.readConnectionStatus(grant.credential, grant.serverId, serverName);
      if (status.state !== "connected") {
        throw new LemmaComputerError("MCP_CONNECTOR_NOT_CONNECTED", "Connect Microsoft 365 before verifying SharePoint access", 409);
      }
      const called = await this.dataCall("/mcp-rest/tools/call", grant.credential, {
        method: "POST",
        body: { server_id: grant.serverId, name: toolName, arguments: argumentsValue as JsonObject },
      });
      if (!called.ok) throw this.upstreamError("MCP_CONNECTION_TOOL_FAILED", called.status, called.payload, "Microsoft 365 could not verify this SharePoint site.");
      const payload = asObject(called.payload);
      if (payload.isError === true) {
        throw new LemmaComputerError("MCP_CONNECTION_TOOL_FAILED", "Microsoft 365 could not verify this SharePoint site. Confirm the site grant and reconnect if permissions changed.", 422);
      }
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = content.map(asObject).find((item) => item.type === "text" && typeof item.text === "string")?.text;
      if (typeof text !== "string") {
        throw new LemmaComputerError("MCP_CONNECTION_TOOL_INVALID", "Microsoft 365 returned an invalid SharePoint verification response", 502, true);
      }
      try {
        return JSON.parse(text) as OwnedJson;
      } catch {
        throw new LemmaComputerError("MCP_CONNECTION_TOOL_INVALID", "Microsoft 365 returned an invalid SharePoint verification response", 502, true);
      }
    } finally {
      await this.deleteConnectionGrant(grant.keyAlias).catch(() => undefined);
    }
  }

  private async readConnectionStatus(credential: string, serverId: string, serverName: string, options: { includeAccount?: boolean } = {}): Promise<OAuthConnectionStatus> {
    const result = await this.dataCall(`/v1/mcp/server/${encodeURIComponent(serverId)}/oauth-user-credential/status`, credential);
    if (!result.ok) throw this.upstreamError("MCP_CONNECTION_STATUS_FAILED", result.status, result.payload, "The connector connection status is unavailable. Reconnect and try again.");
    const payload = asObject(result.payload);
    const hasCredential = payload.has_credential === true;
    const isExpired = payload.is_expired === true;
    const state = !hasCredential ? "disconnected" : isExpired ? "expired" : "connected";
    const account = options.includeAccount === true && state === "connected" && serverName === "lemmacomputer_ms365"
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
    if (payload.isError === true) throw new LemmaComputerError("MCP_ACCOUNT_LOOKUP_FAILED", "Connector account details are unavailable", 502, true);
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = content.map(asObject).find((item) => item.type === "text" && typeof item.text === "string")?.text;
    if (typeof text !== "string") throw new LemmaComputerError("MCP_ACCOUNT_LOOKUP_FAILED", "Connector account details are unavailable", 502, true);
    let profile: JsonObject;
    try {
      profile = asObject(JSON.parse(text));
    } catch {
      throw new LemmaComputerError("MCP_ACCOUNT_LOOKUP_FAILED", "Connector account details are unavailable", 502, true);
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
      throw new LemmaComputerError("MCP_ACCOUNT_LOOKUP_FAILED", "Connector account details are unavailable", 502, true);
    }
    return account;
  }

  private async deleteConnectionGrant(keyAlias: string) {
    const result = await this.adminCall("/key/delete", {
      method: "POST",
      body: { key_aliases: [keyAlias] },
    }, true);
    if (!result.ok && result.status !== 404) throw this.upstreamError("MCP_CONNECTION_GRANT_REVOKE_FAILED", result.status, result.payload);
  }

  private executionCredential(operationId: string, leaseId: string) {
    const digest = createHmac("sha256", this.config.credentialSecret)
      .update(`lemmacomputer:litellm:execution:${operationId}:${leaseId}`)
      .digest("base64url");
    return `sk-oce-${digest}`;
  }

  async ensureGrant(input: { workspaceId: string; accessGeneration: number; identity: IdentityContext; agentId?: string; policy?: RuntimePolicy }): Promise<GatewayGrant> {
    const agentId = input.policy?.agentId ?? input.agentId;
    const modelAlias = input.policy?.modelAlias ?? this.modelAlias;
    const { clientModelAlias, transportModelAlias, providerAccessGroup, grantModels } = workspaceModelGrantProjection(
      input.identity.tenantId,
      modelAlias,
      input.policy,
    );
    const mcpServer = input.policy?.mcpServer ?? this.mcpServer;
    const allowedTools = input.policy?.allowedTools ?? this.allowedTools;
    const assignedMcpServers = input.policy?.mcpServers ?? [mcpServer];
    const projectedToolPermissions = input.policy?.mcpToolPermissions ?? { [mcpServer]: allowedTools };
    // Policy assignment and live connector availability are intentionally
    // separate. A disconnected assigned connector remains in the signed
    // policy, but it must not enter the callable LiteLLM key projection.
    const requestedActiveMcpServers = input.policy?.activeMcpServers ?? assignedMcpServers;
    const mcpServers = requestedActiveMcpServers.filter((serverName) => (
      Array.isArray(projectedToolPermissions[serverName])
      && projectedToolPermissions[serverName]!.length > 0
    ));
    const mcpToolPermissions = Object.fromEntries(mcpServers.map((serverName) => [
      serverName,
      projectedToolPermissions[serverName]!,
    ]));
    const projection = JSON.stringify({
      agentId,
      modelAlias,
      clientModelAlias,
      grantModels,
      transportModelAlias,
      mcpServer,
      allowedTools,
      assignedMcpServers,
      mcpServers,
      mcpToolPermissions,
      connectionProjectionHash: input.policy?.connectionProjectionHash ?? null,
      policyVersionId: input.policy?.policyVersionId ?? null,
      policyHash: input.policy?.policyHash ?? null,
      accessGeneration: input.accessGeneration,
    });
    const credential = this.credentialFor(input.workspaceId, agentId, input.accessGeneration);
    const gatewayUserId = this.userIdFor(input.identity);
    const gatewayAgentId = this.agentIdFor(input.workspaceId, agentId);
    const cached = this.workspaceGrantStates.get(credential);
    if (cached && cached.projection === projection && cached.expiresAt > Date.now() + this.workspaceGrantRenewalMs) {
      return { baseUrl: this.workspaceUrl, credential, modelAlias: cached.modelAlias, transportModelAlias: cached.transportModelAlias, expiresAt: new Date(cached.expiresAt).toISOString() };
    }
    const expiresAt = new Date(Date.now() + this.workspaceGrantTtlMs);
    const durationSeconds = Math.max(60, Math.ceil(this.workspaceGrantTtlMs / 1_000));
    const grant = {
      key: credential,
      key_alias: this.workspaceKeyAlias(gatewayAgentId, input.accessGeneration),
      key_type: "llm_api",
      user_id: gatewayUserId,
      agent_id: gatewayAgentId,
      duration: `${durationSeconds}s`,
      models: grantModels,
      rpm_limit: WORKSPACE_RPM_LIMIT,
      max_parallel_requests: WORKSPACE_MAX_PARALLEL_REQUESTS,
      metadata: {
        lemmacomputer_workspace_id: input.workspaceId,
        lemmacomputer_access_generation: input.accessGeneration,
        lemmacomputer_tenant_id: input.identity.tenantId,
        lemmacomputer_subject_id: input.identity.subjectId,
        lemmacomputer_agent_id: agentId ?? `workspace-default:${input.workspaceId}`,
        lemmacomputer_policy_model_alias: modelAlias,
        lemmacomputer_client_model_alias: clientModelAlias,
        lemmacomputer_provider_access_group: providerAccessGroup,
        lemmacomputer_governed_routing: transportModelAlias === "lemmacomputer-auto",
        ...(input.policy ? {
          lemmacomputer_policy_version_id: input.policy.policyVersionId,
          lemmacomputer_policy_version: input.policy.policyVersion,
          lemmacomputer_policy_hash: input.policy.policyHash,
        } : {}),
        lemmacomputer_gateway_user_id: gatewayUserId,
        lemmacomputer_gateway_agent_id: gatewayAgentId,
        lemmacomputer_mcp_servers: mcpServers,
      },
      object_permission: {
        mcp_servers: mcpServers,
        mcp_tool_permissions: mcpToolPermissions,
      },
    };

    const existing = await this.adminCall(`/key/list?return_full_object=true&key_alias=${encodeURIComponent(grant.key_alias)}`, { method: "GET" }, true);
    if (!existing.ok) throw this.upstreamError("GATEWAY_GRANT_FAILED", existing.status, existing.payload);
    const keys = Array.isArray(asObject(existing.payload).keys) ? asObject(existing.payload).keys as unknown[] : [];
    const tokenHash = createHash("sha256").update(credential).digest("hex");
    const current = keys.map(asObject).find((key) => key.token === tokenHash);
    const identityMatches = (key: JsonObject | undefined) => {
      const metadata = asObject(key?.metadata);
      return key?.user_id === gatewayUserId
        && key?.agent_id === gatewayAgentId
        && key?.max_budget == null
        && key?.budget_duration == null
        && key?.tpm_limit == null
        && metadata.lemmacomputer_tenant_id === input.identity.tenantId
        && metadata.lemmacomputer_subject_id === input.identity.subjectId
        && metadata.lemmacomputer_workspace_id === input.workspaceId
        && metadata.lemmacomputer_access_generation === input.accessGeneration
        && metadata.lemmacomputer_agent_id === (agentId ?? `workspace-default:${input.workspaceId}`)
        && (!input.policy || (metadata.lemmacomputer_policy_version_id === input.policy.policyVersionId
          && metadata.lemmacomputer_policy_hash === input.policy.policyHash));
    };
    const modelProjectionMatches = (key: JsonObject | undefined) => {
      const metadata = asObject(key?.metadata);
      return sameStrings(stringArray(key?.models), grantModels)
        && metadata.lemmacomputer_policy_model_alias === modelAlias
        && metadata.lemmacomputer_client_model_alias === clientModelAlias
        && (metadata.lemmacomputer_provider_access_group ?? null) === providerAccessGroup;
    };
    const currentIdentityMatches = identityMatches(current);
    const currentModelProjectionMatches = modelProjectionMatches(current);
    const replaceForModelChange = currentIdentityMatches && !currentModelProjectionMatches;
    if (keys.length && (!currentIdentityMatches || replaceForModelChange)) {
      const removed = await this.adminCall("/key/delete", {
        method: "POST",
        body: { key_aliases: [grant.key_alias] },
      }, true);
      if (!removed.ok && removed.status !== 404) {
        throw this.upstreamError("GATEWAY_GRANT_IDENTITY_MISMATCH", removed.status, removed.payload);
      }
    }
    const updateExisting = currentIdentityMatches && currentModelProjectionMatches;
    const reconciled = updateExisting
      ? await this.adminCall("/key/update", { method: "POST", body: grant }, true)
      : await this.adminCall("/key/generate", { method: "POST", body: grant }, true);
    if (!reconciled.ok) {
      throw this.upstreamError(
        currentIdentityMatches ? "GATEWAY_GRANT_FAILED" : "GATEWAY_GRANT_IDENTITY_MISMATCH",
        reconciled.status,
        reconciled.payload,
      );
    }
    if (replaceForModelChange) {
      const [verified, available] = await Promise.all([
        this.adminCall(`/key/list?return_full_object=true&key_alias=${encodeURIComponent(grant.key_alias)}`, { method: "GET" }, true),
        this.dataCall("/v1/models", credential),
      ]);
      const verifiedKeys = Array.isArray(asObject(verified.payload).keys) ? asObject(verified.payload).keys as unknown[] : [];
      const verifiedKey = verifiedKeys.map(asObject).find((key) => key.token === tokenHash);
      const modelIds = Array.isArray(asObject(available.payload).data)
        ? (asObject(available.payload).data as unknown[]).map((item) => String(asObject(item).id ?? ""))
        : [];
      if (
        !verified.ok
        || !available.ok
        || !identityMatches(verifiedKey)
        || !modelProjectionMatches(verifiedKey)
        || !modelIds.includes(transportModelAlias)
      ) {
        await this.adminCall("/key/delete", {
          method: "POST",
          body: { key_aliases: [grant.key_alias] },
        }, true).catch(() => undefined);
        this.workspaceGrantStates.delete(credential);
        throw new LemmaComputerError(
          "GATEWAY_GRANT_FAILED",
          "The model gateway did not apply the workspace model grant",
          502,
          true,
        );
      }
    }
    this.workspaceGrantStates.set(credential, { expiresAt: expiresAt.getTime(), projection, modelAlias: clientModelAlias, transportModelAlias, accessGeneration: input.accessGeneration });
    return { baseUrl: this.workspaceUrl, credential, modelAlias: clientModelAlias, transportModelAlias, expiresAt: expiresAt.toISOString() };
  }

  async readiness(workspaceId: string, agentId?: string, policy?: RuntimePolicy, accessGeneration?: number): Promise<GatewayReadiness> {
    const effectiveAgentId = policy?.agentId ?? agentId;
    const modelAlias = policy?.modelAlias ?? this.modelAlias;
    const activeMcpServers = policy?.activeMcpServers ?? policy?.mcpServers ?? [policy?.mcpServer ?? this.mcpServer];
    const projectedToolPermissions = policy?.mcpToolPermissions ?? {
      [policy?.mcpServer ?? this.mcpServer]: policy?.allowedTools ?? this.allowedTools,
    };
    const allowedTools = [...new Set(activeMcpServers.flatMap((serverName) => (
      projectedToolPermissions[serverName] ?? []
    )))];
    const credential = this.credentialFor(workspaceId, effectiveAgentId, accessGeneration);
    const gatewayModelAlias = this.workspaceGrantStates.get(credential)?.transportModelAlias ?? (modelAlias === "lemmacomputer-auto" ? "lemmacomputer-auto" : desktopModelAlias(modelAlias, policy));
    const [models, discovery, modelRoute] = await Promise.all([
      this.dataCall("/v1/models", credential),
      this.discoverToolsForServers(credential, activeMcpServers),
      this.modelRoute(credential, workspaceId, effectiveAgentId, modelAlias, accessGeneration ?? this.workspaceGrantStates.get(credential)?.accessGeneration),
    ]);
    if (!models.ok) this.workspaceGrantStates.delete(credential);
    const modelIds = Array.isArray(asObject(models.payload).data)
      ? (asObject(models.payload).data as unknown[]).map((item) => String(asObject(item).id ?? ""))
      : [];
    const toolNames = discovery.tools.map((item) => String(asObject(item).name ?? ""));
    return {
      models: models.ok && modelIds.includes(gatewayModelAlias) ? "ready" : "failed",
      tools: discovery.failedServers.length === 0 && allowedTools.every((tool) => toolNames.includes(tool)) ? "ready" : "failed",
      modelRoute: {
        ...modelRoute,
        status: models.ok && modelIds.includes(gatewayModelAlias) ? "ready" : "failed",
      },
    };
  }

  async modelCapabilities(modelAlias: string): Promise<GatewayModelCapabilities> {
    const cached = this.modelCapabilityStates.get(modelAlias);
    if (cached && cached.expiresAt > Date.now()) return cached.capabilities;
    if (modelAlias === "lemmacomputer-auto") {
      // Auto is a synthetic governed route rather than a LiteLLM provider
      // model. The router includes image requirements in task classification
      // and selects only an eligible vision-capable deployment for them.
      const capabilities = { vision: true };
      this.modelCapabilityStates.set(modelAlias, { expiresAt: Date.now() + 60_000, capabilities });
      return capabilities;
    }
    const managedProvider = managedProviderForAlias(modelAlias);
    const managedModel = managedProvider && managedProviderModels[managedProvider].find((model) => model.alias === modelAlias);
    if (managedModel) {
      const capabilities = { vision: managedModel.vision };
      this.modelCapabilityStates.set(modelAlias, { expiresAt: Date.now() + 60_000, capabilities });
      return capabilities;
    }
    const result = await this.adminCall("/model/info", { method: "GET" });
    const models = Array.isArray(asObject(result.payload).data)
      ? asObject(result.payload).data as unknown[]
      : [];
    const selected = models.map(asObject).find((item) => item.model_name === modelAlias);
    const supportsVision = asObject(selected?.model_info).supports_vision;
    if (typeof supportsVision !== "boolean") {
      throw new LemmaComputerError(
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

  async configureBedrockApiKeyRoute(input: BedrockApiKeyRouteProvisioningInput): Promise<BedrockApiKeyRoute> {
    const configuration = bedrockApiKeyRouteConfigurationSchema.parse({
      apiKey: input.apiKey,
      region: input.region,
      modelProfileId: input.modelProfileId,
    });
    if (!BEDROCK_CREDENTIAL_NAME.test(input.credentialName)) {
      throw new LemmaComputerError(
        "BEDROCK_CREDENTIAL_NAME_INVALID",
        "The Bedrock credential reference is not an approved internal name",
        400,
      );
    }

    const profile = this.bedrockProfile(configuration);
    const credential = {
      credential_name: input.credentialName,
      credential_info: {
        provider: "bedrock",
        route_alias: bedrockApiKeyRouteAlias,
        region: configuration.region,
        model_profile_id: profile.id,
      },
      // LiteLLM encrypts this value in its credential table. The model
      // deployment below references only the credential name, never this key.
      credential_values: { api_key: configuration.apiKey },
    };
    let createdCredential = false;
    const patchedCredential = await this.adminCall(
      `/credentials/${encodeURIComponent(input.credentialName)}`,
      { method: "PATCH", body: credential },
      true,
    );
    if (patchedCredential.status === 404) {
      const createdCredentialResult = await this.adminCall("/credentials", { method: "POST", body: credential }, true);
      if (!createdCredentialResult.ok) {
        throw this.bedrockUpstreamError(createdCredentialResult.status, createdCredentialResult.payload);
      }
      createdCredential = true;
    } else if (!patchedCredential.ok) {
      throw this.bedrockUpstreamError(patchedCredential.status, patchedCredential.payload);
    }

    const deployment = this.bedrockDeployment(profile, configuration.region, input.credentialName);
    const updatedModel = await this.adminCall(
      `/model/${encodeURIComponent(BEDROCK_MODEL_ID)}/update`,
      { method: "PATCH", body: deployment },
      true,
    );
    const savedModel = updatedModel.status === 404
      ? await this.adminCall("/model/new", { method: "POST", body: deployment }, true)
      : updatedModel;
    if (!savedModel.ok) {
      if (createdCredential) {
        await this.adminCall(
          `/credentials/${encodeURIComponent(input.credentialName)}`,
          { method: "DELETE" },
          true,
        ).catch(() => undefined);
      }
      throw this.bedrockUpstreamError(savedModel.status, savedModel.payload);
    }

    this.modelCapabilityStates.delete(bedrockApiKeyRouteAlias);
    return this.bedrockRoute(profile, configuration.region);
  }

  async testBedrockApiKeyRoute(input: BedrockApiKeyRouteSelection): Promise<BedrockApiKeyRouteTestResult> {
    const profile = this.bedrockProfile(input);
    const credential = `sk-ocb-${randomBytes(24).toString("base64url")}`;
    const keyAlias = `lemmacomputer-bedrock-probe-${randomBytes(12).toString("hex")}`;
    const grant = await this.adminCall("/key/generate", {
      method: "POST",
      body: {
        key: credential,
        key_alias: keyAlias,
        key_type: "llm_api",
        duration: "60s",
        models: [bedrockApiKeyRouteAlias],
        rpm_limit: 2,
        tpm_limit: 4_096,
        max_parallel_requests: 1,
        metadata: {
          lemmacomputer_purpose: "bedrock-route-test",
          lemmacomputer_non_billable_exemption: "provider-route-test-v1",
          lemmacomputer_model_alias: bedrockApiKeyRouteAlias,
        },
      },
    }, true);
    if (!grant.ok) throw this.bedrockUpstreamError(grant.status, grant.payload);

    try {
      const tested = await this.dataCall("/v1/chat/completions", credential, {
        method: "POST",
        body: {
          model: bedrockApiKeyRouteAlias,
          messages: [{ role: "user", content: "Reply exactly with OK." }],
          max_tokens: 8,
          temperature: 0,
        },
      });
      if (!tested.ok) throw this.bedrockUpstreamError(tested.status, tested.payload);
      return {
        ...this.bedrockRoute(profile, input.region),
        usage: this.bedrockUsage(tested.payload),
      };
    } finally {
      await this.adminCall("/key/delete", { method: "POST", body: { keys: [credential] } }, true).catch(() => undefined);
    }
  }

  private bedrockProfile(input: BedrockApiKeyRouteSelection): BedrockApiKeyModelProfile {
    const profile = approvedBedrockApiKeyModelProfiles.find((candidate) => candidate.id === input.modelProfileId);
    if (!profile || !profile.regions.includes(input.region)) {
      throw new LemmaComputerError(
        "BEDROCK_ROUTE_UNAPPROVED",
        "The selected Bedrock region or inference profile is not approved",
        400,
      );
    }
    return profile;
  }

  private bedrockDeployment(profile: BedrockApiKeyModelProfile, region: BedrockApiKeyRouteConfiguration["region"], credentialName: string): JsonObject {
    return {
      model_name: bedrockApiKeyRouteAlias,
      litellm_params: {
        model: profile.litellmModel,
        litellm_credential_name: credentialName,
        aws_region_name: region,
        timeout: BEDROCK_ROUTE_TIMEOUT_SECONDS,
        max_retries: BEDROCK_ROUTE_MAX_RETRIES,
      },
      model_info: {
        id: BEDROCK_MODEL_ID,
        lemmacomputer_provider: "bedrock",
        lemmacomputer_provider_account_id: credentialName,
        lemmacomputer_base_model: profile.litellmModel,
        lemmacomputer_deployment_id: BEDROCK_MODEL_ID,
        lemmacomputer_region: region,
        lemmacomputer_provider_service_tier: "standard",
        supports_vision: profile.capabilities.vision,
        supports_function_calling: profile.capabilities.toolCalls,
        supports_response_schema: profile.capabilities.structuredOutput,
        supports_streaming: profile.capabilities.streaming,
        max_input_tokens: profile.limits.contextWindowTokens,
        max_output_tokens: profile.limits.maxOutputTokens,
        input_cost_per_token: profile.pricing.inputUsdPerMillionTokens / 1_000_000,
        output_cost_per_token: profile.pricing.outputUsdPerMillionTokens / 1_000_000,
      },
    };
  }

  private bedrockRoute(profile: BedrockApiKeyModelProfile, region: BedrockApiKeyRouteConfiguration["region"]): BedrockApiKeyRoute {
    return {
      alias: bedrockApiKeyRouteAlias,
      region,
      modelProfileId: profile.id,
      capabilities: { ...profile.capabilities },
      limits: { ...profile.limits },
      pricing: { ...profile.pricing },
    };
  }

  private bedrockUsage(payload: unknown): BedrockApiKeyRouteTestResult["usage"] {
    const usage = asObject(asObject(payload).usage);
    const promptTokens = usage.prompt_tokens;
    const completionTokens = usage.completion_tokens;
    const totalTokens = usage.total_tokens;
    const isTokenCount = (value: unknown): value is number => (
      typeof value === "number" && Number.isInteger(value) && value >= 0
    );
    if (!isTokenCount(promptTokens) || !isTokenCount(completionTokens) || !isTokenCount(totalTokens)) {
      throw new LemmaComputerError(
        "BEDROCK_USAGE_UNAVAILABLE",
        "The Bedrock route did not return verifiable usage metadata",
        502,
        true,
      );
    }
    return { promptTokens, completionTokens, totalTokens };
  }

  private bedrockUpstreamError(status: number, payload: unknown): LemmaComputerError {
    const body = asObject(payload);
    const detail = asObject(body.detail);
    const error = asObject(body.error);
    const diagnostic = [
      typeof body.error === "string" ? body.error : undefined,
      typeof body.message === "string" ? body.message : undefined,
      typeof body.detail === "string" ? body.detail : undefined,
      typeof detail.error === "string" ? detail.error : undefined,
      typeof detail.message === "string" ? detail.message : undefined,
      typeof error.message === "string" ? error.message : undefined,
      typeof error.code === "string" ? error.code : undefined,
    ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();

    if (status === 429 || /throttl|rate.?limit/.test(diagnostic)) {
      return new LemmaComputerError("BEDROCK_THROTTLED", "Bedrock is throttling this route; retry shortly", 429, true);
    }
    if (status === 408 || status === 504 || /timeout|timed out/.test(diagnostic)) {
      return new LemmaComputerError("BEDROCK_TIMEOUT", "Bedrock did not respond before the route timeout", 504, true);
    }
    if (/invalid.*(?:api|bearer).*key|(?:api|bearer).*key.*invalid|authentication/.test(diagnostic) || status === 401) {
      return new LemmaComputerError("BEDROCK_API_KEY_INVALID", "Bedrock rejected the API key", 401);
    }
    if (/marketplace|eula|subscription|model access|access to (?:the )?model|enable.*model/.test(diagnostic)) {
      return new LemmaComputerError(
        "BEDROCK_MODEL_ACCESS_REQUIRED",
        "Enable the approved model and accept its applicable Bedrock terms before retrying",
        403,
      );
    }
    if (/unsupported.*region|region.*(?:unsupported|not supported|invalid)/.test(diagnostic)) {
      return new LemmaComputerError("BEDROCK_REGION_UNSUPPORTED", "The approved Bedrock inference profile is not available in that region", 422);
    }
    if (/accessdenied|access denied|not authorized|permission/.test(diagnostic)) {
      return new LemmaComputerError("BEDROCK_ACCESS_DENIED", "Bedrock denied access to the approved route", 403);
    }
    if (status >= 500) {
      return new LemmaComputerError("BEDROCK_ROUTE_UNAVAILABLE", "The Bedrock route is temporarily unavailable", 503, true);
    }
    return new LemmaComputerError("BEDROCK_ROUTE_REJECTED", "Bedrock rejected the route configuration or test request", status || 502);
  }

  private async modelRoute(credential: string, workspaceId: string, agentId: string | undefined, modelAlias: string, accessGeneration?: number): Promise<GatewayModelRoute> {
    const gatewayAgentId = this.agentIdFor(workspaceId, agentId);
    const keyAlias = accessGeneration === undefined
      ? `lemmacomputer-agent-${gatewayAgentId}`
      : this.workspaceKeyAlias(gatewayAgentId, accessGeneration);
    const [result, capabilities] = await Promise.all([
      this.adminCall(`/key/list?return_full_object=true&key_alias=${encodeURIComponent(keyAlias)}`, { method: "GET" }),
      this.modelCapabilities(modelAlias),
    ]);
    const keys = Array.isArray(asObject(result.payload).keys) ? asObject(result.payload).keys as unknown[] : [];
    const tokenHash = createHash("sha256").update(credential).digest("hex");
    const key = keys.map(asObject).find((item) => item.token === tokenHash);
    if (!key) throw new LemmaComputerError("GATEWAY_USAGE_UNAVAILABLE", "The model route usage state is unavailable", 502, true);
    const numberOr = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
    const positiveNumberOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    return {
      alias: modelAlias,
      status: "ready",
      fallback: "none",
      capabilities,
      limits: {
        requestsPerMinute: numberOr(key.rpm_limit, WORKSPACE_RPM_LIMIT),
        tokensPerMinute: positiveNumberOrNull(key.tpm_limit),
        maxParallelRequests: numberOr(key.max_parallel_requests, WORKSPACE_MAX_PARALLEL_REQUESTS),
      },
    };
  }

  async test(workspaceId: string, agentId?: string, policy?: RuntimePolicy, accessGeneration?: number): Promise<GatewayTestResult> {
    const effectiveAgentId = policy?.agentId ?? agentId;
    const modelAlias = policy?.modelAlias ?? this.modelAlias;
    const credential = this.credentialFor(workspaceId, effectiveAgentId, accessGeneration);
    const activeMcpServers = policy?.activeMcpServers ?? policy?.mcpServers ?? [policy?.mcpServer ?? this.mcpServer];
    const [readiness, discovery] = await Promise.all([
      this.readiness(workspaceId, effectiveAgentId, policy, accessGeneration),
      this.discoverToolsForServers(credential, activeMcpServers),
    ]);
    if (readiness.models !== "ready" || !readiness.modelRoute) throw new LemmaComputerError("MODEL_ROUTE_FAILED", "The assigned model route is unavailable", 502, true);
    // Model routing and optional MCP connectors have independent health. A stale
    // or disconnected connector must not make a working model gateway look down.
    const tools = discovery.tools.length
      ? discovery.tools.map((item) => {
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
    const gatewayUserId = this.userIdFor({ tenantId: input.tenantId, subjectId: input.subjectId, audience: "lemmacomputer-control" });
    const gatewayAgentId = this.agentIdFor(input.workspaceId, input.agentId);
    const grant = await this.adminCall("/key/generate", {
      method: "POST",
      body: {
        key: credential,
        key_alias: `lemmacomputer-execution-${input.operationId}`,
        key_type: "llm_api",
        user_id: gatewayUserId,
        agent_id: gatewayAgentId,
        duration: "60s",
        models: [],
        rpm_limit: 4,
        metadata: {
          lemmacomputer_tenant_id: input.tenantId,
          lemmacomputer_subject_id: input.subjectId,
          lemmacomputer_workspace_id: input.workspaceId,
          lemmacomputer_access_generation: input.accessGeneration,
          lemmacomputer_agent_id: input.agentId ?? `workspace-default:${input.workspaceId}`,
          lemmacomputer_gateway_user_id: gatewayUserId,
          lemmacomputer_gateway_agent_id: gatewayAgentId,
          lemmacomputer_operation_id: input.operationId,
          lemmacomputer_operation_digest: input.operationDigest,
          lemmacomputer_lease_id: input.leaseId,
          lemmacomputer_mcp_servers: [input.serverName],
        },
        object_permission: {
          mcp_servers: [input.serverName],
          mcp_tool_permissions: { [input.serverName]: [input.toolName] },
        },
      },
    });
    if (!grant.ok) throw this.upstreamError("GATEWAY_EXECUTION_GRANT_FAILED", grant.status, grant.payload);
    try {
      const availableTools = await this.dataCall(
        `/mcp-rest/tools/list?mcp_server_name=${encodeURIComponent(input.serverName)}`,
        credential,
      );
      if (!availableTools.ok) throw this.upstreamError("GATEWAY_EXECUTION_DISCOVERY_FAILED", availableTools.status, availableTools.payload);
      const tools = Array.isArray(asObject(availableTools.payload).tools) ? asObject(availableTools.payload).tools as unknown[] : [];
      const selectedTool = tools.map(asObject).find((tool) => tool.name === input.toolName);
      const selectedServerId = asObject(selectedTool?.mcp_info).server_id;
      if (typeof selectedServerId !== "string" || !selectedServerId) {
        throw new LemmaComputerError("GATEWAY_EXECUTION_TOOL_NOT_ASSIGNED", "The exact governed tool is not assigned to this execution", 403);
      }
      const called = await this.dataCall("/mcp-rest/tools/call", credential, {
        method: "POST",
        body: { server_id: selectedServerId, name: input.toolName, arguments: input.arguments as JsonObject },
      });
      if (!called.ok) throw this.upstreamError("GATEWAY_TOOL_EXECUTION_FAILED", called.status, called.payload);
      const payload = asObject(called.payload);
      const content = Array.isArray(payload.content) ? payload.content : [];
      const firstText = content.map(asObject).find((item) => item.type === "text" && typeof item.text === "string")?.text;
      if (payload.isError === true) {
        const failureSummary = typeof firstText === "string" && firstText.trim()
          ? firstText.trim().slice(0, 240)
          : "The governed Microsoft 365 tool reported a failure";
        throw new LemmaComputerError("UPSTREAM_TOOL_FAILED", failureSummary, 502, true);
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
    const gatewayAgentId = this.agentIdFor(workspaceId, agentId);
    const listed = await this.adminCall("/key/list?return_full_object=true", { method: "GET" }, true);
    if (!listed.ok) throw this.upstreamError("GATEWAY_REVOKE_FAILED", listed.status, listed.payload);
    const keys = Array.isArray(asObject(listed.payload).keys) ? asObject(listed.payload).keys as unknown[] : [];
    const aliases = keys.map(asObject)
      .filter((key) => {
        const metadata = asObject(key.metadata);
        return metadata.lemmacomputer_workspace_id === workspaceId
          && metadata.lemmacomputer_gateway_agent_id === gatewayAgentId;
      })
      .map((key) => key.key_alias)
      .filter((alias): alias is string => typeof alias === "string" && alias.length > 0);
    const result = aliases.length
      ? await this.adminCall("/key/delete", { method: "POST", body: { key_aliases: aliases } }, true)
      : { ok: true, status: 204, payload: {} };
    this.workspaceGrantStates.clear();
    if (!result.ok && result.status !== 404) throw this.upstreamError("GATEWAY_REVOKE_FAILED", result.status, result.payload);
  }

  async revokeWorkspace(workspaceId: string, accessGeneration?: number) {
    const listed = await this.adminCall("/key/list?return_full_object=true", { method: "GET" }, true);
    if (!listed.ok) throw this.upstreamError("GATEWAY_REVOKE_FAILED", listed.status, listed.payload);
    const keys = Array.isArray(asObject(listed.payload).keys) ? asObject(listed.payload).keys as unknown[] : [];
    const aliases = keys.map(asObject)
      .filter((key) => {
        const metadata = asObject(key.metadata);
        if (metadata.lemmacomputer_workspace_id !== workspaceId) return false;
        if (accessGeneration === undefined) return true;
        const keyGeneration = Number(metadata.lemmacomputer_access_generation);
        return !Number.isInteger(keyGeneration) || keyGeneration <= accessGeneration;
      })
      .map((key) => key.key_alias)
      .filter((alias): alias is string => typeof alias === "string" && alias.length > 0);
    if (aliases.length) {
      const deleted = await this.adminCall("/key/delete", { method: "POST", body: { key_aliases: aliases } }, true);
      if (!deleted.ok && deleted.status !== 404) throw this.upstreamError("GATEWAY_REVOKE_FAILED", deleted.status, deleted.payload);
    }
    this.workspaceGrantStates.clear();
  }

  private workspaceKeyAlias(gatewayAgentId: string, accessGeneration: number) {
    return `lemmacomputer-agent-${gatewayAgentId}-g${accessGeneration}`;
  }

  private async discoverToolsForServers(credential: string, serverNames: string[]) {
    if (serverNames.length === 0) return { tools: [] as unknown[], failedServers: [] as string[] };
    const results = await Promise.all(serverNames.map(async (serverName) => {
      try {
        return {
          serverName,
          result: await this.dataCall(
            `/mcp-rest/tools/list?mcp_server_name=${encodeURIComponent(serverName)}`,
            credential,
          ),
        };
      } catch {
        return { serverName, result: null };
      }
    }));
    const tools: unknown[] = [];
    const failedServers: string[] = [];
    for (const { serverName, result } of results) {
      if (!result) {
        failedServers.push(serverName);
        continue;
      }
      const payload = asObject(result.payload);
      const failed = !result.ok || (typeof payload.error === "string" && payload.error.length > 0);
      if (failed) {
        failedServers.push(serverName);
        continue;
      }
      if (Array.isArray(payload.tools)) tools.push(...payload.tools);
    }
    return { tools, failedServers };
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
      const response = await this.adminFetch(url, {
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
      throw new LemmaComputerError("GATEWAY_UNAVAILABLE", "The model gateway is unavailable", 503, true);
    }
  }

  private upstreamError(code: string, status: number, payload: unknown, safeMessage?: string) {
    const detail = asObject(asObject(payload).detail);
    const error = asObject(payload).error;
    const message = safeMessage ?? (typeof error === "string"
      ? error
      : typeof detail.error === "string"
        ? detail.error
        : "The model gateway rejected the request");
    return new LemmaComputerError(code, message, status >= 500 ? 502 : status, status >= 500);
  }
}
