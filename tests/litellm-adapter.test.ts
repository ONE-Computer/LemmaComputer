import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { LiteLLMGatewayAdapter, tenantManagedModelAccessGroup } from "@onecomputer/litellm-adapter";

const identity = { tenantId: "acme", subjectId: "alex-morgan", audience: "onecomputer-control" as const };

const adapter = new LiteLLMGatewayAdapter({
  adminUrl: "http://litellm.internal:4000",
  workspaceUrl: "http://litellm:4000",
  masterKey: "sk-master-test-not-used-00001",
  credentialSecret: "credential-secret-for-tests-00000001",
});

test("workspace credentials are deterministic, scoped by workspace, and not the master key", () => {
  const first = adapter.credentialFor("workspace-a");
  assert.equal(first, adapter.credentialFor("workspace-a"));
  assert.notEqual(first, adapter.credentialFor("workspace-b"));
  assert.notEqual(first, "sk-master-test-not-used-00001");
  assert.match(first, /^sk-ocw-[A-Za-z0-9_-]+$/);
});

test("gateway identity separates OAuth owner, agent actor, and workspace", () => {
  const sameUser = adapter.userIdFor(identity);
  assert.equal(sameUser, adapter.userIdFor(identity));
  assert.notEqual(sameUser, adapter.userIdFor({ ...identity, subjectId: "another-user" }));
  assert.notEqual(sameUser, adapter.userIdFor({ ...identity, tenantId: "another-tenant" }));
  assert.notEqual(adapter.agentIdFor("workspace-a", "research"), adapter.agentIdFor("workspace-a", "calendar"));
  assert.notEqual(adapter.agentIdFor("workspace-a", "research"), adapter.agentIdFor("workspace-b", "research"));
  assert.notEqual(adapter.credentialFor("workspace-a", "research"), adapter.credentialFor("workspace-a", "calendar"));
  const rotatedCredentialAdapter = new LiteLLMGatewayAdapter({
    adminUrl: "http://litellm.internal:4000",
    workspaceUrl: "http://litellm:4000",
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "a-different-credential-secret-000001",
  });
  assert.equal(rotatedCredentialAdapter.userIdFor(identity), sameUser);
  assert.equal(rotatedCredentialAdapter.agentIdFor("workspace-a", "research"), adapter.agentIdFor("workspace-a", "research"));
  assert.notEqual(rotatedCredentialAdapter.credentialFor("workspace-a", "research"), adapter.credentialFor("workspace-a", "research"));
});

test("connection credentials are unique per lease and scoped by user and MCP server", () => {
  const connection = adapter.connectionCredentialFor(identity, "onecomputer_ms365", "lease-a");
  assert.equal(connection, adapter.connectionCredentialFor(identity, "onecomputer_ms365", "lease-a"));
  assert.notEqual(connection, adapter.connectionCredentialFor(identity, "onecomputer_ms365", "lease-b"));
  assert.notEqual(connection, adapter.connectionCredentialFor({ ...identity, subjectId: "another-user" }, "onecomputer_ms365", "lease-a"));
  assert.notEqual(connection, adapter.connectionCredentialFor(identity, "another-server", "lease-a"));
  assert.notEqual(connection, adapter.credentialFor("workspace-a"));
  assert.notEqual(connection, "sk-master-test-not-used-00001");
  assert.match(connection, /^sk-occ-[A-Za-z0-9_-]+$/);
});

test("concurrent connection reads use independent temporary grants and revoke each by alias", async () => {
  const generated: Array<Record<string, unknown>> = [];
  const deleted: Array<Record<string, unknown>> = [];
  const statusCredentials: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/server") {
      response.end(JSON.stringify([{ server_id: "ms365-server-id", server_name: "onecomputer_ms365" }]));
      return;
    }
    if (request.url === "/key/generate") generated.push(body);
    if (request.url === "/key/delete") deleted.push(body);
    if (request.url === "/v1/mcp/server/ms365-server-id/oauth-user-credential/status") {
      statusCredentials.push(String(request.headers.authorization ?? ""));
      response.end(JSON.stringify({ has_credential: false, is_expired: false }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    const results = await Promise.all([
      liveAdapter.userOAuthConnectionStatus(identity, "onecomputer_ms365"),
      liveAdapter.userOAuthConnectionStatus(identity, "onecomputer_ms365"),
    ]);
    assert.deepEqual(results.map((result) => result.state), ["disconnected", "disconnected"]);
    assert.equal(generated.length, 2);
    assert.equal(new Set(generated.map((grant) => grant.key)).size, 2);
    assert.equal(new Set(generated.map((grant) => grant.key_alias)).size, 2);
    assert.equal(new Set(statusCredentials).size, 2);
    assert.deepEqual(
      new Set(deleted.flatMap((request) => request.key_aliases as string[])),
      new Set(generated.map((grant) => grant.key_alias as string)),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("expired Microsoft 365 connection discovery re-reads status without a tool call", async () => {
  const marker = "oauth-token-must-not-escape";
  const requests: Array<{ url: string; authorization: string }> = [];
  let statusReads = 0;
  let failDiscovery = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain request bodies so the local HTTP connection can be reused.
    }
    requests.push({ url: request.url ?? "", authorization: String(request.headers.authorization ?? "") });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/server") {
      response.end(JSON.stringify([{ server_id: "ms365-server-id", server_name: "onecomputer_ms365" }]));
      return;
    }
    if (request.url === "/v1/mcp/server/ms365-server-id/oauth-user-credential/status") {
      statusReads += 1;
      response.end(JSON.stringify(statusReads === 1
        ? { has_credential: true, is_expired: true, access_token: marker }
        : { has_credential: true, is_expired: false, access_token: marker }));
      return;
    }
    if (request.url === "/mcp-rest/tools/list") {
      if (failDiscovery) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: marker }));
        return;
      }
      response.end(JSON.stringify({
        tools: [
          { name: "list_issues", mcp_info: { server_id: "ms365-server-id" } },
          { name: "foreign_tool", mcp_info: { server_id: "other-server-id" } },
        ],
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    const tools = await liveAdapter.userOAuthConnectionTools(identity, "onecomputer_ms365");
    assert.deepEqual(tools, ["list_issues"]);
    assert.equal(statusReads, 2);
    assert.equal(requests.filter(({ url }) => url === "/mcp-rest/tools/list").length, 1);
    assert.equal(requests.filter(({ url }) => url === "/mcp-rest/tools/call").length, 0);
    assert.ok(requests.filter(({ url }) => url === "/mcp-rest/tools/list").every(({ authorization }) => authorization !== "Bearer sk-master-test-not-used-00001"));
    assert.equal(JSON.stringify(tools).includes(marker), false);
    failDiscovery = true;
    await assert.rejects(
      () => liveAdapter.userOAuthConnectionTools(identity, "onecomputer_ms365"),
      (error: unknown) => {
        const failure = error as { code?: unknown; message?: unknown };
        assert.equal(failure.code, "MCP_TOOL_DISCOVERY_FAILED");
        assert.equal(failure.message, "The connector could not refresh its saved credentials. Reconnect and try again.");
        assert.equal(JSON.stringify(error).includes(marker), false);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("connector discovery and registration keep provider credentials inside LiteLLM payloads", async () => {
  const requests: Array<{ method: string; url: string; authorization: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: String(request.headers.authorization ?? ""),
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/server/oauth/session") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url?.startsWith("/v1/mcp/server/oauth/onecomputer_discovery_") && request.url.includes("/authorize?")) {
      response.statusCode = 302;
      response.setHeader("location", "https://login.acme.example/oauth/authorize");
      response.end();
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const connector = {
    name: "Acme Projects",
    description: "Work with Acme projects.",
    url: "https://mcp.acme.example/mcp",
    scopes: ["projects:read", "projects:write"],
    clientId: "acme-client",
    clientSecret: "acme-secret",
  };
  try {
    const discovered = await liveAdapter.discoverOAuthMcpServer({
      ...connector,
      callbackUrl: "https://onecomputer.example/callback",
    });
    assert.deepEqual(discovered, {
      authorizationOrigin: "https://login.acme.example",
      dynamicClientRegistration: false,
    });
    await liveAdapter.registerOAuthMcpServer({
      ...connector,
      serverId: "acme-server-id",
      serverName: "onecomputer_acme_projects",
    });
    const discovery = requests.find((request) => request.url === "/v1/mcp/server/oauth/session")!;
    const registration = requests.find((request) => request.url === "/v1/mcp/server" && request.method === "POST")!;
    assert.match(String(discovery.body.server_name), /^onecomputer_discovery_[a-f0-9]{20}$/);
    assert.doesNotMatch(String(discovery.body.server_name), /-/);
    assert.deepEqual(discovery.body.credentials, {
      client_id: "acme-client",
      client_secret: "acme-secret",
      scopes: ["projects:read", "projects:write"],
    });
    assert.deepEqual(registration.body.credentials, discovery.body.credentials);
    assert.equal(registration.body.server_id, "acme-server-id");
    assert.equal(registration.body.server_name, "onecomputer_acme_projects");
    assert.equal("client_secret" in registration.body, false);
    assert.ok(requests.every((request) => request.authorization === "Bearer sk-master-test-not-used-00001"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("connector discovery performs dynamic client registration when credentials are not supplied", async () => {
  const requests: Array<{ method: string; url: string; authorization: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: String(request.headers.authorization ?? ""),
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/server/oauth/session") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url?.includes("/register")) {
      response.end(JSON.stringify({ client_id: "dynamic-client-id", token_endpoint_auth_method: "none" }));
      return;
    }
    if (request.url?.includes("/authorize?")) {
      assert.match(request.url, /client_id=dynamic-client-id/);
      response.statusCode = 302;
      response.setHeader("location", "https://login.acme.example/oauth/authorize");
      response.end();
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    const discovered = await liveAdapter.discoverOAuthMcpServer({
      name: "Acme Projects",
      description: "Work with Acme projects.",
      url: "https://mcp.acme.example/mcp",
      scopes: ["projects:read"],
      callbackUrl: "https://onecomputer.example/callback",
    });
    assert.deepEqual(discovered, {
      authorizationOrigin: "https://login.acme.example",
      dynamicClientRegistration: true,
    });
    const registration = requests.find((request) => request.url.includes("/register"))!;
    assert.equal(registration.authorization, "Bearer sk-master-test-not-used-00001");
    assert.deepEqual(registration.body, {
      client_name: "ONEComputer",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("connector discovery asks for provider credentials when LiteLLM reports its no-registration fallback", async () => {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/server/oauth/session") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url?.includes("/register")) {
      const serverId = request.url.split("/").at(-2);
      response.end(JSON.stringify({ client_id: serverId, client_secret: "dummy" }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    await assert.rejects(
      liveAdapter.discoverOAuthMcpServer({
        name: "Static OAuth",
        description: "Requires a pre-registered provider app.",
        url: "https://mcp.static.example/mcp",
        scopes: ["read"],
        callbackUrl: "https://onecomputer.example/callback",
      }),
      (error: Error & { code?: string }) => error.code === "MCP_OAUTH_CLIENT_REQUIRED",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("owned OAuth uses a narrow per-user connection key and returns only the upstream redirect", async () => {
  const requests: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length && request.headers["content-type"]?.includes("application/json")
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : {};
    requests.push({ url: request.url ?? "", authorization: String(request.headers.authorization ?? ""), body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/server") {
      response.end(JSON.stringify([{ server_id: "ms365-server-id", server_name: "onecomputer_ms365" }]));
      return;
    }
    if (request.url === "/v1/mcp/server/oauth/ms365-server-id/register") {
      response.end(JSON.stringify({ client_id: "ms365-server-id", client_secret: "dummy" }));
      return;
    }
    if (request.url?.startsWith("/v1/mcp/server/oauth/ms365-server-id/authorize?")) {
      response.statusCode = 307;
      response.setHeader("location", "http://localhost:3001/authorize?opaque=upstream-state");
      response.setHeader("set-cookie", "mcp_oauth_state=opaque; Path=/callback; HttpOnly; SameSite=lax");
      response.end();
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    const started = await liveAdapter.beginUserOAuthConnection({
      identity,
      serverName: "onecomputer_ms365",
      redirectUri: "http://localhost:4174/api/v1/connections/microsoft-365/callback",
      state: "opaque-onecomputer-state",
      codeChallenge: "a".repeat(43),
      authorizationOrigin: "http://localhost:3001",
    });
    assert.equal(started.location, "http://localhost:3001/authorize?opaque=upstream-state");
    assert.equal(started.cookies.length, 1);
    const grant = requests.find((item) => item.url === "/key/generate")!;
    const authorize = requests.find((item) => item.url.includes("/authorize?"))!;
    assert.equal(grant.body.user_id, liveAdapter.userIdFor(identity));
    assert.equal("max_budget" in grant.body, false);
    assert.equal(
      (grant.body.metadata as Record<string, unknown>).onecomputer_connection_account_lookup,
      false,
    );
    assert.deepEqual(grant.body.object_permission, {
      mcp_servers: ["onecomputer_ms365"],
      mcp_tool_permissions: { onecomputer_ms365: [] },
    });
    assert.deepEqual(grant.body.allowed_routes, [
      "/v1/mcp/server/oauth/ms365-server-id/authorize",
      "/v1/mcp/server/oauth/ms365-server-id/token",
      "/v1/mcp/server/ms365-server-id/oauth-user-credential",
      "/v1/mcp/server/ms365-server-id/oauth-user-credential/status",
      "/mcp-rest/tools/list",
    ]);
    assert.notEqual(authorize.authorization, "Bearer sk-master-test-not-used-00001");
    assert.match(authorize.authorization, /^Bearer sk-occ-/);
    assert.ok(!JSON.stringify(started).includes("sk-occ-"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("owned OAuth registers and retries a persistent MCP server when LiteLLM reports a missing client id", async () => {
  const requests: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  let authorizeAttempts = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length && request.headers["content-type"]?.includes("application/json")
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : {};
    requests.push({ url: request.url ?? "", authorization: String(request.headers.authorization ?? ""), body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/server") {
      response.end(JSON.stringify([{ server_id: "linear-server-id", server_name: "onecomputer_linear" }]));
      return;
    }
    if (request.url?.startsWith("/v1/mcp/server/oauth/linear-server-id/authorize?")) {
      authorizeAttempts += 1;
      if (authorizeAttempts === 1) {
        response.statusCode = 400;
        response.end(JSON.stringify({ detail: { error: "missing_client_id" } }));
        return;
      }
      response.statusCode = 307;
      response.setHeader("location", "https://mcp.linear.app/authorize?client_id=dynamic-client-id");
      response.end();
      return;
    }
    if (request.url === "/v1/mcp/server/oauth/linear-server-id/register") {
      response.end(JSON.stringify({ client_id: "dynamic-client-id" }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    const started = await liveAdapter.beginUserOAuthConnection({
      identity,
      serverName: "onecomputer_linear",
      redirectUri: "https://onecomputer.example/api/v1/connections/linear/callback",
      state: "opaque-onecomputer-state",
      codeChallenge: "a".repeat(43),
      authorizationOrigins: ["https://mcp.linear.app"],
    });
    assert.equal(started.location, "https://mcp.linear.app/authorize?client_id=dynamic-client-id");
    assert.equal(authorizeAttempts, 2);
    const registration = requests.find((request) => request.url.endsWith("/register"))!;
    assert.equal(registration.authorization, "Bearer sk-master-test-not-used-00001");
    assert.ok(requests.indexOf(registration) < requests.findIndex((request) => request.url.includes("/authorize?")));
    const authorizeRequests = requests.filter((request) => request.url.includes("/authorize?"));
    assert.ok(authorizeRequests.every((request) => request.authorization.startsWith("Bearer sk-occ-")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("hosted MCP status grants cannot call tools or expose provider credentials", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length && request.headers["content-type"]?.includes("application/json")
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : {};
    requests.push({ url: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/server") {
      response.end(JSON.stringify([{ server_id: "linear-server-id", server_name: "onecomputer_linear" }]));
      return;
    }
    if (request.url === "/v1/mcp/server/linear-server-id/oauth-user-credential/status") {
      response.end(JSON.stringify({ server_id: "linear-server-id", has_credential: false, is_expired: false }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    const status = await liveAdapter.userOAuthConnectionStatus(identity, "onecomputer_linear");
    assert.deepEqual(status, { state: "disconnected", connectedAt: null, expiresAt: null, account: null });
    const grant = requests.find((request) => request.url === "/key/generate")!.body;
    assert.deepEqual(grant.object_permission, {
      mcp_servers: ["onecomputer_linear"],
      mcp_tool_permissions: { onecomputer_linear: [] },
    });
    assert.deepEqual(grant.allowed_routes, [
      "/v1/mcp/server/oauth/linear-server-id/authorize",
      "/v1/mcp/server/oauth/linear-server-id/token",
      "/v1/mcp/server/linear-server-id/oauth-user-credential",
      "/v1/mcp/server/linear-server-id/oauth-user-credential/status",
      "/mcp-rest/tools/list",
    ]);
    assert.equal((grant.metadata as Record<string, unknown>).onecomputer_connection_account_lookup, false);
    assert.ok(!requests.some((request) => request.url === "/mcp-rest/tools/call"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OAuth token exchange stays inside the adapter response boundary and exposes only safe status", async () => {
  const markerAccessToken = "oauth-access-token-must-not-escape";
  const markerRefreshToken = "oauth-refresh-token-must-not-escape";
  const requests: Array<{ url: string; authorization: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ url: request.url ?? "", authorization: String(request.headers.authorization ?? ""), body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/server") {
      response.end(JSON.stringify([{ server_id: "ms365-server-id", server_name: "onecomputer_ms365" }]));
      return;
    }
    if (request.url === "/v1/mcp/server/oauth/ms365-server-id/token") {
      response.end(JSON.stringify({ access_token: markerAccessToken, refresh_token: markerRefreshToken, expires_in: 3600 }));
      return;
    }
    if (request.url === "/v1/mcp/server/ms365-server-id/oauth-user-credential/status") {
      response.end(JSON.stringify({ server_id: "ms365-server-id", has_credential: true, is_expired: false, connected_at: "2026-07-20T01:02:03Z", expires_at: "2026-07-20T02:02:03Z" }));
      return;
    }
    if (request.url === "/mcp-rest/tools/call") {
      response.end(JSON.stringify({
        content: [{
          type: "text",
          text: JSON.stringify({
            displayName: "Alex Morgan",
            mail: "alex.morgan@acme.example",
            userPrincipalName: "alex@acme.example",
          }),
        }],
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    const status = await liveAdapter.completeUserOAuthConnection({
      identity,
      serverName: "onecomputer_ms365",
      code: "one-time-authorization-code",
      codeVerifier: "v".repeat(48),
    });
    assert.deepEqual(status, {
      state: "connected",
      connectedAt: "2026-07-20T01:02:03Z",
      expiresAt: "2026-07-20T02:02:03Z",
      account: {
        displayName: "Alex Morgan",
        email: "alex.morgan@acme.example",
        userPrincipalName: "alex@acme.example",
      },
    });
    assert.deepEqual(
      await liveAdapter.userOAuthConnectionStatus(identity, "onecomputer_ms365"),
      status,
      "a post-redirect detail status check must retain the safe account label",
    );
    assert.ok(!JSON.stringify(status).includes(markerAccessToken));
    assert.ok(!JSON.stringify(status).includes(markerRefreshToken));
    const exchange = requests.find((item) => item.url.endsWith("/token"))!;
    assert.match(exchange.authorization, /^Bearer sk-occ-/);
    assert.match(exchange.body, /grant_type=authorization_code/);
    assert.match(exchange.body, /code=one-time-authorization-code/);
    assert.match(exchange.body, /code_verifier=v+/);
    const accountLookup = requests.find((item) => item.url === "/mcp-rest/tools/call")!;
    assert.deepEqual(JSON.parse(accountLookup.body), {
      server_id: "ms365-server-id",
      name: "get-current-user",
      arguments: { $select: "displayName,mail,userPrincipalName" },
    });
    const accountLookups = requests.filter((item) => item.url === "/mcp-rest/tools/call");
    assert.equal(accountLookups.length, 2);
    const connectionGrants = requests
      .filter((item) => item.url === "/key/generate")
      .map((item) => JSON.parse(item.body));
    assert.ok(connectionGrants.every((grant) => grant.metadata.onecomputer_connection_account_lookup === true));
    assert.ok(connectionGrants.every((grant) => grant.allowed_routes.includes("/mcp-rest/tools/call")));
    assert.equal(requests.at(-1)?.url, "/key/delete");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("workspace grant expiry renews independently of workspace lifetime", async () => {
  let grantRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/key/generate") grantRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
    workspaceGrantTtlMs: 120_000,
    workspaceGrantRenewalMs: 30_000,
  });
  try {
    const first = await liveAdapter.ensureGrant({ workspaceId: "workspace-a", identity });
    const reused = await liveAdapter.ensureGrant({ workspaceId: "workspace-a", identity });
    assert.equal(reused.credential, first.credential);
    assert.equal(reused.expiresAt, first.expiresAt);
    assert.equal(grantRequests, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a policy projection change bypasses the grant cache immediately", async () => {
  let grantRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/key/generate") grantRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
    workspaceGrantTtlMs: 120_000,
    workspaceGrantRenewalMs: 30_000,
  });
  const basePolicy = {
    schemaVersion: 1 as const,
    policyVersionId: "policy-version-1",
    policyVersion: 1,
    policyHash: "1".repeat(64),
    workspaceProfile: "kasm-persistent-standard" as const,
    agentId: "persisted-agent-id",
    agentProfile: "onecomputer-default-agent" as const,
    networkProfile: "controlled-egress-v1" as const,
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-folders"],
  };
  try {
    await liveAdapter.ensureGrant({ workspaceId: "workspace-a", identity, policy: basePolicy });
    await liveAdapter.ensureGrant({
      workspaceId: "workspace-a",
      identity,
      policy: { ...basePolicy, policyVersionId: "policy-version-2", policyVersion: 2, policyHash: "2".repeat(64), allowedTools: ["list-calendars"] },
    });
    assert.equal(grantRequests, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a managed model change replaces and verifies the existing workspace grant", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let storedKey: Record<string, unknown> | undefined;
  let modelChecks = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({ url: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/key/list?")) {
      response.end(JSON.stringify({ keys: storedKey ? [storedKey] : [] }));
      return;
    }
    if (request.url === "/key/delete") {
      storedKey = undefined;
      response.end(JSON.stringify({ deleted_keys: 1 }));
      return;
    }
    if (request.url === "/key/generate") {
      storedKey = {
        ...body,
        token: createHash("sha256").update(String(body.key)).digest("hex"),
      };
      response.end(JSON.stringify({ key: body.key }));
      return;
    }
    if (request.url === "/key/update") {
      storedKey = { ...storedKey, ...body };
      response.end(JSON.stringify({ key: body.key }));
      return;
    }
    if (request.url === "/v1/models") {
      modelChecks += 1;
      const metadata = storedKey?.metadata as Record<string, unknown> | undefined;
      response.end(JSON.stringify({ data: [{ id: metadata?.onecomputer_client_model_alias }] }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const routedAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const basePolicy = {
    schemaVersion: 1 as const,
    policyVersionId: "policy-version-1",
    policyVersion: 1,
    policyHash: "1".repeat(64),
    workspaceProfile: "kasm-persistent-standard" as const,
    agentId: "persisted-agent-id",
    agentProfile: "hermes-claw-managed-v1" as const,
    networkProfile: "controlled-egress-v1" as const,
    modelAlias: "onecomputer-claude",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-folders"],
  };
  try {
    await routedAdapter.ensureGrant({ workspaceId: "workspace-a", identity, policy: basePolicy });
    const switched = await routedAdapter.ensureGrant({
      workspaceId: "workspace-a",
      identity,
      policy: { ...basePolicy, modelAlias: "onecomputer-glm" },
    });

    assert.equal(switched.modelAlias, "onecomputer-glm");
    assert.equal(requests.filter(({ url }) => url === "/key/generate").length, 2);
    assert.equal(requests.filter(({ url }) => url === "/key/delete").length, 1);
    assert.equal(requests.filter(({ url }) => url === "/key/update").length, 0);
    assert.equal(modelChecks, 1);
    assert.deepEqual(storedKey?.models, [tenantManagedModelAccessGroup(identity.tenantId, "onecomputer-glm")]);
    assert.equal((storedKey?.metadata as Record<string, unknown>).onecomputer_policy_model_alias, "onecomputer-glm");
    assert.equal((storedKey?.metadata as Record<string, unknown>).onecomputer_client_model_alias, "onecomputer-glm");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a model grant replacement fails closed when LiteLLM keeps the stale allowlist", async () => {
  const routedAdapter = new LiteLLMGatewayAdapter({
    adminUrl: "http://unused",
    workspaceUrl: "http://unused",
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const credential = routedAdapter.credentialFor("workspace-a", "persisted-agent-id");
  const gatewayUserId = routedAdapter.userIdFor(identity);
  const gatewayAgentId = routedAdapter.agentIdFor("workspace-a", "persisted-agent-id");
  const claudeAccessGroup = tenantManagedModelAccessGroup(identity.tenantId, "onecomputer-claude");
  const staleKey = {
    token: createHash("sha256").update(credential).digest("hex"),
    user_id: gatewayUserId,
    agent_id: gatewayAgentId,
    models: [claudeAccessGroup],
    metadata: {
      onecomputer_tenant_id: identity.tenantId,
      onecomputer_subject_id: identity.subjectId,
      onecomputer_workspace_id: "workspace-a",
      onecomputer_agent_id: "persisted-agent-id",
      onecomputer_policy_version_id: "policy-version-1",
      onecomputer_policy_hash: "1".repeat(64),
      onecomputer_policy_model_alias: "onecomputer-claude",
      onecomputer_client_model_alias: "onecomputer-claude",
      onecomputer_provider_access_group: claudeAccessGroup,
    },
  };
  let deleteRequests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain request bodies so the local HTTP connection can be reused.
    }
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/key/list?")) {
      response.end(JSON.stringify({ keys: [staleKey] }));
      return;
    }
    if (request.url === "/key/delete") {
      deleteRequests += 1;
      response.end(JSON.stringify({ deleted_keys: 1 }));
      return;
    }
    if (request.url === "/key/generate") {
      response.end(JSON.stringify({ key: credential }));
      return;
    }
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "onecomputer-claude" }] }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const glmPolicy = {
    schemaVersion: 1 as const,
    policyVersionId: "policy-version-1",
    policyVersion: 1,
    policyHash: "1".repeat(64),
    workspaceProfile: "kasm-persistent-standard" as const,
    agentId: "persisted-agent-id",
    agentProfile: "hermes-claw-managed-v1" as const,
    networkProfile: "controlled-egress-v1" as const,
    modelAlias: "onecomputer-glm",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-folders"],
  };
  try {
    await assert.rejects(
      liveAdapter.ensureGrant({ workspaceId: "workspace-a", identity, policy: glmPolicy }),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "GATEWAY_GRANT_FAILED"),
    );
    assert.equal(deleteRequests, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("workspace grants bind LiteLLM user and agent identities without making either policy authority", async () => {
  let grantBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    grantBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    await liveAdapter.ensureGrant({ workspaceId: "workspace-a", identity, agentId: "research" });
    assert.equal(grantBody.user_id, liveAdapter.userIdFor(identity));
    assert.equal(grantBody.agent_id, liveAdapter.agentIdFor("workspace-a", "research"));
    assert.equal((grantBody.metadata as Record<string, unknown>).onecomputer_agent_id, "research");
    assert.equal((grantBody.metadata as Record<string, unknown>).onecomputer_subject_id, "alex-morgan");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("workspace grant preserves the Control alias while scoping a managed-provider route to its tenant", async () => {
  let grantBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    grantBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const policy = {
    schemaVersion: 1 as const,
    policyVersionId: "policy-version-6",
    policyVersion: 6,
    policyHash: "b".repeat(64),
    workspaceProfile: "kasm-persistent-standard" as const,
    agentId: "persisted-agent-id",
    agentProfile: "onecomputer-default-agent" as const,
    networkProfile: "controlled-egress-v1" as const,
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    mcpServers: ["onecomputer_ms365", "onecomputer_notion"],
    mcpToolPermissions: {
      onecomputer_ms365: ["list-mail-folders", "list-calendars", "list-drives"],
      onecomputer_notion: ["search", "fetch"],
    },
    allowedTools: ["list-mail-folders", "list-calendars", "list-drives", "search", "fetch"],
  };
  try {
    await liveAdapter.ensureGrant({ workspaceId: "workspace-a", identity, policy });
    assert.deepEqual(grantBody.models, [tenantManagedModelAccessGroup(identity.tenantId, "onecomputer-assistant")]);
    assert.equal("max_budget" in grantBody, false);
    assert.equal("budget_duration" in grantBody, false);
    assert.equal(grantBody.rpm_limit, 30);
    assert.equal("tpm_limit" in grantBody, false);
    assert.equal(grantBody.max_parallel_requests, 30);
    assert.deepEqual(grantBody.object_permission, {
      mcp_servers: ["onecomputer_ms365", "onecomputer_notion"],
      mcp_tool_permissions: {
        onecomputer_ms365: ["list-mail-folders", "list-calendars", "list-drives"],
        onecomputer_notion: ["search", "fetch"],
      },
    });
    assert.equal(grantBody.agent_id, liveAdapter.agentIdFor("workspace-a", "persisted-agent-id"));
    const metadata = grantBody.metadata as Record<string, unknown>;
    assert.equal(metadata.onecomputer_policy_version_id, "policy-version-6");
    assert.equal(metadata.onecomputer_policy_model_alias, "onecomputer-assistant");
    assert.equal(metadata.onecomputer_client_model_alias, "onecomputer-assistant");
    assert.equal(metadata.onecomputer_policy_hash, "b".repeat(64));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("managed Claude Desktop and CLI Bedrock policies receive only their scoped Bedrock route", async () => {
  const grantBodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = (chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}) as Record<string, unknown>;
    if (request.url === "/key/generate") grantBodies.push(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const masterKey = "sk-master-test-not-exposed-00001";
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey,
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const policy = {
    schemaVersion: 1 as const,
    policyVersionId: "policy-version-desktop",
    policyVersion: 1,
    policyHash: "c".repeat(64),
    workspaceProfile: "claude-desktop-standard-v1" as const,
    agentId: "desktop-agent",
    agentProfile: "claude-desktop-managed-v1" as const,
    networkProfile: "controlled-egress-v1" as const,
    modelAlias: "onecomputer-bedrock" as const,
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-drives"],
  };
  try {
    for (const agentProfile of ["claude-desktop-managed-v1", "claude-cli-managed-v1"] as const) {
      const workspaceId = `workspace-bedrock-${agentProfile}`;
      const grant = await liveAdapter.ensureGrant({
        workspaceId,
        identity,
        policy: { ...policy, agentProfile },
      });
      assert.equal(grant.modelAlias, "onecomputer-bedrock");
      assert.notEqual(grant.credential, masterKey);
      assert.match(grant.credential, /^sk-ocw-[A-Za-z0-9_-]+$/);
    }
    assert.equal(grantBodies.length, 2);
    for (const grantBody of grantBodies) {
      assert.deepEqual(grantBody.models, [tenantManagedModelAccessGroup(identity.tenantId, "onecomputer-bedrock")]);
      assert.equal(JSON.stringify(grantBody).includes(masterKey), false);
      assert.equal(JSON.stringify(grantBody).includes("api_key"), false);
      assert.equal(JSON.stringify(grantBody).includes("aws_access_key_id"), false);
      const metadata = grantBody.metadata as Record<string, unknown>;
      assert.equal(metadata.onecomputer_policy_model_alias, "onecomputer-bedrock");
      assert.equal(metadata.onecomputer_client_model_alias, "onecomputer-bedrock");
      assert.equal(metadata.onecomputer_provider_access_group, tenantManagedModelAccessGroup(identity.tenantId, "onecomputer-bedrock"));
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a pre-existing key with mismatched identity is deleted by alias and replaced", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({ url: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/key/generate") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url?.startsWith("/key/list?")) {
      const credential = new LiteLLMGatewayAdapter({
        adminUrl: "http://unused",
        workspaceUrl: "http://unused",
        masterKey: "sk-master-test-not-used-00001",
        credentialSecret: "credential-secret-for-tests-00000001",
      }).credentialFor("workspace-a");
      response.end(JSON.stringify({
        keys: [{
          token: createHash("sha256").update(credential).digest("hex"),
          user_id: "wrong-user",
          agent_id: "wrong-agent",
          metadata: { onecomputer_workspace_id: "workspace-a" },
        }],
      }));
      return;
    }
    if (request.url === "/model/info") {
      response.end(JSON.stringify({
        data: [{
          model_name: "onecomputer-assistant",
          model_info: { supports_vision: true },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    await liveAdapter.ensureGrant({ workspaceId: "workspace-a", identity });
    assert.equal(requests.filter(({ url }) => url === "/key/generate").length, 1);
    assert.ok(requests.some(({ url }) => url.startsWith("/key/list?")));
    assert.deepEqual(requests.find(({ url }) => url === "/key/delete")?.body, {
      key_aliases: [`onecomputer-agent-${liveAdapter.agentIdFor("workspace-a")}`],
    });
    assert.ok(!requests.some(({ url }) => url === "/key/update"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a matching existing workspace key is updated without a duplicate generation attempt", async () => {
  const requests: string[] = [];
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: "http://unused",
    workspaceUrl: "http://unused",
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const credential = liveAdapter.credentialFor("workspace-a");
  const gatewayUserId = liveAdapter.userIdFor(identity);
  const gatewayAgentId = liveAdapter.agentIdFor("workspace-a");
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/key/list?")) {
      response.end(JSON.stringify({
        keys: [{
          token: createHash("sha256").update(credential).digest("hex"),
          user_id: gatewayUserId,
          agent_id: gatewayAgentId,
          models: [tenantManagedModelAccessGroup(identity.tenantId, "onecomputer-assistant")],
          metadata: {
            onecomputer_tenant_id: identity.tenantId,
            onecomputer_subject_id: identity.subjectId,
            onecomputer_workspace_id: "workspace-a",
            onecomputer_agent_id: "workspace-default:workspace-a",
            onecomputer_policy_model_alias: "onecomputer-assistant",
            onecomputer_client_model_alias: "onecomputer-assistant",
            onecomputer_provider_access_group: tenantManagedModelAccessGroup(identity.tenantId, "onecomputer-assistant"),
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const routedAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    await routedAdapter.ensureGrant({ workspaceId: "workspace-a", identity });
    assert.ok(requests.includes("/key/update"));
    assert.ok(!requests.includes("/key/generate"));
    assert.ok(!requests.includes("/key/delete"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a legacy token-capped workspace key is replaced so the allowance cannot survive reconciliation", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: "http://unused",
    workspaceUrl: "http://unused",
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const credential = liveAdapter.credentialFor("workspace-a");
  const gatewayUserId = liveAdapter.userIdFor(identity);
  const gatewayAgentId = liveAdapter.agentIdFor("workspace-a");
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url ?? "",
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {},
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/key/list?")) {
      response.end(JSON.stringify({
        keys: [{
          token: createHash("sha256").update(credential).digest("hex"),
          user_id: gatewayUserId,
          agent_id: gatewayAgentId,
          tpm_limit: 500_000,
          metadata: {
            onecomputer_tenant_id: identity.tenantId,
            onecomputer_subject_id: identity.subjectId,
            onecomputer_workspace_id: "workspace-a",
            onecomputer_agent_id: "workspace-default:workspace-a",
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const routedAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    await routedAdapter.ensureGrant({ workspaceId: "workspace-a", identity });
    assert.deepEqual(requests.find(({ url }) => url === "/key/delete")?.body, {
      key_aliases: [`onecomputer-agent-${routedAdapter.agentIdFor("workspace-a")}`],
    });
    const generated = requests.find(({ url }) => url === "/key/generate")?.body ?? {};
    assert.equal("tpm_limit" in generated, false);
    assert.ok(!requests.some(({ url }) => url === "/key/update"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a legacy budgeted workspace key is replaced so the cap cannot survive reconciliation", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: "http://unused",
    workspaceUrl: "http://unused",
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const credential = liveAdapter.credentialFor("workspace-a");
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url ?? "",
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {},
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/key/list?")) {
      response.end(JSON.stringify({
        keys: [{
          token: createHash("sha256").update(credential).digest("hex"),
          user_id: liveAdapter.userIdFor(identity),
          agent_id: liveAdapter.agentIdFor("workspace-a"),
          max_budget: 1,
          budget_duration: "30d",
          metadata: {
            onecomputer_tenant_id: identity.tenantId,
            onecomputer_subject_id: identity.subjectId,
            onecomputer_workspace_id: "workspace-a",
            onecomputer_agent_id: "workspace-default:workspace-a",
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const routedAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    await routedAdapter.ensureGrant({ workspaceId: "workspace-a", identity });
    assert.deepEqual(requests.find(({ url }) => url === "/key/delete")?.body, {
      key_aliases: [`onecomputer-agent-${routedAdapter.agentIdFor("workspace-a")}`],
    });
    const generated = requests.find(({ url }) => url === "/key/generate")?.body ?? {};
    assert.equal("max_budget" in generated, false);
    assert.equal("budget_duration" in generated, false);
    assert.equal("tpm_limit" in generated, false);
    assert.ok(!requests.some(({ url }) => url === "/key/update"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("availability check exposes safe route usage without sending a prompt", async () => {
  const requests: string[] = [];
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: "http://unused",
    workspaceUrl: "http://unused",
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  const credential = liveAdapter.credentialFor("workspace-a");
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "onecomputer-assistant" }] }));
      return;
    }
    if (request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({
        tools: [
          { name: "search_files", description: "Search assigned files" },
          { name: "global_unassigned_tool", description: "Visible globally but rejected by the workspace policy bridge" },
        ],
      }));
      return;
    }
    if (request.url === "/model/info") {
      response.end(JSON.stringify({
        data: [{
          model_name: "onecomputer-assistant",
          model_info: { supports_vision: true },
        }],
      }));
      return;
    }
    if (request.url?.startsWith("/key/list?")) {
      response.end(JSON.stringify({
        keys: [{
          token: createHash("sha256").update(credential).digest("hex"),
          rpm_limit: 30,
          max_parallel_requests: 30,
        }],
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const routedAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    const result = await routedAdapter.test("workspace-a");
    assert.equal(result.availability, "ready");
    assert.equal(result.model, "onecomputer-assistant");
    assert.equal(result.modelRoute.fallback, "none");
    assert.equal(result.modelRoute.capabilities.vision, true);
    assert.equal(result.modelRoute.limits.tokensPerMinute, null);
    assert.equal(result.tools.length, 2);
    assert.ok(!requests.includes("/v1/chat/completions"));
    assert.ok(!JSON.stringify(result).includes("gpt-"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("governed execution uses one exact-tool key, resolved server id, and revocation", async () => {
  const requests: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({ url: request.url ?? "", authorization: String(request.headers.authorization ?? ""), body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{ name: "delete_file", mcp_info: { server_id: "fixture-server-id" } }] }));
    } else if (request.url === "/mcp-rest/tools/call") {
      response.end(JSON.stringify({ content: [{ type: "text", text: "Deleted fixture Q3-draft.docx" }] }));
    } else {
      response.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    const result = await liveAdapter.executeGovernedTool({
      tenantId: "acme",
      subjectId: "alex-morgan",
      workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
      operationId: "15eaf54f-5f29-4b2d-9e21-890e8711720d",
      operationDigest: "0".repeat(64),
      leaseId: "73bc3cc4-34da-42ea-a933-0d6bf2bfd968",
      serverName: "onecomputer_fixture",
      toolName: "delete_file",
      arguments: { path: "/Finance/2026/Q3-draft.docx" },
    });
    const grant = requests.find((item) => item.url === "/key/generate")!;
    const call = requests.find((item) => item.url === "/mcp-rest/tools/call")!;
    assert.deepEqual((grant.body.object_permission as Record<string, unknown>).mcp_tool_permissions, { onecomputer_fixture: ["delete_file"] });
    assert.equal(grant.body.user_id, liveAdapter.userIdFor(identity));
    assert.equal(grant.body.agent_id, liveAdapter.agentIdFor("b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508"));
    assert.notEqual(call.authorization, "Bearer sk-master-test-not-used-00001");
    assert.match(call.authorization, /^Bearer sk-oce-/);
    assert.deepEqual(call.body, { server_id: "fixture-server-id", name: "delete_file", arguments: { path: "/Finance/2026/Q3-draft.docx" } });
    assert.equal(requests.at(-1)?.url, "/key/delete");
    assert.equal(result.resultSummary, "Deleted fixture Q3-draft.docx");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("governed execution preserves the connector's safe failure summary", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain request bodies so the local HTTP connection can be reused.
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{ name: "upload-file-content", mcp_info: { server_id: "fixture-server-id" } }] }));
    } else if (request.url === "/mcp-rest/tools/call") {
      response.end(JSON.stringify({
        content: [{ type: "text", text: "Microsoft Graph rejected the target path." }],
        isError: true,
      }));
    } else {
      response.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const liveAdapter = new LiteLLMGatewayAdapter({
    adminUrl: `http://127.0.0.1:${address.port}`,
    workspaceUrl: `http://127.0.0.1:${address.port}`,
    masterKey: "sk-master-test-not-used-00001",
    credentialSecret: "credential-secret-for-tests-00000001",
  });
  try {
    await assert.rejects(
      () => liveAdapter.executeGovernedTool({
        tenantId: "acme",
        subjectId: "alex-morgan",
        workspaceId: "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508",
        operationId: "15eaf54f-5f29-4b2d-9e21-890e8711720d",
        operationDigest: "0".repeat(64),
        leaseId: "73bc3cc4-34da-42ea-a933-0d6bf2bfd968",
        serverName: "onecomputer_ms365",
        toolName: "upload-file-content",
        arguments: { driveId: "drive", driveItemId: "root:/happy.txt:", body: "aGFwcHk=" },
      }),
      (error: Error & { code?: string }) => error.code === "UPSTREAM_TOOL_FAILED"
        && error.message === "Microsoft Graph rejected the target path.",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
