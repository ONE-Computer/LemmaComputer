import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { egressSecurityGroupVersionSchema } from "@onecomputer/contracts";
import { compileEgressSecurityGroup, deriveEgressProxySecret, issueEgressProxyGrant } from "@onecomputer/egress-policy";
import { createEgressProxy } from "../apps/egress-proxy/src/server.js";

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
  agentId: "agent-alex",
  securityGroupVersionId: policy.id,
  egressMode: "restricted" as const,
  policyHash: "d".repeat(64),
};

const connect = (port: number, path: string, token?: string) => new Promise<{ statusCode: number; socket?: net.Socket }>((resolve, reject) => {
  const request = http.request({
    host: "127.0.0.1",
    port,
    method: "CONNECT",
    path,
    headers: token ? { "proxy-authorization": `Basic ${Buffer.from(`onecomputer:${token}`).toString("base64")}` } : {},
  });
  request.on("connect", (response, socket) => resolve({ statusCode: response.statusCode ?? 0, socket }));
  request.on("response", (response) => resolve({ statusCode: response.statusCode ?? 0 }));
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
  const events: Record<string, unknown>[] = [];
  const proxy = createEgressProxy({
    policy: compileEgressSecurityGroup(policy),
    verificationSecret: secret,
    expectedGrant,
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
    allowed.socket!.destroy();
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
