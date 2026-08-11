import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { egressSecurityGroupVersionSchema } from "@lemmacomputer/contracts";
import { compileEgressSecurityGroup, compileRuntimeEgressPolicy, deriveEgressProxySecret, issueEgressProxyGrant } from "@lemmacomputer/egress-policy";
import { createEgressProxy, createHttpDynamicDestinationAuthorizer } from "../apps/egress-proxy/src/server.js";

const policy = egressSecurityGroupVersionSchema.parse({
  schemaVersion: 1,
  id: "egv_acme_updates_v1",
  securityGroupId: "esg_acme_updates",
  tenantId: "acme",
  version: 1,
  name: "Approved updates",
  description: "Only reviewed update destinations.",
  defaultAction: "deny",
  rules: [{ id: "claude-downloads", action: "allow", protocol: "https", host: "downloads.claude.ai", includeSubdomains: false, port: 443, purpose: "Download approved updates" }],
  documentHash: "e".repeat(64),
  createdBy: "alex",
  createdAt: "2026-07-23T04:00:00.000Z",
});

const expectedGrant = {
  tenantId: "acme",
  subjectId: "alex",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  accessGeneration: 1,
  agentId: "agent-alex",
  securityGroupVersionId: policy.id,
  egressMode: "restricted" as const,
  policyHash: "d".repeat(64),
};

const proxyAuthorization = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

const connect = (port: number, path: string, token?: string, username = "lemmacomputer") => new Promise<{ statusCode: number; socket?: net.Socket }>((resolve, reject) => {
  const request = http.request({
    host: "127.0.0.1",
    port,
    method: "CONNECT",
    path,
    headers: token ? { "proxy-authorization": proxyAuthorization(username, token) } : {},
  });
  request.on("connect", (response, socket) => resolve({ statusCode: response.statusCode ?? 0, socket }));
  request.on("response", (response) => resolve({ statusCode: response.statusCode ?? 0 }));
  request.on("error", reject);
  request.end();
});

const requestViaProxy = (port: number, target: string, username: string, password: string) => new Promise<number>((resolve, reject) => {
  const request = http.request({
    host: "127.0.0.1",
    port,
    method: "GET",
    path: target,
    headers: { "proxy-authorization": proxyAuthorization(username, password) },
  }, (response) => {
    response.resume();
    response.once("end", () => resolve(response.statusCode ?? 0));
  });
  request.on("error", reject);
  request.end();
});

const clientHello = (host: string) => {
  const name = Buffer.from(host);
  const serverName = Buffer.concat([Buffer.from([0x00, name.length >> 8, name.length & 0xff]), name]);
  const serverNameList = Buffer.concat([Buffer.from([serverName.length >> 8, serverName.length & 0xff]), serverName]);
  const extension = Buffer.concat([Buffer.from([0x00, 0x00, serverNameList.length >> 8, serverNameList.length & 0xff]), serverNameList]);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32),
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x02, 0x13, 0x01]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([extension.length >> 8, extension.length & 0xff]),
    extension,
  ]);
  const handshake = Buffer.concat([Buffer.from([0x01, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01, handshake.length >> 8, handshake.length & 0xff]), handshake]);
};

test("authenticated CONNECT reaches only an exact approved destination", async () => {
  const upstream = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const secret = deriveEgressProxySecret("root-secret-with-at-least-thirty-two-characters", expectedGrant.workspaceId);
  const token = issueEgressProxyGrant(secret, expectedGrant, new Date(), 60);
  let upstreamConnections = 0;
  let workspaceAccess = true;
  const events: Record<string, unknown>[] = [];
  const proxy = createEgressProxy({
    policy: compileEgressSecurityGroup(policy),
    verificationSecret: secret,
    expectedGrant,
    workspaceAccessAuthorizer: async () => workspaceAccess,
    accessHeartbeatMs: 25,
    resolveHost: async () => [{ address: "104.18.0.1", family: 4 }],
    connect: () => {
      upstreamConnections += 1;
      return net.connect({ host: "127.0.0.1", port: upstreamPort });
    },
    audit: (event) => events.push(event),
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  try {
    const allowed = await connect(proxyPort, "downloads.claude.ai:443", token);
    assert.equal(allowed.statusCode, 200);
    const echoed = new Promise<string>((resolve) => allowed.socket!.once("data", (chunk) => resolve(chunk.toString("hex"))));
    const hello = clientHello("downloads.claude.ai");
    allowed.socket!.write(hello);
    assert.equal(await echoed, hello.toString("hex"));
    const revoked = new Promise<void>((resolve) => allowed.socket!.once("close", resolve));
    workspaceAccess = false;
    await revoked;
    workspaceAccess = true;
    assert.equal(upstreamConnections, 1);

    const mismatchedSni = await connect(proxyPort, "downloads.claude.ai:443", token);
    assert.equal(mismatchedSni.statusCode, 200);
    const closed = new Promise<void>((resolve) => mismatchedSni.socket!.once("close", resolve));
    mismatchedSni.socket!.write(clientHello("api.anthropic.com"));
    await closed;
    assert.equal(upstreamConnections, 1);

    const denied = await connect(proxyPort, "api.anthropic.com:443", token);
    assert.equal(denied.statusCode, 403);
    assert.equal(upstreamConnections, 1);

    const missing = await connect(proxyPort, "downloads.claude.ai:443");
    assert.equal(missing.statusCode, 407);
    assert.equal(upstreamConnections, 1);
    assert.deepEqual(events.map((event) => event.reasonCode), ["EGRESS_ALLOWED", "EGRESS_TLS_SNI_MISMATCH", "EGRESS_DEFAULT_DENY", "EGRESS_PROXY_UNAUTHORIZED"]);
    assert.ok(events.every((event) => !("url" in event) && !("query" in event) && !("payload" in event)));
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway service authentication permits only public HTTPS tunnels", async () => {
  const upstream = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const servicePassword = "gateway-proxy-password-with-at-least-32-characters";
  let upstreamConnections = 0;
  const events: Record<string, unknown>[] = [];
  const proxy = createEgressProxy({
    policy: compileEgressSecurityGroup(policy),
    servicePassword,
    resolveHost: async (host) => host === "private.example.com"
      ? [{ address: "fd00::1", family: 6 }]
      : [{ address: "104.18.0.1", family: 4 }],
    connect: () => {
      upstreamConnections += 1;
      return net.connect({ host: "127.0.0.1", port: upstreamPort });
    },
    audit: (event) => events.push(event),
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  try {
    const invalidPassword = await connect(proxyPort, "downloads.claude.ai:443", "not-the-service-password", "litellm-gateway");
    assert.equal(invalidPassword.statusCode, 407);

    const wrongService = await connect(proxyPort, "downloads.claude.ai:443", servicePassword, "lemmacomputer");
    assert.equal(wrongService.statusCode, 407);

    const allowed = await connect(proxyPort, "downloads.claude.ai:443", servicePassword, "litellm-gateway");
    assert.equal(allowed.statusCode, 200);
    const echoed = new Promise<string>((resolve) => allowed.socket!.once("data", (chunk) => resolve(chunk.toString("hex"))));
    const hello = clientHello("downloads.claude.ai");
    allowed.socket!.write(hello);
    assert.equal(await echoed, hello.toString("hex"));
    allowed.socket!.destroy();
    assert.equal(upstreamConnections, 1);

    assert.equal(await requestViaProxy(proxyPort, "http://downloads.claude.ai/", "litellm-gateway", servicePassword), 403);
    assert.equal(upstreamConnections, 1);

    const privateTarget = await connect(proxyPort, "private.example.com:443", servicePassword, "litellm-gateway");
    assert.equal(privateTarget.statusCode, 403);
    assert.equal(upstreamConnections, 1);

    assert.ok(events.every((event) => event.service === "litellm-gateway"));
    assert.ok(events.every((event) => !("workspaceId" in event)));
    assert.ok(events.some((event) => event.reasonCode === "EGRESS_ALLOWED"));
    assert.ok(events.some((event) => event.reasonCode === "EGRESS_UNSUPPORTED_PROTOCOL"));
    assert.ok(events.some((event) => event.reasonCode === "EGRESS_DESTINATION_RESERVED"));
    assert.ok(events.every((event) => !JSON.stringify(event).includes(servicePassword)));
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway service proxy requires a high-entropy password", () => {
  assert.throws(() => createEgressProxy({
    policy: compileEgressSecurityGroup(policy),
    servicePassword: "too-short",
  }), /EGRESS_PROXY_SERVICE_PASSWORD/);

  assert.throws(() => createEgressProxy({
    policy: compileRuntimeEgressPolicy({
      schemaVersion: 2,
      mode: "full-web",
      id: "egv_gateway_full_web",
      securityGroupId: "esg_gateway_full_web",
      version: 1,
      name: "Gateway full web",
      description: "This policy must not become a gateway default.",
      defaultAction: "allow-public-http-https",
      rules: [],
      documentHash: "f".repeat(64),
    }),
    servicePassword: "gateway-proxy-password-with-at-least-32-characters",
  }), /restricted allowlist/);
});

test("gateway dynamic authorization is additive only after public DNS and a static default deny", async () => {
  const upstream = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const servicePassword = "gateway-proxy-password-with-at-least-32-characters";
  const calls: Array<{ phase: string; value?: unknown }> = [];
  const connections: net.NetConnectOpts[] = [];
  const dynamicPolicy = compileEgressSecurityGroup({
    ...policy,
    rules: [
      ...policy.rules,
      {
        id: "explicit-deny",
        action: "deny",
        protocol: "https",
        host: "blocked.example.com",
        includeSubdomains: false,
        port: 443,
        purpose: "Never allow this endpoint",
      },
    ],
  });
  const proxy = createEgressProxy({
    policy: dynamicPolicy,
    servicePassword,
    resolveHost: async (host) => {
      calls.push({ phase: "resolve", value: host });
      if (host === "private.example.com") return [{ address: "fd00::1", family: 6 }];
      if (host === "dns-unavailable.example.com") throw new Error("unavailable");
      return [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }];
    },
    dynamicDestinationAuthorizer: async (destination) => {
      calls.push({ phase: "authorize", value: destination });
      if (destination.host === "authorizer-error.example.com") throw new Error("control unavailable");
      return destination.host === "connector.example.com" && destination.protocol === "https" && destination.port === 443;
    },
    connect: (options) => {
      connections.push(options);
      return net.connect({ host: "127.0.0.1", port: upstreamPort });
    },
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  try {
    const dynamicallyAllowed = await connect(proxyPort, "connector.example.com:443", servicePassword, "litellm-gateway");
    assert.equal(dynamicallyAllowed.statusCode, 200);
    const echoed = new Promise<string>((resolve) => dynamicallyAllowed.socket!.once("data", (chunk) => resolve(chunk.toString("hex"))));
    const hello = clientHello("connector.example.com");
    dynamicallyAllowed.socket!.write(hello);
    assert.equal(await echoed, hello.toString("hex"));
    dynamicallyAllowed.socket!.destroy();
    assert.deepEqual(calls.slice(0, 2), [
      { phase: "resolve", value: "connector.example.com" },
      { phase: "authorize", value: { protocol: "https", host: "connector.example.com", port: 443 } },
    ]);
    assert.equal(connections.length, 1);
    assert.equal(connections[0]!.host, "93.184.216.34");

    assert.equal((await connect(proxyPort, "blocked.example.com:443", servicePassword, "litellm-gateway")).statusCode, 403);
    assert.equal((await connect(proxyPort, "private.example.com:443", servicePassword, "litellm-gateway")).statusCode, 403);
    assert.equal((await connect(proxyPort, "dns-unavailable.example.com:443", servicePassword, "litellm-gateway")).statusCode, 403);
    assert.equal((await connect(proxyPort, "127.0.0.1:443", servicePassword, "litellm-gateway")).statusCode, 403);
    assert.equal((await connect(proxyPort, "authorizer-error.example.com:443", servicePassword, "litellm-gateway")).statusCode, 403);

    const authorizationCalls = calls.filter((call) => call.phase === "authorize");
    assert.deepEqual(authorizationCalls, [
      { phase: "authorize", value: { protocol: "https", host: "connector.example.com", port: 443 } },
      { phase: "authorize", value: { protocol: "https", host: "authorizer-error.example.com", port: 443 } },
    ]);
    assert.equal(connections.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("HTTP dynamic authorization sends only an exact destination tuple and fails closed", async () => {
  const token = "control-to-egress-token-with-at-least-32-characters";
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const authorizer = createHttpDynamicDestinationAuthorizer(
    "http://control-api:8080/v1/internal/mcp-egress/authorize",
    token,
    async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ allowed: true }) };
    },
  );
  assert.equal(await authorizer({ protocol: "https", host: "connector.example.com", port: 443 }), true);
  assert.deepEqual(requests, [{
    url: "http://control-api:8080/v1/internal/mcp-egress/authorize",
    init: {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocol: "https", host: "connector.example.com", port: 443 }),
      signal: requests[0]!.init.signal,
    },
  }]);

  const extraField = createHttpDynamicDestinationAuthorizer(
    "http://control-api:8080/v1/internal/mcp-egress/authorize",
    token,
    async () => ({ ok: true, json: async () => ({ allowed: true, unexpected: true }) }),
  );
  assert.equal(await extraField({ protocol: "https", host: "connector.example.com", port: 443 }), false);
  const failing = createHttpDynamicDestinationAuthorizer(
    "http://control-api:8080/v1/internal/mcp-egress/authorize",
    token,
    async () => { throw new Error("control unavailable"); },
  );
  assert.equal(await failing({ protocol: "https", host: "connector.example.com", port: 443 }), false);
  assert.equal(await authorizer({ protocol: "https", host: "Connector.Example.com", port: 443 }), false);
  assert.throws(
    () => createHttpDynamicDestinationAuthorizer("http://control-api:8080/v1/internal/mcp-egress/authorize?bad=true", token),
    /without credentials, query, or fragment/,
  );
});

test("a stalled gateway dynamic authorizer fails closed", async () => {
  const proxy = createEgressProxy({
    policy: compileEgressSecurityGroup(policy),
    servicePassword: "gateway-proxy-password-with-at-least-32-characters",
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    dynamicDestinationAuthorizer: async () => new Promise<boolean>(() => {}),
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  try {
    assert.equal(
      (await connect(proxyPort, "stalled-authorizer.example.com:443", "gateway-proxy-password-with-at-least-32-characters", "litellm-gateway")).statusCode,
      403,
    );
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
});
