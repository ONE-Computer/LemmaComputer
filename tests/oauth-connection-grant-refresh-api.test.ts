import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import type { GatewayClient, McpConnectorAdministrationGateway, OAuthConnectionGateway, OAuthConnectionStatus } from "@lemmacomputer/litellm-adapter";
import { MemoryConnectorRegistryStore, MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import { AgentBridgeAuthority } from "../apps/control-api/src/agent-bridge.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "proxy-test-token-at-least-24-characters";
const agentBridgeSecret = "oauth-refresh-agent-bridge-secret-at-least-32-characters";
const identity: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" };
const headers = {
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": identity.tenantId,
  "x-lemmacomputer-test-user-id": identity.subjectId,
};

const connected = (): OAuthConnectionStatus => ({
  state: "connected",
  connectedAt: "2026-07-28T00:00:00.000Z",
  expiresAt: "2026-07-28T01:00:00.000Z",
  account: null,
});
const expired = (): OAuthConnectionStatus => ({
  state: "expired",
  connectedAt: "2026-07-28T00:00:00.000Z",
  expiresAt: "2026-07-28T00:30:00.000Z",
  account: null,
});
const disconnected = (): OAuthConnectionStatus => ({ state: "disconnected", connectedAt: null, expiresAt: null, account: null });

test("catalog re-entry reconciles only explicit marker transitions and removes stale remote projections", async () => {
  const issuedPolicies: RuntimePolicy[] = [];
  let linearState: OAuthConnectionStatus["state"] = "connected";
  let renewalFails = false;
  let grantRefreshFails = false;
  let renewalAttempts = 0;
  let revokedGatewayGrants = 0;
  let oauthState = "";
  const statusServers: string[] = [];
  const toolServers: string[] = [];
  const gateway: GatewayClient & OAuthConnectionGateway & Pick<McpConnectorAdministrationGateway, "ensureOAuthMcpServers"> = {
    ensureGrant: async (input) => {
      assert.ok(input.policy);
      issuedPolicies.push(input.policy);
      if (grantRefreshFails) throw new Error("gateway grant refresh unavailable");
      return {
        baseUrl: "http://gateway",
        credential: "scoped-" + input.workspaceId,
        modelAlias: "lemmacomputer-assistant",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    modelCapabilities: async () => ({ vision: true }),
    readiness: async () => ({
      models: "ready",
      tools: "ready",
      modelRoute: {
        alias: "lemmacomputer-assistant",
        status: "ready",
        fallback: "none",
        capabilities: { vision: true },
        limits: { requestsPerMinute: 30, tokensPerMinute: 50_000, maxParallelRequests: 4 },
      },
    }),
    test: async () => ({
      model: "lemmacomputer-assistant",
      availability: "ready",
      modelRoute: {
        alias: "lemmacomputer-assistant",
        status: "ready",
        fallback: "none",
        capabilities: { vision: true },
        limits: { requestsPerMinute: 30, tokensPerMinute: 50_000, maxParallelRequests: 4 },
      },
      tools: [],
      apiBaseUrl: "http://gateway/v1",
      mcpUrl: "http://gateway/mcp",
    }),
    revoke: async () => { revokedGatewayGrants += 1; },
    ensureOAuthMcpServers: async () => undefined,
    beginUserOAuthConnection: async (input) => {
      oauthState = input.state;
      return { location: "http://provider/authorize", cookies: [] };
    },
    completeUserOAuthConnection: async () => connected(),
    userOAuthConnectionStatus: async (_identity, serverName) => {
      statusServers.push(serverName);
      if (serverName === "lemmacomputer_linear") {
        if (linearState === "connected") return connected();
        if (linearState === "expired") return expired();
      }
      return disconnected();
    },
    userOAuthConnectionTools: async (_identity, serverName) => {
      toolServers.push(serverName);
      if (serverName !== "lemmacomputer_linear") return [];
      if (linearState === "expired") {
        renewalAttempts += 1;
        if (renewalFails) throw new Error("provider refresh was denied");
        linearState = "connected";
      }
      return [{ name: "create_issue", definitionHash: "a".repeat(64) }];
    },
    disconnectUserOAuthConnection: async () => disconnected(),
  };
  const controller: ControllerClient = {
    create: async ({ workspaceId }) => ({ providerId: "sandbox-" + workspaceId, state: "ready", failureCode: null }),
    updateEgressPolicy: async () => undefined,
    status: async (providerId) => ({ providerId, state: "ready", failureCode: null }),
    open: async () => ({ launchUrl: "http://gateway/workspace", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    destroy: async () => undefined,
    purgeWorkspace: async () => undefined,
  };
  const workspaceStore = new MemoryWorkspaceStore();
  const connectorRegistry = new MemoryConnectorRegistryStore();
  const app = createControlServer(
    workspaceStore,
    controller,
    proxyToken,
    gateway,
    "api-fixture-approval-secret-at-least-32-characters",
    {},
    { testIdentityMode: true, connectorRegistryStore: connectorRegistry, agentBridgeSecret },
  );

  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...headers, "idempotency-key": "oauth-grant-refresh-create-001" },
      payload: { grantId: "personal" },
    });
    assert.equal(created.statusCode, 201);
    const workspaceId = created.json().id as string;
    const createdRecord = await workspaceStore.getOwned(identity, workspaceId);
    assert.ok(createdRecord);
    const originalGeneration = createdRecord.accessGeneration;
    const bridgeToken = new AgentBridgeAuthority(agentBridgeSecret).issue(identity, workspaceId, issuedPolicies[0]!, {
      workspaceGeneration: originalGeneration,
    });
    assert.equal(issuedPolicies.length, 1);
    assert.deepEqual(issuedPolicies[0]!.mcpServers, ["lemmacomputer_fixture"]);
    assert.equal(issuedPolicies[0]!.mcpToolPermissions?.lemmacomputer_linear, undefined);

    const unconnected = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(unconnected.statusCode, 200);
    assert.equal(issuedPolicies.length, 1, "an unconnected catalog card must not refresh a workspace grant");
    assert.deepEqual(statusServers, []);
    assert.deepEqual(toolServers, []);

    const authorize = await app.inject({
      method: "GET",
      url: "/v1/connections/linear/authorize",
      headers,
    });
    assert.equal(authorize.statusCode, 302);
    const callback = await app.inject({
      method: "GET",
      url: `/v1/connections/linear/callback?state=${encodeURIComponent(oauthState)}&code=fixture-authorization-code`,
      headers,
    });
    assert.equal(callback.statusCode, 303);
    assert.equal(issuedPolicies.length, 2);
    assert.deepEqual(issuedPolicies.at(-1)!.mcpServers, ["lemmacomputer_fixture"], "a connected provider is still fail-closed until its tools are reviewed");
    assert.equal(issuedPolicies.at(-1)!.mcpToolPermissions?.lemmacomputer_linear, undefined);

    const pendingReview = await app.inject({
      method: "GET",
      url: "/v1/admin/connectors/linear/tool-policy",
      headers,
    });
    assert.equal(pendingReview.statusCode, 200);
    const reviewed = await app.inject({
      method: "PUT",
      url: "/v1/admin/connectors/linear/tool-policy",
      headers,
      payload: {
        expectedDocumentHash: pendingReview.json().documentHash,
        expectedAccessPolicyVersion: pendingReview.json().accessPolicyVersion,
        tools: { create_issue: "allow" },
      },
    });
    assert.equal(reviewed.statusCode, 200);
    // This fixture intentionally has no tenant identity directory, so its
    // admin-wide refresh is a no-op. A normal owner refresh immediately picks
    // up the invalidated, now-reviewed projection.
    const reviewedStatus = await app.inject({
      method: "GET",
      url: "/v1/connections/linear",
      headers,
    });
    assert.equal(reviewedStatus.statusCode, 200);
    assert.equal(issuedPolicies.length, 3, "an administrator's current-definition review refreshes connected workspace grants");
    assert.deepEqual(issuedPolicies.at(-1)!.mcpServers, ["lemmacomputer_fixture", "lemmacomputer_linear"]);
    assert.deepEqual(issuedPolicies.at(-1)!.mcpToolPermissions?.lemmacomputer_linear, ["create_issue"]);

    statusServers.length = 0;
    toolServers.length = 0;
    const stable = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(stable.statusCode, 200);
    assert.equal(issuedPolicies.length, 3, "a stable connected marker must not reissue a workspace grant");
    const stableLinear = stable.json().connections.find((connector: { id: string }) => connector.id === "linear");
    assert.equal(stableLinear.state, "connected");
    assert.deepEqual(statusServers, ["lemmacomputer_linear"]);
    assert.deepEqual(toolServers, []);

    linearState = "expired";
    renewalFails = true;
    await connectorRegistry.saveConnectionState({
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      connectorId: "linear",
      state: "expired",
      connectedAt: new Date("2026-07-28T00:00:00.000Z"),
      expiresAt: new Date("2026-07-28T00:30:00.000Z"),
    });
    statusServers.length = 0;
    toolServers.length = 0;
    const stale = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(stale.statusCode, 200);
    const staleLinear = stale.json().connections.find((connector: { id: string }) => connector.id === "linear");
    assert.equal(staleLinear.state, "expired");
    assert.ok(renewalAttempts >= 1);
    assert.equal(issuedPolicies.length, 4, "an expired durable marker must remove its stale remote projection");
    const staleReplacement = issuedPolicies.at(-1)!;
    assert.ok(!staleReplacement.mcpServers?.includes("lemmacomputer_linear"));
    assert.equal(staleReplacement.mcpToolPermissions?.lemmacomputer_linear, undefined);
    assert.ok(!staleReplacement.allowedTools.includes("create_issue"));
    assert.ok(statusServers.every((serverName) => serverName === "lemmacomputer_linear"));
    assert.ok(toolServers.every((serverName) => serverName === "lemmacomputer_linear"));

    renewalFails = false;
    statusServers.length = 0;
    toolServers.length = 0;
    const recovered = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(recovered.statusCode, 200);
    const recoveredLinear = recovered.json().connections.find((connector: { id: string }) => connector.id === "linear");
    assert.equal(recoveredLinear.state, "connected");
    assert.equal(issuedPolicies.length, 5, "a renewed marker must restore its remote projection");
    const restored = issuedPolicies.at(-1)!;
    assert.ok(restored.mcpServers?.includes("lemmacomputer_linear"));
    assert.deepEqual(restored.mcpToolPermissions?.lemmacomputer_linear, ["create_issue"]);
    assert.ok(statusServers.every((serverName) => serverName === "lemmacomputer_linear"));
    assert.ok(toolServers.every((serverName) => serverName === "lemmacomputer_linear"));

    linearState = "disconnected";
    grantRefreshFails = true;
    statusServers.length = 0;
    toolServers.length = 0;
    const revoked = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(revoked.statusCode, 200);
    const revokedLinear = revoked.json().connections.find((connector: { id: string }) => connector.id === "linear");
    assert.equal(revokedLinear.state, "disconnected");
    assert.equal(issuedPolicies.length, 6, "a revoked marker must remove its remote projection");
    const revokedReplacement = issuedPolicies.at(-1)!;
    assert.ok(!revokedReplacement.mcpServers?.includes("lemmacomputer_linear"));
    assert.equal(revokedReplacement.mcpToolPermissions?.lemmacomputer_linear, undefined);
    assert.ok(!revokedReplacement.allowedTools.includes("create_issue"));
    assert.equal(await connectorRegistry.getConnectionState(identity.tenantId, identity.subjectId, "linear"), null);
    assert.ok(statusServers.every((serverName) => serverName === "lemmacomputer_linear"));
    assert.deepEqual(toolServers, []);
    const afterFailedRefresh = await workspaceStore.getOwned(identity, workspaceId);
    assert.equal(afterFailedRefresh?.accessGeneration, originalGeneration, "connector gateway failure must not revoke the workspace-to-Control bridge");
    assert.ok(revokedGatewayGrants >= 1, "the failed gateway projection is still removed fail closed");
    const renewedBridge = await app.inject({
      method: "POST",
      url: "/internal/v1/agent/grants/renew",
      headers: { authorization: `Bearer ${bridgeToken}` },
    });
    assert.equal(renewedBridge.statusCode, 200, "Sites and other Control capabilities retain a renewable workspace bridge");
    grantRefreshFails = false;

    statusServers.length = 0;
    toolServers.length = 0;
    const noMarkerAgain = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(noMarkerAgain.statusCode, 200);
    assert.equal(issuedPolicies.length, 6, "a removed marker must leave catalog re-entry local");
    assert.deepEqual(statusServers, []);
    assert.deepEqual(toolServers, []);

  } finally {
    await app.close();
  }
});
