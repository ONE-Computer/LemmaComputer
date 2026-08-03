import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertHostedLiteLlmAdminSecurity,
} from "../apps/control-api/src/litellm-admin-security.js";
import {
  initializeEnvironment,
  mergeEnvironment,
  parseEnvironment,
} from "../scripts/environment-template.mjs";
import { projectServiceEnvironment } from "../scripts/deployment-config.mjs";

const credentialSecret = "credential-secret-that-is-long-enough-0000001";
const sessionSecret = "session-secret-that-is-long-enough-0000000001";
const ingressSecret = "ingress-secret-that-is-long-enough-0000000001";

test("hosted LiteLLM administration requires HTTPS mutual TLS and distinct secrets", () => {
  const material = assertHostedLiteLlmAdminSecurity({
    installationKind: "hosted",
    adminUrl: "https://litellm-admin.internal:8443",
    credentialSecret,
    sessionSecret,
    workspaceIngressSecret: ingressSecret,
    caBase64: Buffer.from("-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n").toString("base64"),
    clientCertificateBase64: Buffer.from("-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n").toString("base64"),
    clientKeyBase64: Buffer.from("-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n").toString("base64"),
  });

  assert.equal(material.serverName, "litellm-admin.internal");
  assert.match(material.ca, /BEGIN CERTIFICATE/);
  assert.match(material.clientCertificate, /BEGIN CERTIFICATE/);
  assert.match(material.clientKey, /BEGIN PRIVATE KEY/);

  assert.throws(() => assertHostedLiteLlmAdminSecurity({
    installationKind: "hosted",
    adminUrl: "http://litellm:4000",
    credentialSecret,
    sessionSecret,
    workspaceIngressSecret: ingressSecret,
  }), /HTTPS mutual TLS/);
  assert.throws(() => assertHostedLiteLlmAdminSecurity({
    installationKind: "hosted",
    adminUrl: "https://litellm-admin.internal:8443",
    credentialSecret,
    sessionSecret: credentialSecret,
    workspaceIngressSecret: ingressSecret,
    caBase64: "missing",
    clientCertificateBase64: "missing",
    clientKeyBase64: "missing",
  }), /must not equal/);
  assert.throws(() => assertHostedLiteLlmAdminSecurity({
    installationKind: "hosted",
    adminUrl: "https://litellm-admin.internal:8443",
    credentialSecret,
    sessionSecret,
    workspaceIngressSecret: ingressSecret,
  }), /HTTPS mutual TLS/);
});

test("environment initialization and upgrades never derive session or ingress secrets from LiteLLM credentials", async () => {
  const template = [
    "ONECOMPUTER_LITELLM_CREDENTIAL_SECRET=generated",
    "ONECOMPUTER_SESSION_SECRET=generated",
    "ONECOMPUTER_WORKSPACE_INGRESS_SECRET=generated",
  ].join("\n");
  const initialized = initializeEnvironment(await readFile(new URL("../.env.example", import.meta.url), "utf8"), "Etc/UTC");
  const initialValues = parseEnvironment(initialized).values;
  assert.notEqual(initialValues.get("ONECOMPUTER_LITELLM_CREDENTIAL_SECRET"), initialValues.get("ONECOMPUTER_SESSION_SECRET"));
  assert.notEqual(initialValues.get("ONECOMPUTER_LITELLM_CREDENTIAL_SECRET"), initialValues.get("ONECOMPUTER_WORKSPACE_INGRESS_SECRET"));

  const merged = mergeEnvironment(template, `ONECOMPUTER_LITELLM_CREDENTIAL_SECRET=${credentialSecret}`, initialized);
  const mergedValues = parseEnvironment(merged.contents).values;
  assert.equal(mergedValues.get("ONECOMPUTER_LITELLM_CREDENTIAL_SECRET"), credentialSecret);
  assert.notEqual(mergedValues.get("ONECOMPUTER_SESSION_SECRET"), credentialSecret);
  assert.notEqual(mergedValues.get("ONECOMPUTER_WORKSPACE_INGRESS_SECRET"), credentialSecret);
  assert.equal(merged.mapped, 0);
});

test("the shared projection routes LiteLLM administration through the dedicated mutual-TLS listener", async () => {
  const [compose, hostedCompose] = await Promise.all([
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../compose.hosted.yaml", import.meta.url), "utf8"),
  ]);
  const control = compose.split("  control-api:")[1]?.split("\n  channel-broker:")[0] ?? "";
  const proxy = compose.split("  litellm-admin-proxy:")[1]?.split("\n  openvtc-consent:")[0] ?? "";
  const projected = projectServiceEnvironment();
  const controlEnvironment = projected["control-api"];
  const proxyEnvironment = projected["litellm-admin-proxy"];

  assert.match(control, /env_file:\s+- path: \.runtime-env\/control-api\.env\s+format: raw/);
  assert.match(proxy, /env_file:\s+- path: \.runtime-env\/litellm-admin-proxy\.env\s+format: raw/);
  assert.equal(controlEnvironment.LITELLM_ADMIN_URL, "http://litellm-admin-listener:8443");
  assert.ok("SESSION_SECRET" in controlEnvironment);
  assert.ok("WORKSPACE_INGRESS_SECRET" in controlEnvironment);
  assert.ok("LITELLM_ADMIN_PROXY_TLS_SERVER_CERT_B64" in proxyEnvironment);
  assert.ok("LITELLM_ADMIN_PROXY_TLS_CA_B64" in proxyEnvironment);
  assert.equal(proxyEnvironment.LITELLM_ADMIN_PROXY_HOST, "litellm-admin-listener");
  assert.ok(!("LITELLM_ADMIN_PROXY_TLS_SERVER_KEY_B64" in controlEnvironment));
  assert.doesNotMatch(hostedCompose, /^\s+environment:/m);
});

test("Compose separates model egress from strict remote-MCP egress", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const litellm = compose.split("  litellm:")[1]?.split("\n  # The model-only internet-routed hop")[0] ?? "";
  const modelProxy = compose.split("\n  gateway-egress-proxy:\n")[1]?.split("\n  # The only external path for custom/public MCP operations.")[0] ?? "";
  const remoteProxy = compose.split("\n  remote-mcp-egress-proxy:\n")[1]?.split("\n  # Control uses this dedicated listener")[0] ?? "";
  const dockerfile = await readFile(new URL("../docker/Dockerfile.litellm", import.meta.url), "utf8");
  const patch = await readFile(new URL("../integrations/litellm/onecomputer_remote_mcp_egress.py", import.meta.url), "utf8");
  const projected = projectServiceEnvironment();
  const litellmEnvironment = projected.litellm;
  const modelProxyEnvironment = projected["gateway-egress-proxy"];
  const remoteProxyEnvironment = projected["remote-mcp-egress-proxy"];
  const controlEnvironment = projected["control-api"];

  assert.match(litellm, /image: onecomputer\/litellm:v1\.93\.0-onecomputer-egress/);
  assert.match(litellm, /dockerfile: docker\/Dockerfile\.litellm/);
  assert.match(litellm, /env_file:\s+- path: \.runtime-env\/litellm\.env\s+format: raw/);
  assert.match(litellmEnvironment.HTTP_PROXY, /^http:\/\/litellm-gateway:.*@gateway-egress-proxy:3128$/);
  assert.equal(litellmEnvironment.HTTPS_PROXY, litellmEnvironment.HTTP_PROXY);
  assert.match(litellmEnvironment.ONECOMPUTER_REMOTE_MCP_EGRESS_PROXY_URL, /^http:\/\/litellm-gateway:.*@remote-mcp-egress-proxy:3128$/);
  assert.equal(litellmEnvironment.AIOHTTP_TRUST_ENV, "true");
  assert.match(litellmEnvironment.NO_PROXY, /ms365-mcp.*control-api/);
  assert.match(litellm, /networks:\n\s+- gateway-private/);
  assert.match(litellm, /\n\s+- mcp-client-private/);
  assert.doesNotMatch(litellm, /\n\s+- model-egress/);
  assert.match(litellm, /socket\.create_connection\(\('remote-mcp-egress-proxy',3128\),2\)/);
  assert.match(modelProxy, /env_file:\s+- path: \.runtime-env\/gateway-egress-proxy\.env\s+format: raw/);
  assert.match(modelProxy, /model-egress: \{\}/);
  assert.equal(modelProxyEnvironment.EGRESS_PROXY_PORT, "3128");
  assert.ok("EGRESS_PROXY_SERVICE_PASSWORD" in modelProxyEnvironment);
  assert.ok(!("EGRESS_DYNAMIC_AUTHORIZATION_URL" in modelProxyEnvironment));
  assert.match(remoteProxy, /env_file:\s+- path: \.runtime-env\/remote-mcp-egress-proxy\.env\s+format: raw/);
  assert.match(remoteProxy, /mcp-client-private:\n\s+aliases:\n\s+- remote-mcp-egress-proxy/);
  assert.match(remoteProxy, /mcp-egress-private: \{\}/);
  assert.doesNotMatch(remoteProxy, /gateway-private/);
  assert.match(remoteProxy, /model-egress: \{\}/);
  assert.equal(remoteProxyEnvironment.EGRESS_DYNAMIC_AUTHORIZATION_URL, "http://control-api:4100/internal/v1/mcp-egress/authorize");
  assert.ok("EGRESS_PROXY_SERVICE_PASSWORD" in remoteProxyEnvironment);
  assert.ok("EGRESS_DYNAMIC_AUTHORIZATION_TOKEN" in remoteProxyEnvironment);
  assert.ok("MCP_EGRESS_PROXY_TOKEN" in controlEnvironment);
  assert.ok(!("ONECOMPUTER_REMOTE_MCP_EGRESS_PROXY_URL" in controlEnvironment));
  assert.match(dockerfile, /FROM ghcr\.io\/berriai\/litellm:v1\.93\.0@sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e/);
  assert.match(dockerfile, /onecomputer_remote_mcp_egress\.py/);
  assert.match(patch, /trust_env=False/);
  assert.match(patch, /follow_redirects=True/);
  assert.match(patch, /EXPECTED_LITELLM_VERSION = "1\.93\.0"/);
});
