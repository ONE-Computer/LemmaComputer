import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";

const required = (value, name) => {
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const decodePem = (value, name) => {
  const decoded = Buffer.from(required(value, name), "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN")) throw new Error(`${name} must be base64-encoded PEM material`);
  return decoded;
};

const allowedClient = (request, expectedClientCommonName) => {
  const socket = request.socket;
  const certificate = typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate() : undefined;
  return socket.authorized === true && certificate?.subject?.CN === expectedClientCommonName;
};

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

const forward = (upstreamUrl, request, response) => {
  const upstream = new URL(request.url ?? "/", upstreamUrl);
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !hopByHopHeaders.has(name.toLowerCase())));
  const client = (upstream.protocol === "https:" ? httpsRequest : httpRequest)(upstream, {
    method: request.method,
    headers: { ...headers, host: upstream.host },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  client.once("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "LiteLLM administration upstream is unavailable" }));
  });
  request.once("aborted", () => client.destroy());
  request.pipe(client);
};

export const createLiteLlmAdminProxy = ({
  upstreamUrl,
  certificate,
  privateKey,
  clientCa,
  expectedClientCommonName = "onecomputer-control",
  requireMutualTls = true,
}) => {
  const handler = (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (requireMutualTls && !allowedClient(request, expectedClientCommonName)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Control workload identity is required" }));
      return;
    }
    forward(upstreamUrl, request, response);
  };
  if (!requireMutualTls) return createHttpServer(handler);
  return createHttpsServer({
    cert: required(certificate, "LITELLM_ADMIN_PROXY_TLS_SERVER_CERT_B64"),
    key: required(privateKey, "LITELLM_ADMIN_PROXY_TLS_SERVER_KEY_B64"),
    ca: required(clientCa, "LITELLM_ADMIN_PROXY_TLS_CA_B64"),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  }, handler);
};

const main = () => {
  const installationKind = process.env.ONECOMPUTER_INSTALLATION_KIND ?? "customer-managed";
  const requireMutualTls = installationKind === "hosted";
  const proxy = createLiteLlmAdminProxy({
    upstreamUrl: process.env.LITELLM_ADMIN_PROXY_UPSTREAM_URL ?? "http://litellm:4000",
    requireMutualTls,
    certificate: requireMutualTls ? decodePem(process.env.LITELLM_ADMIN_PROXY_TLS_SERVER_CERT_B64, "LITELLM_ADMIN_PROXY_TLS_SERVER_CERT_B64") : undefined,
    privateKey: requireMutualTls ? decodePem(process.env.LITELLM_ADMIN_PROXY_TLS_SERVER_KEY_B64, "LITELLM_ADMIN_PROXY_TLS_SERVER_KEY_B64") : undefined,
    clientCa: requireMutualTls ? decodePem(process.env.LITELLM_ADMIN_PROXY_TLS_CA_B64, "LITELLM_ADMIN_PROXY_TLS_CA_B64") : undefined,
    expectedClientCommonName: process.env.LITELLM_ADMIN_PROXY_CLIENT_COMMON_NAME ?? "onecomputer-control",
  });
  const host = process.env.LITELLM_ADMIN_PROXY_HOST ?? "0.0.0.0";
  const port = Number(process.env.LITELLM_ADMIN_PROXY_PORT ?? "8443");
  proxy.listen(port, host, () => process.stdout.write(`LiteLLM administration proxy listening on ${host}:${port}\n`));
};

if (import.meta.url === new URL(process.argv[1], "file:").href) main();
