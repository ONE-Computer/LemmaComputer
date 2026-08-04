import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import net from "node:net";
import test from "node:test";
import {
  WorkspaceIngressAuthority,
  workspaceIngressAccessParameter,
  workspaceIngressSessionCookie,
} from "@lemmacomputer/workspace-ingress-auth";
import { createWorkspaceIngress } from "../apps/workspace-ingress/src/server.js";

const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
const secret = "workspace-ingress-server-test-secret-at-least-32-characters";

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
  return address.port;
};

const close = async (server: Server) => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

const requestWithAuthority = async (method: string, url: string, authority: string, cookie?: string) => (
  new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request(url, {
      method,
      headers: {
        host: authority,
        ...(cookie ? { cookie } : {}),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    request.once("error", reject);
    request.end();
  })
);

const getWithAuthority = async (url: string, authority: string, cookie?: string) => (
  requestWithAuthority("GET", url, authority, cookie)
);

test("workspace ingress forwards the web app and exchanges a launch for an isolated workspace session", async () => {
  let workspaceRequest: { url?: string; authorization?: string; cookie?: string } | undefined;
  let workspaceUpgradeRawHeaders: string[] | undefined;
  const web = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("web");
  });
  const workspace = http.createServer((request, response) => {
    workspaceRequest = {
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    };
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("workspace");
  });
  const webPort = await listen(web);
  const workspacePort = await listen(workspace);
  const authority = new WorkspaceIngressAuthority(secret);
  const ingress = createWorkspaceIngress({
    authority,
    publicUrl: "http://localhost:4174",
    webUpstream: `http://127.0.0.1:${webPort}`,
    audit: () => undefined,
  });
  const ingressPort = await listen(ingress);

  try {
    const webResponse = await fetch(`http://127.0.0.1:${ingressPort}/`);
    assert.equal(webResponse.status, 200);
    assert.equal(await webResponse.text(), "web");

    const launch = authority.issueLaunch({
      identity: { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" },
      workspaceId,
      target: { protocol: "http", host: "127.0.0.1", port: workspacePort },
    });
    const launchUrl = new URL(`http://127.0.0.1:${ingressPort}/workspaces/${workspaceId}/`);
    launchUrl.searchParams.set("clipboard_up", "true");
    launchUrl.searchParams.set(workspaceIngressAccessParameter, launch.token);
    const exchange = await fetch(launchUrl, { redirect: "manual" });
    assert.equal(exchange.status, 303);
    assert.equal(exchange.headers.get("location"), `/workspaces/${workspaceId}/?clipboard_up=true`);
    const cookie = exchange.headers.get("set-cookie");
    assert.ok(cookie?.includes(`${workspaceIngressSessionCookie}=`));
    assert.ok(cookie?.includes(`Path=/workspaces/${workspaceId}/`));
    assert.ok(!cookie?.includes("Secure"));

    const sessionCookie = cookie!.split(";")[0]!;
    const proxied = await fetch(`http://127.0.0.1:${ingressPort}/workspaces/${workspaceId}/app/client.js?clipboard_up=true`, {
      headers: {
        cookie: sessionCookie,
        authorization: "Bearer must-not-enter-the-sandbox",
      },
    });
    assert.equal(proxied.status, 200);
    assert.equal(await proxied.text(), "workspace");
    assert.deepEqual(workspaceRequest, {
      url: "/app/client.js?clipboard_up=true",
      authorization: undefined,
      cookie: undefined,
    });

    workspace.on("upgrade", (request, socket) => {
      workspaceUpgradeRawHeaders = request.rawHeaders;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      socket.end();
    });
    const upgradeResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(ingressPort, "127.0.0.1", () => {
        socket.write(
          `GET /workspaces/${workspaceId}/websockify HTTP/1.1\r\n`
          + `Host: 127.0.0.1:${ingressPort}\r\n`
          + `Cookie: ${sessionCookie}\r\n`
          + `Origin: http://127.0.0.1:${ingressPort}\r\n`
          + "Connection: Upgrade\r\n"
          + "Upgrade: websocket\r\n"
          + "Sec-WebSocket-Key: dGVzdC13b3Jrc3BhY2U=\r\n"
          + "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { received += chunk; });
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
    });
    assert.match(upgradeResponse, /^HTTP\/1\.1 101 Switching Protocols/);
    const hostHeaderIndex = workspaceUpgradeRawHeaders?.indexOf("Host") ?? -1;
    assert.ok(hostHeaderIndex >= 0);
    assert.equal(workspaceUpgradeRawHeaders?.[hostHeaderIndex + 1], `127.0.0.1:${workspacePort}`);
    for (const header of ["Connection", "Upgrade", "Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version"]) {
      assert.ok(workspaceUpgradeRawHeaders?.includes(header), `expected canonical ${header} header`);
    }

    const unauthorized = await fetch(`http://127.0.0.1:${ingressPort}/workspaces/${workspaceId}/`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await Promise.all([close(ingress), close(workspace), close(web)]);
  }
});

test("workspace ingress exposes only the browser-facing Microsoft 365 OAuth routes", async () => {
  const upstreamRequests: Array<{ service: string; method?: string; url?: string; cookie?: string }> = [];
  const web = http.createServer((request, response) => {
    upstreamRequests.push({ service: "web", method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("web");
  });
  const microsoft365 = http.createServer((request, response) => {
    upstreamRequests.push({ service: "microsoft365", method: request.method, url: request.url });
    response.writeHead(302, { location: "https://login.microsoftonline.com/example/oauth2/v2.0/authorize" });
    response.end();
  });
  const litellm = http.createServer((request, response) => {
    upstreamRequests.push({
      service: "litellm",
      method: request.method,
      url: request.url,
      cookie: request.headers.cookie,
    });
    response.writeHead(303, { location: "/api/v1/connections/microsoft-365/callback?state=relay&code=sentinel" });
    response.end();
  });
  const [webPort, microsoft365Port, litellmPort] = await Promise.all([
    listen(web),
    listen(microsoft365),
    listen(litellm),
  ]);
  const ingress = createWorkspaceIngress({
    authority: new WorkspaceIngressAuthority(secret),
    publicUrl: "http://lemmacomputer.example",
    litellmPublicUrl: "http://lemmacomputer.example/oauth/mcp",
    webUpstream: `http://127.0.0.1:${webPort}`,
    microsoft365AuthorizationUpstream: `http://127.0.0.1:${microsoft365Port}`,
    litellmOAuthUpstream: `http://127.0.0.1:${litellmPort}`,
    audit: () => undefined,
  });
  const ingressPort = await listen(ingress);

  try {
    const authorize = await fetch(`http://127.0.0.1:${ingressPort}/m365/authorize?state=opaque`, { redirect: "manual" });
    assert.equal(authorize.status, 302);
    assert.equal(authorize.headers.get("location"), "https://login.microsoftonline.com/example/oauth2/v2.0/authorize");

    const callback = await getWithAuthority(
      `http://127.0.0.1:${ingressPort}/oauth/mcp/callback?state=relay&code=sentinel`,
      "lemmacomputer.example",
      "mcp_oauth_state_relay=opaque",
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.location, "/api/v1/connections/microsoft-365/callback?state=relay&code=sentinel");

    const rejectedOAuthSurface = await getWithAuthority(
      `http://127.0.0.1:${ingressPort}/oauth/mcp/not-a-callback`,
      "lemmacomputer.example",
    );
    assert.equal(rejectedOAuthSurface.status, 404);

    const rejectedCallbackAuthority = await fetch(`http://127.0.0.1:${ingressPort}/oauth/mcp/callback?state=relay&code=sentinel`);
    assert.equal(rejectedCallbackAuthority.status, 404);

    const rejectedMethod = await requestWithAuthority(
      "POST",
      `http://127.0.0.1:${ingressPort}/oauth/mcp/callback`,
      "lemmacomputer.example",
    );
    assert.equal(rejectedMethod.status, 405);
    assert.equal(rejectedMethod.headers.allow, "GET");

    const privateConnectorRoute = await fetch(`http://127.0.0.1:${ingressPort}/m365/token`);
    assert.equal(privateConnectorRoute.status, 200);
    assert.equal(await privateConnectorRoute.text(), "web");

    assert.deepEqual(upstreamRequests, [
      { service: "microsoft365", method: "GET", url: "/authorize?state=opaque" },
      {
        service: "litellm",
        method: "GET",
        url: "/callback?state=relay&code=sentinel",
        cookie: "mcp_oauth_state_relay=opaque",
      },
      { service: "web", method: "GET", url: "/m365/token" },
    ]);
  } finally {
    await Promise.all([close(ingress), close(litellm), close(microsoft365), close(web)]);
  }
});

test("workspace ingress gives agent chat turns a longer timeout than ordinary web requests", async () => {
  const web = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("finished");
    }, 80);
  });
  const webPort = await listen(web);
  const ingress = createWorkspaceIngress({
    authority: new WorkspaceIngressAuthority(secret),
    publicUrl: "http://localhost:4174",
    webUpstream: `http://127.0.0.1:${webPort}`,
    requestTimeoutMs: 25,
    agentChatRequestTimeoutMs: 250,
    audit: () => undefined,
  });
  const ingressPort = await listen(ingress);

  try {
    const ordinary = await fetch(`http://127.0.0.1:${ingressPort}/api/v1/workspaces`);
    assert.equal(ordinary.status, 502);

    const chat = await fetch(
      `http://127.0.0.1:${ingressPort}/api/v1/workspaces/${workspaceId}/chat/agents/hermes-claw/sessions/session-1/messages`,
      { method: "POST", body: "{}" },
    );
    assert.equal(chat.status, 200);
    assert.equal(await chat.text(), "finished");
  } finally {
    await Promise.all([close(ingress), close(web)]);
  }
});
