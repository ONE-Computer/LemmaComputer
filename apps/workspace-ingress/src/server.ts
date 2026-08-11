import http, { type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import {
  WorkspaceIngressAuthority,
  workspaceIngressAccessParameter,
  workspaceIngressSessionCookie,
  type WorkspaceIngressClaims,
} from "@lemmacomputer/workspace-ingress-auth";
import { z } from "zod";

type Protocol = "http" | "https";

export type WorkspaceIngressConfig = {
  authority: WorkspaceIngressAuthority;
  publicUrl: string;
  litellmPublicUrl?: string;
  webUpstream: string;
  microsoft365AuthorizationUpstream?: string;
  litellmOAuthUpstream?: string;
  requestTimeoutMs?: number;
  agentChatRequestTimeoutMs?: number;
  verifyWorkspaceTls?: boolean;
  authorizeWorkspaceAccess: (claims: WorkspaceIngressClaims) => Promise<boolean>;
  accessHeartbeatMs?: number;
  audit?: (event: Record<string, unknown>) => void;
};

const workspacePathPattern = /^\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/.*)?$/i;
const agentChatTurnPathPattern = /^\/api\/v1\/workspaces\/[^/]+\/chat\/agents\/[^/]+\/sessions\/[^/]+\/messages\/?$/;
const defaultAgentChatRequestTimeoutMs = 16 * 60_000;
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
    if (options.workspace && ["authorization", "cookie", "x-lemmacomputer-proxy-token", "x-controller-token"].includes(name)) continue;
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

const requestTimeout = (
  request: IncomingMessage,
  ordinaryTimeoutMs: number,
  agentChatTimeoutMs: number,
) => request.method === "POST"
  && agentChatTurnPathPattern.test(new URL(request.url ?? "/", "http://workspace-ingress.invalid").pathname)
  ? agentChatTimeoutMs
  : ordinaryTimeoutMs;

const proxyRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  path: string,
  timeoutMs: number,
  workspace: boolean,
  verifyWorkspaceTls: boolean,
  audit: (event: Record<string, unknown>) => void,
  failure?: { code: string; message: string },
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
    response.end(JSON.stringify({
      error: failure ?? { code: "WORKSPACE_UPSTREAM_UNAVAILABLE", message: "The workspace is unavailable" },
    }));
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
  claims?: WorkspaceIngressClaims,
  authorizeWorkspaceAccess?: (claims: WorkspaceIngressClaims) => Promise<boolean>,
  heartbeatMs = 1_000,
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
    if (claims && authorizeWorkspaceAccess) {
      const heartbeat = setInterval(() => {
        void authorizeWorkspaceAccess(claims).then((allowed) => {
          if (!allowed) {
            audit({ event: "workspace_ingress_access_revoked", transport: "websocket", workspaceId: claims.workspaceId });
            socket.destroy();
            upstreamSocket.destroy();
          }
        }).catch(() => {
          socket.destroy();
          upstreamSocket.destroy();
        });
      }, heartbeatMs);
      heartbeat.unref();
      const clear = () => clearInterval(heartbeat);
      socket.once("close", clear);
      upstreamSocket.once("close", clear);
    }
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

const publicOAuthRoute = (
  request: IncomingMessage,
  microsoft365AuthorizationUpstream: URL | null,
  litellmOAuthUpstream: URL | null,
  litellmPublicAuthority: string | null,
  litellmCallbackPath: string,
) => {
  const url = new URL(request.url ?? "/", "http://workspace-ingress.invalid");
  if (url.pathname === "/m365/authorize" && microsoft365AuthorizationUpstream) {
    return {
      upstream: microsoft365AuthorizationUpstream,
      upstreamPath: `/authorize${url.search}`,
    };
  }
  if (
    url.pathname === litellmCallbackPath
    && litellmOAuthUpstream
    && (!litellmPublicAuthority || request.headers.host?.toLowerCase() === litellmPublicAuthority)
  ) {
    return {
      upstream: litellmOAuthUpstream,
      upstreamPath: `/callback${url.search}`,
    };
  }
  return null;
};

const sessionCookie = (token: string, workspaceId: string, maxAge: number, secure: boolean) => [
  `${workspaceIngressSessionCookie}=${encodeURIComponent(token)}`,
  `Path=/workspaces/${workspaceId}/`,
  `Max-Age=${maxAge}`,
  "HttpOnly",
  "SameSite=Lax",
  ...(secure ? ["Secure"] : []),
].join("; ");

export const createHttpWorkspaceAccessAuthorizer = (
  controlUrl: string,
  token: string,
  request: typeof fetch = globalThis.fetch,
) => {
  const endpoint = new URL("/internal/v1/workspace-access/authorize", controlUrl);
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || token.length < 24) {
    throw new Error("Workspace access authorizer configuration is invalid");
  }
  return async (claims: WorkspaceIngressClaims) => {
    const response = await request(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-lemmacomputer-mcp-policy-token": token,
      },
      body: JSON.stringify({
        tenantId: claims.tenantId,
        subjectId: claims.subjectId,
        workspaceId: claims.workspaceId,
        accessGeneration: claims.accessGeneration,
      }),
      signal: AbortSignal.timeout(900),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = await response.json() as { allowed?: unknown };
    return body.allowed === true;
  };
};

export function createWorkspaceIngress(config: WorkspaceIngressConfig) {
  const publicUrl = new URL(config.publicUrl);
  const litellmPublicUrl = config.litellmPublicUrl ? new URL(config.litellmPublicUrl) : null;
  const litellmPublicAuthority = litellmPublicUrl?.host.toLowerCase() ?? null;
  const litellmPublicPath = litellmPublicUrl?.pathname.replace(/\/$/, "") || "";
  const litellmCallbackPath = `${litellmPublicPath}/callback`;
  const webUpstream = new URL(config.webUpstream);
  const microsoft365AuthorizationUpstream = config.microsoft365AuthorizationUpstream
    ? new URL(config.microsoft365AuthorizationUpstream)
    : null;
  const litellmOAuthUpstream = config.litellmOAuthUpstream
    ? new URL(config.litellmOAuthUpstream)
    : null;
  const timeoutMs = config.requestTimeoutMs ?? 30_000;
  const agentChatTimeoutMs = config.agentChatRequestTimeoutMs ?? defaultAgentChatRequestTimeoutMs;
  const verifyWorkspaceTls = config.verifyWorkspaceTls ?? true;
  const audit = config.audit ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  const accessHeartbeatMs = config.accessHeartbeatMs ?? 1_000;
  const authorizeWorkspaceAccess = async (claims: WorkspaceIngressClaims) => {
    try {
      return await config.authorizeWorkspaceAccess(claims);
    } catch {
      audit({ event: "workspace_ingress_access_authorizer_unavailable", workspaceId: claims.workspaceId });
      return false;
    }
  };

  const server = http.createServer(async (request, response) => {
    if (request.url === "/__lemmacomputer/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    const oauthRoute = publicOAuthRoute(
      request,
      microsoft365AuthorizationUpstream,
      litellmOAuthUpstream,
      litellmPublicAuthority,
      litellmCallbackPath,
    );
    if (oauthRoute) {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET", "cache-control": "no-store" });
        response.end();
        return;
      }
      proxyRequest(
        request,
        response,
        oauthRoute.upstream,
        oauthRoute.upstreamPath,
        timeoutMs,
        false,
        true,
        audit,
        { code: "OAUTH_UPSTREAM_UNAVAILABLE", message: "The Microsoft 365 connection service is unavailable" },
      );
      return;
    }
    const requestPath = new URL(request.url ?? "/", "http://workspace-ingress.invalid").pathname;
    const inLiteLlmPublicPath = litellmPublicPath
      ? requestPath === litellmPublicPath || requestPath.startsWith(`${litellmPublicPath}/`)
      : requestPath === "/callback";
    if (litellmPublicAuthority && inLiteLlmPublicPath) {
      response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { code: "OAUTH_ROUTE_NOT_FOUND", message: "The OAuth callback route was not found" } }));
      return;
    }
    const route = workspaceRoute(request);
    if (!route) {
      proxyRequest(
        request,
        response,
        webUpstream,
        request.url ?? "/",
        requestTimeout(request, timeoutMs, agentChatTimeoutMs),
        false,
        true,
        audit,
      );
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
      if (!await authorizeWorkspaceAccess(exchanged.claims)) {
        response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: "WORKSPACE_ACCESS_REVOKED", message: "Workspace access is no longer active" } }));
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
    if (!await authorizeWorkspaceAccess(claims)) {
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { code: "WORKSPACE_ACCESS_REVOKED", message: "Workspace access is no longer active" } }));
      return;
    }
    proxyRequest(request, response, upstreamFor(claims), route.upstreamPath, timeoutMs, true, verifyWorkspaceTls, audit);
  });

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
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
    if (!await authorizeWorkspaceAccess(claims)) {
      writeSocketResponse(socket, 403, "Forbidden");
      return;
    }
    proxyUpgrade(request, socket, head, upstreamFor(claims), route.upstreamPath, timeoutMs, true, verifyWorkspaceTls, audit, claims, authorizeWorkspaceAccess, accessHeartbeatMs);
    })().catch(() => writeSocketResponse(socket, 403, "Forbidden"));
  });

  return server;
}

const envSchema = z.object({
  WORKSPACE_INGRESS_HOST: z.string().default("127.0.0.1"),
  WORKSPACE_INGRESS_PORT: z.coerce.number().int().positive().default(4174),
  WORKSPACE_INGRESS_PUBLIC_URL: z.string().url().default("http://localhost:4174"),
  WORKSPACE_INGRESS_LITELLM_PUBLIC_URL: z.string().url().optional(),
  WORKSPACE_INGRESS_WEB_UPSTREAM: z.string().url().default("http://127.0.0.1:4173"),
  WORKSPACE_INGRESS_CONTROL_URL: z.string().url(),
  WORKSPACE_INGRESS_CONTROL_TOKEN: z.string().min(24),
  WORKSPACE_INGRESS_MICROSOFT365_AUTHORIZATION_UPSTREAM: z.string().url().optional(),
  WORKSPACE_INGRESS_LITELLM_OAUTH_UPSTREAM: z.string().url().optional(),
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
    litellmPublicUrl: env.WORKSPACE_INGRESS_LITELLM_PUBLIC_URL,
    webUpstream: env.WORKSPACE_INGRESS_WEB_UPSTREAM,
    microsoft365AuthorizationUpstream: env.WORKSPACE_INGRESS_MICROSOFT365_AUTHORIZATION_UPSTREAM,
    litellmOAuthUpstream: env.WORKSPACE_INGRESS_LITELLM_OAUTH_UPSTREAM,
    verifyWorkspaceTls: env.WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS,
    authorizeWorkspaceAccess: createHttpWorkspaceAccessAuthorizer(
      env.WORKSPACE_INGRESS_CONTROL_URL,
      env.WORKSPACE_INGRESS_CONTROL_TOKEN,
    ),
  });
  server.listen(env.WORKSPACE_INGRESS_PORT, env.WORKSPACE_INGRESS_HOST);
}
