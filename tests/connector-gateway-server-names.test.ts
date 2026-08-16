import assert from "node:assert/strict";
import test from "node:test";
import { LemmaComputerError, type IdentityContext } from "@lemmacomputer/contracts";
import type {
  McpConnectorRegistrationInput,
  OAuthConnectionGateway,
  OAuthConnectionStatus,
  OAuthConnectionTool,
} from "@lemmacomputer/litellm-adapter";
import { MemoryConnectorRegistryStore } from "@lemmacomputer/workspace-store";
import { tenantOwnedServerName } from "../apps/control-api/src/connector-catalog.js";
import { McpConnectionService } from "../apps/control-api/src/connections.js";

// One shared gateway and one shared control database, which is the hosted
// shape. `server_name` is not unique in LiteLLM's own schema and connections
// resolve by name, so anything a tenant can name has to be unique across every
// tenant rather than only within its own.
const acme: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" };
const globex: IdentityContext = { tenantId: "globex", subjectId: "sam", audience: "lemmacomputer-control" };

const connected: OAuthConnectionStatus = {
  state: "connected",
  connectedAt: "2026-08-16T01:02:03Z",
  expiresAt: "2026-08-16T02:02:03Z",
  account: null,
};

class SharedGateway implements OAuthConnectionGateway {
  started: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0][] = [];
  registered: McpConnectorRegistrationInput[] = [];
  ensured: McpConnectorRegistrationInput[][] = [];
  statusServers: string[] = [];
  removed: string[] = [];
  /** Names the gateway currently answers to, keyed by the row's server id. */
  readonly rows = new Map<string, string>();
  unresolvedNames = new Set<string>();

  async beginUserOAuthConnection(input: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0]) {
    this.started.push(input);
    return { location: "http://localhost:3001/authorize", cookies: [] };
  }
  async completeUserOAuthConnection() { return connected; }
  async userOAuthConnectionStatus(_identity: IdentityContext, serverName: string) {
    this.statusServers.push(serverName);
    if (this.unresolvedNames.has(serverName)) {
      throw new LemmaComputerError("MCP_CONNECTION_NOT_REGISTERED", "The connector is not registered in LiteLLM", 503, true);
    }
    return connected;
  }
  async disconnectUserOAuthConnection() {
    return { state: "disconnected", connectedAt: null, expiresAt: null, account: null } as const;
  }
  async userOAuthConnectionTools(): Promise<OAuthConnectionTool[]> { return []; }
  async discoverOAuthMcpServer() {
    return { authorizationOrigin: "https://auth.reports.example", dynamicClientRegistration: true };
  }
  async registerOAuthMcpServer(input: McpConnectorRegistrationInput) {
    if ([...this.rows.entries()].some(([serverId, name]) => name === input.serverName && serverId !== input.serverId)) {
      throw new LemmaComputerError("MCP_REGISTRATION_CONFLICT", "The connector name is already registered", 409);
    }
    this.registered.push(input);
    this.rows.set(input.serverId, input.serverName);
  }
  async ensureOAuthMcpServers(inputs: McpConnectorRegistrationInput[]) {
    this.ensured.push(inputs);
    for (const input of inputs) {
      // Reconciliation is an upsert keyed by server id, so a name that drifted
      // is renamed in place rather than duplicated.
      this.rows.set(input.serverId, input.serverName);
      this.unresolvedNames.delete(input.serverName);
    }
  }
  async removeMcpServer(serverId: string) { this.removed.push(serverId); this.rows.delete(serverId); }
}

const publicConnectorResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

const reports = {
  name: "Reports",
  shortDescription: "Review company reports",
  description: "Work with the company reports this account authorizes.",
  category: "Business" as const,
  services: ["Reports"],
  endpointUrl: "https://mcp.reports.example/mcp",
  scopes: ["reports.read"],
};

const addReportsConnector = async (service: McpConnectionService, identity: IdentityContext) => {
  const discovered = await service.discoverConnector(identity, reports);
  return service.createConnector(identity, `admin-${identity.tenantId}`, {
    ...reports,
    discoveryToken: discovered.discoveryToken,
  });
};

test("two tenants naming a connector identically get distinct gateway servers", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new SharedGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    liteLlmPublicUrl: "http://localhost:4000",
    resolveCustomConnectorHostname: publicConnectorResolver,
    registry,
  });

  const acmeConnector = await addReportsConnector(service, acme);
  const globexConnector = await addReportsConnector(service, globex);

  // The tenant-facing identity is deliberately the same in both tenants.
  assert.equal(acmeConnector.id, "reports");
  assert.equal(globexConnector.id, "reports");

  const [acmeRegistration, globexRegistration] = gateway.registered;
  assert.ok(acmeRegistration && globexRegistration);
  assert.notEqual(acmeRegistration.serverId, globexRegistration.serverId);
  assert.notEqual(
    acmeRegistration.serverName,
    globexRegistration.serverName,
    "one tenant's connector must never answer to another tenant's gateway name",
  );
  assert.equal(acmeRegistration.serverName, tenantOwnedServerName("reports", acmeRegistration.serverId));
  assert.equal(globexRegistration.serverName, tenantOwnedServerName("reports", globexRegistration.serverId));
  assert.match(acmeRegistration.serverName, /^lemmacomputer_reports_[0-9a-f]{32}$/);
  assert.ok(acmeRegistration.serverName.length <= 96, "LiteLLM server names stay inside the column width");
  // The name carries the row's own server id and nothing about the tenant.
  assert.ok(!acmeRegistration.serverName.includes("acme"));

  // Each tenant's connect flow addresses only its own gateway row.
  await service.start(acme, "reports", true);
  await service.start(globex, "reports", true);
  assert.deepEqual(
    gateway.started.map((request) => request.serverName),
    [acmeRegistration.serverName, globexRegistration.serverName],
  );
  assert.equal(gateway.rows.size, 2);
});

test("a tenant-owned gateway name cannot be reused by another tenant's record", async () => {
  const registry = new MemoryConnectorRegistryStore();
  await registry.saveConnector({
    tenantId: "acme",
    id: "reports",
    serverId: "acme-server-id",
    serverName: "lemmacomputer_reports_shared",
    name: "Reports",
    shortDescription: "Review company reports",
    description: "Work with company reports.",
    category: "Business",
    services: ["Reports"],
    endpointUrl: "https://mcp.reports.example/mcp",
    authorizationOrigins: ["https://auth.reports.example"],
    scopes: [],
    brand: "generic",
    policySupport: "automatic",
    source: "custom",
    createdBy: "admin-acme",
  });

  // Mirrors connector_registry_custom_server_name_key: a collision fails closed
  // at the store instead of resolving to the other tenant's connector.
  await assert.rejects(
    () => registry.saveConnector({
      tenantId: "globex",
      id: "reports",
      serverId: "globex-server-id",
      serverName: "lemmacomputer_reports_shared",
      name: "Reports",
      shortDescription: "Review company reports",
      description: "Work with company reports.",
      category: "Business",
      services: ["Reports"],
      endpointUrl: "https://mcp.reports.example/mcp",
      authorizationOrigins: ["https://auth.reports.example"],
      scopes: [],
      brand: "generic",
      policySupport: "automatic",
      source: "custom",
      createdBy: "admin-globex",
    }),
    /server name already exists/,
  );

  // Built-in rows deliberately repeat one shared gateway name per tenant.
  const builtIn = {
    id: "linear",
    serverId: "lemmacomputer_linear",
    serverName: "lemmacomputer_linear",
    name: "Linear",
    shortDescription: "Track issues",
    description: "Work with Linear issues.",
    category: "Developer tools" as const,
    services: ["Issues"],
    endpointUrl: "https://mcp.linear.app/mcp",
    authorizationOrigins: ["https://mcp.linear.app"],
    scopes: [],
    brand: "linear",
    policySupport: "automatic" as const,
    source: "built-in" as const,
    createdBy: "lemmacomputer",
  };
  await registry.saveConnector({ tenantId: "acme", ...builtIn });
  await registry.saveConnector({ tenantId: "globex", ...builtIn });
  assert.equal((await registry.getConnector("globex", "linear"))?.serverName, "lemmacomputer_linear");
});

test("a connector whose gateway name was recomputed heals without a reconnection", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new SharedGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    liteLlmPublicUrl: "http://localhost:4000",
    resolveCustomConnectorHostname: publicConnectorResolver,
    registry,
  });
  const connector = await addReportsConnector(service, acme);
  await service.start(acme, connector.id, true);
  const request = gateway.started.at(-1)!;
  await service.complete(acme, connector.id, { state: request.state, code: "fixture-authorization-code" });

  // Stand in for the state right after the server-name migration: the registry
  // record names the recomputed server, the gateway row still answers to the
  // old one.
  const serverName = (await registry.getConnector("acme", connector.id))!.serverName;
  gateway.unresolvedNames.add(serverName);
  gateway.ensured.length = 0;
  gateway.statusServers.length = 0;

  const listed = await service.list(acme, true);
  const card = listed.connections.find((entry) => entry.id === connector.id);
  assert.equal(card?.state, "connected", "an already-connected connector stays connected across the rename");
  assert.deepEqual(
    gateway.ensured.flat().map((input) => input.serverName),
    [serverName],
    "the unresolved read reconciles the gateway row exactly once",
  );
  assert.deepEqual(
    gateway.statusServers,
    [serverName, serverName],
    "the status read is retried against the renamed row rather than abandoned",
  );
});
