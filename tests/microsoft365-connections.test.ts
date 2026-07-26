import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext } from "@onecomputer/contracts";
import type { OAuthConnectionGateway, OAuthConnectionStatus } from "@onecomputer/litellm-adapter";
import { Microsoft365ConnectionService } from "../apps/control-api/src/connections.js";

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

  async beginUserOAuthConnection(input: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0]) {
    this.started.push(input);
    return { location: "http://localhost:3001/authorize", cookies: ["mcp_oauth_state=opaque; HttpOnly"] };
  }
  async completeUserOAuthConnection(input: Parameters<OAuthConnectionGateway["completeUserOAuthConnection"]>[0]) {
    this.completed.push(input);
    return connected;
  }
  async userOAuthConnectionStatus() { return { state: "disconnected", connectedAt: null, expiresAt: null, account: null } as const; }
  async disconnectUserOAuthConnection() { return { state: "disconnected", connectedAt: null, expiresAt: null, account: null } as const; }
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
  await assert.rejects(() => service.complete(beta, { state, code: "authorization-code" }), { code: "M365_OAUTH_IDENTITY_MISMATCH" });
  await assert.rejects(() => service.complete(alpha, { state, code: "authorization-code" }), { code: "M365_OAUTH_STATE_INVALID" });
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
  await assert.rejects(() => service.complete(alpha, { state: expired, code: "authorization-code" }), { code: "M365_OAUTH_STATE_INVALID" });

  await service.start(alpha);
  const denied = gateway.started.at(-1)!.state;
  await assert.rejects(() => service.complete(alpha, { state: denied, error: "access_denied" }), { code: "M365_OAUTH_DENIED" });

  await service.start(alpha);
  const missingCode = gateway.started.at(-1)!.state;
  await assert.rejects(() => service.complete(alpha, { state: missingCode }), { code: "M365_OAUTH_CODE_INVALID" });
  assert.equal(gateway.completed.length, 0);
});
