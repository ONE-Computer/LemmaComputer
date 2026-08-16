import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controlRequestTimeout } from "./proxy-timeout.mjs";
import { platformOperatorEntryRedirect } from "./platform-operator-entry.mjs";

const host = process.env.WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.WEB_PORT ?? 4173);
const controlUrl = new URL(process.env.LEMMACOMPUTER_CONTROL_URL ?? "http://127.0.0.1:4100");
const channelBrokerIntakeUrl = process.env.LEMMACOMPUTER_CHANNEL_BROKER_INTAKE_URL
  ? new URL(process.env.LEMMACOMPUTER_CHANNEL_BROKER_INTAKE_URL)
  : null;
const proxyToken = process.env.LEMMACOMPUTER_WEB_PROXY_TOKEN;
const distribution = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dist");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("WEB_PORT must be a valid TCP port");
}
if (!proxyToken || proxyToken.length < 24) {
  throw new Error("LEMMACOMPUTER_WEB_PROXY_TOKEN must contain at least 24 characters");
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
    "x-lemmacomputer-proxy-token": proxyToken,
  };
  delete headers.connection;

  const upstream = transport.request(upstreamUrl, {
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(
    controlRequestTimeout(request.method, upstreamUrl.pathname),
    () => upstream.destroy(new Error("Control API timeout")),
  );
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
        message: "LemmaComputer Control is unavailable",
        retryable: true,
      },
    }));
  });
  request.pipe(upstream);
};

const proxyTelegramIntake = (request, response, requestUrl) => {
  if (!channelBrokerIntakeUrl) {
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      error: {
        code: "TELEGRAM_INTAKE_UNAVAILABLE",
        message: "Telegram credential intake is unavailable",
        retryable: true,
      },
    }));
    return;
  }
  const upstreamUrl = new URL(`${requestUrl.pathname.slice("/api/channel-intake".length)}${requestUrl.search}`, channelBrokerIntakeUrl);
  const transport = upstreamUrl.protocol === "https:" ? https : http;
  // This endpoint carries an envelope that is self-authorized by the signed
  // grant. Do not relay browser cookies, bearer tokens, or Control's proxy
  // credential to the broker.
  const headers = {
    host: upstreamUrl.host,
    ...(typeof request.headers["content-type"] === "string"
      ? { "content-type": request.headers["content-type"] }
      : {}),
    ...(typeof request.headers["content-length"] === "string"
      ? { "content-length": request.headers["content-length"] }
      : {}),
  };
  const upstream = transport.request(upstreamUrl, { method: request.method, headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(controlRequestTimeout(request.method, "/v1/credentials/telegram/intake"), () => {
    upstream.destroy(new Error("Telegram broker intake timeout"));
  });
  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      error: {
        code: "TELEGRAM_INTAKE_UNAVAILABLE",
        message: "Telegram credential intake is unavailable",
        retryable: true,
      },
    }));
  });
  request.pipe(upstream);
};

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://lemmacomputer.invalid");
  if (requestUrl.pathname === "/healthz") {
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  const platformEntry = platformOperatorEntryRedirect(request.method, request.url);
  if (platformEntry) {
    response.writeHead(303, {
      location: platformEntry,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/api/channel-intake/v1/telegram") {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    proxyTelegramIntake(request, response, requestUrl);
    return;
  }
  if (requestUrl.pathname.startsWith("/api/channel-intake/")) {
    response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found", retryable: false } }));
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
