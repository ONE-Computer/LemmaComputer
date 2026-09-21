import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const listen = async (server: http.Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
};
const close = (server: http.Server) => new Promise<void>((resolve, reject) => {
  server.closeAllConnections();
  server.close((error) => error ? reject(error) : resolve());
});

test("Web API requests cannot redirect the proxy or its credentials to another origin", async (t) => {
  const proxyToken = "synthetic-web-proxy-token-for-boundary-test";
  const received: Array<{ url: string; token: string | string[] | undefined }> = [];
  const control = http.createServer((request, response) => {
    received.push({ url: request.url!, token: request.headers["x-lemmacomputer-proxy-token"] });
    response.end("control");
  });
  const controlPort = await listen(control);
  t.after(() => close(control));
  let otherOriginRequests = 0;
  const otherOrigin = http.createServer((_request, response) => {
    otherOriginRequests++;
    response.end("wrong origin");
  });
  const otherPort = await listen(otherOrigin);
  t.after(() => close(otherOrigin));
  const reservation = http.createServer();
  const webPort = await listen(reservation);
  await close(reservation);
  const child = spawn(process.execPath, ["apps/web/server.mjs"], {
    env: {
      ...process.env,
      WEB_HOST: "127.0.0.1",
      WEB_PORT: String(webPort),
      LEMMACOMPUTER_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
      LEMMACOMPUTER_WEB_PROXY_TOKEN: proxyToken,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  const webUrl = `http://127.0.0.1:${webPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await fetch(`${webUrl}/healthz`).then((response) => response.ok).catch(() => false);
    if (ready) break;
    await delay(20);
  }
  assert.ok(ready, "production Web server started");
  for (const path of [
    "/api/v1/workspaces?limit=2",
    `/api//127.0.0.1:${otherPort}/probe?code=synthetic`,
    `/api///127.0.0.1:${otherPort}/probe`,
  ]) {
    const response = await fetch(`${webUrl}${path}`, { headers: { cookie: "synthetic_session=example" } });
    assert.equal(await response.text(), "control");
    assert.equal(otherOriginRequests, 0, "untrusted origin received no request or credentials");
    assert.deepEqual(received.at(-1), { url: path.slice(4), token: proxyToken });
  }
});
