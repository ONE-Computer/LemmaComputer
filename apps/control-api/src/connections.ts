import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OneComputerError, runtimePolicySchema, type IdentityContext, type RuntimePolicy } from "@onecomputer/contracts";
import type {
  McpConnectorAdministrationGateway,
  OAuthConnectionGateway,
  OAuthConnectionStatus,
} from "@onecomputer/litellm-adapter";
import {
  MemoryConnectorRegistryStore,
  type ConnectorCategory,
  type ConnectorRegistryStore,
} from "@onecomputer/workspace-store";
import { connectorCatalog, type ConnectorDefinition } from "./connector-catalog.js";

type PendingConnection = {
  tenantId: string;
  subjectId: string;
  connectorId: string;
  codeVerifier: string;
  expiresAt: number;
};

type PendingConnectorDiscovery = {
  inputDigest: string;
  authorizationOrigin: string;
  expiresAt: number;
};

type ConnectionServiceOptions = {
  publicWebUrl: string;
  authorizationOrigin: string;
  liteLlmPublicUrl?: string;
  registry?: ConnectorRegistryStore;
  sessionTtlMs?: number;
  now?: () => number;
};

export type CreateConnectorInput = {
  name: string;
  shortDescription: string;
  description: string;
  category: ConnectorCategory;
  services: string[];
  endpointUrl: string;
  scopes: string[];
  clientId?: string;
  clientSecret?: string;
  discoveryToken?: string;
};

const stateDigest = (state: string) => createHash("sha256").update(state).digest("base64url");
const connectorInputDigest = (input: CreateConnectorInput) => createHash("sha256").update(JSON.stringify({
  name: input.name.trim(),
  shortDescription: input.shortDescription.trim(),
  description: input.description.trim(),
  category: input.category,
  services: input.services,
  endpointUrl: new URL(input.endpointUrl).toString(),
  scopes: input.scopes,
  clientId: input.clientId,
  clientSecret: input.clientSecret,
})).digest("base64url");

export class McpConnectionService {
  private readonly sessions = new Map<string, PendingConnection>();
  private readonly connectorDiscoveries = new Map<string, PendingConnectorDiscovery>();
  private readonly publicWebUrl: string;
  private readonly liteLlmPublicUrl: string;
  private readonly microsoftAuthorizationOrigin: string;
  private readonly registry: ConnectorRegistryStore;
  private readonly projectionCache = new Map<string, { expiresAt: number; policy: RuntimePolicy }>();
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly gateway: OAuthConnectionGateway & Partial<McpConnectorAdministrationGateway>,
    options: ConnectionServiceOptions,
  ) {
    const publicWebUrl = new URL(options.publicWebUrl);
    if (!["http:", "https:"].includes(publicWebUrl.protocol)) throw new Error("PUBLIC_WEB_URL must use http or https");
    this.publicWebUrl = publicWebUrl.toString().replace(/\/$/, "");
    this.liteLlmPublicUrl = new URL(options.liteLlmPublicUrl ?? "http://localhost:4000").toString().replace(/\/$/, "");
    this.microsoftAuthorizationOrigin = new URL(options.authorizationOrigin).origin;
    this.registry = options.registry ?? new MemoryConnectorRegistryStore();
    this.sessionTtlMs = options.sessionTtlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  async list(identity: IdentityContext) {
    const connectors = await this.connectors(identity.tenantId);
    const connections = await Promise.all(connectors.map(async (connector) => {
      try {
        const status = await this.gateway.userOAuthConnectionStatus(identity, connector.serverName);
        return { ...this.publicConnector(connector), available: true, ...status };
      } catch (error) {
        const unavailable = error instanceof OneComputerError
          && ["MCP_CONNECTION_NOT_REGISTERED", "M365_MCP_NOT_REGISTERED"].includes(error.code);
        return {
          ...this.publicConnector(connector),
          available: !unavailable,
          state: "unavailable" as const,
          connectedAt: null,
          expiresAt: null,
          account: null,
        };
      }
    }));
    return { connections };
  }

  async start(identity: IdentityContext, connectorId = "microsoft-365") {
    const connector = await this.connector(identity.tenantId, connectorId);
    this.pruneExpired();
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const key = stateDigest(state);
    this.sessions.set(key, {
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      connectorId: connector.id,
      codeVerifier,
      expiresAt: this.now() + this.sessionTtlMs,
    });
    try {
      return await this.gateway.beginUserOAuthConnection({
        identity,
        serverName: connector.serverName,
        redirectUri: `${this.publicWebUrl}/api/v1/connections/${connector.id}/callback`,
        state,
        codeChallenge,
        authorizationOrigins: connector.authorizationOrigins,
      });
    } catch (error) {
      this.sessions.delete(key);
      throw error;
    }
  }

  async complete(
    identity: IdentityContext,
    connectorId: string,
    input: { state?: string; code?: string; error?: string },
  ): Promise<OAuthConnectionStatus> {
    const connector = await this.connector(identity.tenantId, connectorId);
    this.pruneExpired();
    if (!input.state) throw new OneComputerError("MCP_OAUTH_STATE_MISSING", `The ${connector.name} connection could not be verified`, 400);
    const key = stateDigest(input.state);
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    if (!pending) throw new OneComputerError("MCP_OAUTH_STATE_INVALID", `The ${connector.name} connection expired or was already used`, 400);
    if (pending.expiresAt <= this.now()) throw new OneComputerError("MCP_OAUTH_STATE_EXPIRED", `The ${connector.name} connection expired; please try again`, 400);
    if (pending.tenantId !== identity.tenantId || pending.subjectId !== identity.subjectId) {
      throw new OneComputerError("MCP_OAUTH_IDENTITY_MISMATCH", `The ${connector.name} connection belongs to another user`, 403);
    }
    if (pending.connectorId !== connector.id) {
      throw new OneComputerError("MCP_OAUTH_CONNECTOR_MISMATCH", "The connection returned to a different connector", 400);
    }
    if (input.error) throw new OneComputerError("MCP_OAUTH_DENIED", `${connector.name} access was not granted`, 400);
    if (!input.code || input.code.length > 4096) throw new OneComputerError("MCP_OAUTH_CODE_INVALID", `${connector.name} returned an invalid authorization response`, 400);
    const result = await this.gateway.completeUserOAuthConnection({
      identity,
      serverName: connector.serverName,
      code: input.code,
      codeVerifier: pending.codeVerifier,
    });
    this.invalidateProjection(identity);
    return result;
  }

  async status(identity: IdentityContext, connectorId = "microsoft-365") {
    return this.gateway.userOAuthConnectionStatus(identity, (await this.connector(identity.tenantId, connectorId)).serverName);
  }

  async disconnect(identity: IdentityContext, connectorId = "microsoft-365") {
    const connector = await this.connector(identity.tenantId, connectorId);
    const result = await this.gateway.disconnectUserOAuthConnection(identity, connector.serverName);
    this.invalidateProjection(identity);
    return result;
  }

  resultUrl(connectorId: string, result: "connected" | "error", reason?: string) {
    const url = new URL(this.publicWebUrl);
    url.searchParams.set("view", "connections");
    if (connectorId === "microsoft-365") url.searchParams.set("m365", result);
    else {
      url.searchParams.set("connector", connectorId);
      url.searchParams.set("connection", result);
    }
    if (reason) url.searchParams.set("reason", reason);
    return url.toString();
  }

  async adminList(identity: IdentityContext) {
    return { connectors: await this.connectors(identity.tenantId) };
  }

  async discoverConnector(input: CreateConnectorInput) {
    this.validateCustomConnector(input);
    this.pruneExpired();
    const discovered = await this.administratorGateway().discoverOAuthMcpServer({
      name: input.name,
      description: input.description,
      url: input.endpointUrl,
      scopes: input.scopes,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      callbackUrl: `${this.liteLlmPublicUrl}/callback`,
    });
    const discoveryToken = randomBytes(32).toString("base64url");
    this.connectorDiscoveries.set(stateDigest(discoveryToken), {
      inputDigest: connectorInputDigest(input),
      authorizationOrigin: discovered.authorizationOrigin,
      expiresAt: this.now() + this.sessionTtlMs,
    });
    return { ...discovered, discoveryToken };
  }

  async createConnector(identity: IdentityContext, createdBy: string, input: CreateConnectorInput) {
    this.validateCustomConnector(input);
    this.pruneExpired();
    const administrator = this.administratorGateway();
    if (!input.discoveryToken) {
      throw new OneComputerError("MCP_CONNECTOR_DISCOVERY_REQUIRED", "Check the connector server before adding it", 400);
    }
    const discoveryKey = stateDigest(input.discoveryToken);
    const discovered = this.connectorDiscoveries.get(discoveryKey);
    this.connectorDiscoveries.delete(discoveryKey);
    if (!discovered || discovered.expiresAt <= this.now() || discovered.inputDigest !== connectorInputDigest(input)) {
      throw new OneComputerError("MCP_CONNECTOR_DISCOVERY_INVALID", "The connector check expired or its details changed; check the server again", 400);
    }
    const slug = input.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    if (!slug) throw new OneComputerError("MCP_CONNECTOR_NAME_INVALID", "Enter a connector name using letters or numbers", 400);
    const existing = await this.connectors(identity.tenantId);
    const id = existing.some((connector) => connector.id === slug)
      ? `${slug}-${createHash("sha256").update(input.endpointUrl).digest("hex").slice(0, 8)}`
      : slug;
    const serverId = randomUUID();
    const serverName = `onecomputer_${id.replace(/-/g, "_")}`.slice(0, 96);
    if (existing.some((connector) => connector.serverName === serverName)) {
      throw new OneComputerError("MCP_CONNECTOR_EXISTS", "A connector with this name already exists", 409);
    }
    const record = {
      tenantId: identity.tenantId,
      id,
      serverId,
      serverName,
      name: input.name.trim(),
      shortDescription: input.shortDescription.trim(),
      description: input.description.trim(),
      category: input.category,
      services: input.services,
      endpointUrl: new URL(input.endpointUrl).toString(),
      authorizationOrigins: [discovered.authorizationOrigin],
      scopes: input.scopes,
      brand: "generic",
      policySupport: "automatic" as const,
      source: "custom" as const,
      createdBy,
    };
    await administrator.registerOAuthMcpServer({
      serverId,
      serverName,
      name: record.name,
      description: record.description,
      url: record.endpointUrl,
      scopes: record.scopes,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });
    try {
      const saved = await this.registry.saveConnector(record);
      return this.publicConnector(saved);
    } catch (error) {
      await administrator.removeMcpServer(serverId).catch(() => undefined);
      throw error;
    }
  }

  async deleteConnector(identity: IdentityContext, connectorId: string) {
    const connector = await this.connector(identity.tenantId, connectorId);
    if (connector.source !== "custom") throw new OneComputerError("MCP_CONNECTOR_MANAGED", "Built-in connectors cannot be removed", 409);
    await this.administratorGateway().removeMcpServer(connector.serverId);
    const deleted = await this.registry.deleteConnector(identity.tenantId, connector.id);
    if (!deleted) throw new OneComputerError("MCP_CONNECTOR_NOT_FOUND", "Connector not found", 404);
    this.invalidateProjection(identity);
    return { deleted: true };
  }

  async projectConnectedConnectors(identity: IdentityContext, policy: RuntimePolicy) {
    const cacheKey = `${identity.tenantId}:${identity.subjectId}:${policy.policyHash}:${policy.agentId}`;
    const cached = this.projectionCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.policy;
    const connectors = await this.connectors(identity.tenantId);
    const connected = await Promise.all(connectors
      .filter((connector) => connector.serverName !== policy.mcpServer)
      .map(async (connector) => {
        try {
          const status = await this.gateway.userOAuthConnectionStatus(identity, connector.serverName);
          if (status.state !== "connected") return null;
          const tools = await this.gateway.userOAuthConnectionTools(identity, connector.serverName);
          return tools.length ? { connector, tools } : null;
        } catch {
          return null;
        }
      }));
    const active = connected.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const mcpServers = [policy.mcpServer, ...active.map(({ connector }) => connector.serverName)];
    const mcpToolPermissions = {
      [policy.mcpServer]: policy.allowedTools,
      ...Object.fromEntries(active.map(({ connector, tools }) => [connector.serverName, tools])),
    };
    const allowedTools = [...new Set(Object.values(mcpToolPermissions).flat())].sort();
    const projectionDocument = JSON.stringify({ mcpServers, mcpToolPermissions });
    const projected = runtimePolicySchema.parse({
      ...policy,
      mcpServers,
      mcpToolPermissions,
      allowedTools,
      connectionProjectionHash: createHash("sha256").update(projectionDocument).digest("hex"),
      ...(policy.agents ? {
        agents: policy.agents.map((agent) => ({
          ...agent,
          allowedTools,
          toolPolicies: {
            ...agent.toolPolicies,
            ...Object.fromEntries(allowedTools.filter((tool) => !(tool in agent.toolPolicies)).map((tool) => [tool, "allow"])),
          },
        })),
      } : {}),
    });
    this.projectionCache.set(cacheKey, { expiresAt: this.now() + 15_000, policy: projected });
    return projected;
  }

  private async connectors(tenantId: string) {
    const seeded = connectorCatalog(tenantId, this.microsoftAuthorizationOrigin);
    await this.registry.seedConnectors(tenantId, seeded);
    const order = new Map(seeded.map((connector, index) => [connector.id, index]));
    return (await this.registry.listConnectors(tenantId)).sort((left, right) => (
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.category.localeCompare(right.category)
      || left.name.localeCompare(right.name)
    ));
  }

  private async connector(tenantId: string, connectorId: string) {
    await this.registry.seedConnectors(tenantId, connectorCatalog(tenantId, this.microsoftAuthorizationOrigin));
    const connector = await this.registry.getConnector(tenantId, connectorId);
    if (!connector) throw new OneComputerError("MCP_CONNECTOR_NOT_FOUND", "That connector is not in the approved catalog", 404);
    return connector;
  }

  private publicConnector(connector: ConnectorDefinition) {
    const {
      authorizationOrigins: _authorizationOrigins,
      endpointUrl: _endpointUrl,
      scopes: _scopes,
      tenantId: _tenantId,
      serverId: _serverId,
      createdBy: _createdBy,
      ...safe
    } = connector;
    return safe;
  }

  private administratorGateway() {
    if (
      typeof this.gateway.discoverOAuthMcpServer !== "function"
      || typeof this.gateway.registerOAuthMcpServer !== "function"
      || typeof this.gateway.removeMcpServer !== "function"
    ) throw new OneComputerError("MCP_ADMINISTRATION_NOT_CONFIGURED", "Connector administration is unavailable", 503, true);
    return this.gateway as OAuthConnectionGateway & McpConnectorAdministrationGateway;
  }

  private validateCustomConnector(input: CreateConnectorInput) {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpointUrl);
    } catch {
      throw new OneComputerError("MCP_CONNECTOR_URL_INVALID", "Enter a valid connector address", 400);
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      throw new OneComputerError("MCP_CONNECTOR_URL_INVALID", "Custom connectors must use a public HTTPS address", 400);
    }
    const hostname = endpoint.hostname.toLowerCase();
    const privateHost = hostname === "localhost"
      || hostname.endsWith(".local")
      || /^127\./.test(hostname)
      || /^10\./.test(hostname)
      || /^192\.168\./.test(hostname)
      || /^169\.254\./.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
      || hostname === "::1";
    if (privateHost) throw new OneComputerError("MCP_CONNECTOR_URL_PRIVATE", "Private and local connector addresses are not allowed", 400);
    if (!input.name.trim() || !input.shortDescription.trim() || !input.description.trim()) {
      throw new OneComputerError("MCP_CONNECTOR_DETAILS_REQUIRED", "Name and descriptions are required", 400);
    }
    if (input.clientSecret && !input.clientId) {
      throw new OneComputerError("MCP_CONNECTOR_CLIENT_INVALID", "Client ID is required when a client secret is supplied", 400);
    }
  }

  private invalidateProjection(identity: IdentityContext) {
    const prefix = `${identity.tenantId}:${identity.subjectId}:`;
    for (const key of this.projectionCache.keys()) if (key.startsWith(prefix)) this.projectionCache.delete(key);
  }

  private pruneExpired() {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
    for (const [key, discovery] of this.connectorDiscoveries) {
      if (discovery.expiresAt <= now) this.connectorDiscoveries.delete(key);
    }
  }
}

// Retain the original single-provider surface for downstream callers while
// Control itself uses the full catalog service above.
export class Microsoft365ConnectionService {
  private readonly service: McpConnectionService;

  constructor(gateway: OAuthConnectionGateway, options: ConnectionServiceOptions) {
    this.service = new McpConnectionService(gateway, options);
  }

  start(identity: IdentityContext) {
    return this.service.start(identity, "microsoft-365");
  }

  complete(identity: IdentityContext, input: { state?: string; code?: string; error?: string }) {
    return this.service.complete(identity, "microsoft-365", input);
  }

  status(identity: IdentityContext) {
    return this.service.status(identity, "microsoft-365");
  }

  disconnect(identity: IdentityContext) {
    return this.service.disconnect(identity, "microsoft-365");
  }

  resultUrl(result: "connected" | "error", reason?: string) {
    return this.service.resultUrl("microsoft-365", result, reason);
  }
}
