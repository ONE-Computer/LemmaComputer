import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { IdentityContext, LemmaComputerError, OwnedJson, RuntimeAgentPolicy, RuntimePolicy } from "@lemmacomputer/contracts";
import type { McpConnectorRegistrationInput, OAuthConnectionGateway, OAuthConnectionStatus, OAuthConnectionTool } from "@lemmacomputer/litellm-adapter";
import { MemoryConnectorRegistryStore } from "@lemmacomputer/workspace-store";
import {
  connectorCatalog,
  staticCredentialGroups,
  withheldConnectors,
} from "../apps/control-api/src/connector-catalog.js";
import { McpConnectionService, Microsoft365ConnectionService } from "../apps/control-api/src/connections.js";
import type { MicrosoftSharePointSitePermissionGateway } from "../apps/control-api/src/microsoft-sharepoint-site-permissions.js";

const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "lemmacomputer-control" };
const connectorApplicationId = "33333333-3333-4333-8333-333333333333";
const providerDirectoryId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
// A deployment that has registered both provider OAuth applications. Without
// them, the connectors depending on those credentials are not published.
const allCredentials = [...staticCredentialGroups];
const beta: IdentityContext = { tenantId: "acme", subjectId: "beta", audience: "lemmacomputer-control" };
const connected: OAuthConnectionStatus = {
  state: "connected",
  connectedAt: "2026-07-20T01:02:03Z",
  expiresAt: "2026-07-20T02:02:03Z",
  account: { displayName: "Alex Morgan", email: "alex@acme.example", userPrincipalName: "alex@acme.example" },
};

type FixtureTool = string | OAuthConnectionTool;
const fixtureTool = (tool: FixtureTool): OAuthConnectionTool => typeof tool === "string"
  ? {
    name: tool,
    definitionHash: createHash("sha256").update(JSON.stringify({ name: tool })).digest("hex"),
  }
  : tool;

class FakeConnectionGateway implements OAuthConnectionGateway {
  started: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0][] = [];
  completed: Parameters<OAuthConnectionGateway["completeUserOAuthConnection"]>[0][] = [];
  statusServers: string[] = [];
  disconnectedServers: string[] = [];
  registered: McpConnectorRegistrationInput[] = [];
  ensured: McpConnectorRegistrationInput[][] = [];
  removed: string[] = [];
  discoveries = 0;
  toolServers: string[] = [];
  onStatus?: (identity: IdentityContext, serverName: string) => OAuthConnectionStatus | Promise<OAuthConnectionStatus>;
  onTools?: (identity: IdentityContext, serverName: string) => FixtureTool[] | Promise<FixtureTool[]>;
  onDiscover?: () => { authorizationOrigin: string; dynamicClientRegistration: boolean } | Promise<{ authorizationOrigin: string; dynamicClientRegistration: boolean }>;
  onRegister?: (input: McpConnectorRegistrationInput) => void | Promise<void>;
  statusByServer = new Map<string, OAuthConnectionStatus>();
  toolsByServer = new Map<string, FixtureTool[]>();
  calledTools: Array<{ identity: IdentityContext; serverName: string; toolName: string; argumentsValue: Record<string, OwnedJson> }> = [];
  onCall?: (toolName: string, argumentsValue: Record<string, OwnedJson>) => OwnedJson | Promise<OwnedJson>;

  async beginUserOAuthConnection(input: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0]) {
    this.started.push(input);
    return { location: "http://localhost:3001/authorize", cookies: ["mcp_oauth_state=opaque; HttpOnly"] };
  }
  async completeUserOAuthConnection(input: Parameters<OAuthConnectionGateway["completeUserOAuthConnection"]>[0]) {
    this.completed.push(input);
    return connected;
  }
  async userOAuthConnectionStatus(identity: IdentityContext, serverName: string) {
    this.statusServers.push(serverName);
    if (this.onStatus) return this.onStatus(identity, serverName);
    return this.statusByServer.get(serverName)
      ?? { state: "disconnected", connectedAt: null, expiresAt: null, account: null } as const;
  }
  async disconnectUserOAuthConnection(_identity: IdentityContext, serverName: string) {
    this.disconnectedServers.push(serverName);
    return { state: "disconnected", connectedAt: null, expiresAt: null, account: null } as const;
  }
  async userOAuthConnectionTools(identity: IdentityContext, serverName: string): Promise<OAuthConnectionTool[]> {
    this.toolServers.push(serverName);
    const tools = this.onTools
      ? await this.onTools(identity, serverName)
      : this.toolsByServer.get(serverName) ?? [];
    return tools.map(fixtureTool);
  }
  async callUserOAuthConnectionTool(identity: IdentityContext, serverName: string, toolName: string, argumentsValue: Record<string, OwnedJson>) {
    this.calledTools.push({ identity, serverName, toolName, argumentsValue });
    return this.onCall ? this.onCall(toolName, argumentsValue) : {};
  }
  async discoverOAuthMcpServer() {
    this.discoveries += 1;
    if (this.onDiscover) return this.onDiscover();
    return { authorizationOrigin: "https://auth.example.com", dynamicClientRegistration: true };
  }
  async registerOAuthMcpServer(input: McpConnectorRegistrationInput) {
    this.registered.push(input);
    await this.onRegister?.(input);
  }
  async ensureOAuthMcpServers(inputs: McpConnectorRegistrationInput[]) {
    this.ensured.push(inputs);
  }
  async removeMcpServer(serverId: string) { this.removed.push(serverId); }
}

const completeFixtureConnection = async (
  service: McpConnectionService,
  gateway: FakeConnectionGateway,
  identity: IdentityContext,
  connectorId: string,
) => {
  await service.start(identity, connectorId);
  const request = gateway.started.at(-1)!;
  return service.complete(identity, connectorId, { state: request.state, code: "fixture-authorization-code" });
};

const saveCurrentConnectorToolPolicy = async (
  service: McpConnectionService,
  identity: IdentityContext,
  connectorId: string,
  tools: Record<string, "allow" | "approval_required" | "deny">,
) => {
  const current = await service.connectorToolPolicy(identity, connectorId);
  return service.saveConnectorToolPolicy(identity, identity.subjectId, connectorId, tools, current.documentHash, current.accessPolicyVersion, `test-${connectorId}-${current.accessPolicyVersion}`);
};

const publicConnectorResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];
const sharePointSitePermissions: MicrosoftSharePointSitePermissionGateway = {
  grantRead: async ({ hostname, sitePath }) => ({
    graphSiteId: `${hostname},collection,${sitePath.split("/").at(-1)?.toLowerCase()}`,
    permissionId: `permission-${sitePath.split("/").at(-1)?.toLowerCase()}`,
  }),
  revoke: async () => ({ revoked: true }),
};

const approveSharePointSiteAdministration = async (
  service: McpConnectionService,
  registry: MemoryConnectorRegistryStore,
  identity: IdentityContext,
) => {
  await service.list(identity, true);
  await registry.recordSharePointAdminConsent(identity.tenantId, "microsoft-365", {
    providerTenantId: providerDirectoryId,
    requestedBy: identity.subjectId,
  });
};

test("owned Microsoft 365 flow binds state and PKCE to the initiating LemmaComputer identity", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new Microsoft365ConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  const started = await service.start(alpha);
  const request = gateway.started[0]!;
  assert.equal(started.location, "http://localhost:3001/authorize");
  assert.equal(request.identity, alpha);
  assert.equal(request.serverName, "lemmacomputer_ms365");
  assert.equal(request.redirectUri, "http://localhost:4174/api/v1/connections/microsoft-365/callback");
  assert.match(request.state, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(request.codeChallenge, /^[A-Za-z0-9_-]{40,}$/);

  const result = await service.complete(alpha, { state: request.state, code: "authorization-code" });
  assert.deepEqual(result, connected);
  assert.equal(gateway.completed.length, 1);
  assert.equal(gateway.completed[0]!.identity, alpha);
  assert.equal(gateway.completed[0]!.serverName, "lemmacomputer_ms365");
  assert.notEqual(gateway.completed[0]!.codeVerifier, request.codeChallenge);
});

test("SharePoint site administration is tenant-scoped and verification stores only non-secret Graph identifiers", async () => {
  const gateway = new FakeConnectionGateway();
  const registry = new MemoryConnectorRegistryStore();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
    registry,
    microsoftSharePointSitePermissions: sharePointSitePermissions,
    microsoftSharePointConnectorClientId: connectorApplicationId,
  });
  await approveSharePointSiteAdministration(service, registry, alpha);
  const otherTenant = { ...alpha, tenantId: "other" };
  const created = await service.createMicrosoft365SharePointSite(alpha, alpha.subjectId, {
    displayName: " Finance policies ",
    siteUrl: "https://CONTOSO.sharepoint.com/sites/Finance/",
  });
  assert.equal(created.displayName, "Finance policies");
  assert.equal(created.siteUrl, "https://contoso.sharepoint.com/sites/Finance");
  assert.equal(created.microsoftAccessStatus, "granted");
  assert.equal(created.microsoftPermissionId, "permission-finance");
  assert.equal((await service.listMicrosoft365SharePointSites(otherTenant)).sites.length, 0);

  gateway.onCall = async (toolName, argumentsValue) => {
    if (toolName === "get-sharepoint-site-by-path") {
      assert.deepEqual(argumentsValue, { "site-id": "contoso.sharepoint.com", path: "sites/Finance" });
      return { id: "contoso.sharepoint.com,collection,finance", displayName: "Finance" };
    }
    assert.equal(toolName, "list-sharepoint-site-drives");
    assert.deepEqual(argumentsValue, { "site-id": "contoso.sharepoint.com,collection,finance" });
    return { value: [{ id: "drive-a", name: "Documents" }, { id: "drive-b", name: "Policies" }] };
  };
  const verified = await service.verifyMicrosoft365SharePointSite(alpha, created.id);
  assert.equal(verified.status, "verified");
  assert.equal(verified.graphSiteId, "contoso.sharepoint.com,collection,finance");
  assert.deepEqual(verified.driveIds, ["drive-a", "drive-b"]);
  assert.equal(await service.authorizeMicrosoft365SharePointTarget(alpha, "get-sharepoint-site-by-path", {
    "site-id": "contoso.sharepoint.com",
    path: "sites/Finance",
  }), true);
  assert.equal(await service.authorizeMicrosoft365SharePointTarget(alpha, "list-sharepoint-site-drives", {
    "site-id": "contoso.sharepoint.com,collection,finance",
  }), true);
  assert.equal(await service.authorizeMicrosoft365SharePointTarget(alpha, "get-sharepoint-site", {
    "site-id": "contoso.sharepoint.com,collection,other",
  }), false);
  assert.deepEqual(await service.approvedMicrosoft365SharePointSites(alpha), [{
    displayName: "Finance policies",
    siteUrl: "https://contoso.sharepoint.com/sites/Finance",
    hostname: "contoso.sharepoint.com",
    sitePath: "sites/Finance",
  }]);
  assert.deepEqual(gateway.calledTools.map((call) => call.toolName), [
    "get-sharepoint-site-by-path",
    "list-sharepoint-site-drives",
  ]);
});

test("SharePoint grants target the tenant-owned connector application when configured", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const targetedClientIds: string[] = [];
  const service = new McpConnectionService(new FakeConnectionGateway(), {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    registry,
    microsoftSharePointSitePermissions: {
      grantRead: async ({ connectorClientId }) => {
        targetedClientIds.push(connectorClientId);
        return { graphSiteId: "contoso.sharepoint.com,collection,finance", permissionId: "permission-finance" };
      },
      revoke: async () => ({ revoked: true }),
    },
    microsoftSharePointConnectorClientId: connectorApplicationId,
  });
  await approveSharePointSiteAdministration(service, registry, alpha);
  const tenantConnectorApplicationId = "44444444-4444-4444-8444-444444444444";
  await registry.saveConnectorCredentials(alpha.tenantId, "microsoft-365", {
    serverId: "tenant-ms365-server",
    serverName: "tenant_ms365",
    oauthClientId: tenantConnectorApplicationId,
    updatedBy: alpha.subjectId,
  });

  await service.createMicrosoft365SharePointSite(alpha, alpha.subjectId, {
    displayName: "Finance",
    siteUrl: "https://contoso.sharepoint.com/sites/Finance",
  });

  assert.deepEqual(targetedClientIds, [tenantConnectorApplicationId]);
});

test("SharePoint site URLs preserve a canonical encoded URL and reject malformed encoding", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const service = new McpConnectionService(new FakeConnectionGateway(), {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    registry,
    microsoftSharePointSitePermissions: sharePointSitePermissions,
    microsoftSharePointConnectorClientId: connectorApplicationId,
  });
  await approveSharePointSiteAdministration(service, registry, alpha);
  const created = await service.createMicrosoft365SharePointSite(alpha, alpha.subjectId, {
    displayName: "People policies",
    siteUrl: "https://CONTOSO.sharepoint.com/sites/People%20Policies/",
  });
  assert.equal(created.siteUrl, "https://contoso.sharepoint.com/sites/People%20Policies");
  assert.equal(created.sitePath, "sites/People Policies");
  await assert.rejects(
    service.createMicrosoft365SharePointSite(alpha, alpha.subjectId, {
      displayName: "Broken",
      siteUrl: "https://contoso.sharepoint.com/sites/Bad%ZZ",
    }),
    (error: Error & { code?: string }) => error.code === "M365_SHAREPOINT_SITE_URL_INVALID",
  );
});

test("SharePoint provider failures remain visible and revocation fails closed", async () => {
  let operation: "grant" | "revoke" | "ok" = "grant";
  const gateway = new FakeConnectionGateway();
  gateway.onCall = async (toolName) => toolName === "get-sharepoint-site-by-path"
    ? { id: "contoso.sharepoint.com,collection,legal" }
    : { value: [{ id: "legal-documents" }] };
  const permissions: MicrosoftSharePointSitePermissionGateway = {
    grantRead: async () => {
      if (operation === "grant") throw new Error("Microsoft rejected the site grant");
      return { graphSiteId: "contoso.sharepoint.com,collection,legal", permissionId: "permission-legal" };
    },
    revoke: async () => {
      if (operation === "revoke") throw new Error("Microsoft rejected the site revocation");
      return { revoked: true };
    },
  };
  const registry = new MemoryConnectorRegistryStore();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    registry,
    microsoftSharePointSitePermissions: permissions,
    microsoftSharePointConnectorClientId: connectorApplicationId,
  });
  await approveSharePointSiteAdministration(service, registry, alpha);
  await assert.rejects(
    service.createMicrosoft365SharePointSite(alpha, alpha.subjectId, {
      displayName: "Legal",
      siteUrl: "https://contoso.sharepoint.com/sites/Legal",
    }),
    (error: Error & { code?: string }) => error.code === "M365_SHAREPOINT_SITE_GRANT_FAILED",
  );
  let [site] = (await service.listMicrosoft365SharePointSites(alpha)).sites;
  assert.equal(site?.microsoftAccessStatus, "grant_failed");
  assert.equal(site?.microsoftLastError, "Microsoft rejected the site grant");

  operation = "ok";
  site = await service.grantMicrosoft365SharePointSite(alpha, site!.id);
  assert.equal(site.microsoftAccessStatus, "granted");
  site = await service.verifyMicrosoft365SharePointSite(alpha, site.id);
  assert.equal((await service.approvedMicrosoft365SharePointSites(alpha)).length, 1);

  operation = "revoke";
  await assert.rejects(
    service.deleteMicrosoft365SharePointSite(alpha, site.id),
    (error: Error & { code?: string }) => error.code === "M365_SHAREPOINT_SITE_REVOCATION_FAILED",
  );
  [site] = (await service.listMicrosoft365SharePointSites(alpha)).sites;
  assert.equal(site?.microsoftAccessStatus, "revocation_failed");
  assert.equal((await service.approvedMicrosoft365SharePointSites(alpha)).length, 0);
});

test("connection state is one-time and cannot be finished by another user", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new Microsoft365ConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await service.start(alpha);
  const state = gateway.started[0]!.state;
  await assert.rejects(() => service.complete(beta, { state, code: "authorization-code" }), { code: "MCP_OAUTH_IDENTITY_MISMATCH" });
  await assert.rejects(() => service.complete(alpha, { state, code: "authorization-code" }), { code: "MCP_OAUTH_STATE_INVALID" });
  assert.equal(gateway.completed.length, 0);
});

test("expired, denied, and malformed callbacks fail before token exchange", async () => {
  let now = 1_000;
  const gateway = new FakeConnectionGateway();
  const service = new Microsoft365ConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    sessionTtlMs: 100,
    now: () => now,
  });
  await service.start(alpha);
  const expired = gateway.started.at(-1)!.state;
  now += 101;
  await assert.rejects(() => service.complete(alpha, { state: expired, code: "authorization-code" }), { code: "MCP_OAUTH_STATE_INVALID" });

  await service.start(alpha);
  const denied = gateway.started.at(-1)!.state;
  await assert.rejects(() => service.complete(alpha, { state: denied, error: "access_denied" }), { code: "MCP_OAUTH_DENIED" });

  await service.start(alpha);
  const missingCode = gateway.started.at(-1)!.state;
  await assert.rejects(() => service.complete(alpha, { state: missingCode }), { code: "MCP_OAUTH_CODE_INVALID" });
  assert.equal(gateway.completed.length, 0);
});

test("the default catalog covers the required categories and registers a remote server only on Connect", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });

  const catalog = await service.list(alpha);
  const defaultCards = catalog.connections.map((connector) => [connector.id, connector.serverName]);
  assert.equal(defaultCards.length, 25);
  const neon = catalog.connections.find((connector) => connector.id === "neon");
  assert.equal(neon?.serverName, "lemmacomputer_neon");
  assert.equal(neon?.brand, "neon");
  assert.equal(neon?.source, "built-in");
  const exa = catalog.connections.find((connector) => connector.id === "exa");
  assert.deepEqual(exa && {
    serverName: exa.serverName,
    category: exa.category,
    brand: exa.brand,
  }, {
    serverName: "lemmacomputer_exa",
    category: "Search",
    brand: "exa",
  });
  const exaDefinition = connectorCatalog(alpha.tenantId, "http://localhost:3001")
    .find((connector) => connector.id === "exa");
  assert.deepEqual(exaDefinition && {
    endpointUrl: exaDefinition.endpointUrl,
    authorizationOrigins: exaDefinition.authorizationOrigins,
    scopes: exaDefinition.scopes,
  }, {
    endpointUrl: "https://mcp.exa.ai/mcp",
    authorizationOrigins: ["https://auth.exa.ai"],
    scopes: ["mcp:tools"],
  });
  const researchedEndpoints = Object.fromEntries(
    ["gmail", "google-drive", "google-calendar", "canva", "monday", "clickup", "calendly", "fireflies", "massive", "supabase", "stripe"]
      .map((id) => {
        const connector = connectorCatalog(alpha.tenantId, "http://localhost:3001")
          .find((candidate) => candidate.id === id);
        return [id, connector && {
          endpointUrl: connector.endpointUrl,
          authorizationOrigins: connector.authorizationOrigins,
          scopes: connector.scopes,
        }];
      }),
  );
  assert.deepEqual(researchedEndpoints, {
    gmail: {
      endpointUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      authorizationOrigins: ["https://accounts.google.com", "https://oauth2.googleapis.com"],
      scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.compose"],
    },
    "google-drive": {
      endpointUrl: "https://drivemcp.googleapis.com/mcp/v1",
      authorizationOrigins: ["https://accounts.google.com", "https://oauth2.googleapis.com"],
      scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"],
    },
    "google-calendar": {
      endpointUrl: "https://calendarmcp.googleapis.com/mcp/v1",
      authorizationOrigins: ["https://accounts.google.com", "https://oauth2.googleapis.com"],
      scopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"],
    },
    canva: {
      endpointUrl: "https://mcp.canva.com/mcp",
      authorizationOrigins: ["https://mcp.canva.com"],
      scopes: [],
    },
    monday: {
      endpointUrl: "https://mcp.monday.com/mcp",
      authorizationOrigins: ["https://mcp.monday.com", "https://auth.monday.com"],
      scopes: [],
    },
    clickup: {
      endpointUrl: "https://mcp.clickup.com/mcp",
      authorizationOrigins: ["https://mcp.clickup.com", "https://app.clickup.com"],
      scopes: [],
    },
    calendly: {
      endpointUrl: "https://mcp.calendly.com",
      authorizationOrigins: ["https://calendly.com"],
      scopes: ["mcp:scheduling:read", "mcp:scheduling:write"],
    },
    fireflies: {
      endpointUrl: "https://api.fireflies.ai/mcp",
      authorizationOrigins: ["https://api.fireflies.ai"],
      scopes: [],
    },
    massive: {
      endpointUrl: "https://mcp.massive.com/",
      authorizationOrigins: ["https://mcp.massive.com", "https://massive.com", "https://auth.massive.com"],
      scopes: [],
    },
    supabase: {
      endpointUrl: "https://mcp.supabase.com/mcp",
      authorizationOrigins: ["https://mcp.supabase.com", "https://supabase.com", "https://api.supabase.com"],
      scopes: [],
    },
    stripe: {
      endpointUrl: "https://mcp.stripe.com",
      authorizationOrigins: ["https://mcp.stripe.com", "https://dashboard.stripe.com", "https://access.stripe.com"],
      scopes: [],
    },
  });
  assert.deepEqual(defaultCards.slice(0, 6), [
    ["microsoft-365", "lemmacomputer_ms365"],
    ["gmail", "lemmacomputer_gmail"],
    ["google-drive", "lemmacomputer_google_drive"],
    ["google-calendar", "lemmacomputer_google_calendar"],
    ["notion", "lemmacomputer_notion"],
    ["linear", "lemmacomputer_linear"],
  ]);
  assert.deepEqual(gateway.statusServers, [], "browsing cards without a marker must not probe a provider");
  assert.deepEqual(gateway.toolServers, [], "browsing cards must not discover provider tools");
  assert.equal(gateway.ensured.length, 0, "listing the catalog must not register remote MCP servers");
  await service.start(alpha, "notion");
  assert.deepEqual(gateway.ensured.map((connectors) => connectors.map((connector) => connector.serverName)), [
    ["lemmacomputer_notion"],
  ]);
  assert.ok(catalog.connections.every((connector) => connector.available));
  assert.ok(catalog.connections.every((connector) => !("authorizationOrigins" in connector)));
  assert.ok(catalog.connections.every((connector) => connector.activation.readiness === "ready"));
  assert.ok(catalog.connections.every((connector) => connector.activation.action === "connect"));
  // Communication ships no connector while Slack is withheld for credentials.
  for (const category of ["Productivity", "Search", "Developer tools", "Business", "Data and analytics"]) {
    assert.ok(catalog.connections.some((connector) => connector.category === category), `catalog includes ${category}`);
  }
});

test("every approved remote MCP card lazily starts its provider flow only after Connect", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  for (const connectorId of ["exa", "github", "notion", "neon", "monday"]) await service.start(alpha, connectorId);
  assert.deepEqual(gateway.started.map((request) => request.serverName), [
    "lemmacomputer_exa",
    "lemmacomputer_github",
    "lemmacomputer_notion",
    "lemmacomputer_neon",
    "lemmacomputer_monday",
  ]);
  // GitHub is declared in config/litellm/config.yaml, so the gateway owns its
  // row and connector administration must not try to reconcile it.
  assert.deepEqual(gateway.ensured.map((connectors) => connectors[0]?.serverName), [
    "lemmacomputer_exa",
    "lemmacomputer_notion",
    "lemmacomputer_neon",
    "lemmacomputer_monday",
  ]);
});

test("unconnected connector policy inspection never probes provider grants or tools", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });

  await assert.rejects(
    () => service.connectorToolPolicy(alpha, "linear"),
    { code: "MCP_CONNECTOR_NOT_CONNECTED" },
  );

  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"), null);
  assert.deepEqual(gateway.statusServers, []);
  assert.deepEqual(gateway.toolServers, []);
});

test("catalog re-entry probes only durable markers and flags a changed connector projection", async () => {
  const gateway = new FakeConnectionGateway();
  const registry = new MemoryConnectorRegistryStore();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    registry,
  });

  await service.list(alpha);
  assert.deepEqual(gateway.statusServers, []);
  assert.deepEqual(gateway.toolServers, []);
  await registry.saveConnectionState({
    tenantId: alpha.tenantId,
    subjectId: alpha.subjectId,
    connectorId: "linear",
    state: "expired",
    connectedAt: new Date("2026-07-20T01:02:03Z"),
    expiresAt: new Date("2026-07-20T02:02:03Z"),
  });
  const expired: OAuthConnectionStatus = { state: "expired", connectedAt: connected.connectedAt, expiresAt: connected.expiresAt, account: null };
  gateway.statusByServer.set("lemmacomputer_linear", expired);
  gateway.onTools = (_identity, serverName) => {
    assert.equal(serverName, "lemmacomputer_linear");
    gateway.statusByServer.set(serverName, connected);
    return ["create_issue"];
  };

  const renewed = await service.list(alpha);
  const linear = renewed.connections.find((connector) => connector.id === "linear")!;
  assert.equal(linear.state, "connected");
  assert.equal(renewed.connectionProjectionChanged, true);
  assert.equal(linear.account, null);
  assert.deepEqual(gateway.statusServers, ["lemmacomputer_linear", "lemmacomputer_linear"]);
  assert.deepEqual(gateway.toolServers, ["lemmacomputer_linear"]);
  assert.equal((await registry.getConnectionState(alpha.tenantId, alpha.subjectId, "linear"))?.state, "connected");

  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  const stable = await service.list(alpha);
  assert.equal(stable.connectionProjectionChanged, false);
  assert.deepEqual(gateway.statusServers, ["lemmacomputer_linear"]);
  assert.deepEqual(gateway.toolServers, []);
  await registry.saveConnectionState({
    tenantId: alpha.tenantId,
    subjectId: alpha.subjectId,
    connectorId: "linear",
    state: "expired",
    connectedAt: new Date("2026-07-20T01:02:03Z"),
    expiresAt: new Date("2026-07-20T02:02:03Z"),
  });
  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  gateway.onStatus = () => { throw new Error("fixture status unavailable"); };

  const unavailable = await service.list(alpha);
  const unavailableLinear = unavailable.connections.find((connector) => connector.id === "linear")!;
  assert.equal(unavailableLinear.state, "expired");
  assert.equal(unavailableLinear.account, null);
  assert.equal(unavailable.connectionProjectionChanged, true);
  assert.deepEqual(gateway.statusServers, ["lemmacomputer_linear"]);
});

test("hosted tool policy requires an explicit tool decision and a current connection", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("lemmacomputer_linear", connected);
  gateway.toolsByServer.set("lemmacomputer_linear", ["create_issue"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");

  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"), null);
  assert.deepEqual(gateway.statusServers, []);
  assert.deepEqual(gateway.toolServers, []);

  await saveCurrentConnectorToolPolicy(service, alpha, "linear", { create_issue: "allow" });
  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  assert.equal((await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"))?.decision, "allow");
  assert.deepEqual(gateway.statusServers, ["lemmacomputer_linear"]);
  assert.deepEqual(gateway.toolServers, ["lemmacomputer_linear"]);

  gateway.statusByServer.set("lemmacomputer_linear", { state: "disconnected", connectedAt: null, expiresAt: null, account: null });
  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"), null);
  assert.deepEqual(gateway.statusServers, ["lemmacomputer_linear"]);
  assert.deepEqual(gateway.toolServers, []);

  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"), null);
  assert.deepEqual(gateway.statusServers, []);
  assert.deepEqual(gateway.toolServers, []);
});

test("only explicitly approved connected catalog services contribute workspace tools", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("lemmacomputer_linear", connected);
  gateway.toolsByServer.set("lemmacomputer_linear", ["create_issue"]);
  gateway.toolsByServer.set("lemmacomputer_asana", ["create_task"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");
  const basePolicy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "policy-v1",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "agent-alpha",
    agentProfile: "claude-desktop-managed-v1",
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };

  const projected = await service.projectConnectedConnectors(alpha, basePolicy);

  assert.deepEqual(projected.mcpServers, ["lemmacomputer_ms365"]);
  assert.deepEqual(projected.activeMcpServers, [], "an assigned but disconnected primary connector is not callable");
  assert.equal(projected.mcpToolPermissions?.lemmacomputer_linear, undefined);
  assert.equal(projected.mcpToolPermissions?.lemmacomputer_asana, undefined);
  assert.deepEqual(gateway.toolServers, [], "unreviewed connectors do not spend provider calls during agent discovery");
  assert.deepEqual(gateway.statusServers, [], "unreviewed connectors do not spend status calls during agent discovery");
});

test("a disconnected Microsoft 365 primary cannot suppress an approved connected Exa server", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("lemmacomputer_exa", connected);
  gateway.toolsByServer.set("lemmacomputer_exa", ["web_search"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "exa");
  await saveCurrentConnectorToolPolicy(service, alpha, "exa", { web_search: "allow" });
  const basePolicy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "policy-v1",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "agent-alpha",
    agentProfile: "claude-desktop-managed-v1",
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };

  const projected = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(projected.mcpServers, ["lemmacomputer_ms365", "lemmacomputer_exa"]);
  assert.deepEqual(projected.activeMcpServers, ["lemmacomputer_exa"]);
  assert.deepEqual(projected.mcpToolPermissions?.lemmacomputer_exa, ["web_search"]);

  gateway.statusByServer.set("lemmacomputer_exa", {
    state: "disconnected",
    connectedAt: null,
    expiresAt: null,
    account: null,
  });
  await service.list(alpha);
  const noneConnected = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(noneConnected.mcpServers, ["lemmacomputer_ms365"]);
  assert.deepEqual(noneConnected.activeMcpServers, [], "zero connected connectors is an explicit safe runtime state");
});

test("repeated agent discovery never probes the connected Microsoft 365 provider", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "microsoft-365");
  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  const policy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "policy-v1",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "agent-alpha",
    agentProfile: "claude-desktop-managed-v1",
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages", "create-calendar-event"],
    toolPolicies: { "list-mail-messages": "allow", "create-calendar-event": "allow" },
  };

  for (let count = 0; count < 100; count += 1) {
    const projected = await service.projectConnectedConnectors(alpha, policy);
    assert.deepEqual(projected.activeMcpServers, ["lemmacomputer_ms365"]);
  }
  assert.deepEqual(gateway.statusServers, []);
  assert.deepEqual(gateway.toolServers, []);
});

test("hosted connector OAuth binds the selected catalog entry and refuses cross-connector callbacks", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });

  await service.start(alpha, "linear");
  const request = gateway.started.at(-1)!;
  assert.equal(request.serverName, "lemmacomputer_linear");
  assert.equal(request.redirectUri, "http://localhost:4174/api/v1/connections/linear/callback");
  assert.deepEqual(request.authorizationOrigins, ["https://mcp.linear.app"]);

  await assert.rejects(
    () => service.complete(alpha, "notion", { state: request.state, code: "authorization-code" }),
    { code: "MCP_OAUTH_CONNECTOR_MISMATCH" },
  );
  assert.equal(gateway.completed.length, 0);
});

test("new hosted connector tools are blocked pending review and persist explicit approval rules", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("lemmacomputer_linear", connected);
  gateway.toolsByServer.set("lemmacomputer_linear", ["create_issue", "list_issues"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");

  const initial = await service.connectorToolPolicy(alpha, "linear");
  assert.deepEqual(initial.tools.map((tool) => [tool.name, tool.decision, tool.reviewRequired]), [
    ["create_issue", "deny", true],
    ["list_issues", "deny", true],
  ]);
  assert.match(initial.tools[0]!.description, /Blocked until an administrator reviews/i);
  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"), null);

  const saved = await service.saveConnectorToolPolicy(alpha, alpha.subjectId, "linear", {
    create_issue: "approval_required",
    list_issues: "deny",
  }, initial.documentHash, initial.accessPolicyVersion, "save-new-tools");
  assert.deepEqual(saved.tools.map((tool) => [tool.name, tool.decision, tool.reviewRequired]), [
    ["create_issue", "approval_required", false],
    ["list_issues", "deny", false],
  ]);
  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "list_issues"), null);
  assert.equal((await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"))?.decision, "approval_required");

  gateway.toolsByServer.set("lemmacomputer_linear", ["create_issue", "list_issues", "delete_issue"]);
  const changed = await service.connectorToolPolicy(alpha, "linear");
  assert.deepEqual(changed.tools.map((tool) => [tool.name, tool.decision, tool.reviewRequired]), [
    ["create_issue", "approval_required", false],
    ["list_issues", "deny", false],
    ["delete_issue", "deny", true],
  ]);
  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "delete_issue"), null);

  const projected = await service.projectConnectedConnectors(alpha, {
    schemaVersion: 1,
    policyVersionId: "policy-v1",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "agent-alpha",
    agentProfile: "claude-desktop-managed-v1",
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  });
  assert.deepEqual(projected.mcpToolPermissions?.lemmacomputer_linear, ["create_issue"]);
  assert.equal(projected.toolPolicies.delete_issue, undefined);

  await assert.rejects(
    () => service.saveConnectorToolPolicy(alpha, alpha.subjectId, "linear", { create_issue: "allow" }, changed.documentHash, changed.accessPolicyVersion, "missing-tool-decision"),
    { code: "INVALID_TOOL_POLICY" },
  );
});

test("a same-name provider tool change revokes cached projection and rejects a stale review", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("lemmacomputer_linear", connected);
  gateway.toolsByServer.set("lemmacomputer_linear", [{ name: "create_issue", definitionHash: "a".repeat(64) }]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");
  const review = await service.connectorToolPolicy(alpha, "linear");
  await service.saveConnectorToolPolicy(alpha, alpha.subjectId, "linear", { create_issue: "allow" }, review.documentHash, review.accessPolicyVersion, "initial-review");
  const policy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "policy-v1",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "agent-alpha",
    agentProfile: "claude-desktop-managed-v1",
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  assert.deepEqual((await service.projectConnectedConnectors(alpha, policy)).mcpToolPermissions?.lemmacomputer_linear, ["create_issue"]);

  gateway.toolsByServer.set("lemmacomputer_linear", [{ name: "create_issue", definitionHash: "b".repeat(64) }]);
  const changed = await service.connectorToolPolicy(alpha, "linear");
  assert.deepEqual(changed.changes, { added: [], changed: ["create_issue"], removed: [] });
  assert.deepEqual(changed.tools.map((tool) => [tool.name, tool.decision, tool.reviewRequired]), [["create_issue", "deny", true]]);
  await assert.rejects(
    () => service.saveConnectorToolPolicy(alpha, alpha.subjectId, "linear", { create_issue: "allow" }, review.documentHash, review.accessPolicyVersion, "stale-provider-review"),
    { code: "TOOL_SET_CHANGED_REVIEW_AGAIN" },
  );
  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"), null);
  const afterChange = await service.projectConnectedConnectors(alpha, policy);
  assert.deepEqual(afterChange.mcpServers, ["lemmacomputer_ms365"], "a cache hit cannot retain a changed definition");
});

test("organization connector access policy locks member changes and removes disabled tools from grants", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("lemmacomputer_linear", connected);
  gateway.toolsByServer.set("lemmacomputer_linear", ["create_issue", "list_issues"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");
  const reviewed = await saveCurrentConnectorToolPolicy(service, alpha, "linear", {
    create_issue: "approval_required",
    list_issues: "deny",
  });
  const locked = await service.updateAccessPolicy(alpha, "admin-alpha", "linear", {
    enabled: true,
    membersCanManage: false,
    expectedVersion: reviewed.accessPolicyVersion,
    correlationId: "lock-member-management",
  });
  assert.equal(locked.connector.membersCanManage, false);
  await assert.rejects(
    () => service.updateAccessPolicy(alpha, "admin-alpha", "linear", {
      enabled: false,
      membersCanManage: false,
      expectedVersion: reviewed.accessPolicyVersion,
      correlationId: "stale-access-policy",
    }),
    { code: "CONNECTOR_POLICY_VERSION_CONFLICT" },
  );
  const memberCatalog = await service.list(alpha);
  const memberLinear = memberCatalog.connections.find((connector) => connector.id === "linear")!;
  assert.equal(memberLinear.canManageConnection, false);
  assert.equal((await service.list(alpha, true)).connections.find((connector) => connector.id === "linear")?.canManageConnection, true);
  await assert.rejects(() => service.start(alpha, "linear"), { code: "MCP_CONNECTOR_LOCKED" });
  await service.start(alpha, "linear", true);

  const basePolicy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "policy-v1",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "agent-alpha",
    agentProfile: "claude-desktop-managed-v1",
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  const projected = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(projected.mcpToolPermissions?.lemmacomputer_linear, ["create_issue"]);
  assert.equal(projected.toolPolicies.create_issue, "approval_required");
  assert.equal(projected.toolPolicies.list_issues, undefined);

  await service.updateAccessPolicy(alpha, "admin-alpha", "linear", {
    enabled: false,
    membersCanManage: false,
    expectedVersion: locked.connector.accessPolicyVersion,
    correlationId: "disable-linear",
  });
  await assert.rejects(() => service.start(alpha, "linear", true), { code: "MCP_CONNECTOR_DISABLED" });
  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"), null);
  const disabledProjection = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(disabledProjection.mcpServers, ["lemmacomputer_ms365"]);
  assert.equal(disabledProjection.toolPolicies.create_issue, undefined);
});

test("administrators can add a connector without code, then explicitly approve tools for agent grants", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    liteLlmPublicUrl: "http://localhost:4000",
    resolveCustomConnectorHostname: publicConnectorResolver,
    registry,
  });
  const input = {
    name: "Acme Projects",
    shortDescription: "Plan and follow Acme work",
    description: "Work with approved Acme projects and tasks.",
    category: "Productivity",
    services: ["Projects", "Tasks"],
    endpointUrl: "https://mcp.example.com/mcp",
    scopes: ["read", "write"],
    iconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  };
  await assert.rejects(
    () => service.discoverConnector(alpha, { ...input, iconDataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }),
    { code: "MCP_CONNECTOR_ICON_INVALID" },
  );
  const discovered = await service.discoverConnector(alpha, input);
  const created = await service.createConnector(alpha, "admin-alpha", {
    ...input,
    discoveryToken: discovered.discoveryToken,
  });
  assert.equal(created.id, "acme-projects");
  assert.equal(created.iconDataUrl, input.iconDataUrl);
  assert.equal(gateway.discoveries, 1);
  assert.equal(gateway.registered[0]?.url, "https://mcp.example.com/mcp");
  assert.equal(gateway.registered[0]?.clientSecret, undefined);
  assert.equal(gateway.registered[0]?.egressProfile, "strict_remote");
  await assert.rejects(
    () => service.createConnector(alpha, "admin-alpha", { ...input, discoveryToken: discovered.discoveryToken }),
    { code: "MCP_CONNECTOR_DISCOVERY_INVALID" },
  );
  assert.equal((await service.updateConnectorIcon(alpha, created.id, null)).iconDataUrl, null);
  assert.equal(
    (await service.updateConnectorIcon(alpha, created.id, "data:image/jpeg;base64,/9j/")).iconDataUrl,
    "data:image/jpeg;base64,/9j/",
  );
  await assert.rejects(
    () => service.updateConnectorIcon(alpha, "microsoft-365", null),
    { code: "MCP_CONNECTOR_MANAGED" },
  );
  const serverName = gateway.registered[0]!.serverName;
  gateway.statusByServer.set(serverName, connected);
  gateway.toolsByServer.set(serverName, ["create_task", "list_tasks"]);
  await completeFixtureConnection(service, gateway, alpha, created.id);
  assert.equal(gateway.ensured.at(-1)?.[0]?.serverId, gateway.registered[0]?.serverId, "custom connectors reconcile their durable gateway row before authorization");
  const basePolicy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "policy-v1",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "agent-alpha",
    agentProfile: "claude-desktop-managed-v1",
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  const unreviewed = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(unreviewed.mcpServers, ["lemmacomputer_ms365"]);
  assert.deepEqual(unreviewed.activeMcpServers, []);
  assert.equal(unreviewed.mcpToolPermissions?.[serverName], undefined);

  await saveCurrentConnectorToolPolicy(service, alpha, created.id, {
    create_task: "allow",
    list_tasks: "approval_required",
  });
  const projected = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(projected.mcpServers, ["lemmacomputer_ms365", serverName]);
  assert.deepEqual(projected.activeMcpServers, [serverName]);
  assert.deepEqual(projected.mcpToolPermissions?.[serverName], ["create_task", "list_tasks"]);
  assert.equal(projected.toolPolicies.create_task, "allow");
  assert.equal(projected.toolPolicies.list_tasks, "approval_required");
  assert.deepEqual(projected.allowedTools, ["create_task", "list-mail-messages", "list_tasks"]);
  assert.match(projected.connectionProjectionHash ?? "", /^[a-f0-9]{64}$/);

  await completeFixtureConnection(service, gateway, beta, created.id);
  assert.equal((await registry.listConnectionStates(alpha.tenantId, alpha.subjectId)).some((state) => state.connectorId === created.id), true);
  assert.equal((await registry.listConnectionStates(beta.tenantId, beta.subjectId)).some((state) => state.connectorId === created.id), true);
  assert.deepEqual(await service.deleteConnector(alpha, created.id), { deleted: true });
  assert.deepEqual(gateway.removed, [gateway.registered[0]!.serverId]);
  assert.equal((await service.list(alpha)).connections.some((connector) => connector.id === created.id), false);
  assert.equal((await registry.listConnectionStates(alpha.tenantId, alpha.subjectId)).some((state) => state.connectorId === created.id), false);
  assert.equal((await registry.listConnectionStates(beta.tenantId, beta.subjectId)).some((state) => state.connectorId === created.id), false);
  await assert.rejects(() => service.deleteConnector(alpha, "microsoft-365"), { code: "MCP_CONNECTOR_MANAGED" });
});

test("custom connector admission rejects loopback, IPv6, and DNS-rebinding destinations before LiteLLM discovery", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    resolveCustomConnectorHostname: async (host) => host === "mixed.example.com"
      ? [{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }]
      : [{ address: "93.184.216.34", family: 4 }],
  });
  const input = {
    name: "Unsafe connector",
    shortDescription: "Unsafe test connector",
    description: "Unsafe test connector description.",
    category: "Other" as const,
    services: [],
    scopes: [],
  };
  await assert.rejects(
    () => service.discoverConnector(alpha, { ...input, endpointUrl: "https://[::1]/mcp" }),
    { code: "MCP_CONNECTOR_URL_PRIVATE" },
  );
  await assert.rejects(
    () => service.discoverConnector(alpha, { ...input, endpointUrl: "https://mixed.example.com/mcp" }),
    { code: "MCP_CONNECTOR_URL_PRIVATE" },
  );
  await assert.rejects(
    () => service.discoverConnector(alpha, { ...input, endpointUrl: "http://public.example.com/mcp" }),
    { code: "MCP_CONNECTOR_URL_INVALID" },
  );
  assert.equal(gateway.discoveries, 0, "Control never asks LiteLLM to probe a rejected URL");
});

test("custom connector discovery uses a short permit and hosted origins require deployment approval", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new FakeConnectionGateway();
  gateway.onDiscover = async () => {
    assert.deepEqual(await registry.listEnabledEgressOrigins(), ["https://mcp.example.com"]);
    return { authorizationOrigin: "https://auth.example.com", dynamicClientRegistration: true };
  };
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    registry,
    resolveCustomConnectorHostname: publicConnectorResolver,
  });
  const input = {
    name: "Permit connector",
    shortDescription: "Permit test connector",
    description: "Permit test connector description.",
    category: "Other" as const,
    services: [],
    endpointUrl: "https://mcp.example.com/mcp",
    scopes: [],
  };
  const discovered = await service.discoverConnector(alpha, input);
  assert.equal(discovered.authorizationOrigin, "https://auth.example.com");
  assert.deepEqual(await registry.listEnabledEgressOrigins(), [], "the discovery exception is deleted in finally");

  const insecureAuthorization = new FakeConnectionGateway();
  insecureAuthorization.onDiscover = () => ({ authorizationOrigin: "http://auth.example.com", dynamicClientRegistration: true });
  const insecureAuthorizationService = new McpConnectionService(insecureAuthorization, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    resolveCustomConnectorHostname: publicConnectorResolver,
  });
  await assert.rejects(
    () => insecureAuthorizationService.discoverConnector(alpha, input),
    { code: "MCP_CONNECTOR_AUTHORIZATION_ORIGIN_INVALID" },
  );

  const hostedGateway = new FakeConnectionGateway();
  const hosted = new McpConnectionService(hostedGateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    installationKind: "hosted",
    hostedCustomConnectorEgressOrigins: ["https://mcp.example.com", "https://auth.example.com"],
    resolveCustomConnectorHostname: publicConnectorResolver,
  });
  assert.equal(await hosted.isGatewayEgressDestinationAllowed({ protocol: "https", host: "mcp.example.com", port: 443 }), true);
  assert.equal(await hosted.isGatewayEgressDestinationAllowed({ protocol: "https", host: "unapproved.example.com", port: 443 }), false);
  assert.equal(await hosted.isGatewayEgressDestinationAllowed({ protocol: "https", host: "mcp.notion.com", port: 443 }), true, "built-in catalog origins stay available");
  assert.equal(await hosted.isGatewayEgressDestinationAllowed({ protocol: "https", host: "mcp.exa.ai", port: 443 }), true, "Exa's MCP endpoint is approved");
  assert.equal(await hosted.isGatewayEgressDestinationAllowed({ protocol: "https", host: "auth.exa.ai", port: 443 }), true, "Exa's OAuth origin is approved");

  const missingAuthorizationApproval = new McpConnectionService(new FakeConnectionGateway(), {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    installationKind: "hosted",
    hostedCustomConnectorEgressOrigins: ["https://mcp.example.com"],
    resolveCustomConnectorHostname: publicConnectorResolver,
  });
  await assert.rejects(
    () => missingAuthorizationApproval.discoverConnector(alpha, input),
    { code: "MCP_CONNECTOR_EGRESS_NOT_APPROVED" },
  );
});

test("expired connections share one safe renewal and re-read the connected state", async () => {
  const gateway = new FakeConnectionGateway();
  const expired: OAuthConnectionStatus = { state: "expired", connectedAt: connected.connectedAt, expiresAt: connected.expiresAt, account: null };
  gateway.statusByServer.set("lemmacomputer_linear", expired);
  let startDiscovery: () => void = () => undefined;
  const discoveryStarted = new Promise<void>((resolve) => { startDiscovery = resolve; });
  let releaseDiscovery: () => void = () => undefined;
  const discoveryReleased = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
  gateway.onTools = async (identity, serverName) => {
    assert.equal(identity, alpha);
    assert.equal(serverName, "lemmacomputer_linear");
    startDiscovery();
    await discoveryReleased;
    gateway.statusByServer.set(serverName, connected);
    return ["create_issue"];
  };
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");

  const first = service.status(alpha, "linear");
  await discoveryStarted;
  const second = service.status(alpha, "linear");
  releaseDiscovery();
  const statuses = await Promise.all([first, second]);
  assert.deepEqual(statuses, [connected, connected]);
  assert.deepEqual(gateway.toolServers, ["lemmacomputer_linear"]);
  assert.equal(gateway.statusServers.filter((serverName) => serverName === "lemmacomputer_linear").length, 2);
});

test("failed silent renewal exposes reconnect state and removes stale connector tools", async () => {
  const gateway = new FakeConnectionGateway();
  const expired: OAuthConnectionStatus = { state: "expired", connectedAt: connected.connectedAt, expiresAt: connected.expiresAt, account: null };
  gateway.statusByServer.set("lemmacomputer_linear", connected);
  gateway.toolsByServer.set("lemmacomputer_linear", ["create_issue"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");
  const policy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "policy-v1",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: "agent-alpha",
    agentProfile: "claude-desktop-managed-v1",
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  await saveCurrentConnectorToolPolicy(service, alpha, "linear", { create_issue: "allow" });
  const initial = await service.projectConnectedConnectors(alpha, policy);
  assert.deepEqual(initial.mcpToolPermissions?.lemmacomputer_linear, ["create_issue"]);

  gateway.statusByServer.set("lemmacomputer_linear", expired);
  gateway.onTools = () => {
    throw new Error("fixture refresh denied");
  };
  // A workspace projection may be requested before the Connections screen is
  // revisited, so an expired connector must not survive on a stale projection
  // cache entry until list() happens to invalidate it.
  const after = await service.projectConnectedConnectors(alpha, policy);
  assert.deepEqual(after.mcpServers, ["lemmacomputer_ms365"]);
  assert.equal(after.mcpToolPermissions?.lemmacomputer_linear, undefined);
  const catalog = await service.list(alpha);
  const linear = catalog.connections.find((connector) => connector.id === "linear")!;
  assert.equal(linear.state, "expired");
  assert.ok(gateway.toolServers.every((serverName) => serverName === "lemmacomputer_linear"));
  assert.equal(await service.hostedToolPolicy(alpha, "lemmacomputer_linear", "create_issue"), null);
});

test("connector projection cache preserves the current workspace agent selection", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("lemmacomputer_linear", connected);
  gateway.toolsByServer.set("lemmacomputer_linear", ["create_issue"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");
  const claude: RuntimeAgentPolicy = {
    catalogId: "claude-desktop",
    agentId: "agent-alpha:claude-desktop",
    agentProfile: "claude-desktop-managed-v1",
    displayName: "Claude Desktop",
    clientVersion: "1.0.0",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  const hermes: RuntimeAgentPolicy = {
    catalogId: "hermes-claw",
    agentId: "agent-alpha:hermes-claw",
    agentProfile: "hermes-claw-managed-v1",
    displayName: "Hermes Agent CLI",
    clientVersion: "1.0.0",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  const policy: RuntimePolicy = {
    schemaVersion: 1,
    policyVersionId: "policy-v1",
    policyVersion: 1,
    policyHash: "a".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1",
    executionMode: "managed",
    egressMode: "restricted",
    agentId: claude.agentId,
    agentProfile: claude.agentProfile,
    agents: [claude, hermes],
    networkProfile: "controlled-egress-v1",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };

  const withHermes = await service.projectConnectedConnectors(alpha, policy);
  const withoutHermes = await service.projectConnectedConnectors(alpha, { ...policy, agents: [claude] });

  assert.deepEqual(withHermes.agents?.map((agent) => agent.catalogId), ["claude-desktop", "hermes-claw"]);
  assert.deepEqual(withoutHermes.agents?.map((agent) => agent.catalogId), ["claude-desktop"]);
});

test("gateway-configured connectors connect without reconciling a LiteLLM row", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: allCredentials,
  });

  // config/litellm/config.yaml owns these rows and carries their static
  // provider credentials. LiteLLM derives their server_id from a hash of the
  // server definition, so reconciling by the catalog's literal serverId used to
  // miss, hit the server_name guard, and fail Connect with a registration
  // conflict instead of starting the browser flow.
  for (const connectorId of ["gmail", "google-drive", "google-calendar", "github"]) {
    await service.start(alpha, connectorId);
  }
  assert.deepEqual(gateway.started.map((request) => request.serverName), [
    "lemmacomputer_gmail",
    "lemmacomputer_google_drive",
    "lemmacomputer_google_calendar",
    "lemmacomputer_github",
  ]);
  assert.deepEqual(gateway.ensured, [], "the gateway owns config-declared MCP servers");
});

test("a withheld catalog entry stays unreachable even after an earlier release seeded it", async () => {
  const registry = new MemoryConnectorRegistryStore();
  // An installation that ran a release shipping Slack keeps the row; seeding
  // only upserts. The catalog is authoritative, so the row must stop being
  // listed and must not be connectable.
  await registry.saveConnector({
    tenantId: alpha.tenantId,
    id: "slack",
    serverId: "lemmacomputer_slack",
    serverName: "lemmacomputer_slack",
    name: "Slack",
    shortDescription: "Follow conversations and share updates",
    description: "Work with the Slack conversations your account can access.",
    category: "Communication",
    services: ["Messages", "Channels", "Search"],
    endpointUrl: "https://mcp.slack.com/mcp",
    authorizationOrigins: ["https://mcp.slack.com", "https://slack.com"],
    scopes: [],
    brand: "slack",
    policySupport: "automatic",
    source: "built-in",
    createdBy: "lemmacomputer",
  });
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    registry,
  });

  const catalog = await service.list(alpha);
  assert.ok(!catalog.connections.some((connector) => connector.id === "slack"));
  for (const withheld of withheldConnectors()) {
    assert.ok(
      !catalog.connections.some((connector) => connector.id === withheld.id),
      `withheld connector ${withheld.id} must not be listed`,
    );
  }
  await assert.rejects(
    service.start(alpha, "slack"),
    (error: LemmaComputerError) => error.code === "MCP_CONNECTOR_NOT_FOUND",
  );
  assert.deepEqual(gateway.started, []);
  // A withheld endpoint must also lose its gateway egress grant.
  assert.equal(await service.isGatewayEgressDestinationAllowed({ protocol: "https", host: "mcp.slack.com", port: 443 }), false);
  assert.equal(await service.isGatewayEgressDestinationAllowed({ protocol: "https", host: "mcp.notion.com", port: 443 }), true);
});

test("a connector needing a provider application is offered as setup, not as a broken Connect", async () => {
  const gateway = new FakeConnectionGateway();
  // A deployment that has registered no provider OAuth application. Connect
  // here could only fail: LiteLLM would resolve an empty client_id and the
  // provider's authorize endpoint would refuse the redirect. The card is still
  // listed, because an administrator can now supply an application for this
  // organization without a deployment change.
  const unconfigured = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });

  const catalog = await unconfigured.list(alpha);
  const cards = new Map(catalog.connections.map((connector) => [connector.id, connector]));
  for (const connectorId of ["gmail", "google-drive", "google-calendar", "github"]) {
    const card = cards.get(connectorId);
    assert.ok(card, `${connectorId} is offered so it can be set up`);
    assert.equal(card.activation.readiness, "setup_required");
    assert.equal(card.activation.action, "view_setup");
    assert.deepEqual(
      { ...card.credentials, setup: undefined },
      {
        required: true,
        mode: "deployment",
        deploymentConfigured: false,
        clientId: null,
        updatedAt: null,
        // The provider redirects to the gateway, not to Control. Registering
        // the wrong value here is the most common way this setup fails.
        redirectUri: "http://localhost:4000/callback",
        setup: undefined,
      },
    );
    // Every connector that needs an application carries the console steps and
    // the scopes for it, so nobody has to guess in the provider's console.
    assert.ok(card.credentials?.setup?.steps.length);
    assert.ok(card.credentials?.setup?.scopes.length);
    assert.ok(!JSON.stringify(card.credentials?.setup).includes("localhost:4000"), "the redirect URI is never baked into curated guidance");
    await assert.rejects(
      unconfigured.start(alpha, connectorId, true),
      (error: LemmaComputerError) => error.code === "MCP_CONNECTOR_SETUP_REQUIRED",
    );
  }
  assert.deepEqual(gateway.started, [], "no authorize redirect is attempted without an application");
  // Microsoft 365 carries its own deployment-owned authorization origin and is
  // never gated on a provider OAuth application.
  assert.equal(cards.get("microsoft-365")?.activation.readiness, "ready");
  assert.equal(cards.get("microsoft-365")?.credentials, null);
  assert.equal(cards.get("notion")?.activation.readiness, "ready");
  assert.equal(cards.get("notion")?.credentials, null, "a provider with dynamic registration needs no application");

  const configuredService = new McpConnectionService(new FakeConnectionGateway(), {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    configuredStaticMcpClients: ["google-workspace"],
  });
  const withGoogle = new Map((await configuredService.list(alpha)).connections.map((connector) => [connector.id, connector]));
  assert.equal(withGoogle.get("gmail")?.activation.readiness, "ready", "the deployment application satisfies the requirement");
  assert.equal(withGoogle.get("gmail")?.credentials?.deploymentConfigured, true);
  assert.equal(withGoogle.get("google-drive")?.activation.readiness, "ready");
  assert.equal(withGoogle.get("google-calendar")?.activation.readiness, "ready");
  assert.equal(withGoogle.get("github")?.activation.readiness, "setup_required", "GitHub stays on its own credential group");
  // Catalog endpoints are approved destinations regardless of which
  // installation or tenant holds an application for them. Egress is decided
  // per origin and is deliberately not tenant-scoped, so it cannot depend on
  // whether a particular tenant has finished setup.
  assert.equal(
    await unconfigured.isGatewayEgressDestinationAllowed({ protocol: "https", host: "gmailmcp.googleapis.com", port: 443 }),
    true,
  );
});

test("the Google Workspace servers request offline access so connections can renew", async () => {
  const config = await readFile(new URL("../config/litellm/config.yaml", import.meta.url), "utf8");
  // LiteLLM's refresher returns None when the stored token has no
  // refresh_token, and Google issues one only for access_type=offline. That is
  // a query parameter rather than a scope, so unlike Microsoft 365 and
  // Atlassian this cannot be expressed through `scopes`.
  const offlineAuthorizeUrls = config.match(
    /^\s*authorization_url: https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?access_type=offline&prompt=consent$/gm,
  );
  assert.equal(offlineAuthorizeUrls?.length, 3, "Gmail, Drive, and Calendar each pin offline access");

  // A pinned authorization URL bypasses discovery, so its origin must still sit
  // inside the connector's egress allowlist or the redirect is refused.
  const google = connectorCatalog(alpha.tenantId, "http://localhost:3001")
    .filter((connector) => ["gmail", "google-drive", "google-calendar"].includes(connector.id));
  assert.equal(google.length, 3);
  for (const connector of google) {
    assert.ok(
      connector.authorizationOrigins.includes("https://accounts.google.com"),
      `${connector.id} must allow the pinned authorization origin`,
    );
  }
});
