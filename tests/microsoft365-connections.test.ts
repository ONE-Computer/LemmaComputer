import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { IdentityContext, RuntimeAgentPolicy, RuntimePolicy } from "@onecomputer/contracts";
import type { McpConnectorRegistrationInput, OAuthConnectionGateway, OAuthConnectionStatus, OAuthConnectionTool } from "@onecomputer/litellm-adapter";
import { MemoryConnectorRegistryStore } from "@onecomputer/workspace-store";
import { McpConnectionService, Microsoft365ConnectionService } from "../apps/control-api/src/connections.js";

const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "onecomputer-control" };
const beta: IdentityContext = { tenantId: "acme", subjectId: "beta", audience: "onecomputer-control" };
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
  discoveries = 0;
  toolServers: string[] = [];
  onStatus?: (identity: IdentityContext, serverName: string) => OAuthConnectionStatus | Promise<OAuthConnectionStatus>;
  onTools?: (identity: IdentityContext, serverName: string) => FixtureTool[] | Promise<FixtureTool[]>;
  onDiscover?: () => { authorizationOrigin: string; dynamicClientRegistration: boolean } | Promise<{ authorizationOrigin: string; dynamicClientRegistration: boolean }>;
  onRegister?: (input: McpConnectorRegistrationInput) => void | Promise<void>;
  statusByServer = new Map<string, OAuthConnectionStatus>();
  toolsByServer = new Map<string, FixtureTool[]>();

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
  async removeMcpServer() {}
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
  return service.saveConnectorToolPolicy(identity, connectorId, tools, current.documentHash);
};

const publicConnectorResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

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

test("the default catalog covers the required categories and registers a remote server only on Connect", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });

  const catalog = await service.list(alpha);
  const defaultCards = catalog.connections.map((connector) => [connector.id, connector.serverName]);
  assert.equal(defaultCards.length, 22);
  const neon = catalog.connections.find((connector) => connector.id === "neon");
  assert.equal(neon?.serverName, "onecomputer_neon");
  assert.equal(neon?.brand, "neon");
  assert.equal(neon?.source, "built-in");
  assert.deepEqual(defaultCards.slice(0, 6), [
    ["microsoft-365", "onecomputer_ms365"],
    ["notion", "onecomputer_notion"],
    ["linear", "onecomputer_linear"],
    ["atlassian", "onecomputer_atlassian"],
    ["asana", "onecomputer_asana"],
    ["figma", "onecomputer_figma"],
  ]);
  assert.deepEqual(gateway.statusServers, [], "browsing cards without a marker must not probe a provider");
  assert.deepEqual(gateway.toolServers, [], "browsing cards must not discover provider tools");
  assert.equal(gateway.ensured.length, 0, "listing the catalog must not register remote MCP servers");
  await service.start(alpha, "notion");
  assert.deepEqual(gateway.ensured.map((connectors) => connectors.map((connector) => connector.serverName)), [
    ["onecomputer_notion"],
  ]);
  assert.ok(catalog.connections.every((connector) => connector.available));
  assert.ok(catalog.connections.every((connector) => !("authorizationOrigins" in connector)));
  assert.ok(catalog.connections.every((connector) => connector.activation.readiness === "ready"));
  assert.ok(catalog.connections.every((connector) => connector.activation.action === "connect"));
  for (const category of ["Productivity", "Developer tools", "Business", "Communication", "Data and analytics"]) {
    assert.ok(catalog.connections.some((connector) => connector.category === category), `catalog includes ${category}`);
  }
});

test("every approved remote MCP card lazily starts its provider flow only after Connect", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });
  for (const connectorId of ["github", "figma", "slack", "asana"]) await service.start(alpha, connectorId);
  assert.deepEqual(gateway.started.map((request) => request.serverName), [
    "onecomputer_github",
    "onecomputer_figma",
    "onecomputer_slack",
    "onecomputer_asana",
  ]);
  assert.deepEqual(gateway.ensured.map((connectors) => connectors[0]?.serverName), [
    "onecomputer_github",
    "onecomputer_figma",
    "onecomputer_slack",
    "onecomputer_asana",
  ]);
});

test("unconnected connector policy inspection never probes provider grants or tools", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });

  await assert.rejects(
    () => service.connectorToolPolicy(alpha, "linear"),
    { code: "MCP_CONNECTOR_NOT_CONNECTED" },
  );

  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"), null);
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
  gateway.statusByServer.set("onecomputer_linear", expired);
  gateway.onTools = (_identity, serverName) => {
    assert.equal(serverName, "onecomputer_linear");
    gateway.statusByServer.set(serverName, connected);
    return ["create_issue"];
  };

  const renewed = await service.list(alpha);
  const linear = renewed.connections.find((connector) => connector.id === "linear")!;
  assert.equal(linear.state, "connected");
  assert.equal(renewed.connectionProjectionChanged, true);
  assert.equal(linear.account, null);
  assert.deepEqual(gateway.statusServers, ["onecomputer_linear", "onecomputer_linear"]);
  assert.deepEqual(gateway.toolServers, ["onecomputer_linear"]);
  assert.equal((await registry.getConnectionState(alpha.tenantId, alpha.subjectId, "linear"))?.state, "connected");

  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  const stable = await service.list(alpha);
  assert.equal(stable.connectionProjectionChanged, false);
  assert.deepEqual(gateway.statusServers, ["onecomputer_linear"]);
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
  assert.deepEqual(gateway.statusServers, ["onecomputer_linear"]);
});

test("hosted tool policy requires an explicit tool decision and a current connection", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("onecomputer_linear", connected);
  gateway.toolsByServer.set("onecomputer_linear", ["create_issue"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");

  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"), null);
  assert.deepEqual(gateway.statusServers, []);
  assert.deepEqual(gateway.toolServers, []);

  await saveCurrentConnectorToolPolicy(service, alpha, "linear", { create_issue: "allow" });
  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  assert.equal((await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"))?.decision, "allow");
  assert.deepEqual(gateway.statusServers, ["onecomputer_linear"]);
  assert.deepEqual(gateway.toolServers, ["onecomputer_linear"]);

  gateway.statusByServer.set("onecomputer_linear", { state: "disconnected", connectedAt: null, expiresAt: null, account: null });
  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"), null);
  assert.deepEqual(gateway.statusServers, ["onecomputer_linear"]);
  assert.deepEqual(gateway.toolServers, []);

  gateway.statusServers.length = 0;
  gateway.toolServers.length = 0;
  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"), null);
  assert.deepEqual(gateway.statusServers, []);
  assert.deepEqual(gateway.toolServers, []);
});

test("only explicitly approved connected catalog services contribute workspace tools", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("onecomputer_linear", connected);
  gateway.toolsByServer.set("onecomputer_linear", ["create_issue"]);
  gateway.toolsByServer.set("onecomputer_asana", ["create_task"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
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
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };

  const projected = await service.projectConnectedConnectors(alpha, basePolicy);

  assert.deepEqual(projected.mcpServers, ["onecomputer_ms365"]);
  assert.equal(projected.mcpToolPermissions?.onecomputer_linear, undefined);
  assert.equal(projected.mcpToolPermissions?.onecomputer_asana, undefined);
  assert.deepEqual(gateway.toolServers, ["onecomputer_linear"]);
  assert.deepEqual(gateway.statusServers, ["onecomputer_linear"]);
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

test("new hosted connector tools are blocked pending review and persist explicit approval rules", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("onecomputer_linear", connected);
  gateway.toolsByServer.set("onecomputer_linear", ["create_issue", "list_issues"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");

  const initial = await service.connectorToolPolicy(alpha, "linear");
  assert.deepEqual(initial.tools.map((tool) => [tool.name, tool.decision, tool.reviewRequired]), [
    ["create_issue", "deny", true],
    ["list_issues", "deny", true],
  ]);
  assert.match(initial.tools[0]!.description, /Blocked until an administrator reviews/i);
  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"), null);

  const saved = await service.saveConnectorToolPolicy(alpha, "linear", {
    create_issue: "approval_required",
    list_issues: "deny",
  }, initial.documentHash);
  assert.deepEqual(saved.tools.map((tool) => [tool.name, tool.decision, tool.reviewRequired]), [
    ["create_issue", "approval_required", false],
    ["list_issues", "deny", false],
  ]);
  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "list_issues"), null);
  assert.equal((await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"))?.decision, "approval_required");

  gateway.toolsByServer.set("onecomputer_linear", ["create_issue", "list_issues", "delete_issue"]);
  const changed = await service.connectorToolPolicy(alpha, "linear");
  assert.deepEqual(changed.tools.map((tool) => [tool.name, tool.decision, tool.reviewRequired]), [
    ["create_issue", "approval_required", false],
    ["list_issues", "deny", false],
    ["delete_issue", "deny", true],
  ]);
  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "delete_issue"), null);

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
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  });
  assert.deepEqual(projected.mcpToolPermissions?.onecomputer_linear, ["create_issue"]);
  assert.equal(projected.toolPolicies.delete_issue, undefined);

  await assert.rejects(
    () => service.saveConnectorToolPolicy(alpha, "linear", { create_issue: "allow" }, changed.documentHash),
    { code: "INVALID_TOOL_POLICY" },
  );
});

test("a same-name provider tool change revokes cached projection and rejects a stale review", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("onecomputer_linear", connected);
  gateway.toolsByServer.set("onecomputer_linear", [{ name: "create_issue", definitionHash: "a".repeat(64) }]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");
  const review = await service.connectorToolPolicy(alpha, "linear");
  await service.saveConnectorToolPolicy(alpha, "linear", { create_issue: "allow" }, review.documentHash);
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
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  assert.deepEqual((await service.projectConnectedConnectors(alpha, policy)).mcpToolPermissions?.onecomputer_linear, ["create_issue"]);

  gateway.toolsByServer.set("onecomputer_linear", [{ name: "create_issue", definitionHash: "b".repeat(64) }]);
  const changed = await service.connectorToolPolicy(alpha, "linear");
  assert.deepEqual(changed.changes, { added: [], changed: ["create_issue"], removed: [] });
  assert.deepEqual(changed.tools.map((tool) => [tool.name, tool.decision, tool.reviewRequired]), [["create_issue", "deny", true]]);
  await assert.rejects(
    () => service.saveConnectorToolPolicy(alpha, "linear", { create_issue: "allow" }, review.documentHash),
    { code: "TOOL_SET_CHANGED_REVIEW_AGAIN" },
  );
  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"), null);
  const afterChange = await service.projectConnectedConnectors(alpha, policy);
  assert.deepEqual(afterChange.mcpServers, ["onecomputer_ms365"], "a cache hit cannot retain a changed definition");
});

test("organization connector access policy locks member changes and removes disabled tools from grants", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("onecomputer_linear", connected);
  gateway.toolsByServer.set("onecomputer_linear", ["create_issue", "list_issues"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");
  await saveCurrentConnectorToolPolicy(service, alpha, "linear", {
    create_issue: "approval_required",
    list_issues: "deny",
  });
  const locked = await service.updateAccessPolicy(alpha, "admin-alpha", "linear", {
    enabled: true,
    membersCanManage: false,
  });
  assert.equal(locked.membersCanManage, false);
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
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  const projected = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(projected.mcpToolPermissions?.onecomputer_linear, ["create_issue"]);
  assert.equal(projected.toolPolicies.create_issue, "approval_required");
  assert.equal(projected.toolPolicies.list_issues, undefined);

  await service.updateAccessPolicy(alpha, "admin-alpha", "linear", {
    enabled: false,
    membersCanManage: false,
  });
  await assert.rejects(() => service.start(alpha, "linear", true), { code: "MCP_CONNECTOR_DISABLED" });
  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"), null);
  const disabledProjection = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(disabledProjection.mcpServers, ["onecomputer_ms365"]);
  assert.equal(disabledProjection.toolPolicies.create_issue, undefined);
});

test("administrators can add a connector without code, then explicitly approve tools for agent grants", async () => {
  const gateway = new FakeConnectionGateway();
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    liteLlmPublicUrl: "http://localhost:4000",
    resolveCustomConnectorHostname: publicConnectorResolver,
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
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  const unreviewed = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(unreviewed.mcpServers, ["onecomputer_ms365"]);
  assert.equal(unreviewed.mcpToolPermissions?.[serverName], undefined);

  await saveCurrentConnectorToolPolicy(service, alpha, created.id, {
    create_task: "allow",
    list_tasks: "approval_required",
  });
  const projected = await service.projectConnectedConnectors(alpha, basePolicy);
  assert.deepEqual(projected.mcpServers, ["onecomputer_ms365", serverName]);
  assert.deepEqual(projected.mcpToolPermissions?.[serverName], ["create_task", "list_tasks"]);
  assert.equal(projected.toolPolicies.create_task, "allow");
  assert.equal(projected.toolPolicies.list_tasks, "approval_required");
  assert.deepEqual(projected.allowedTools, ["create_task", "list-mail-messages", "list_tasks"]);
  assert.match(projected.connectionProjectionHash ?? "", /^[a-f0-9]{64}$/);
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
  gateway.statusByServer.set("onecomputer_linear", expired);
  let startDiscovery: () => void = () => undefined;
  const discoveryStarted = new Promise<void>((resolve) => { startDiscovery = resolve; });
  let releaseDiscovery: () => void = () => undefined;
  const discoveryReleased = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
  gateway.onTools = async (identity, serverName) => {
    assert.equal(identity, alpha);
    assert.equal(serverName, "onecomputer_linear");
    startDiscovery();
    await discoveryReleased;
    gateway.statusByServer.set(serverName, connected);
    return ["create_issue"];
  };
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");

  const first = service.status(alpha, "linear");
  await discoveryStarted;
  const second = service.status(alpha, "linear");
  releaseDiscovery();
  const statuses = await Promise.all([first, second]);
  assert.deepEqual(statuses, [connected, connected]);
  assert.deepEqual(gateway.toolServers, ["onecomputer_linear"]);
  assert.equal(gateway.statusServers.filter((serverName) => serverName === "onecomputer_linear").length, 2);
});

test("failed silent renewal exposes reconnect state and removes stale connector tools", async () => {
  const gateway = new FakeConnectionGateway();
  const expired: OAuthConnectionStatus = { state: "expired", connectedAt: connected.connectedAt, expiresAt: connected.expiresAt, account: null };
  gateway.statusByServer.set("onecomputer_linear", connected);
  gateway.toolsByServer.set("onecomputer_linear", ["create_issue"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
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
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  await saveCurrentConnectorToolPolicy(service, alpha, "linear", { create_issue: "allow" });
  const initial = await service.projectConnectedConnectors(alpha, policy);
  assert.deepEqual(initial.mcpToolPermissions?.onecomputer_linear, ["create_issue"]);

  gateway.statusByServer.set("onecomputer_linear", expired);
  gateway.onTools = () => {
    throw new Error("fixture refresh denied");
  };
  const after = await service.projectConnectedConnectors(alpha, policy);
  assert.deepEqual(after.mcpServers, ["onecomputer_ms365"]);
  assert.equal(after.mcpToolPermissions?.onecomputer_linear, undefined);
  const catalog = await service.list(alpha);
  const linear = catalog.connections.find((connector) => connector.id === "linear")!;
  assert.equal(linear.state, "expired");
  assert.ok(gateway.toolServers.every((serverName) => serverName === "onecomputer_linear"));
  assert.equal(await service.hostedToolPolicy(alpha, "onecomputer_linear", "create_issue"), null);
});

test("connector projection cache preserves the current workspace agent selection", async () => {
  const gateway = new FakeConnectionGateway();
  gateway.statusByServer.set("onecomputer_linear", connected);
  gateway.toolsByServer.set("onecomputer_linear", ["create_issue"]);
  const service = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
  });
  await completeFixtureConnection(service, gateway, alpha, "linear");
  const claude: RuntimeAgentPolicy = {
    catalogId: "claude-desktop",
    agentId: "agent-alpha:claude-desktop",
    agentProfile: "claude-desktop-managed-v1",
    displayName: "Claude Desktop",
    clientVersion: "1.0.0",
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };
  const hermes: RuntimeAgentPolicy = {
    catalogId: "hermes-claw",
    agentId: "agent-alpha:hermes-claw",
    agentProfile: "hermes-claw-managed-v1",
    displayName: "Hermes Agent CLI",
    clientVersion: "1.0.0",
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
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
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-messages"],
    toolPolicies: { "list-mail-messages": "allow" },
  };

  const withHermes = await service.projectConnectedConnectors(alpha, policy);
  const withoutHermes = await service.projectConnectedConnectors(alpha, { ...policy, agents: [claude] });

  assert.deepEqual(withHermes.agents?.map((agent) => agent.catalogId), ["claude-desktop", "hermes-claw"]);
  assert.deepEqual(withoutHermes.agents?.map((agent) => agent.catalogId), ["claude-desktop"]);
});
