import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OneComputerError, runtimePolicySchema, type IdentityContext, type McpToolPolicyDecision, type RuntimePolicy } from "@onecomputer/contracts";
import type {
  McpConnectorAdministrationGateway,
  OAuthConnectionGateway,
  OAuthConnectionStatus,
} from "@onecomputer/litellm-adapter";
import {
  MemoryConnectorRegistryStore,
  type ConnectorCategory,
  type ConnectorConnectionStateRecord,
  type ConnectorRegistryStore,
} from "@onecomputer/workspace-store";
import { connectorActivation, connectorCatalog, type ConnectorDefinition } from "./connector-catalog.js";

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
  iconDataUrl?: string;
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
  iconHash: input.iconDataUrl ? createHash("sha256").update(input.iconDataUrl).digest("hex") : null,
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
  private readonly connectionStatusStates = new Map<string, Promise<OAuthConnectionStatus>>();
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

  async list(identity: IdentityContext, isAdministrator = false) {
    const connectors = await this.connectors(identity.tenantId);
    const connectionStates = new Map(
      (await this.registry.listConnectionStates(identity.tenantId, identity.subjectId)).map((state) => [state.connectorId, state]),
    );
    // Catalog re-entry may revalidate only a durable, explicit marker. Visible
    // cards without one remain completely local: no status probe, registration,
    // workspace-grant refresh, or tool projection.
    const refreshedStates = new Map<string, OAuthConnectionStatus>();
    let connectionProjectionChanged = false;
    await Promise.all(connectors.map(async (connector) => {
      const stored = connectionStates.get(connector.id);
      if (!connector.enabled || !stored) return;
      try {
        const refreshed = await this.connectionStatus(identity, connector);
        refreshedStates.set(connector.id, { ...refreshed, account: null });
        if (refreshed.state !== stored.state || refreshed.state === "expired") connectionProjectionChanged = true;
      } catch {
        // Keep the durable safe state visible when the provider is temporarily
        // unavailable. A later re-entry can retry this explicit marker.
        refreshedStates.set(connector.id, this.statusFromStoredState(stored));
        if (stored.state === "expired") connectionProjectionChanged = true;
      }
    }));
    if (connectionProjectionChanged) this.invalidateProjection(identity);
    const connections = connectors.map((connector) => {
      const publicConnector = {
        ...this.publicConnector(connector),
        canManageConnection: isAdministrator || connector.membersCanManage,
      };
      if (!connector.enabled) {
        return {
          ...publicConnector,
          available: false,
          state: "unavailable" as const,
          connectedAt: null,
          expiresAt: null,
          account: null,
        };
      }
      return {
        ...publicConnector,
        available: true,
        ...(refreshedStates.get(connector.id) ?? this.statusFromStoredState(connectionStates.get(connector.id))),
      };
    });
    return { connections, connectionProjectionChanged };
  }

  async start(identity: IdentityContext, connectorId = "microsoft-365", isAdministrator = false) {
    const connector = await this.connector(identity.tenantId, connectorId);
    this.requireConnectionManagement(connector, isAdministrator);
    this.requireConnectionActivation(connector);
    this.pruneExpired();
    await this.ensureManagedConnectorServers([connector]);
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
    isAdministrator = false,
  ): Promise<OAuthConnectionStatus> {
    const connector = await this.connector(identity.tenantId, connectorId);
    this.requireConnectionManagement(connector, isAdministrator);
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
    await this.persistConnectionStatus(identity, connector, result);
    this.invalidateProjection(identity);
    return result;
  }

  async status(identity: IdentityContext, connectorId = "microsoft-365") {
    const connector = await this.connector(identity.tenantId, connectorId);
    const stored = await this.registry.getConnectionState(identity.tenantId, identity.subjectId, connector.id);
    if (!stored) return this.statusFromStoredState(null);
    return this.connectionStatus(identity, connector);
  }

  async disconnect(identity: IdentityContext, connectorId = "microsoft-365", isAdministrator = false) {
    const connector = await this.connector(identity.tenantId, connectorId);
    this.requireConnectionManagement(connector, isAdministrator);
    const result = await this.gateway.disconnectUserOAuthConnection(identity, connector.serverName);
    await this.registry.deleteConnectionState(identity.tenantId, identity.subjectId, connector.id);
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

  async updateAccessPolicy(
    identity: IdentityContext,
    updatedBy: string,
    connectorId: string,
    input: { enabled: boolean; membersCanManage: boolean },
  ) {
    await this.connector(identity.tenantId, connectorId);
    const saved = await this.registry.updateAccessPolicy(identity.tenantId, connectorId, { ...input, updatedBy });
    if (!saved) throw new OneComputerError("MCP_CONNECTOR_NOT_FOUND", "Connector not found", 404);
    this.invalidateTenantProjection(identity.tenantId);
    return this.publicConnector(saved);
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
      iconDataUrl: input.iconDataUrl ?? null,
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

  async updateConnectorIcon(identity: IdentityContext, connectorId: string, iconDataUrl: string | null) {
    const connector = await this.connector(identity.tenantId, connectorId);
    if (connector.source !== "custom") {
      throw new OneComputerError("MCP_CONNECTOR_MANAGED", "Built-in connector icons cannot be changed", 409);
    }
    if (iconDataUrl) this.validateConnectorIcon(iconDataUrl);
    const saved = await this.registry.updateIcon(identity.tenantId, connectorId, iconDataUrl);
    if (!saved) throw new OneComputerError("MCP_CONNECTOR_NOT_FOUND", "Connector not found", 404);
    return this.publicConnector(saved);
  }

  async connectorToolPolicy(identity: IdentityContext, connectorId: string) {
    const connector = await this.connector(identity.tenantId, connectorId);
    if (connector.id === "microsoft-365") {
      throw new OneComputerError("MCP_CONNECTOR_POLICY_MANAGED", "Use the Microsoft 365 tool policy", 409);
    }
    const stored = await this.registry.getConnectionState(identity.tenantId, identity.subjectId, connector.id);
    if (!stored) throw new OneComputerError("MCP_CONNECTOR_NOT_CONNECTED", `Connect ${connector.name} before reviewing its tools`, 409);
    const status = await this.connectionStatus(identity, connector);
    if (status.state !== "connected") {
      throw new OneComputerError("MCP_CONNECTOR_NOT_CONNECTED", `Connect ${connector.name} before reviewing its tools`, 409);
    }
    const toolNames = await this.gateway.userOAuthConnectionTools(identity, connector.serverName);
    const tools = toolNames.map((name) => ({
      name,
      displayName: this.toolDisplayName(name),
      description: `Use ${this.toolDisplayName(name)} in ${connector.name}.`,
      service: "tools",
      risk: "unknown" as const,
      decision: (connector.toolPolicies[name] ?? "allow") as McpToolPolicyDecision,
    }));
    const decisions = Object.fromEntries(tools.map((tool) => [tool.name, tool.decision]));
    return {
      connectorId: connector.id,
      connectorName: connector.name,
      serverName: connector.serverName,
      documentHash: createHash("sha256").update(JSON.stringify(decisions)).digest("hex"),
      tools,
    };
  }

  async saveConnectorToolPolicy(
    identity: IdentityContext,
    connectorId: string,
    tools: Record<string, McpToolPolicyDecision>,
  ) {
    const current = await this.connectorToolPolicy(identity, connectorId);
    const expected = current.tools.map((tool) => tool.name).sort();
    if (Object.keys(tools).sort().join("\0") !== expected.join("\0")) {
      throw new OneComputerError("INVALID_TOOL_POLICY", `A decision is required for every ${current.connectorName} tool`, 400);
    }
    const saved = await this.registry.updateToolPolicies(identity.tenantId, connectorId, tools);
    if (!saved) throw new OneComputerError("MCP_CONNECTOR_NOT_FOUND", "Connector not found", 404);
    this.invalidateTenantProjection(identity.tenantId);
    return this.connectorToolPolicy(identity, connectorId);
  }

  async hostedToolPolicy(identity: IdentityContext, serverName: string, toolName: string) {
    const connector = (await this.connectors(identity.tenantId))
      .find((candidate) => candidate.enabled && candidate.serverName === serverName && candidate.id !== "microsoft-365");
    if (!connector) return null;
    const stored = await this.registry.getConnectionState(identity.tenantId, identity.subjectId, connector.id);
    if (!stored) return null;
    const decision = (connector.toolPolicies[toolName] ?? "allow") as McpToolPolicyDecision;
    try {
      if ((await this.connectionStatus(identity, connector)).state !== "connected") return null;
      const discoveredTools = await this.gateway.userOAuthConnectionTools(identity, connector.serverName);
      if (!discoveredTools.includes(toolName)) return null;
      if (decision === "deny") return null;
    } catch {
      return null;
    }
    return {
      connectorId: connector.id,
      connectorName: connector.name,
      serverId: connector.serverId,
      serverName: connector.serverName,
      toolName,
      displayName: this.toolDisplayName(toolName),
      decision,
    };
  }

  async projectConnectedConnectors(identity: IdentityContext, policy: RuntimePolicy) {
    const connectors = await this.connectors(identity.tenantId);
    const connectionStates = new Map(
      (await this.registry.listConnectionStates(identity.tenantId, identity.subjectId)).map((state) => [state.connectorId, state]),
    );
    const statusStates = new Map<string, Promise<OAuthConnectionStatus>>();
    const currentStatus = (connector: ConnectorDefinition) => {
      const existing = statusStates.get(connector.serverName);
      if (existing) return existing;
      const status = this.connectionStatus(identity, connector);
      statusStates.set(connector.serverName, status);
      return status;
    };
    const cacheKey = `${identity.tenantId}:${identity.subjectId}:${policy.policyHash}:${policy.agentId}`;
    const cached = this.projectionCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      const cachedServers = [...new Set((cached.policy.mcpServers ?? [policy.mcpServer]).filter((serverName) => serverName !== policy.mcpServer))];
      const fresh = await Promise.all(cachedServers.map(async (serverName) => {
        const connector = connectors.find((candidate) => candidate.enabled && candidate.serverName === serverName);
        if (!connector || !connectionStates.has(connector.id)) return false;
        try {
          return (await currentStatus(connector)).state === "connected";
        } catch {
          return false;
        }
      }));
      if (fresh.every(Boolean)) return cached.policy;
      this.invalidateProjection(identity);
    }
    const primaryConnector = connectors.find((connector) => connector.serverName === policy.mcpServer);
    const primaryToolPolicies = primaryConnector?.enabled === false
      ? Object.fromEntries(policy.allowedTools.map((tool) => [tool, "deny" as const]))
      : policy.toolPolicies;
    const connected = await Promise.all(connectors
      .filter((connector) => connector.enabled && connector.serverName !== policy.mcpServer && connectionStates.has(connector.id))
      .map(async (connector) => {
        try {
          const status = await currentStatus(connector);
          if (status.state !== "connected") return null;
          const discoveredTools = await this.gateway.userOAuthConnectionTools(identity, connector.serverName);
          const tools = discoveredTools.filter((tool) => (connector.toolPolicies[tool] ?? "allow") !== "deny");
          const toolPolicies = Object.fromEntries(tools.map((tool) => [tool, connector.toolPolicies[tool] ?? "allow"]));
          return tools.length ? { connector, tools, toolPolicies } : null;
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
    const hostedToolPolicies = Object.assign({}, ...active.map(({ toolPolicies }) => toolPolicies));
    const toolPolicies = { ...primaryToolPolicies, ...hostedToolPolicies };
    const projectionDocument = JSON.stringify({ mcpServers, mcpToolPermissions, toolPolicies });
    const projected = runtimePolicySchema.parse({
      ...policy,
      mcpServers,
      mcpToolPermissions,
      allowedTools,
      toolPolicies,
      connectionProjectionHash: createHash("sha256").update(projectionDocument).digest("hex"),
      ...(policy.agents ? {
        agents: policy.agents.map((agent) => ({
          ...agent,
          allowedTools,
          toolPolicies: { ...agent.toolPolicies, ...primaryToolPolicies, ...hostedToolPolicies },
        })),
      } : {}),
    });
    this.projectionCache.set(cacheKey, { expiresAt: this.now() + 15_000, policy: projected });
    return projected;
  }

  private statusFromStoredState(state: ConnectorConnectionStateRecord | null | undefined): OAuthConnectionStatus {
    if (!state) return { state: "disconnected", connectedAt: null, expiresAt: null, account: null };
    return { state: state.state, connectedAt: state.connectedAt?.toISOString() ?? null, expiresAt: state.expiresAt?.toISOString() ?? null, account: null };
  }

  private async connectionStatus(identity: IdentityContext, connector: Pick<ConnectorDefinition, "id" | "serverName">): Promise<OAuthConnectionStatus> {
    const serverName = connector.serverName;
    const key = JSON.stringify([identity.tenantId, identity.subjectId, serverName]);
    const pending = this.connectionStatusStates.get(key);
    if (pending) return pending;

    const resolution = (async () => {
      const current = await this.gateway.userOAuthConnectionStatus(identity, serverName);
      if (current.state !== "expired") return this.persistConnectionStatus(identity, connector, current);
      try {
        await this.gateway.userOAuthConnectionTools(identity, serverName);
        const refreshed = await this.gateway.userOAuthConnectionStatus(identity, serverName);
        if (refreshed.state !== "connected") this.invalidateProjection(identity);
        return this.persistConnectionStatus(identity, connector, refreshed);
      } catch {
        this.invalidateProjection(identity);
        return this.persistConnectionStatus(identity, connector, current);
      }
    })();
    this.connectionStatusStates.set(key, resolution);
    try {
      return await resolution;
    } finally {
      if (this.connectionStatusStates.get(key) === resolution) this.connectionStatusStates.delete(key);
    }
  }

  private async persistConnectionStatus(
    identity: IdentityContext,
    connector: Pick<ConnectorDefinition, "id">,
    status: OAuthConnectionStatus,
  ) {
    if (status.state === "disconnected") {
      await this.registry.deleteConnectionState(identity.tenantId, identity.subjectId, connector.id);
      this.invalidateProjection(identity);
      return status;
    }
    const parseDate = (value: string | null) => {
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    await this.registry.saveConnectionState({
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      connectorId: connector.id,
      state: status.state,
      connectedAt: parseDate(status.connectedAt),
      expiresAt: parseDate(status.expiresAt),
    });
    return status;
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
    const seeded = connectorCatalog(tenantId, this.microsoftAuthorizationOrigin);
    await this.registry.seedConnectors(tenantId, seeded);
    const connector = await this.registry.getConnector(tenantId, connectorId);
    if (!connector) throw new OneComputerError("MCP_CONNECTOR_NOT_FOUND", "That connector is not in the approved catalog", 404);
    return connector;
  }

  private async ensureManagedConnectorServers(connectors: Array<Pick<
    ConnectorDefinition,
    "id" | "serverId" | "serverName" | "name" | "description" | "endpointUrl" | "scopes" | "source"
  >>) {
    const managed = connectors
      .filter((connector) => this.isOnDemandConnector(connector))
      .map((connector) => ({
        serverId: connector.serverId,
        serverName: connector.serverName,
        name: connector.name,
        description: connector.description,
        url: connector.endpointUrl,
        scopes: connector.scopes,
      }));
    if (!managed.length) return;
    if (typeof this.gateway.ensureOAuthMcpServers !== "function") {
      throw new OneComputerError("MCP_ADMINISTRATION_NOT_CONFIGURED", "Managed connector registration is unavailable", 503, true);
    }
    await this.gateway.ensureOAuthMcpServers(managed);
  }

  private isOnDemandConnector(connector: Pick<ConnectorDefinition, "id" | "source">) {
    return connector.source === "built-in" && connector.id !== "microsoft-365";
  }

  private publicConnector(connector: ConnectorDefinition) {
    const {
      authorizationOrigins: _authorizationOrigins,
      endpointUrl: _endpointUrl,
      scopes: _scopes,
      toolPolicies: _toolPolicies,
      tenantId: _tenantId,
      serverId: _serverId,
      createdBy: _createdBy,
      accessPolicyUpdatedBy: _accessPolicyUpdatedBy,
      ...safe
    } = connector;
    return { ...safe, activation: connectorActivation(connector) };
  }

  private requireConnectionManagement(connector: ConnectorDefinition, isAdministrator: boolean) {
    if (!connector.enabled) {
      throw new OneComputerError("MCP_CONNECTOR_DISABLED", `${connector.name} is disabled by your organization`, 403);
    }
    if (!isAdministrator && !connector.membersCanManage) {
      throw new OneComputerError("MCP_CONNECTOR_LOCKED", `${connector.name} connections are managed by your administrator`, 403);
    }
  }

  private requireConnectionActivation(connector: Pick<ConnectorDefinition, "id" | "source">) {
    const activation = connectorActivation(connector);
    if (activation.action === "connect") return;
    throw new OneComputerError(
      activation.readiness === "setup_required" ? "MCP_CONNECTOR_SETUP_REQUIRED" : "MCP_CONNECTOR_REQUEST_REQUIRED",
      activation.message,
      409,
    );
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
    if (input.iconDataUrl) this.validateConnectorIcon(input.iconDataUrl);
  }

  private validateConnectorIcon(iconDataUrl: string) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(iconDataUrl);
    if (!match) {
      throw new OneComputerError("MCP_CONNECTOR_ICON_INVALID", "Use a PNG, JPEG, or WebP connector icon", 400);
    }
    const bytes = Buffer.from(match[2]!, "base64");
    if (!bytes.length || bytes.length > 256 * 1024) {
      throw new OneComputerError("MCP_CONNECTOR_ICON_INVALID", "Connector icons must be 256 KB or smaller", 400);
    }
    const mediaType = match[1];
    const validSignature = mediaType === "png"
      ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mediaType === "jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!validSignature) {
      throw new OneComputerError("MCP_CONNECTOR_ICON_INVALID", "The connector icon does not match its image format", 400);
    }
  }

  private toolDisplayName(name: string) {
    const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
    return words ? words.replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 128) : "Connector tool";
  }

  private invalidateTenantProjection(tenantId: string) {
    const prefix = `${tenantId}:`;
    for (const key of this.projectionCache.keys()) if (key.startsWith(prefix)) this.projectionCache.delete(key);
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
