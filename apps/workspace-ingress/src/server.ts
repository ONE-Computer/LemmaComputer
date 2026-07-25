import http, { type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import {
  WorkspaceIngressAuthority,
  workspaceIngressAccessParameter,
  workspaceIngressSessionCookie,
  type WorkspaceIngressClaims,
} from "@onecomputer/workspace-ingress-auth";
import { z } from "zod";

type Protocol = "http" | "https";

export type WorkspaceIngressConfig = {
  authority: WorkspaceIngressAuthority;
  publicUrl: string;
  webUpstream: string;
  requestTimeoutMs?: number;
  verifyWorkspaceTls?: boolean;
  audit?: (event: Record<string, unknown>) => void;
};

const workspacePathPattern = /^\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/.*)?$/i;
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const canonicalWebSocketHeaders = new Map([
  ["origin", "Origin"],
  ["sec-websocket-extensions", "Sec-WebSocket-Extensions"],
  ["sec-websocket-key", "Sec-WebSocket-Key"],
  ["sec-websocket-protocol", "Sec-WebSocket-Protocol"],
  ["sec-websocket-version", "Sec-WebSocket-Version"],
]);

const parseCookies = (header: string | undefined) => Object.fromEntries(
  (header ?? "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      return [[name, decodeURIComponent(value)]];
    } catch {
      return [];
    }
  }),
);

const sanitizedHeaders = (
  headers: IncomingHttpHeaders,
  target: URL,
  options: { workspace: boolean; websocket?: boolean },
) => {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (hopByHopHeaders.has(name) || name === "host") continue;
    if (options.workspace && ["authorization", "cookie", "x-onecomputer-proxy-token", "x-controller-token"].includes(name)) continue;
    if (options.workspace && name === "origin") continue;
    result[options.websocket ? canonicalWebSocketHeaders.get(name) ?? name : name] = value;
  }
  // KasmVNC's WebSocket handshake parser requires conventional field-name
  // casing even though HTTP field names are otherwise case-insensitive.
  result.Host = target.host;
  if (options.workspace && typeof headers.origin === "string") result.Origin = `${target.protocol}//${target.host}`;
  if (options.websocket) {
    result.Connection = "Upgrade";
    result.Upgrade = "websocket";
  }
  return result;
};

const requestOptions = (
  request: IncomingMessage,
  target: URL,
  path: string,
  options: { workspace: boolean; websocket?: boolean; verifyWorkspaceTls: boolean },
): RequestOptions => ({
  protocol: target.protocol,
  hostname: target.hostname,
  port: target.port,
  method: request.method,
  path,
  headers: sanitizedHeaders(request.headers, target, options),
  ...(target.protocol === "https:" ? {
    rejectUnauthorized: options.workspace ? options.verifyWorkspaceTls : true,
  } : {}),
});

const proxyRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  path: string,
  timeoutMs: number,
  workspace: boolean,
  verifyWorkspaceTls: boolean,
  audit: (event: Record<string, unknown>) => void,
) => {
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(requestOptions(request, target, path, { workspace, verifyWorkspaceTls }), (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    delete headers.connection;
    delete headers["keep-alive"];
    delete headers["transfer-encoding"];
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    audit({ event: "workspace_ingress_upstream_error", transport: "http", workspace });
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    }
    response.end(JSON.stringify({ error: { code: "WORKSPACE_UPSTREAM_UNAVAILABLE", message: "The workspace is unavailable" } }));
  });
  request.pipe(upstream);
};

const writeSocketResponse = (socket: Duplex, statusCode: number, message: string) => {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${statusCode} ${message}\r\n`
      + "Connection: close\r\n"
      + "Cache-Control: no-store\r\n"
      + "Content-Length: 0\r\n\r\n",
    );
  }
};

const proxyUpgrade = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: URL,
  path: string,
  timeoutMs: number,
  workspace: boolean,
  verifyWorkspaceTls: boolean,
  audit: (event: Record<string, unknown>) => void,
) => {
  const transport = target.protocol === "https:" ? https : http;
  const upstreamRequest = transport.request(requestOptions(request, target, path, { workspace, websocket: true, verifyWorkspaceTls }));
  upstreamRequest.setTimeout(timeoutMs, () => upstreamRequest.destroy(new Error("upstream timeout")));
  upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n`;
    const headers = upstreamResponse.rawHeaders
      .reduce<string[]>((lines, value, index, values) => index % 2 === 0 ? [...lines, `${value}: ${values[index + 1]}`] : lines, [])
      .join("\r\n");
    socket.write(`${statusLine}${headers}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstreamRequest.on("response", (upstreamResponse) => {
    writeSocketResponse(socket, upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage ?? "Bad Gateway");
    upstreamResponse.resume();
  });
  upstreamRequest.on("error", () => {
    audit({ event: "workspace_ingress_upstream_error", transport: "websocket", workspace });
    writeSocketResponse(socket, 502, "Bad Gateway");
  });
  upstreamRequest.end();
};

const upstreamFor = (claims: WorkspaceIngressClaims) => new URL(`${claims.protocol}://${claims.host}:${claims.port}`);

const workspaceRoute = (request: IncomingMessage) => {
  const url = new URL(request.url ?? "/", "http://workspace-ingress.invalid");
  const match = url.pathname.match(workspacePathPattern);
  if (!match) return null;
  return {
    workspaceId: match[1]!,
    upstreamPath: `${match[2] || "/"}${url.search}`,
    url,
  };
};

const sessionCookie = (token: string, workspaceId: string, maxAge: number, secure: boolean) => [
  `${workspaceIngressSessionCookie}=${encodeURIComponent(token)}`,
  `Path=/workspaces/${workspaceId}/`,
  `Max-Age=${maxAge}`,
  "HttpOnly",
  "SameSite=Lax",
  ...(secure ? ["Secure"] : []),
].join("; ");

export function createWorkspaceIngress(config: WorkspaceIngressConfig) {
  const publicUrl = new URL(config.publicUrl);
  const webUpstream = new URL(config.webUpstream);
  const timeoutMs = config.requestTimeoutMs ?? 30_000;
  const verifyWorkspaceTls = config.verifyWorkspaceTls ?? true;
  const audit = config.audit ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`));

  const server = http.createServer((request, response) => {
    if (request.url === "/__onecomputer/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    const route = workspaceRoute(request);
    if (!route) {
      proxyRequest(request, response, webUpstream, request.url ?? "/", timeoutMs, false, true, audit);
      return;
    }
    const accessToken = route.url.searchParams.get(workspaceIngressAccessParameter);
    if (accessToken) {
      const exchanged = config.authority.exchangeLaunch(accessToken, route.workspaceId);
      if (!exchanged) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: "WORKSPACE_LAUNCH_INVALID", message: "The workspace launch link is invalid or expired" } }));
        return;
      }
      route.url.searchParams.delete(workspaceIngressAccessParameter);
      const maxAge = Math.max(1, exchanged.claims.expiresAt - Math.floor(Date.now() / 1000));
      response.writeHead(303, {
        location: `${route.url.pathname}${route.url.search}`,
        "set-cookie": sessionCookie(exchanged.token, route.workspaceId, maxAge, publicUrl.protocol === "https:"),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      response.end();
      audit({ event: "workspace_ingress_session_issued", workspaceId: route.workspaceId, expiresAt: exchanged.expiresAt });
      return;
    }
    const sessionToken = parseCookies(request.headers.cookie)[workspaceIngressSessionCookie];
    const claims = sessionToken ? config.authority.verifySession(sessionToken, route.workspaceId) : null;
    if (!claims) {
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { code: "WORKSPACE_SESSION_REQUIRED", message: "Open the workspace again to start a session" } }));
      return;
    }
    proxyRequest(request, response, upstreamFor(claims), route.upstreamPath, timeoutMs, true, verifyWorkspaceTls, audit);
  });

  server.on("upgrade", (request, socket, head) => {
    const route = workspaceRoute(request);
    if (!route) {
      proxyUpgrade(request, socket, head, webUpstream, request.url ?? "/", timeoutMs, false, true, audit);
      return;
    }
    const sessionToken = parseCookies(request.headers.cookie)[workspaceIngressSessionCookie];
    const claims = sessionToken ? config.authority.verifySession(sessionToken, route.workspaceId) : null;
    if (!claims) {
      writeSocketResponse(socket, 401, "Unauthorized");
      return;
    }
    proxyUpgrade(request, socket, head, upstreamFor(claims), route.upstreamPath, timeoutMs, true, verifyWorkspaceTls, audit);
  });

  return server;
}

const envSchema = z.object({
  WORKSPACE_INGRESS_HOST: z.string().default("127.0.0.1"),
  WORKSPACE_INGRESS_PORT: z.coerce.number().int().positive().default(4174),
  WORKSPACE_INGRESS_PUBLIC_URL: z.string().url().default("http://localhost:4174"),
  WORKSPACE_INGRESS_WEB_UPSTREAM: z.string().url().default("http://127.0.0.1:4173"),
  WORKSPACE_INGRESS_SECRET: z.string().min(32),
  WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  WORKSPACE_INGRESS_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
  WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const env = envSchema.parse(process.env);
  const server = createWorkspaceIngress({
    authority: new WorkspaceIngressAuthority(
      env.WORKSPACE_INGRESS_SECRET,
      env.WORKSPACE_INGRESS_LAUNCH_TTL_SECONDS,
      env.WORKSPACE_INGRESS_SESSION_TTL_SECONDS,
    ),
    publicUrl: env.WORKSPACE_INGRESS_PUBLIC_URL,
    webUpstream: env.WORKSPACE_INGRESS_WEB_UPSTREAM,
    verifyWorkspaceTls: env.WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS,
  });
  server.listen(env.WORKSPACE_INGRESS_PORT, env.WORKSPACE_INGRESS_HOST);
}
