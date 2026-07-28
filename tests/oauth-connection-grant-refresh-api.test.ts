import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext, RuntimePolicy } from "@onecomputer/contracts";
import type { GatewayClient, McpConnectorAdministrationGateway, OAuthConnectionGateway, OAuthConnectionStatus } from "@onecomputer/litellm-adapter";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
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

test("a failed silent connector renewal reissues an existing workspace grant without that connector", async () => {
  const issuedPolicies: RuntimePolicy[] = [];
  let linearState: OAuthConnectionStatus["state"] = "connected";
  let renewalFails = false;
  let renewalAttempts = 0;
  let oauthState = "";
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
      if (serverName === "onecomputer_linear") return linearState === "connected" ? connected() : expired();
      return disconnected();
    },
    userOAuthConnectionTools: async (_identity, serverName) => {
      if (serverName !== "onecomputer_linear") return [];
      if (linearState === "expired") {
        renewalAttempts += 1;
        if (renewalFails) throw new Error("provider refresh was denied");
        linearState = "connected";
      }
      return ["create_issue"];
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
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    controller,
    proxyToken,
    gateway,
    "api-fixture-approval-secret-at-least-32-characters",
    {},
    { testIdentityMode: true },
  );

  try {
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

    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...headers, "idempotency-key": "oauth-grant-refresh-create-001" },
      payload: { grantId: "personal" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(issuedPolicies.length, 1);
    assert.deepEqual(issuedPolicies[0]!.mcpServers, ["onecomputer_fixture", "onecomputer_linear"]);
    assert.deepEqual(issuedPolicies[0]!.mcpToolPermissions?.onecomputer_linear, ["create_issue"]);

    const browsed = await app.inject({ method: "GET", url: "/v1/connections", headers });
    assert.equal(browsed.statusCode, 200);
    assert.equal(issuedPolicies.length, 1, "browsing the catalog must not issue or refresh a workspace grant");

    linearState = "expired";
    renewalFails = true;
    const status = await app.inject({ method: "GET", url: "/v1/connections/linear", headers });

    assert.equal(status.statusCode, 200);
    assert.equal(status.json().state, "expired");
    assert.ok(renewalAttempts >= 1);
    assert.equal(issuedPolicies.length, 2, "the existing workspace grant is reconciled after failed renewal");
    const replacement = issuedPolicies.at(-1)!;
    assert.ok(!replacement.mcpServers?.includes("onecomputer_linear"));
    assert.equal(replacement.mcpToolPermissions?.onecomputer_linear, undefined);
    assert.ok(!replacement.allowedTools.includes("create_issue"));
  } finally {
    await app.close();
  }
});
