import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext, RuntimePolicy } from "@onecomputer/contracts";
import type { GatewayClient, McpConnectorAdministrationGateway, OAuthConnectionGateway, OAuthConnectionStatus } from "@onecomputer/litellm-adapter";
import { MemoryConnectorRegistryStore, MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "proxy-test-token-at-least-24-characters";
const identity: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "onecomputer-control" };
const headers = {
  "x-onecomputer-proxy-token": proxyToken,
  "x-onecomputer-test-tenant-id": identity.tenantId,
  "x-onecomputer-test-user-id": identity.subjectId,
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
  let renewalAttempts = 0;
  let oauthState = "";
  const statusServers: string[] = [];
  const toolServers: string[] = [];
  const gateway: GatewayClient & OAuthConnectionGateway & Pick<McpConnectorAdministrationGateway, "ensureOAuthMcpServers"> = {
    ensureGrant: async (input) => {
      assert.ok(input.policy);
      issuedPolicies.push(input.policy);
      return {
        baseUrl: "http://gateway",
        credential: "scoped-" + input.workspaceId,
        modelAlias: "onecomputer-assistant",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    modelCapabilities: async () => ({ vision: true }),
    readiness: async () => ({
      models: "ready",
      tools: "ready",
      modelRoute: {
        alias: "onecomputer-assistant",
        status: "ready",
        fallback: "none",
        capabilities: { vision: true },
        limits: { requestsPerMinute: 30, tokensPerMinute: 50_000, maxParallelRequests: 4 },
      },
    }),
    test: async () => ({
      model: "onecomputer-assistant",
      availability: "ready",
      modelRoute: {
        alias: "onecomputer-assistant",
        status: "ready",
        fallback: "none",
        capabilities: { vision: true },
        limits: { requestsPerMinute: 30, tokensPerMinute: 50_000, maxParallelRequests: 4 },
      },
      tools: [],
      apiBaseUrl: "http://gateway/v1",
      mcpUrl: "http://gateway/mcp",
    }),
    revoke: async () => undefined,
    ensureOAuthMcpServers: async () => undefined,
    beginUserOAuthConnection: async (input) => {
      oauthState = input.state;
      return { location: "http://provider/authorize", cookies: [] };
    },
    completeUserOAuthConnection: async () => connected(),
    userOAuthConnectionStatus: async (_identity, serverName) => {
      statusServers.push(serverName);
      if (serverName === "onecomputer_linear") {
        if (linearState === "connected") return connected();
        if (linearState === "expired") return expired();
      }
      return disconnected();
    },
    userOAuthConnectionTools: async (_identity, serverName) => {
      toolServers.push(serverName);
      if (serverName !== "onecomputer_linear") return [];
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
    { testIdentityMode: true, connectorRegistryStore: connectorRegistry },
  );

  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...headers, "idempotency-key": "oauth-grant-refresh-create-001" },
      payload: { grantId: "personal" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(issuedPolicies.length, 1);
    assert.deepEqual(issuedPolicies[0]!.mcpServers, ["onecomputer_fixture"]);
    assert.equal(issuedPolicies[0]!.mcpToolPermissions?.onecomputer_linear, undefined);

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
    assert.deepEqual(issuedPolicies.at(-1)!.mcpServers, ["onecomputer_fixture"], "a connected provider is still fail-closed until its tools are reviewed");
    assert.equal(issuedPolicies.at(-1)!.mcpToolPermissions?.onecomputer_linear, undefined);

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
    assert.deepEqual(issuedPolicies.at(-1)!.mcpServers, ["onecomputer_fixture", "onecomputer_linear"]);
    assert.deepEqual(issuedPolicies.at(-1)!.mcpToolPermissions?.onecomputer_linear, ["create_issue"]);

    statusServers.length = 0;
    toolServers.length = 0;
    const stable = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(stable.statusCode, 200);
    assert.equal(issuedPolicies.length, 3, "a stable connected marker must not reissue a workspace grant");
    const stableLinear = stable.json().connections.find((connector: { id: string }) => connector.id === "linear");
    assert.equal(stableLinear.state, "connected");
    assert.deepEqual(statusServers, ["onecomputer_linear"]);
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
    assert.ok(!staleReplacement.mcpServers?.includes("onecomputer_linear"));
    assert.equal(staleReplacement.mcpToolPermissions?.onecomputer_linear, undefined);
    assert.ok(!staleReplacement.allowedTools.includes("create_issue"));
    assert.ok(statusServers.every((serverName) => serverName === "onecomputer_linear"));
    assert.ok(toolServers.every((serverName) => serverName === "onecomputer_linear"));

    renewalFails = false;
    statusServers.length = 0;
    toolServers.length = 0;
    const recovered = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(recovered.statusCode, 200);
    const recoveredLinear = recovered.json().connections.find((connector: { id: string }) => connector.id === "linear");
    assert.equal(recoveredLinear.state, "connected");
    assert.equal(issuedPolicies.length, 5, "a renewed marker must restore its remote projection");
    const restored = issuedPolicies.at(-1)!;
    assert.ok(restored.mcpServers?.includes("onecomputer_linear"));
    assert.deepEqual(restored.mcpToolPermissions?.onecomputer_linear, ["create_issue"]);
    assert.ok(statusServers.every((serverName) => serverName === "onecomputer_linear"));
    assert.ok(toolServers.every((serverName) => serverName === "onecomputer_linear"));

    linearState = "disconnected";
    statusServers.length = 0;
    toolServers.length = 0;
    const revoked = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(revoked.statusCode, 200);
    const revokedLinear = revoked.json().connections.find((connector: { id: string }) => connector.id === "linear");
    assert.equal(revokedLinear.state, "disconnected");
    assert.equal(issuedPolicies.length, 6, "a revoked marker must remove its remote projection");
    const revokedReplacement = issuedPolicies.at(-1)!;
    assert.ok(!revokedReplacement.mcpServers?.includes("onecomputer_linear"));
    assert.equal(revokedReplacement.mcpToolPermissions?.onecomputer_linear, undefined);
    assert.ok(!revokedReplacement.allowedTools.includes("create_issue"));
    assert.equal(await connectorRegistry.getConnectionState(identity.tenantId, identity.subjectId, "linear"), null);
    assert.ok(statusServers.every((serverName) => serverName === "onecomputer_linear"));
    assert.deepEqual(toolServers, []);

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
