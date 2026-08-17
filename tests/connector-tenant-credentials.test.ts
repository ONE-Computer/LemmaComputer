import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext, LemmaComputerError } from "@lemmacomputer/contracts";
import type {
  McpConnectorRegistrationInput,
  OAuthConnectionGateway,
  OAuthConnectionStatus,
  OAuthConnectionTool,
} from "@lemmacomputer/litellm-adapter";
import { MemoryConnectorRegistryStore, MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import { McpConnectionService } from "../apps/control-api/src/connections.js";
import { catalogCredentialSetup, connectorCatalog } from "../apps/control-api/src/connector-catalog.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "proxy-test-token-at-least-24-characters";
const headersFor = (identity: IdentityContext) => ({
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": identity.tenantId,
  "x-lemmacomputer-test-user-id": identity.subjectId,
});

// One control database and one gateway shared by two organizations, which is
// the hosted shape. Each supplies the OAuth application it registered with the
// provider, so neither organization's mail passes through a client the other
// controls.
const acme: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" };
const globex: IdentityContext = { tenantId: "globex", subjectId: "sam", audience: "lemmacomputer-control" };

const connected: OAuthConnectionStatus = {
  state: "connected",
  connectedAt: "2026-08-16T01:02:03Z",
  expiresAt: "2026-08-16T02:02:03Z",
  account: null,
};

type CredentialReplacement = { serverId: string; clientId: string; clientSecret: string; scopes: string[] };

class SharedGateway implements OAuthConnectionGateway {
  started: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0][] = [];
  registered: McpConnectorRegistrationInput[] = [];
  replaced: CredentialReplacement[] = [];
  removed: string[] = [];

  async beginUserOAuthConnection(input: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0]) {
    this.started.push(input);
    return { location: "https://accounts.google.com/o/oauth2/v2/auth", cookies: [] };
  }
  async completeUserOAuthConnection() { return connected; }
  async userOAuthConnectionStatus() { return connected; }
  async disconnectUserOAuthConnection() {
    return { state: "disconnected", connectedAt: null, expiresAt: null, account: null } as const;
  }
  async userOAuthConnectionTools(): Promise<OAuthConnectionTool[]> { return []; }
  async discoverOAuthMcpServer() {
    return { authorizationOrigin: "https://accounts.google.com", dynamicClientRegistration: false };
  }
  async registerOAuthMcpServer(input: McpConnectorRegistrationInput) { this.registered.push(input); }
  ensured: McpConnectorRegistrationInput[][] = [];
  syncedScopes: Array<{ serverId: string; scopes: string[] }> = [];
  async ensureOAuthMcpServers(inputs: McpConnectorRegistrationInput[]) { this.ensured.push(inputs); }
  async syncOAuthMcpServerScopes(input: { serverId: string; scopes: string[] }) { this.syncedScopes.push(input); }
  async replaceOAuthMcpServerCredentials(input: CredentialReplacement) { this.replaced.push(input); }
  async removeMcpServer(serverId: string) { this.removed.push(serverId); }
}

const service = (gateway: SharedGateway, registry: MemoryConnectorRegistryStore) => new McpConnectionService(gateway, {
  publicWebUrl: "http://localhost:4174",
  authorizationOrigin: "http://localhost:3001",
  liteLlmPublicUrl: "http://localhost:4000",
  registry,
});

const cardFor = async (connections: McpConnectionService, identity: IdentityContext, connectorId: string) =>
  (await connections.list(identity, true)).connections.find((connector) => connector.id === connectorId);

test("each organization's Gmail runs on the OAuth application it registered itself", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new SharedGateway();
  const connections = service(gateway, registry);

  const acmeSaved = await connections.saveConnectorCredentials(acme, "admin-acme", "gmail", {
    clientId: "acme-client.apps.googleusercontent.com",
    clientSecret: "acme-secret",
  });
  const globexSaved = await connections.saveConnectorCredentials(globex, "admin-globex", "gmail", {
    clientId: "globex-client.apps.googleusercontent.com",
    clientSecret: "globex-secret",
  });

  assert.equal(acmeSaved.credentials?.mode, "tenant");
  assert.equal(acmeSaved.credentials?.clientId, "acme-client.apps.googleusercontent.com");
  assert.equal(globexSaved.credentials?.clientId, "globex-client.apps.googleusercontent.com");
  assert.equal(acmeSaved.activation.readiness, "ready", "a tenant application satisfies the requirement on its own");

  // Two rows in one gateway, each with its own id and globally unique name.
  assert.equal(gateway.registered.length, 2);
  const [acmeRow, globexRow] = gateway.registered;
  assert.notEqual(acmeRow!.serverId, globexRow!.serverId);
  assert.notEqual(acmeRow!.serverName, globexRow!.serverName);
  assert.equal(acmeRow!.clientId, "acme-client.apps.googleusercontent.com");
  assert.equal(acmeRow!.clientSecret, "acme-secret");
  assert.equal(acmeRow!.egressProfile, "strict_remote");
  // The endpoint stays the catalog's, so setting up credentials cannot open a
  // new gateway destination.
  assert.equal(acmeRow!.url, "https://gmailmcp.googleapis.com/mcp/v1");
  assert.equal(globexRow!.url, acmeRow!.url);

  // Neither organization can read the other's application, and no secret is
  // readable back through any surface.
  const acmeCard = await cardFor(connections, acme, "gmail");
  const globexCard = await cardFor(connections, globex, "gmail");
  assert.equal(acmeCard?.credentials?.clientId, "acme-client.apps.googleusercontent.com");
  assert.equal(globexCard?.credentials?.clientId, "globex-client.apps.googleusercontent.com");
  assert.ok(!JSON.stringify(acmeCard).includes("acme-secret"), "a client secret is never returned to a browser");
  const stored = await registry.getConnector("acme", "gmail");
  assert.ok(!JSON.stringify(stored).includes("acme-secret"), "Control never persists the client secret");

  // Connecting addresses this organization's row, never the shared one.
  await connections.start(acme, "gmail", true);
  assert.equal(gateway.started.at(-1)?.serverName, acmeRow!.serverName);
  // Reconciliation never touches a row carrying a tenant's application: it does
  // not hold the client secret, so recreating the row would silently replace a
  // working connector with a credential-less one.
  assert.deepEqual(gateway.ensured.flat(), []);
  await connections.start(globex, "gmail", true);
  assert.equal(gateway.started.at(-1)?.serverName, globexRow!.serverName);

  // Reseeding the catalog refreshes presentation without pointing a configured
  // organization back at the deployment-wide server.
  assert.equal((await cardFor(connections, acme, "gmail"))?.serverName, acmeRow!.serverName);
});

test("rotating an application replaces the client in place and retires live connections", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new SharedGateway();
  const connections = service(gateway, registry);
  await connections.saveConnectorCredentials(acme, "admin-acme", "gmail", {
    clientId: "first-client",
    clientSecret: "first-secret",
  });
  const serverId = gateway.registered[0]!.serverId;
  const serverName = gateway.registered[0]!.serverName;

  await connections.start(acme, "gmail", true);
  const request = gateway.started.at(-1)!;
  await connections.complete(acme, "gmail", { state: request.state, code: "authorization-code" }, true);
  assert.ok(await registry.getConnectionState("acme", "alex", "gmail"), "the connection is recorded before rotation");

  const rotated = await connections.saveConnectorCredentials(acme, "admin-acme", "gmail", {
    clientId: "second-client",
    clientSecret: "second-secret",
  });
  assert.equal(gateway.registered.length, 1, "rotation keeps the existing gateway row");
  assert.deepEqual(gateway.replaced, [{
    serverId,
    clientId: "second-client",
    clientSecret: "second-secret",
    // Rotation carries the connector's scopes, so a replacement client is not
    // quietly downgraded to a token that cannot list tools.
    scopes: catalogCredentialSetup("gmail")!.scopes,
  }]);
  assert.equal(rotated.serverName, serverName);
  assert.equal(rotated.credentials?.clientId, "second-client");
  // The gateway purges its stored per-user tokens when the OAuth client
  // changes, so a durable marker saying "connected" would be a lie.
  assert.equal(
    await registry.getConnectionState("acme", "alex", "gmail"),
    null,
    "everyone reauthorizes against the new application",
  );
});

test("removing an application returns the connector to the deployment-wide client", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new SharedGateway();
  const connections = service(gateway, registry);
  await connections.saveConnectorCredentials(acme, "admin-acme", "gmail", {
    clientId: "acme-client",
    clientSecret: "acme-secret",
  });
  const serverId = gateway.registered[0]!.serverId;
  await connections.start(acme, "gmail", true);
  const request = gateway.started.at(-1)!;
  await connections.complete(acme, "gmail", { state: request.state, code: "authorization-code" }, true);

  const removed = await connections.removeConnectorCredentials(acme, "gmail");
  assert.deepEqual(gateway.removed, [serverId], "the tenant's credentials do not linger in a shared gateway");
  assert.equal(removed.serverName, "lemmacomputer_gmail", "the connector returns to the catalog server");
  assert.equal(removed.credentials?.mode, "deployment");
  assert.equal(removed.credentials?.clientId, null);
  assert.equal(await registry.getConnectionState("acme", "alex", "gmail"), null);
  // Nothing is configured any more, so the card asks for setup again rather
  // than offering a Connect that cannot succeed.
  assert.equal(removed.activation.readiness, "setup_required");

  await assert.rejects(
    connections.removeConnectorCredentials(acme, "gmail"),
    (error: LemmaComputerError) => error.code === "MCP_CONNECTOR_CREDENTIALS_NOT_SET",
  );
});

test("only a catalog connector whose provider needs an application accepts one", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new SharedGateway();
  const connections = service(gateway, registry);
  const credentials = { clientId: "client", clientSecret: "secret" };

  // Microsoft 365 is a separate container configured by environment, not a
  // gateway row carrying credentials.
  await assert.rejects(
    connections.saveConnectorCredentials(acme, "admin-acme", "microsoft-365", credentials),
    (error: LemmaComputerError) => error.code === "MCP_CONNECTOR_CREDENTIALS_UNSUPPORTED",
  );
  // Notion registers itself dynamically and needs no application.
  await assert.rejects(
    connections.saveConnectorCredentials(acme, "admin-acme", "notion", credentials),
    (error: LemmaComputerError) => error.code === "MCP_CONNECTOR_CREDENTIALS_UNSUPPORTED",
  );
  await assert.rejects(
    connections.saveConnectorCredentials(acme, "admin-acme", "gmail", { clientId: "  ", clientSecret: "secret" }),
    (error: LemmaComputerError) => error.code === "MCP_CONNECTOR_CLIENT_INVALID",
  );
  assert.deepEqual(gateway.registered, []);
});

test("the credentials route returns what is configured and never the secret", async () => {
  const gateway = new SharedGateway();
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    Object.assign(gateway, {
      ensureGrant: async () => ({ baseUrl: "http://gateway", credential: "scoped-test-credential-000001", modelAlias: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      readiness: async () => ({ models: "ready" as const, tools: "ready" as const }),
      revoke: async () => undefined,
    }),
    "api-fixture-approval-secret-at-least-32-characters",
    { publicWebUrl: "http://localhost:4174", authorizationOrigin: "http://localhost:3001" },
    { testIdentityMode: true },
  );
  try {
    const saved = await app.inject({
      method: "PUT",
      url: "/v1/admin/connectors/gmail/credentials",
      headers: headersFor(acme),
      payload: { clientId: "acme-client.apps.googleusercontent.com", clientSecret: "acme-secret" },
    });
    assert.equal(saved.statusCode, 200);
    assert.ok(!saved.body.includes("acme-secret"), "the client secret never travels back to a browser");
    assert.equal(saved.json().connector.credentials.clientId, "acme-client.apps.googleusercontent.com");
    assert.equal(saved.json().connector.credentials.mode, "tenant");

    const catalog = await app.inject({ method: "GET", url: "/v1/connections", headers: headersFor(acme) });
    const gmail = (catalog.json().connections as Array<Record<string, never>>).find((connector) => connector.id === "gmail");
    assert.equal(gmail?.credentials.mode, "tenant");
    assert.equal(gmail?.activation.readiness, "ready");
    assert.ok(!catalog.body.includes("acme-secret"));

    // A neighbouring organization sees only its own unconfigured connector.
    const neighbour = await app.inject({ method: "GET", url: "/v1/connections", headers: headersFor(globex) });
    const neighbourGmail = (neighbour.json().connections as Array<Record<string, never>>).find((connector) => connector.id === "gmail");
    assert.equal(neighbourGmail?.credentials.mode, "deployment");
    assert.equal(neighbourGmail?.credentials.clientId, null);
    assert.equal(neighbourGmail?.activation.readiness, "setup_required");

    const rejected = await app.inject({
      method: "PUT",
      url: "/v1/admin/connectors/gmail/credentials",
      headers: headersFor(acme),
      payload: { clientId: "acme-client" },
    });
    assert.equal(rejected.statusCode, 400, "a client id without a secret is refused");

    const removed = await app.inject({ method: "DELETE", url: "/v1/admin/connectors/gmail/credentials", headers: headersFor(acme) });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().connector.credentials.mode, "deployment");
  } finally {
    await app.close();
  }
});

test("a connector that needs an application asks for the scopes its setup tells you to register", async () => {
  // A connector registered with no scopes still completes its OAuth flow, so it
  // reports Connected while the provider refuses tools/list. The result is a
  // connector that looks healthy, projects nothing to any agent, and gives no
  // indication why. Google's remote MCP endpoints answer 403 in exactly this
  // case.
  const catalog = connectorCatalog("acme", "http://localhost:3001");
  const credentialed = catalog.filter((connector) => catalogCredentialSetup(connector.id));
  assert.ok(credentialed.length >= 4, "Gmail, Drive, Calendar, and GitHub all need an application");

  for (const connector of credentialed) {
    const setup = catalogCredentialSetup(connector.id)!;
    assert.ok(connector.scopes.length, `${connector.id} must request scopes, not rely on discovery`);
    // The console guidance and the authorization request are the same list, so
    // an administrator cannot register one set and have the connector ask for
    // another.
    assert.deepEqual(
      [...connector.scopes].sort(),
      [...setup.scopes].sort(),
      `${connector.id} must request exactly the scopes its guidance asks to register`,
    );
  }
});

test("tenant credentials register the connector's scopes with the gateway", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new SharedGateway();
  const connections = service(gateway, registry);
  await connections.saveConnectorCredentials(acme, "admin-acme", "gmail", {
    clientId: "acme-client",
    clientSecret: "acme-secret",
  });
  const registered = gateway.registered[0]!;
  assert.ok(registered.scopes.length, "an empty scope list produces a connector that cannot list tools");
  assert.deepEqual(registered.scopes, catalogCredentialSetup("gmail")!.scopes);
});

test("a tenant row registered with stale scopes is corrected without re-entering the secret", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const gateway = new SharedGateway();
  const connections = service(gateway, registry);
  await connections.saveConnectorCredentials(acme, "admin-acme", "gmail", {
    clientId: "acme-client",
    clientSecret: "acme-secret",
  });
  const serverId = gateway.registered[0]!.serverId;

  // Stand in for a row registered before its connector declared any scopes.
  // Control never stores the client secret, so without this reconciliation the
  // only way to correct such a row would be for an administrator to find the
  // secret again in the provider's console.
  gateway.syncedScopes.length = 0;
  await connections.start(acme, "gmail", true);

  assert.deepEqual(gateway.syncedScopes, [{
    serverId,
    scopes: catalogCredentialSetup("gmail")!.scopes,
  }]);
  // Reconciliation must never recreate the row, which would replace a working
  // OAuth client with a credential-less one.
  assert.deepEqual(gateway.ensured.flat(), []);
  assert.equal(gateway.registered.length, 1);
});
