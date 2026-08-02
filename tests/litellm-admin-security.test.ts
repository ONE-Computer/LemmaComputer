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
