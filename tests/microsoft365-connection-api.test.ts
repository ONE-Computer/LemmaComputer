import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext } from "@lemmacomputer/contracts";
import type { GatewayClient, McpConnectorAdministrationGateway, OAuthConnectionGateway } from "@lemmacomputer/litellm-adapter";
import { MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import { withheldConnectors } from "../apps/control-api/src/connector-catalog.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "proxy-test-token-at-least-24-characters";
const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "lemmacomputer-control" };
const headersFor = (identity: IdentityContext) => ({
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": identity.tenantId,
  "x-lemmacomputer-test-user-id": identity.subjectId,
});

test("Control exposes an owned Microsoft 365 redirect, callback, status, and disconnect surface", async () => {
  let oauthState = "";
  const completions: string[] = [];
  const startedServers: string[] = [];
  const completedServers: string[] = [];
  let providerStatusCalls = 0;
  const disconnects: IdentityContext[] = [];
  const gateway: GatewayClient & OAuthConnectionGateway & Pick<McpConnectorAdministrationGateway, "ensureOAuthMcpServers"> = {
    ensureGrant: async () => ({ baseUrl: "http://gateway", credential: "scoped-test-credential-000001", modelAlias: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    readiness: async () => ({ models: "ready", tools: "ready" }),
    test: async () => ({
      model: "test",
      availability: "ready",
      modelRoute: { alias: "test", status: "ready", fallback: "none", capabilities: { vision: true }, limits: { requestsPerMinute: 30, tokensPerMinute: 50_000, maxParallelRequests: 4 } },
      tools: [],
      apiBaseUrl: "http://gateway/v1",
      mcpUrl: "http://gateway/mcp",
    }),
    revoke: async () => undefined,
    ensureOAuthMcpServers: async () => undefined,
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
    userOAuthConnectionStatus: async () => {
      providerStatusCalls += 1;
      return {
      state: "connected",
      connectedAt: "2026-07-20T01:02:03Z",
      expiresAt: "2026-07-20T02:02:03Z",
      account: { displayName: "Alex Morgan", email: "alex@acme.example", userPrincipalName: "alex@acme.example" },
      };
    },
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
    {
      publicWebUrl: "http://localhost:4174",
      authorizationOrigin: "http://localhost:3001",
      configuredStaticMcpClients: ["google-workspace", "github"],
    },
    { testIdentityMode: true },
  );
  try {
    const catalog = await app.inject({ method: "GET", url: "/v1/connections", headers: headersFor(alpha) });
    assert.equal(catalog.statusCode, 200);
    const connectorCards = catalog.json().connections as Array<{ id: string; serverName: string }>;
    assert.equal(connectorCards.length, 25);
    assert.deepEqual(connectorCards.slice(0, 6).map((connector) => [connector.id, connector.serverName]), [
      ["microsoft-365", "lemmacomputer_ms365"],
      ["gmail", "lemmacomputer_gmail"],
      ["google-drive", "lemmacomputer_google_drive"],
      ["google-calendar", "lemmacomputer_google_calendar"],
      ["notion", "lemmacomputer_notion"],
      ["linear", "lemmacomputer_linear"],
    ]);
    assert.ok(connectorCards.some((connector) => connector.id === "stripe"));
    assert.ok(connectorCards.some((connector) => connector.id === "github"));
    assert.ok(connectorCards.some((connector) => connector.id === "neon"));
    assert.ok(connectorCards.some((connector) => connector.id === "exa" && connector.serverName === "lemmacomputer_exa"));
    assert.ok(connectorCards.some((connector) => connector.id === "supabase"));
    assert.ok(connectorCards.some((connector) => connector.id === "massive"));
    assert.ok(connectorCards.some((connector) => connector.id === "monday"));
    // A withheld catalog entry must never reach a customer, whether or not an
    // earlier release already seeded its row.
    for (const withheld of withheldConnectors()) {
      assert.ok(
        !connectorCards.some((connector) => connector.id === withheld.id),
        `withheld connector ${withheld.id} must not be listed`,
      );
    }
    assert.equal(providerStatusCalls, 0, "catalog browsing must not probe a provider connection");

    const status = await app.inject({ method: "GET", url: "/v1/connections/microsoft-365", headers: headersFor(alpha) });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), {
      state: "disconnected",
      connectedAt: null,
      expiresAt: null,
      account: null,
    });
    assert.equal(providerStatusCalls, 0, "an unconnected status read must remain local");

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
    assert.deepEqual(startedServers, ["lemmacomputer_ms365"]);
    assert.deepEqual(completedServers, ["lemmacomputer_ms365"]);

    const connectedCatalog = await app.inject({ method: "GET", url: "/v1/connections", headers: headersFor(alpha) });
    assert.equal(connectedCatalog.statusCode, 200);
    const connectedMicrosoft = (connectedCatalog.json().connections as Array<{ id: string; state: string; account: unknown }>)
      .find((connector) => connector.id === "microsoft-365");
    assert.equal(connectedMicrosoft?.state, "connected");
    assert.equal(connectedMicrosoft?.account, null);
    assert.equal(providerStatusCalls, 1, "catalog re-entry revalidates the explicit durable marker once");

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
    assert.deepEqual(startedServers, ["lemmacomputer_ms365", "lemmacomputer_linear"]);
    assert.deepEqual(completedServers, ["lemmacomputer_ms365", "lemmacomputer_linear"]);

    const disconnected = await app.inject({ method: "DELETE", url: "/v1/connections/microsoft-365", headers: headersFor(alpha) });
    assert.equal(disconnected.statusCode, 200);
    assert.deepEqual(disconnected.json(), { state: "disconnected", connectedAt: null, expiresAt: null, account: null });
    assert.deepEqual(disconnects, [alpha]);
  } finally {
    await app.close();
  }
});
