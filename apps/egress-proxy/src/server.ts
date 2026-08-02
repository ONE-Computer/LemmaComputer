import { lookup } from "node:dns/promises";
import { createHash, timingSafeEqual } from "node:crypto";
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

type ProxySharedConfig = {
  policy: ReturnType<typeof compileRuntimeEgressPolicy>;
  resolveHost?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  connect?: (options: net.NetConnectOpts) => net.Socket;
  audit?: (event: Record<string, unknown>) => void;
};

/**
 * The only data a dynamic authorizer receives. In particular, a CONNECT
 * target's path, query, credentials, and resolved address are never sent to
 * the authorizer.
 */
export type DynamicDestinationAuthorizationRequest = Readonly<{
  protocol: "http" | "https";
  host: string;
  port: number;
}>;

/**
 * A gateway-only, additive authorization check for destinations which miss a
 * restricted static allowlist. It cannot override a static deny or a failed
 * host/DNS/reserved-address check.
 */
export type DynamicDestinationAuthorizer = (
  destination: DynamicDestinationAuthorizationRequest,
) => Promise<boolean>;

export type WorkspaceProxyConfig = ProxySharedConfig & {
  verificationSecret: string;
  expectedGrant: Pick<EgressProxyGrantClaims, "tenantId" | "subjectId" | "workspaceId" | "agentId" | "securityGroupVersionId" | "egressMode" | "policyHash">;
};

/**
 * A fixed service credential for the gateway-owned proxy. This mode is
 * deliberately distinct from workspace grants: LiteLLM has no workspace user
 * identity to put in a grant, and may only tunnel HTTPS through this proxy.
 */
export type GatewayServiceProxyConfig = ProxySharedConfig & {
  servicePassword: string;
  dynamicDestinationAuthorizer?: DynamicDestinationAuthorizer;
  /** Bound the lifetime of a gateway tunnel so a later permit expiry or
   * connector disable cannot leave an unbounded pre-existing connection. */
  maxTunnelLifetimeMs?: number;
  idleTunnelTimeoutMs?: number;
};

export type ProxyConfig = WorkspaceProxyConfig | GatewayServiceProxyConfig;

const gatewayServiceId = "litellm-gateway";
const dynamicAuthorizationTimeoutMs = 2_000;
const dynamicAuthorizationRuleId = "dynamic-destination-authorization";
const defaultGatewayTunnelLifetimeMs = 5 * 60 * 1_000;
const defaultGatewayIdleTunnelTimeoutMs = 60 * 1_000;

const denyResponse = (response: http.ServerResponse, statusCode: number, reasonCode: string) => {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(statusCode === 407 ? { "proxy-authenticate": 'Basic realm="ONEComputer egress"' } : {}),
  });
  response.end(JSON.stringify({ error: { code: reasonCode, message: "The egress firewall denied this connection" } }));
};

const proxyCredentials = (header: string | undefined) => {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0
      ? { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
      : null;
  } catch {
    return null;
  }
};

const isGatewayServiceProxy = (config: ProxyConfig): config is GatewayServiceProxyConfig => "servicePassword" in config;

const passwordsMatch = (actual: string, expected: string) => timingSafeEqual(
  createHash("sha256").update(actual).digest(),
  createHash("sha256").update(expected).digest(),
);

const authorize = (header: string | undefined, config: ProxyConfig) => {
  const credentials = proxyCredentials(header);
  if (!credentials) return null;
  if (isGatewayServiceProxy(config)) {
    return credentials.username === gatewayServiceId && passwordsMatch(credentials.password, config.servicePassword)
      ? { service: gatewayServiceId }
      : null;
  }
  const { tenantId, subjectId, workspaceId, agentId } = config.expectedGrant;
  return verifyEgressProxyGrant(credentials.password, config.verificationSecret, {
    tenantId,
    subjectId,
    workspaceId,
    agentId,
  });
};

const dynamicallyAuthorizeDestination = async (
  config: ProxyConfig,
  protocol: "http" | "https",
  host: string,
  port: number,
) => {
  if (
    !isGatewayServiceProxy(config)
    || !config.dynamicDestinationAuthorizer
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
  ) return false;
  let normalizedHost: string;
  try {
    normalizedHost = normalizeEgressHost(host);
  } catch {
    return false;
  }

  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), dynamicAuthorizationTimeoutMs);
  });
  const authorizer = Promise.resolve()
    .then(() => config.dynamicDestinationAuthorizer!({ protocol, host: normalizedHost, port }))
    .then((allowed) => allowed === true, () => false);
  try {
    return await Promise.race([authorizer, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
  const decision = decideEgress(config.policy, {
    protocol,
    host,
    port,
    resolvedAddresses: addresses.map((item) => item.address),
  });
  if (
    decision.decision === "deny"
    && decision.reasonCode === "EGRESS_DEFAULT_DENY"
    && addresses.length > 0
    && await dynamicallyAuthorizeDestination(config, protocol, host, port)
  ) {
    return {
      decision: { decision: "allow" as const, reasonCode: "EGRESS_ALLOWED" as const, ruleId: dynamicAuthorizationRuleId },
      addresses,
    };
  }
  return {
    decision,
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
    ...(isGatewayServiceProxy(config)
      ? { service: gatewayServiceId }
      : {
        workspaceId: config.expectedGrant.workspaceId,
        agentId: config.expectedGrant.agentId,
        egressMode: config.expectedGrant.egressMode,
        policyHash: config.expectedGrant.policyHash,
        securityGroupVersionId: config.expectedGrant.securityGroupVersionId,
      }),
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

type DynamicAuthorizationFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

const isExactlyAllowedResponse = (value: unknown): value is { allowed: true } => (
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
  && Object.keys(value).length === 1
  && (value as Record<string, unknown>).allowed === true
);

/**
 * Builds the optional, internal Control authorization call used by the gateway
 * proxy. The configured URL is fixed at startup; only the normalized
 * protocol/host/port tuple is sent for a requested destination.
 */
export function createHttpDynamicDestinationAuthorizer(
  authorizationUrl: string,
  authorizationToken: string,
  fetcher: DynamicAuthorizationFetcher = (url, init) => fetch(url, init),
): DynamicDestinationAuthorizer {
  let endpoint: URL;
  try {
    endpoint = new URL(authorizationUrl);
  } catch {
    throw new Error("EGRESS_DYNAMIC_AUTHORIZATION_URL must be an absolute HTTP(S) URL");
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || !endpoint.hostname
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error("EGRESS_DYNAMIC_AUTHORIZATION_URL must be an absolute HTTP(S) URL without credentials, query, or fragment");
  }
  if (authorizationToken.length < 32) {
    throw new Error("EGRESS_DYNAMIC_AUTHORIZATION_TOKEN must be at least 32 characters");
  }
  const endpointUrl = endpoint.toString();

  return async (destination) => {
    let normalizedHost: string;
    try {
      normalizedHost = normalizeEgressHost(destination.host);
    } catch {
      return false;
    }
    if (
      normalizedHost !== destination.host
      || (destination.protocol !== "http" && destination.protocol !== "https")
      || !Number.isInteger(destination.port)
      || destination.port < 1
      || destination.port > 65_535
    ) return false;
    try {
      const response = await fetcher(endpointUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${authorizationToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: destination.protocol,
          host: destination.host,
          port: destination.port,
        }),
        signal: AbortSignal.timeout(dynamicAuthorizationTimeoutMs),
      });
      if (!response.ok) return false;
      return isExactlyAllowedResponse(await response.json());
    } catch {
      return false;
    }
  };
}

export function createEgressProxy(config: ProxyConfig) {
  if (isGatewayServiceProxy(config) && config.servicePassword.length < 32) {
    throw new Error("EGRESS_PROXY_SERVICE_PASSWORD must be at least 32 characters");
  }
  if (isGatewayServiceProxy(config) && config.policy.mode === "full-web") {
    throw new Error("Gateway egress requires a restricted allowlist policy");
  }
  if (
    isGatewayServiceProxy(config)
    && (!Number.isInteger(config.maxTunnelLifetimeMs ?? defaultGatewayTunnelLifetimeMs)
      || (config.maxTunnelLifetimeMs ?? defaultGatewayTunnelLifetimeMs) < 1_000
      || !Number.isInteger(config.idleTunnelTimeoutMs ?? defaultGatewayIdleTunnelTimeoutMs)
      || (config.idleTunnelTimeoutMs ?? defaultGatewayIdleTunnelTimeoutMs) < 1_000)
  ) {
    throw new Error("Gateway tunnel limits must be whole milliseconds of at least one second");
  }
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
    if (isGatewayServiceProxy(config)) {
      audit(config, "EGRESS_UNSUPPORTED_PROTOCOL", undefined, {
        protocol: "http",
        host: target.hostname,
        port: Number(target.port || 80),
      });
      denyResponse(response, 403, "EGRESS_UNSUPPORTED_PROTOCOL");
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
    // Node's HTTP typings expose CONNECT peers as a generic Duplex even
    // though the server supplies a net.Socket. Keep the socket type here for
    // the gateway-only idle timeout without broadening the proxy interface.
    const clientSocket = client as net.Socket;
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
      let closed = false;
      let maxLifetime: NodeJS.Timeout | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        if (maxLifetime) clearTimeout(maxLifetime);
        clientSocket.setTimeout(0);
        client.destroy();
        upstream.destroy();
      };
      if (isGatewayServiceProxy(config)) {
        maxLifetime = setTimeout(close, config.maxTunnelLifetimeMs ?? defaultGatewayTunnelLifetimeMs);
      }
      if (isGatewayServiceProxy(config)) {
        clientSocket.setTimeout(config.idleTunnelTimeoutMs ?? defaultGatewayIdleTunnelTimeoutMs);
        client.once("timeout", close);
      }
      upstream.once("connect", () => {
        upstream.write(hello);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", close);
      client.on("error", close);
      upstream.once("close", close);
      client.once("close", close);
    };
    inspectHello();
  });
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const policy = runtimeEgressPolicySchema.parse(JSON.parse(process.env.EGRESS_POLICY_JSON ?? ""));
  const port = Number(process.env.EGRESS_PROXY_PORT ?? 3128);
  const servicePassword = process.env.EGRESS_PROXY_SERVICE_PASSWORD;
  const dynamicAuthorizationUrl = process.env.EGRESS_DYNAMIC_AUTHORIZATION_URL;
  const dynamicAuthorizationToken = process.env.EGRESS_DYNAMIC_AUTHORIZATION_TOKEN;
  if (Boolean(dynamicAuthorizationUrl) !== Boolean(dynamicAuthorizationToken)) {
    throw new Error("EGRESS_DYNAMIC_AUTHORIZATION_URL and EGRESS_DYNAMIC_AUTHORIZATION_TOKEN must be configured together");
  }
  let config: ProxyConfig;
  if (servicePassword) {
    config = {
      policy: compileRuntimeEgressPolicy(policy),
      servicePassword,
      ...(dynamicAuthorizationUrl && dynamicAuthorizationToken
        ? { dynamicDestinationAuthorizer: createHttpDynamicDestinationAuthorizer(dynamicAuthorizationUrl, dynamicAuthorizationToken) }
        : {}),
    };
  } else {
    if (dynamicAuthorizationUrl || dynamicAuthorizationToken) {
      throw new Error("Dynamic destination authorization is available only with EGRESS_PROXY_SERVICE_PASSWORD");
    }
    const verificationSecret = process.env.EGRESS_GRANT_SECRET;
    if (!verificationSecret || verificationSecret.length < 32) throw new Error("EGRESS_GRANT_SECRET is required");
    config = {
      policy: compileRuntimeEgressPolicy(policy),
      verificationSecret,
      expectedGrant: JSON.parse(process.env.EGRESS_EXPECTED_GRANT_JSON ?? "") as WorkspaceProxyConfig["expectedGrant"],
    };
  }
  createEgressProxy(config)
    .listen(port, "0.0.0.0");
}
