import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext } from "@onecomputer/contracts";
import type { GatewayClient, OAuthConnectionGateway } from "@onecomputer/litellm-adapter";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "proxy-test-token-at-least-24-characters";
const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "onecomputer-control" };
const headersFor = (identity: IdentityContext) => ({
  "x-onecomputer-proxy-token": proxyToken,
  "x-onecomputer-test-tenant-id": identity.tenantId,
  "x-onecomputer-test-user-id": identity.subjectId,
});

test("Control exposes an owned Microsoft 365 redirect, callback, status, and disconnect surface", async () => {
  let oauthState = "";
  const completions: string[] = [];
  const startedServers: string[] = [];
  const completedServers: string[] = [];
  const disconnects: IdentityContext[] = [];
  const gateway: GatewayClient & OAuthConnectionGateway = {
    ensureGrant: async () => ({ baseUrl: "http://gateway", credential: "scoped-test-credential-000001", modelAlias: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    readiness: async () => ({ models: "ready", tools: "ready" }),
    test: async () => ({
      model: "test",
      availability: "ready",
      modelRoute: { alias: "test", status: "ready", fallback: "none", capabilities: { vision: true }, budget: { limitUsd: 1, spentUsd: 0, remainingUsd: 1, duration: "30d", resetsAt: null }, limits: { requestsPerMinute: 30, tokensPerMinute: 50_000, maxParallelRequests: 4 } },
      tools: [],
      apiBaseUrl: "http://gateway/v1",
      mcpUrl: "http://gateway/mcp",
    }),
    revoke: async () => undefined,
    beginUserOAuthConnection: async (input) => {
      oauthState = input.state;
      startedServers.push(input.serverName);
      return { location: "http://localhost:3001/authorize?safe=start", cookies: ["mcp_oauth_state=opaque; Path=/callback; HttpOnly"] };
    },
    completeUserOAuthConnection: async (input) => {
      completions.push(input.code);
      completedServers.push(input.serverName);
      return {
        state: "connected",
        connectedAt: "2026-07-20T01:02:03Z",
        expiresAt: "2026-07-20T02:02:03Z",
        account: { displayName: "Alex Morgan", email: "alex@acme.example", userPrincipalName: "alex@acme.example" },
      };
    },
    userOAuthConnectionStatus: async () => ({
      state: "connected",
      connectedAt: "2026-07-20T01:02:03Z",
      expiresAt: "2026-07-20T02:02:03Z",
      account: { displayName: "Alex Morgan", email: "alex@acme.example", userPrincipalName: "alex@acme.example" },
    }),
    disconnectUserOAuthConnection: async (identity) => {
      disconnects.push(identity);
      return { state: "disconnected", connectedAt: null, expiresAt: null, account: null };
    },
  };
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    gateway,
    "api-fixture-approval-secret-at-least-32-characters",
    { publicWebUrl: "http://localhost:4174", authorizationOrigin: "http://localhost:3001" },
    { testIdentityMode: true },
  );
  try {
    const catalog = await app.inject({ method: "GET", url: "/v1/connections", headers: headersFor(alpha) });
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(catalog.json().connections.map((connector: { id: string; serverName: string }) => [connector.id, connector.serverName]), [
      ["microsoft-365", "onecomputer_ms365"],
      ["notion", "onecomputer_notion"],
      ["linear", "onecomputer_linear"],
      ["atlassian", "onecomputer_atlassian"],
      ["github", "onecomputer_github"],
    ]);

    const status = await app.inject({ method: "GET", url: "/v1/connections/microsoft-365", headers: headersFor(alpha) });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), {
      state: "connected",
      connectedAt: "2026-07-20T01:02:03Z",
      expiresAt: "2026-07-20T02:02:03Z",
      account: { displayName: "Alex Morgan", email: "alex@acme.example", userPrincipalName: "alex@acme.example" },
    });

    const start = await app.inject({ method: "GET", url: "/v1/connections/microsoft-365/authorize", headers: headersFor(alpha) });
    assert.equal(start.statusCode, 302);
    assert.equal(start.headers.location, "http://localhost:3001/authorize?safe=start");
    assert.match(String(start.headers["set-cookie"]), /HttpOnly/);

    const callbackCode = "provider-code-must-not-survive-the-redirect";
    const callback = await app.inject({
      method: "GET",
      url: `/v1/connections/microsoft-365/callback?state=${encodeURIComponent(oauthState)}&code=${callbackCode}`,
      headers: headersFor(alpha),
    });
    assert.equal(callback.statusCode, 303);
    assert.equal(callback.headers.location, "http://localhost:4174/?view=connections&m365=connected");
    assert.ok(!String(callback.headers.location).includes(callbackCode));
    assert.deepEqual(completions, [callbackCode]);
    assert.deepEqual(startedServers, ["onecomputer_ms365"]);
    assert.deepEqual(completedServers, ["onecomputer_ms365"]);

    const replay = await app.inject({
      method: "GET",
      url: `/v1/connections/microsoft-365/callback?state=${encodeURIComponent(oauthState)}&code=${callbackCode}`,
      headers: headersFor(alpha),
    });
    assert.equal(replay.statusCode, 303);
    assert.match(String(replay.headers.location), /m365=error/);
    assert.deepEqual(completions, [callbackCode]);

    const linearStart = await app.inject({ method: "GET", url: "/v1/connections/linear/authorize", headers: headersFor(alpha) });
    assert.equal(linearStart.statusCode, 302);
    const linearCallback = await app.inject({
      method: "GET",
      url: `/v1/connections/linear/callback?state=${encodeURIComponent(oauthState)}&code=linear-provider-code`,
      headers: headersFor(alpha),
    });
    assert.equal(linearCallback.statusCode, 303);
    assert.equal(linearCallback.headers.location, "http://localhost:4174/?view=connections&connector=linear&connection=connected");
    assert.deepEqual(startedServers, ["onecomputer_ms365", "onecomputer_linear"]);
    assert.deepEqual(completedServers, ["onecomputer_ms365", "onecomputer_linear"]);

    const disconnected = await app.inject({ method: "DELETE", url: "/v1/connections/microsoft-365", headers: headersFor(alpha) });
    assert.equal(disconnected.statusCode, 200);
    assert.deepEqual(disconnected.json(), { state: "disconnected", connectedAt: null, expiresAt: null, account: null });
    assert.deepEqual(disconnects, [alpha]);
  } finally {
    await app.close();
  }
});
