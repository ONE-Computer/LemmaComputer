import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const certificate = readFileSync("/qualification-pki/application-server.crt");
const privateKey = readFileSync("/qualification-pki/application-server.key");
const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const listen = (port, upstream) => {
  const server = https.createServer({ cert: certificate, key: privateKey, minVersion: "TLSv1.2" }, (request, response) => {
    if (request.url === "/__lemmacomputer/qualification-healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    const target = new URL(request.url ?? "/", upstream);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !hopByHop.has(name.toLowerCase())));
    const forwarded = http.request(target, {
      method: request.method,
      headers: { ...headers, host: target.host, connection: "close" },
      agent: false,
    }, (upstreamResponse) => {
      const responseHeaders = Object.fromEntries(Object.entries(upstreamResponse.headers).filter(([name]) => !hopByHop.has(name.toLowerCase())));
      response.writeHead(upstreamResponse.statusCode ?? 502, { ...responseHeaders, connection: "close" });
      upstreamResponse.pipe(response);
    });
    forwarded.once("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { code: "REMOTE_QUALIFICATION_UPSTREAM_UNAVAILABLE" } }));
    });
    request.pipe(forwarded);
  });
  server.listen(port, "0.0.0.0");
};

listen(4443, "http://control-api:4100");
listen(4444, "http://litellm:4000");
