import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LemmaComputerError, runtimePolicySchema, type IdentityContext, type McpToolPolicyDecision, type RuntimePolicy } from "@lemmacomputer/contracts";
import type {
  McpConnectorAdministrationGateway,
  OAuthConnectionGateway,
  OAuthConnectionStatus,
  OAuthConnectionTool,
} from "@lemmacomputer/litellm-adapter";
import {
  normalizeEgressHost,
  PublicHttpsTargetValidationError,
  validatePublicHttpsTarget,
  type PublicHttpsTargetResolver,
  type ValidatedPublicHttpsTarget,
} from "@lemmacomputer/egress-policy";
import {
  MemoryConnectorRegistryStore,
  type ConnectorCategory,
  type ConnectorConnectionStateRecord,
  type ConnectorRegistryStore,
} from "@lemmacomputer/workspace-store";
import { connectorActivation, connectorCatalog, type ConnectorDefinition } from "./connector-catalog.js";
import type { EffectiveConnectorPolicyInput } from "./connector-policy-administration.js";

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
  installationKind?: "customer-managed" | "hosted" | "worktree";
  /**
   * Deployment-owned exact origins for hosted custom MCP connectors. This is
   * intentionally separate from a tenant administrator's catalog record: one
   * shared LiteLLM/proxy cannot safely turn a tenant-local entry into a new
   * gateway-wide internet destination.
   */
  hostedCustomConnectorEgressOrigins?: string[];
  /**
   * Test/control-plane DNS resolver used only to reject unsafe custom URLs at
   * admission. The gateway proxy repeats the resolution and enforcement when
   * it opens the real connection, so this never becomes the SSRF boundary.
   */
  resolveCustomConnectorHostname?: PublicHttpsTargetResolver;
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
const policyProjectionDigest = (policy: RuntimePolicy) => createHash("sha256")
  .update(JSON.stringify(policy))
  .digest("base64url");
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

const explicitToolPolicy = (toolPolicies: Record<string, McpToolPolicyDecision>, toolName: string): McpToolPolicyDecision => {
  const decision = toolPolicies[toolName];
  return decision === "allow" || decision === "approval_required" || decision === "deny" ? decision : "deny";
};

const hasCurrentToolReview = (
  toolPolicies: Record<string, McpToolPolicyDecision>,
  toolDefinitionHashes: Record<string, string>,
  tool: OAuthConnectionTool,
) => Object.hasOwn(toolPolicies, tool.name)
  && ["allow", "approval_required", "deny"].includes(toolPolicies[tool.name])
  && toolDefinitionHashes[tool.name] === tool.definitionHash;

const toolRequiresReview = (
  toolPolicies: Record<string, McpToolPolicyDecision>,
  toolDefinitionHashes: Record<string, string>,
  tool: OAuthConnectionTool,
) => !hasCurrentToolReview(toolPolicies, toolDefinitionHashes, tool);

const reviewedToolDecision = (
  toolPolicies: Record<string, McpToolPolicyDecision>,
  toolDefinitionHashes: Record<string, string>,
  tool: OAuthConnectionTool,
) => hasCurrentToolReview(toolPolicies, toolDefinitionHashes, tool)
  ? explicitToolPolicy(toolPolicies, tool.name)
  : "deny" as const;

const toolsetDocumentHash = (tools: OAuthConnectionTool[]) => createHash("sha256")
  .update(JSON.stringify(tools
    .map(({ name, definitionHash }) => ({ name, definitionHash }))
  .sort((left, right) => left.name.localeCompare(right.name))), "utf8")
  .digest("hex");

const canonicalHttpsOrigin = (input: string): string | null => {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = normalizeEgressHost(url.hostname);
    const port = url.port ? Number(url.port) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    url.hostname = host;
    url.port = port === 443 ? "" : String(port);
    return url.origin;
  } catch {
    return null;
  }
};

const canonicalConfiguredHttpsOrigin = (input: string): string | null => {
  try {
    const url = new URL(input);
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return canonicalHttpsOrigin(input);
  } catch {
    return null;
  }
};

const gatewayDestinationOrigin = (protocol: "https", host: string, port: number) => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const normalizedHost = normalizeEgressHost(host);
  const url = new URL(`${protocol}://${normalizedHost}`);
  url.port = port === 443 ? "" : String(port);
  return url.origin;
};

export class McpConnectionService {
  private readonly sessions = new Map<string, PendingConnection>();
  private readonly connectorDiscoveries = new Map<string, PendingConnectorDiscovery>();
  private readonly publicWebUrl: string;
  private readonly liteLlmPublicUrl: string;
  private readonly microsoftAuthorizationOrigin: string;
  private readonly registry: ConnectorRegistryStore;
  private readonly resolveCustomConnectorHostname?: PublicHttpsTargetResolver;
  private readonly installationKind: "customer-managed" | "hosted" | "worktree";
  private readonly hostedCustomConnectorEgressOrigins: ReadonlySet<string>;
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
    this.resolveCustomConnectorHostname = options.resolveCustomConnectorHostname;
    this.installationKind = options.installationKind ?? "customer-managed";
    const configuredOrigins = options.hostedCustomConnectorEgressOrigins ?? [];
    const normalizedOrigins = configuredOrigins.map((origin) => canonicalConfiguredHttpsOrigin(origin));
    if (normalizedOrigins.some((origin) => !origin)) {
      throw new Error("Hosted custom MCP egress origins must be exact public HTTPS origins");
    }
    this.hostedCustomConnectorEgressOrigins = new Set(normalizedOrigins.filter((origin): origin is string => Boolean(origin)));
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
    if (!input.state) throw new LemmaComputerError("MCP_OAUTH_STATE_MISSING", `The ${connector.name} connection could not be verified`, 400);
    const key = stateDigest(input.state);
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    if (!pending) throw new LemmaComputerError("MCP_OAUTH_STATE_INVALID", `The ${connector.name} connection expired or was already used`, 400);
    if (pending.expiresAt <= this.now()) throw new LemmaComputerError("MCP_OAUTH_STATE_EXPIRED", `The ${connector.name} connection expired; please try again`, 400);
    if (pending.tenantId !== identity.tenantId || pending.subjectId !== identity.subjectId) {
      throw new LemmaComputerError("MCP_OAUTH_IDENTITY_MISMATCH", `The ${connector.name} connection belongs to another user`, 403);
    }
    if (pending.connectorId !== connector.id) {
      throw new LemmaComputerError("MCP_OAUTH_CONNECTOR_MISMATCH", "The connection returned to a different connector", 400);
    }
    if (input.error) throw new LemmaComputerError("MCP_OAUTH_DENIED", `${connector.name} access was not granted`, 400);
    if (!input.code || input.code.length > 4096) throw new LemmaComputerError("MCP_OAUTH_CODE_INVALID", `${connector.name} returned an invalid authorization response`, 400);
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

  async connectorPolicyAdministrationSnapshot(
    identity: IdentityContext,
    connectorId: string,
    input: {
      configuredToolPolicies?: Record<string, McpToolPolicyDecision>;
      toolDisplayNames?: Record<string, string>;
      reviewMode?: EffectiveConnectorPolicyInput["connector"]["reviewMode"];
    } = {},
  ): Promise<Pick<EffectiveConnectorPolicyInput, "connector" | "observedTools">> {
    const connector = await this.connector(identity.tenantId, connectorId);
    let stored = await this.registry.getConnectionState(identity.tenantId, identity.subjectId, connector.id);
    let observedTools: EffectiveConnectorPolicyInput["observedTools"] = null;
    let toolDisplayNames = input.toolDisplayNames ?? {};
    const reviewMode = input.reviewMode ?? (connector.id === "microsoft-365" ? "product_owned" : "provider_definition_hash");
    if (reviewMode === "provider_definition_hash" && stored?.state === "connected") {
      try {
        const current = await this.connectorToolPolicy(identity, connector.id);
        observedTools = current.tools.map((tool) => ({ name: tool.name, definitionHash: tool.definitionHash }));
        toolDisplayNames = Object.fromEntries(current.tools.map((tool) => [tool.name, tool.displayName]));
      } catch {
        // The effective read model stays available during a provider outage,
        // but reports the saved review as unchecked so the UI cannot imply
        // that a provider definition is current.
        observedTools = null;
      }
      stored = await this.registry.getConnectionState(identity.tenantId, identity.subjectId, connector.id);
    }
    return {
      connector: {
        id: connector.id,
        name: connector.name,
        enabled: connector.enabled,
        membersCanManage: connector.membersCanManage,
        accessPolicyVersion: connector.accessPolicyVersion,
        accessPolicyUpdatedAt: connector.accessPolicyUpdatedAt.toISOString(),
        configuredToolPolicies: input.configuredToolPolicies ?? connector.toolPolicies,
        toolDisplayNames,
        reviewedToolDefinitionHashes: reviewMode === "product_owned" ? {} : connector.toolDefinitionHashes,
        connectionState: stored?.state ?? "disconnected",
        reviewMode,
      },
      observedTools,
    };
  }

  async updateAccessPolicy(
    identity: IdentityContext,
    updatedBy: string,
    connectorId: string,
    input: { enabled: boolean; membersCanManage: boolean; expectedVersion: number; correlationId: string },
  ) {
    await this.connector(identity.tenantId, connectorId);
    const saved = await this.registry.applyAccessPolicyChange(identity.tenantId, connectorId, { ...input, updatedBy });
    if (!saved) throw new LemmaComputerError("MCP_CONNECTOR_NOT_FOUND", "Connector not found", 404);
    if (saved.event.outcome === "conflict") {
      throw new LemmaComputerError(
        "CONNECTOR_POLICY_VERSION_CONFLICT",
        "This connector policy changed while you were editing it. Refresh and review the latest version before saving again.",
        409,
      );
    }
    this.invalidateTenantProjection(identity.tenantId);
    return { connector: this.publicConnector(saved.connector), policyChange: saved.event };
  }

  async discoverConnector(identity: IdentityContext, input: CreateConnectorInput) {
    const endpoint = await this.validateCustomConnector(input);
    const validatedInput = { ...input, endpointUrl: endpoint.canonicalUrl };
    this.pruneExpired();
    const discovered = await this.withDiscoveryEgressPermit(identity, [endpoint.origin], async () => this.administratorGateway().discoverOAuthMcpServer({
      name: validatedInput.name,
      description: validatedInput.description,
      url: validatedInput.endpointUrl,
      scopes: validatedInput.scopes,
      clientId: validatedInput.clientId,
      clientSecret: validatedInput.clientSecret,
      egressProfile: "strict_remote",
      callbackUrl: `${this.liteLlmPublicUrl}/callback`,
    }));
    const authorization = await this.validateCustomAuthorizationOrigin(discovered.authorizationOrigin);
    const discoveryToken = randomBytes(32).toString("base64url");
    this.connectorDiscoveries.set(stateDigest(discoveryToken), {
      inputDigest: connectorInputDigest(validatedInput),
      authorizationOrigin: authorization.origin,
      expiresAt: this.now() + this.sessionTtlMs,
    });
    return { ...discovered, discoveryToken };
  }

  async createConnector(identity: IdentityContext, createdBy: string, input: CreateConnectorInput) {
    const endpoint = await this.validateCustomConnector(input);
    const validatedInput = { ...input, endpointUrl: endpoint.canonicalUrl };
    this.pruneExpired();
    const administrator = this.administratorGateway();
    if (!validatedInput.discoveryToken) {
      throw new LemmaComputerError("MCP_CONNECTOR_DISCOVERY_REQUIRED", "Check the connector server before adding it", 400);
    }
    const discoveryKey = stateDigest(validatedInput.discoveryToken);
    const discovered = this.connectorDiscoveries.get(discoveryKey);
    this.connectorDiscoveries.delete(discoveryKey);
    if (!discovered || discovered.expiresAt <= this.now() || discovered.inputDigest !== connectorInputDigest(validatedInput)) {
      throw new LemmaComputerError("MCP_CONNECTOR_DISCOVERY_INVALID", "The connector check expired or its details changed; check the server again", 400);
    }
    const authorization = await this.validateCustomAuthorizationOrigin(discovered.authorizationOrigin);
    const slug = validatedInput.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    if (!slug) throw new LemmaComputerError("MCP_CONNECTOR_NAME_INVALID", "Enter a connector name using letters or numbers", 400);
    const existing = await this.connectors(identity.tenantId);
    const id = existing.some((connector) => connector.id === slug)
      ? `${slug}-${createHash("sha256").update(validatedInput.endpointUrl).digest("hex").slice(0, 8)}`
      : slug;
    const serverId = randomUUID();
    const serverName = `lemmacomputer_${id.replace(/-/g, "_")}`.slice(0, 96);
    if (existing.some((connector) => connector.serverName === serverName)) {
      throw new LemmaComputerError("MCP_CONNECTOR_EXISTS", "A connector with this name already exists", 409);
    }
    const record = {
      tenantId: identity.tenantId,
      id,
      serverId,
      serverName,
      name: validatedInput.name.trim(),
      shortDescription: validatedInput.shortDescription.trim(),
      description: validatedInput.description.trim(),
      category: validatedInput.category,
      services: validatedInput.services,
      endpointUrl: endpoint.canonicalUrl,
      authorizationOrigins: [authorization.origin],
      scopes: validatedInput.scopes,
      brand: "generic",
      iconDataUrl: validatedInput.iconDataUrl ?? null,
      policySupport: "automatic" as const,
      source: "custom" as const,
      createdBy,
    };
    return this.withDiscoveryEgressPermit(identity, [endpoint.origin, authorization.origin], async () => {
      await administrator.registerOAuthMcpServer({
        serverId,
        serverName,
        name: record.name,
        description: record.description,
        url: record.endpointUrl,
        scopes: record.scopes,
        clientId: validatedInput.clientId,
        clientSecret: validatedInput.clientSecret,
        egressProfile: "strict_remote",
      });
      try {
        const saved = await this.registry.saveConnector(record);
        return this.publicConnector(saved);
      } catch (error) {
        await administrator.removeMcpServer(serverId).catch(() => undefined);
        throw error;
      }
    });
  }

  async deleteConnector(identity: IdentityContext, connectorId: string) {
    const connector = await this.connector(identity.tenantId, connectorId);
    if (connector.source !== "custom") throw new LemmaComputerError("MCP_CONNECTOR_MANAGED", "Built-in connectors cannot be removed", 409);
    await this.administratorGateway().removeMcpServer(connector.serverId);
    const deleted = await this.registry.deleteConnector(identity.tenantId, connector.id);
    if (!deleted) throw new LemmaComputerError("MCP_CONNECTOR_NOT_FOUND", "Connector not found", 404);
    this.invalidateProjection(identity);
    return { deleted: true };
  }

  async updateConnectorIcon(identity: IdentityContext, connectorId: string, iconDataUrl: string | null) {
    const connector = await this.connector(identity.tenantId, connectorId);
    if (connector.source !== "custom") {
      throw new LemmaComputerError("MCP_CONNECTOR_MANAGED", "Built-in connector icons cannot be changed", 409);
    }
    if (iconDataUrl) this.validateConnectorIcon(iconDataUrl);
    const saved = await this.registry.updateIcon(identity.tenantId, connectorId, iconDataUrl);
    if (!saved) throw new LemmaComputerError("MCP_CONNECTOR_NOT_FOUND", "Connector not found", 404);
    return this.publicConnector(saved);
  }

  async connectorToolPolicy(identity: IdentityContext, connectorId: string) {
    const connector = await this.connector(identity.tenantId, connectorId);
    if (connector.id === "microsoft-365") {
      throw new LemmaComputerError("MCP_CONNECTOR_POLICY_MANAGED", "Use the Microsoft 365 tool policy", 409);
    }
    const stored = await this.registry.getConnectionState(identity.tenantId, identity.subjectId, connector.id);
    if (!stored) throw new LemmaComputerError("MCP_CONNECTOR_NOT_CONNECTED", `Connect ${connector.name} before reviewing its tools`, 409);
    const status = await this.connectionStatus(identity, connector);
    if (status.state !== "connected") {
      throw new LemmaComputerError("MCP_CONNECTOR_NOT_CONNECTED", `Connect ${connector.name} before reviewing its tools`, 409);
    }
    const discoveredTools = await this.gateway.userOAuthConnectionTools(identity, connector.serverName);
    const discoveredToolNames = new Set(discoveredTools.map((tool) => tool.name));
    const addedTools: string[] = [];
    const changedTools: string[] = [];
    const tools = discoveredTools.map((tool) => {
      const reviewRequired = toolRequiresReview(connector.toolPolicies, connector.toolDefinitionHashes, tool);
      if (reviewRequired) {
        if (Object.hasOwn(connector.toolPolicies, tool.name)) changedTools.push(tool.name);
        else addedTools.push(tool.name);
      }
      const providerDescription = tool.description?.trim().slice(0, 320);
      return {
        name: tool.name,
        definitionHash: tool.definitionHash,
        displayName: this.toolDisplayName(tool.name),
        description: reviewRequired
          ? `Blocked until an administrator reviews the current definition of ${this.toolDisplayName(tool.name)} in ${connector.name}.${providerDescription ? ` Provider description: ${providerDescription}` : " The provider did not supply a description."}`
          : (providerDescription || `Use ${this.toolDisplayName(tool.name)} in ${connector.name}.`),
        ...(tool.definitionPreview ? { definitionPreview: tool.definitionPreview } : {}),
        service: "tools",
        risk: "unknown" as const,
        decision: reviewedToolDecision(connector.toolPolicies, connector.toolDefinitionHashes, tool),
        reviewRequired,
      };
    });
    const removedTools = Object.keys(connector.toolPolicies)
      .filter((toolName) => !discoveredToolNames.has(toolName))
      .sort();
    if (addedTools.length || changedTools.length || removedTools.length) this.invalidateProjection(identity);
    return {
      connectorId: connector.id,
      connectorName: connector.name,
      serverName: connector.serverName,
      accessPolicyVersion: connector.accessPolicyVersion,
      documentHash: toolsetDocumentHash(discoveredTools),
      changes: {
        added: addedTools.sort(),
        changed: changedTools.sort(),
        removed: removedTools,
      },
      tools,
    };
  }

  async saveConnectorToolPolicy(
    identity: IdentityContext,
    updatedBy: string,
    connectorId: string,
    tools: Record<string, McpToolPolicyDecision>,
    expectedDocumentHash: string,
    expectedAccessPolicyVersion: number,
    correlationId: string,
  ) {
    const current = await this.connectorToolPolicy(identity, connectorId);
    if (current.documentHash !== expectedDocumentHash) {
      await this.registry.recordToolPolicyConflict(identity.tenantId, connectorId, {
        actorUserId: updatedBy,
        reviewedDefinitionHash: current.documentHash,
        failureCode: "TOOL_SET_CHANGED_REVIEW_AGAIN",
        correlationId,
      });
      throw new LemmaComputerError(
        "TOOL_SET_CHANGED_REVIEW_AGAIN",
        `${current.connectorName} changed while it was being reviewed. Refresh the tool list and review it again.`,
        409,
      );
    }
    const expected = current.tools.map((tool) => tool.name).sort();
    if (Object.keys(tools).sort().join("\0") !== expected.join("\0")) {
      throw new LemmaComputerError("INVALID_TOOL_POLICY", `A decision is required for every ${current.connectorName} tool`, 400);
    }
    const toolDefinitionHashes = Object.fromEntries(current.tools.map((tool) => [tool.name, tool.definitionHash]));
    const saved = await this.registry.applyToolPolicyChange(identity.tenantId, connectorId, {
      toolPolicies: tools,
      toolDefinitionHashes,
      updatedBy,
      expectedVersion: expectedAccessPolicyVersion,
      reviewedDefinitionHash: expectedDocumentHash,
      correlationId,
    });
    if (!saved) throw new LemmaComputerError("MCP_CONNECTOR_NOT_FOUND", "Connector not found", 404);
    if (saved.event.outcome === "conflict") {
      throw new LemmaComputerError(
        "CONNECTOR_POLICY_VERSION_CONFLICT",
        "This connector policy changed while you were editing it. Refresh and review the latest version before saving again.",
        409,
      );
    }
    this.invalidateTenantProjection(identity.tenantId);
    return { ...(await this.connectorToolPolicy(identity, connectorId)), policyChange: saved.event };
  }

  async hostedToolPolicy(identity: IdentityContext, serverName: string, toolName: string) {
    const connector = (await this.connectors(identity.tenantId))
      .find((candidate) => candidate.enabled && candidate.serverName === serverName && candidate.id !== "microsoft-365");
    if (!connector) return null;
    if (!Object.hasOwn(connector.toolPolicies, toolName) || explicitToolPolicy(connector.toolPolicies, toolName) === "deny") return null;
    const stored = await this.registry.getConnectionState(identity.tenantId, identity.subjectId, connector.id);
    if (!stored) return null;
    try {
      if ((await this.connectionStatus(identity, connector)).state !== "connected") return null;
      const discoveredTools = await this.gateway.userOAuthConnectionTools(identity, connector.serverName);
      const tool = discoveredTools.find((candidate) => candidate.name === toolName);
      if (!tool) return null;
      const decision = reviewedToolDecision(connector.toolPolicies, connector.toolDefinitionHashes, tool);
      if (decision === "deny") return null;
      return {
        connectorId: connector.id,
        connectorName: connector.name,
        serverId: connector.serverId,
        serverName: connector.serverName,
        toolName,
        displayName: this.toolDisplayName(toolName),
        decision,
      };
    } catch {
      return null;
    }
  }

  /**
   * Called only by the gateway egress proxy. The proxy has already resolved
   * every A/AAAA record and rejected private addresses; this method decides
   * whether that public HTTPS origin is one Control is willing to route to.
   */
  async isGatewayEgressDestinationAllowed(input: { protocol: "https"; host: string; port: number }) {
    let destination: string;
    try {
      destination = gatewayDestinationOrigin(input.protocol, input.host, input.port)!;
    } catch {
      return false;
    }
    if (!destination) return false;

    try {
      const catalogOrigins = connectorCatalog("gateway-egress", this.microsoftAuthorizationOrigin)
        .flatMap((connector) => [connector.endpointUrl, ...connector.authorizationOrigins])
        .map(canonicalHttpsOrigin)
        .filter((origin): origin is string => Boolean(origin));
      if (catalogOrigins.includes(destination)) return true;

      // Hosted LiteLLM is shared by tenants. A tenant-local connector record
      // must not make an arbitrary host gateway-wide reachable, so hosted
      // custom destinations are deployment/IT-owned exact origins. In a
      // customer-managed single-tenant installation, the owner may opt into
      // the registry-backed dynamic path below.
      if (this.installationKind === "hosted") {
        return this.hostedCustomConnectorEgressOrigins.has(destination);
      }
      return (await this.registry.listEnabledEgressOrigins()).includes(destination);
    } catch {
      // A control/database outage must never become an egress allow.
      return false;
    }
  }

  async projectConnectedConnectors(identity: IdentityContext, policy: RuntimePolicy) {
    const connectors = await this.connectors(identity.tenantId);
    const connectionStates = new Map(
      (await this.registry.listConnectionStates(identity.tenantId, identity.subjectId)).map((state) => [state.connectorId, state]),
    );
    const cacheKey = `${identity.tenantId}:${identity.subjectId}:${policyProjectionDigest(policy)}`;
    const primaryConnector = connectors.find((connector) => connector.serverName === policy.mcpServer);
    const primaryIsActive = () => {
      // A policy-owned fixture or non-catalog MCP remains active by contract.
      // Catalog connectors, including Microsoft 365, require a current
      // tenant/user connection before they are projected into a gateway key.
      if (!primaryConnector) return true;
      if (!primaryConnector.enabled) return false;
      return connectionStates.get(primaryConnector.id)?.state === "connected";
    };
    const cached = this.projectionCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.policy;
    const primaryToolPolicies = primaryConnector?.enabled === false
      ? Object.fromEntries(policy.allowedTools.map((tool) => [tool, "deny" as const]))
      : policy.toolPolicies;
    // Agent discovery is a high-frequency control-plane read. Microsoft 365's
    // built-in policy uses durable connection state and never spends provider
    // calls on idle discovery. Reviewed custom connectors are revalidated only
    // on a bounded cache miss so same-name definition changes still fail closed.
    const connected = await Promise.all(connectors
      .filter((connector) => connector.enabled
        && connector.serverName !== policy.mcpServer
        && connectionStates.get(connector.id)?.state === "connected"
        && Object.keys(connector.toolPolicies).some((toolName) => explicitToolPolicy(connector.toolPolicies, toolName) !== "deny"))
      .map(async (connector) => {
        try {
          const status = await this.connectionStatus(identity, connector);
          if (status.state !== "connected") return null;
          const discoveredTools = await this.gateway.userOAuthConnectionTools(identity, connector.serverName);
          const { tools, toolPolicies } = this.reviewedToolsForProjection(connector, discoveredTools);
          return tools.length ? { connector, tools, toolPolicies, expiresAt: status.expiresAt } : null;
        } catch {
          return null;
        }
      }));
    const active = connected.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const primaryActive = primaryIsActive();
    const mcpServers = [policy.mcpServer, ...active.map(({ connector }) => connector.serverName)];
    const activeMcpServers = [
      ...(primaryActive ? [policy.mcpServer] : []),
      ...active.map(({ connector }) => connector.serverName),
    ];
    const mcpToolPermissions = {
      [policy.mcpServer]: policy.allowedTools,
      ...Object.fromEntries(active.map(({ connector, tools }) => [connector.serverName, tools])),
    };
    const allowedTools = [...new Set(Object.values(mcpToolPermissions).flat())].sort();
    const hostedToolPolicies = Object.assign({}, ...active.map(({ toolPolicies }) => toolPolicies));
    const toolPolicies = { ...primaryToolPolicies, ...hostedToolPolicies };
    const projectionDocument = JSON.stringify({ mcpServers, activeMcpServers, mcpToolPermissions, toolPolicies });
    const projected = runtimePolicySchema.parse({
      ...policy,
      mcpServers,
      activeMcpServers,
      mcpToolPermissions,
      allowedTools,
      toolPolicies,
      connectionProjectionHash: createHash("sha256").update(projectionDocument).digest("hex"),
      ...(policy.agents ? {
        agents: policy.agents.map((agent) => ({
          ...agent,
          activeMcpServers,
          allowedTools,
          toolPolicies: { ...agent.toolPolicies, ...primaryToolPolicies, ...hostedToolPolicies },
        })),
      } : {}),
    });
    // A cached connector grant must never outlive the OAuth credential that
    // justified it. Otherwise a provider-side revocation could remain usable
    // until the five-minute discovery cache expires without another status
    // check. Unknown or malformed expiries deliberately disable caching.
    const now = this.now();
    const cacheTtlMs = active.reduce((ttlMs, entry) => {
      const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
      return Number.isFinite(expiresAt)
        ? Math.min(ttlMs, Math.max(0, expiresAt - now))
        : 0;
    }, 5 * 60_000);
    this.projectionCache.set(cacheKey, { expiresAt: now + cacheTtlMs, policy: projected });
    return projected;
  }

  private statusFromStoredState(state: ConnectorConnectionStateRecord | null | undefined): OAuthConnectionStatus {
    if (!state) return { state: "disconnected", connectedAt: null, expiresAt: null, account: null };
    return { state: state.state, connectedAt: state.connectedAt?.toISOString() ?? null, expiresAt: state.expiresAt?.toISOString() ?? null, account: null };
  }

  private reviewedToolsForProjection(
    connector: Pick<ConnectorDefinition, "toolPolicies" | "toolDefinitionHashes">,
    discoveredTools: OAuthConnectionTool[],
  ) {
    const reviewed = discoveredTools.filter((tool) => (
      reviewedToolDecision(connector.toolPolicies, connector.toolDefinitionHashes, tool) !== "deny"
    ));
    return {
      tools: reviewed.map((tool) => tool.name),
      toolPolicies: Object.fromEntries(reviewed.map((tool) => [
        tool.name,
        reviewedToolDecision(connector.toolPolicies, connector.toolDefinitionHashes, tool),
      ])),
    };
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
    if (!connector) throw new LemmaComputerError("MCP_CONNECTOR_NOT_FOUND", "That connector is not in the approved catalog", 404);
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
        egressProfile: "strict_remote" as const,
      }));
    if (!managed.length) return;
    if (typeof this.gateway.ensureOAuthMcpServers !== "function") {
      throw new LemmaComputerError("MCP_ADMINISTRATION_NOT_CONFIGURED", "Managed connector registration is unavailable", 503, true);
    }
    await this.gateway.ensureOAuthMcpServers(managed);
  }

  private isOnDemandConnector(connector: Pick<ConnectorDefinition, "id" | "source">) {
    // Microsoft 365 is a static internal server. Every remote connector,
    // including an administrator-added custom connector, must reconcile its
    // durable LiteLLM row when a user connects so a failed startup discovery
    // cannot leave the connector permanently unusable.
    return connector.id !== "microsoft-365";
  }

  private publicConnector(connector: ConnectorDefinition) {
    const {
      authorizationOrigins: _authorizationOrigins,
      endpointUrl: _endpointUrl,
      scopes: _scopes,
      toolPolicies: _toolPolicies,
      toolDefinitionHashes: _toolDefinitionHashes,
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
      throw new LemmaComputerError("MCP_CONNECTOR_DISABLED", `${connector.name} is disabled by your organization`, 403);
    }
    if (!isAdministrator && !connector.membersCanManage) {
      throw new LemmaComputerError("MCP_CONNECTOR_LOCKED", `${connector.name} connections are managed by your administrator`, 403);
    }
  }

  private requireConnectionActivation(connector: Pick<ConnectorDefinition, "id" | "source">) {
    const activation = connectorActivation(connector);
    if (activation.action === "connect") return;
    throw new LemmaComputerError(
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
    ) throw new LemmaComputerError("MCP_ADMINISTRATION_NOT_CONFIGURED", "Connector administration is unavailable", 503, true);
    return this.gateway as OAuthConnectionGateway & McpConnectorAdministrationGateway;
  }

  private async validateCustomConnector(input: CreateConnectorInput): Promise<ValidatedPublicHttpsTarget> {
    if (!input.name.trim() || !input.shortDescription.trim() || !input.description.trim()) {
      throw new LemmaComputerError("MCP_CONNECTOR_DETAILS_REQUIRED", "Name and descriptions are required", 400);
    }
    if (input.clientSecret && !input.clientId) {
      throw new LemmaComputerError("MCP_CONNECTOR_CLIENT_INVALID", "Client ID is required when a client secret is supplied", 400);
    }
    if (input.iconDataUrl) this.validateConnectorIcon(input.iconDataUrl);
    let endpoint: ValidatedPublicHttpsTarget;
    try {
      endpoint = await validatePublicHttpsTarget(input.endpointUrl, {
        resolveHostname: this.resolveCustomConnectorHostname,
      });
    } catch (error) {
      if (
        error instanceof PublicHttpsTargetValidationError
        && (error.reasonCode === "EGRESS_IP_LITERAL_DENIED" || error.reasonCode === "EGRESS_DESTINATION_RESERVED")
      ) {
        throw new LemmaComputerError("MCP_CONNECTOR_URL_PRIVATE", "Private and local connector addresses are not allowed", 400);
      }
      throw new LemmaComputerError("MCP_CONNECTOR_URL_INVALID", "Enter a valid public HTTPS connector address", 400);
    }
    this.requireCustomConnectorEgressApproval(endpoint.origin);
    return endpoint;
  }

  private async validateCustomAuthorizationOrigin(origin: string): Promise<ValidatedPublicHttpsTarget> {
    let authorization: ValidatedPublicHttpsTarget;
    try {
      authorization = await validatePublicHttpsTarget(origin, {
        resolveHostname: this.resolveCustomConnectorHostname,
      });
    } catch {
      throw new LemmaComputerError(
        "MCP_CONNECTOR_AUTHORIZATION_ORIGIN_INVALID",
        "The connector did not provide a valid public HTTPS authorization address",
        400,
      );
    }
    this.requireCustomConnectorEgressApproval(authorization.origin);
    return authorization;
  }

  private requireCustomConnectorEgressApproval(origin: string) {
    if (this.installationKind === "hosted" && !this.hostedCustomConnectorEgressOrigins.has(origin)) {
      throw new LemmaComputerError(
        "MCP_CONNECTOR_EGRESS_NOT_APPROVED",
        `Deployment network approval is required for ${origin} before this connector can be added`,
        403,
      );
    }
  }

  private async withDiscoveryEgressPermit<T>(
    identity: IdentityContext,
    origins: string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const permit = await this.registry.createDiscoveryEgressPermit({
      tenantId: identity.tenantId,
      createdBy: identity.subjectId,
      origins,
      expiresAt: new Date(this.now() + Math.min(this.sessionTtlMs, 10 * 60 * 1_000)),
    });
    try {
      return await operation();
    } finally {
      await this.registry.deleteDiscoveryEgressPermit(identity.tenantId, permit.id).catch(() => undefined);
    }
  }

  private validateConnectorIcon(iconDataUrl: string) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(iconDataUrl);
    if (!match) {
      throw new LemmaComputerError("MCP_CONNECTOR_ICON_INVALID", "Use a PNG, JPEG, or WebP connector icon", 400);
    }
    const bytes = Buffer.from(match[2]!, "base64");
    if (!bytes.length || bytes.length > 256 * 1024) {
      throw new LemmaComputerError("MCP_CONNECTOR_ICON_INVALID", "Connector icons must be 256 KB or smaller", 400);
    }
    const mediaType = match[1];
    const validSignature = mediaType === "png"
      ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mediaType === "jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!validSignature) {
      throw new LemmaComputerError("MCP_CONNECTOR_ICON_INVALID", "The connector icon does not match its image format", 400);
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
