import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext, RuntimePolicy } from "@onecomputer/contracts";
import type { McpConnectorRegistrationInput, OAuthConnectionGateway, OAuthConnectionStatus } from "@onecomputer/litellm-adapter";
import { McpConnectionService, Microsoft365ConnectionService } from "../apps/control-api/src/connections.js";

const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "onecomputer-control" };
const beta: IdentityContext = { tenantId: "acme", subjectId: "beta", audience: "onecomputer-control" };
const connected: OAuthConnectionStatus = {
  state: "connected",
  connectedAt: "2026-07-20T01:02:03Z",
  expiresAt: "2026-07-20T02:02:03Z",
  account: { displayName: "Alex Morgan", email: "alex@acme.example", userPrincipalName: "alex@acme.example" },
};

class FakeConnectionGateway implements OAuthConnectionGateway {
  started: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0][] = [];
  completed: Parameters<OAuthConnectionGateway["completeUserOAuthConnection"]>[0][] = [];
  statusServers: string[] = [];
  disconnectedServers: string[] = [];
  registered: McpConnectorRegistrationInput[] = [];
  ensured: McpConnectorRegistrationInput[][] = [];
  discoveries = 0;
  statusByServer = new Map<string, OAuthConnectionStatus>();
  toolsByServer = new Map<string, string[]>();

  async beginUserOAuthConnection(input: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0]) {
    this.started.push(input);
    return { location: "http://localhost:3001/authorize", cookies: ["mcp_oauth_state=opaque; HttpOnly"] };
  }
  async completeUserOAuthConnection(input: Parameters<OAuthConnectionGateway["completeUserOAuthConnection"]>[0]) {
    this.completed.push(input);
    return connected;
  }
  async userOAuthConnectionStatus(_identity: IdentityContext, serverName: string) {
    this.statusServers.push(serverName);
    return this.statusByServer.get(serverName)
      ?? { state: "disconnected", connectedAt: null, expiresAt: null, account: null } as const;
  }
  async disconnectUserOAuthConnection(_identity: IdentityContext, serverName: string) {
    this.disconnectedServers.push(serverName);
    return { state: "disconnected", connectedAt: null, expiresAt: null, account: null } as const;
  }
  async userOAuthConnectionTools(_identity: IdentityContext, serverName: string) {
    return this.toolsByServer.get(serverName) ?? [];
  }
  async discoverOAuthMcpServer() {
    this.discoveries += 1;
    return { authorizationOrigin: "https://auth.example.com", dynamicClientRegistration: true };
  }
  async registerOAuthMcpServer(input: McpConnectorRegistrationInput) {
    this.registered.push(input);
  }
  async ensureOAuthMcpServers(inputs: McpConnectorRegistrationInput[]) {
    this.ensured.push(inputs);
  }
  async removeMcpServer() {}
}

test("owned Microsoft 365 flow binds state and PKCE to the initiating ONEComputer identity", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new Microsoft365ConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });
  const started = await service.start(alpha);
  const request = gateway.started[0]!;
  assert.equal(started.location, "http://localhost:3001/authorize");
  assert.equal(request.identity, alpha);
  assert.equal(request.serverName, "onecomputer_ms365");
  assert.equal(request.redirectUri, "http://localhost:4174/api/v1/connections/microsoft-365/callback");
  assert.match(request.state, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(request.codeChallenge, /^[A-Za-z0-9_-]{40,}$/);

  const result = await service.complete(alpha, { state: request.state, code: "authorization-code" });
  assert.deepEqual(result, connected);
  assert.equal(gateway.completed.length, 1);
  assert.equal(gateway.completed[0]!.identity, alpha);
  assert.equal(gateway.completed[0]!.serverName, "onecomputer_ms365");
  assert.notEqual(gateway.completed[0]!.codeVerifier, request.codeChallenge);
});

test("connection state is one-time and cannot be finished by another user", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new Microsoft365ConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
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

test("the approved catalog maps every ONEComputer connector to one LiteLLM MCP server", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });

  const catalog = await service.list(alpha);
  assert.deepEqual(catalog.connections.map((connector) => [connector.id, connector.serverName]), [
    ["microsoft-365", "onecomputer_ms365"],
    ["notion", "onecomputer_notion"],
    ["linear", "onecomputer_linear"],
    ["atlassian", "onecomputer_atlassian"],
    ["github", "onecomputer_github"],
  ]);
  assert.deepEqual(gateway.statusServers, [
    "onecomputer_ms365",
    "onecomputer_notion",
    "onecomputer_linear",
    "onecomputer_atlassian",
    "onecomputer_github",
  ]);
  assert.deepEqual(gateway.ensured[0]?.map((connector) => connector.serverName), [
    "onecomputer_notion",
    "onecomputer_linear",
    "onecomputer_atlassian",
  ]);
  assert.ok(catalog.connections.every((connector) => connector.available));
  assert.ok(catalog.connections.every((connector) => !("authorizationOrigins" in connector)));
});

test("hosted connector OAuth binds the selected catalog entry and refuses cross-connector callbacks", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });

  await service.start(alpha, "linear");
  const request = gateway.started.at(-1)!;
  assert.equal(request.serverName, "onecomputer_linear");
  assert.equal(request.redirectUri, "http://localhost:4174/api/v1/connections/linear/callback");
  assert.deepEqual(request.authorizationOrigins, ["https://mcp.linear.app"]);

  await assert.rejects(
    () => service.complete(alpha, "notion", { state: request.state, code: "authorization-code" }),
    { code: "MCP_OAUTH_CONNECTOR_MISMATCH" },
  );
  assert.equal(gateway.completed.length, 0);
});

test("administrators can add a connector without code and connected tools are projected into agent grants", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    liteLlmPublicUrl: "http://localhost:4000",
  });
  const input = {
    name: "Acme Projects",
    shortDescription: "Plan and follow Acme work",
    description: "Work with approved Acme projects and tasks.",
    category: "Productivity",
    services: ["Projects", "Tasks"],
    endpointUrl: "https://mcp.example.com/mcp",
    scopes: ["read", "write"],
  };
  const discovered = await service.discoverConnector(input);
  const created = await service.createConnector(alpha, "admin-alpha", {
    ...input,
    discoveryToken: discovered.discoveryToken,
  });
  assert.equal(created.id, "acme-projects");
  assert.equal(gateway.discoveries, 1);
  assert.equal(gateway.registered[0]?.url, "https://mcp.example.com/mcp");
  assert.equal(gateway.registered[0]?.clientSecret, undefined);
  await assert.rejects(
    () => service.createConnector(alpha, "admin-alpha", { ...input, discoveryToken: discovered.discoveryToken }),
    { code: "MCP_CONNECTOR_DISCOVERY_INVALID" },
  );
  const serverName = gateway.registered[0]!.serverName;
  gateway.statusByServer.set(serverName, connected);
  gateway.toolsByServer.set(serverName, ["create_task", "list_tasks"]);
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
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  const projected = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(projected.mcpServers, ["onecomputer_ms365", serverName]);
  assert.deepEqual(projected.mcpToolPermissions?.[serverName], ["create_task", "list_tasks"]);
  assert.deepEqual(projected.allowedTools, ["create_task", "list-mail-messages", "list_tasks"]);
  assert.match(projected.connectionProjectionHash ?? "", /^[a-f0-9]{64}$/);
});
