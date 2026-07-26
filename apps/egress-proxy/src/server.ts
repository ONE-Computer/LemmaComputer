import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { runtimeEgressPolicySchema } from "@onecomputer/contracts";
import {
  compileRuntimeEgressPolicy,
  decideEgress,
  normalizeEgressHost,
  verifyEgressProxyGrant,
  type EgressProxyGrantClaims,
} from "@onecomputer/egress-policy";

export type ProxyConfig = {
  policy: ReturnType<typeof compileRuntimeEgressPolicy>;
  verificationSecret: string;
  expectedGrant: Pick<EgressProxyGrantClaims, "tenantId" | "subjectId" | "workspaceId" | "agentId" | "securityGroupVersionId" | "egressMode" | "policyHash">;
  resolveHost?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  connect?: (options: net.NetConnectOpts) => net.Socket;
  audit?: (event: Record<string, unknown>) => void;
};

const denyResponse = (response: http.ServerResponse, statusCode: number, reasonCode: string) => {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(statusCode === 407 ? { "proxy-authenticate": 'Basic realm="ONEComputer egress"' } : {}),
  });
  response.end(JSON.stringify({ error: { code: reasonCode, message: "The egress firewall denied this connection" } }));
};

const proxyToken = (header: string | undefined) => {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : null;
  } catch {
    return null;
  }
};

const authorize = (header: string | undefined, config: ProxyConfig) => {
  const token = proxyToken(header);
  return token ? verifyEgressProxyGrant(token, config.verificationSecret, config.expectedGrant) : null;
};

const resolveAndDecide = async (config: ProxyConfig, protocol: "http" | "https", host: string, port: number) => {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = config.resolveHost
      ? await config.resolveHost(host)
      : await lookup(host, { all: true, verbatim: true });
  } catch {
    return { decision: decideEgress(config.policy, { protocol, host, port, resolvedAddresses: [] }), addresses: [] };
  }
  return {
    decision: decideEgress(config.policy, { protocol, host, port, resolvedAddresses: addresses.map((item) => item.address) }),
    addresses,
  };
};

const audit = (
  config: ProxyConfig,
  reasonCode: string,
  ruleId?: string,
  destination?: { protocol: "http" | "https"; host: string; port: number },
) => {
  let normalizedHost: string | undefined;
  if (destination) {
    try { normalizedHost = normalizeEgressHost(destination.host); } catch { normalizedHost = undefined; }
  }
  const event = {
    event: "egress_decision",
    workspaceId: config.expectedGrant.workspaceId,
    agentId: config.expectedGrant.agentId,
    egressMode: config.expectedGrant.egressMode,
    policyHash: config.expectedGrant.policyHash,
    securityGroupVersionId: config.expectedGrant.securityGroupVersionId,
    decision: reasonCode === "EGRESS_ALLOWED" ? "allow" : "deny",
    reasonCode,
    ...(ruleId ? { ruleId } : {}),
    ...(destination ? {
      protocol: destination.protocol,
      ...(normalizedHost ? { host: normalizedHost } : {}),
      port: destination.port,
    } : {}),
  };
  if (config.audit) config.audit(event);
  else process.stdout.write(`${JSON.stringify(event)}\n`);
};

export function readTlsClientHelloSni(input: Buffer): { status: "incomplete" | "invalid" | "found"; host?: string } {
  if (input.length < 5) return { status: "incomplete" };
  if (input[0] !== 0x16) return { status: "invalid" };
  const recordLength = input.readUInt16BE(3);
  if (recordLength > 65_535) return { status: "invalid" };
  if (input.length < 5 + recordLength) return { status: "incomplete" };
  if (input[5] !== 0x01 || input.length < 9) return { status: "invalid" };
  let offset = 9 + 2 + 32;
  if (offset >= input.length) return { status: "invalid" };
  const sessionLength = input[offset]!;
  offset += 1 + sessionLength;
  if (offset + 2 > input.length) return { status: "invalid" };
  const cipherLength = input.readUInt16BE(offset);
  offset += 2 + cipherLength;
  if (offset >= input.length) return { status: "invalid" };
  const compressionLength = input[offset]!;
  offset += 1 + compressionLength;
  if (offset + 2 > input.length) return { status: "invalid" };
  const extensionsLength = input.readUInt16BE(offset);
  offset += 2;
  const extensionsEnd = offset + extensionsLength;
  if (extensionsEnd > 5 + recordLength || extensionsEnd > input.length) return { status: "invalid" };
  while (offset + 4 <= extensionsEnd) {
    const type = input.readUInt16BE(offset);
    const length = input.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > extensionsEnd) return { status: "invalid" };
    if (type === 0) {
      if (length < 5 || offset + 5 > input.length) return { status: "invalid" };
      const listLength = input.readUInt16BE(offset);
      if (listLength + 2 > length || input[offset + 2] !== 0) return { status: "invalid" };
      const nameLength = input.readUInt16BE(offset + 3);
      if (nameLength + 5 > length) return { status: "invalid" };
      return { status: "found", host: input.subarray(offset + 5, offset + 5 + nameLength).toString("utf8") };
    }
    offset += length;
  }
  return { status: "invalid" };
}

export function createEgressProxy(config: ProxyConfig) {
  const server = http.createServer(async (request, response) => {
    if (!authorize(request.headers["proxy-authorization"], config)) {
      audit(config, "EGRESS_PROXY_UNAUTHORIZED");
      denyResponse(response, 407, "EGRESS_PROXY_UNAUTHORIZED");
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      denyResponse(response, 400, "EGRESS_INVALID_TARGET");
      return;
    }
    if (target.protocol !== "http:") {
      denyResponse(response, 403, "EGRESS_UNSUPPORTED_PROTOCOL");
      return;
    }
    const port = Number(target.port || 80);
    const result = await resolveAndDecide(config, "http", target.hostname, port);
    audit(config, result.decision.reasonCode, result.decision.ruleId, { protocol: "http", host: target.hostname, port });
    if (result.decision.decision !== "allow" || !result.addresses[0]) {
      denyResponse(response, 403, result.decision.reasonCode);
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: target.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request({
      host: result.addresses[0].address,
      family: result.addresses[0].family,
      port,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => denyResponse(response, 502, "EGRESS_UPSTREAM_UNAVAILABLE"));
    request.pipe(upstream);
  });

  server.on("connect", async (request, client, head) => {
    if (!authorize(request.headers["proxy-authorization"], config)) {
      audit(config, "EGRESS_PROXY_UNAUTHORIZED");
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nConnection: close\r\n\r\n");
      return;
    }
    let target: URL;
    try {
      target = new URL(`http://${request.url}`);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const port = Number(target.port || 443);
    const result = await resolveAndDecide(config, "https", target.hostname, port);
    if (result.decision.decision !== "allow" || !result.addresses[0]) {
      audit(config, result.decision.reasonCode, result.decision.ruleId, { protocol: "https", host: target.hostname, port });
      client.end(`HTTP/1.1 403 Forbidden\r\nX-OneComputer-Reason: ${result.decision.reasonCode}\r\nConnection: close\r\n\r\n`);
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let hello = head;
    const timeout = setTimeout(() => {
      audit(config, "EGRESS_TLS_SNI_REQUIRED", undefined, { protocol: "https", host: target.hostname, port });
      client.destroy();
    }, 5_000);
    const inspectHello = (chunk?: Buffer) => {
      if (chunk?.length) hello = Buffer.concat([hello, chunk]);
      if (hello.length > 65_540) {
        clearTimeout(timeout);
        audit(config, "EGRESS_TLS_SNI_REQUIRED", undefined, { protocol: "https", host: target.hostname, port });
        client.destroy();
        return;
      }
      const parsed = readTlsClientHelloSni(hello);
      if (parsed.status === "incomplete") {
        client.once("data", inspectHello);
        return;
      }
      clearTimeout(timeout);
      let requestedHost: string;
      try {
        requestedHost = normalizeEgressHost(target.hostname);
      } catch {
        client.destroy();
        return;
      }
      if (parsed.status !== "found" || !parsed.host) {
        audit(config, "EGRESS_TLS_SNI_REQUIRED", undefined, { protocol: "https", host: target.hostname, port });
        client.destroy();
        return;
      }
      let sniHost: string;
      try {
        sniHost = normalizeEgressHost(parsed.host);
      } catch {
        audit(config, "EGRESS_TLS_SNI_MISMATCH", undefined, { protocol: "https", host: target.hostname, port });
        client.destroy();
        return;
      }
      if (sniHost !== requestedHost) {
        audit(config, "EGRESS_TLS_SNI_MISMATCH", undefined, { protocol: "https", host: target.hostname, port });
        client.destroy();
        return;
      }
      audit(config, result.decision.reasonCode, result.decision.ruleId, { protocol: "https", host: target.hostname, port });
      const upstream = (config.connect ?? net.connect)({ host: result.addresses[0]!.address, family: result.addresses[0]!.family, port });
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.once("connect", () => {
        upstream.write(hello);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", close);
      client.on("error", close);
    };
    inspectHello();
  });
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const policy = runtimeEgressPolicySchema.parse(JSON.parse(process.env.EGRESS_POLICY_JSON ?? ""));
  const expectedGrant = JSON.parse(process.env.EGRESS_EXPECTED_GRANT_JSON ?? "") as ProxyConfig["expectedGrant"];
  const verificationSecret = process.env.EGRESS_GRANT_SECRET;
  if (!verificationSecret || verificationSecret.length < 32) throw new Error("EGRESS_GRANT_SECRET is required");
  const port = Number(process.env.EGRESS_PROXY_PORT ?? 3128);
  createEgressProxy({ policy: compileRuntimeEgressPolicy(policy), verificationSecret, expectedGrant })
    .listen(port, "0.0.0.0");
}
