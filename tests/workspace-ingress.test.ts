import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import net from "node:net";
import test from "node:test";
import {
  WorkspaceIngressAuthority,
  workspaceIngressAccessParameter,
  workspaceIngressSessionCookie,
} from "@onecomputer/workspace-ingress-auth";
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
      identity: { tenantId: "acme", subjectId: "alex", audience: "onecomputer-control" },
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
