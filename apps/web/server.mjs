import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.WEB_PORT ?? 4173);
const controlUrl = new URL(process.env.ONECOMPUTER_CONTROL_URL ?? "http://127.0.0.1:4100");
const proxyToken = process.env.ONECOMPUTER_WEB_PROXY_TOKEN;
const distribution = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dist");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("WEB_PORT must be a valid TCP port");
}
if (!proxyToken || proxyToken.length < 24) {
  throw new Error("ONECOMPUTER_WEB_PROXY_TOKEN must contain at least 24 characters");
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const safePath = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = path.resolve(distribution, `.${decoded}`);
  return candidate === distribution || candidate.startsWith(`${distribution}${path.sep}`)
    ? candidate
    : null;
};

const sendFile = async (request, response, filename, fallback = true) => {
  let selected = filename;
  let metadata = await stat(selected).catch(() => null);
  if (metadata?.isDirectory()) {
    selected = path.join(selected, "index.html");
    metadata = await stat(selected).catch(() => null);
  }
  if (!metadata?.isFile() && fallback) {
    selected = path.join(distribution, "index.html");
    metadata = await stat(selected).catch(() => null);
  }
  if (!metadata?.isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const extension = path.extname(selected).toLowerCase();
  const relative = path.relative(distribution, selected);
  response.writeHead(200, {
    "content-type": contentTypes.get(extension) ?? "application/octet-stream",
    "content-length": metadata.size,
    "cache-control": relative.startsWith(`assets${path.sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(selected)
    .on("error", () => response.destroy())
    .pipe(response);
};

const proxy = (request, response, requestUrl) => {
  const upstreamUrl = new URL(`${requestUrl.pathname.slice(4) || "/"}${requestUrl.search}`, controlUrl);
  const transport = upstreamUrl.protocol === "https:" ? https : http;
  const headers = {
    ...request.headers,
    host: upstreamUrl.host,
    "x-onecomputer-proxy-token": proxyToken,
  };
  delete headers.connection;

  const upstream = transport.request(upstreamUrl, {
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("Control API timeout")));
  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      error: {
        code: "CONTROL_UNAVAILABLE",
        message: "ONEComputer Control is unavailable",
        retryable: true,
      },
    }));
  });
  request.pipe(upstream);
};

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://onecomputer.invalid");
  if (requestUrl.pathname === "/healthz") {
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")) {
    proxy(request, response, requestUrl);
    return;
  }
  if (!["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }
  const filename = safePath(requestUrl.pathname);
  if (!filename) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid path");
    return;
  }
  await sendFile(request, response, filename);
});

server.listen(port, host);

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
