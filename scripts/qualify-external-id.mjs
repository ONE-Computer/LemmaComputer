import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseEnvironment } from "./environment-template.mjs";

const EXTERNAL_ID_KEYS = Object.freeze({
  tenantId: "LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID",
  tenantSubdomain: "LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN",
  clientId: "LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID",
  clientSecret: "LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET",
  publicWebUrl: "LEMMACOMPUTER_PUBLIC_WEB_URL",
});

export class ExternalIdQualificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ExternalIdQualificationError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new ExternalIdQualificationError(code);
};

const required = (values, key) => {
  const value = values[key]?.trim();
  if (!value || value.startsWith("replace-with-")) fail(`MISSING_${key}`);
  return value;
};

const normalizeUrl = (value) => value.replace(/\/$/, "");

const readJson = async (response, failureCode) => {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (!response.ok || (Number.isFinite(length) && length > 1_000_000)) fail(failureCode);
  try {
    const body = await response.text();
    if (body.length > 1_000_000) fail(failureCode);
    return JSON.parse(body);
  } catch {
    fail(failureCode);
  }
};

const fetchWithTimeout = async (fetchImpl, url, options, timeoutMs) => {
  try {
    return await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail("NETWORK_REQUEST_FAILED");
  }
};

const assertMicrosoftHttpsEndpoint = (value, allowedHosts, code) => {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail(code);
  }
  if (endpoint.protocol !== "https:" || !allowedHosts.has(endpoint.hostname.toLowerCase())) fail(code);
  return endpoint;
};

/**
 * Perform a non-interactive real-tenant OIDC smoke. The client secret is
 * deliberately checked for presence but never sent: token redemption belongs
 * to the full browser acceptance smoke documented in hosted-external-id.md.
 */
export async function qualifyExternalId(values, {
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  if (values.LEMMACOMPUTER_INSTALLATION_KIND !== "hosted") fail("HOSTED_PROFILE_REQUIRED");

  const tenantId = required(values, EXTERNAL_ID_KEYS.tenantId);
  const tenantSubdomain = required(values, EXTERNAL_ID_KEYS.tenantSubdomain).toLowerCase();
  const clientId = required(values, EXTERNAL_ID_KEYS.clientId);
  required(values, EXTERNAL_ID_KEYS.clientSecret);
  const publicWebUrl = required(values, EXTERNAL_ID_KEYS.publicWebUrl);

  const isNonzeroGuid = (value) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    && value.replaceAll("-", "") !== "0".repeat(32);
  if (!isNonzeroGuid(tenantId)) {
    fail("INVALID_TENANT_ID");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenantSubdomain)) {
    fail("INVALID_TENANT_SUBDOMAIN");
  }
  if (!isNonzeroGuid(clientId)) {
    fail("INVALID_CLIENT_ID");
  }

  let callback;
  try {
    const publicOrigin = new URL(publicWebUrl);
    if (publicOrigin.protocol !== "https:") fail("HOSTED_HTTPS_REQUIRED");
    callback = new URL("/api/v1/auth/external-id/callback", publicOrigin);
  } catch (error) {
    if (error instanceof ExternalIdQualificationError) throw error;
    fail("INVALID_PUBLIC_WEB_URL");
  }

  const authorityHost = `${tenantSubdomain}.ciamlogin.com`;
  const authority = `https://${authorityHost}/${tenantId}/v2.0`;
  const metadataResponse = await fetchWithTimeout(
    fetchImpl,
    `${authority}/.well-known/openid-configuration`,
    { headers: { accept: "application/json" }, redirect: "error" },
    timeoutMs,
  );
  const metadata = await readJson(metadataResponse, "DISCOVERY_FAILED");
  if (normalizeUrl(String(metadata.issuer ?? "")) !== authority) fail("ISSUER_MISMATCH");

  const allowedHosts = new Set([authorityHost, "login.microsoftonline.com"]);
  const authorizationEndpoint = assertMicrosoftHttpsEndpoint(
    metadata.authorization_endpoint,
    allowedHosts,
    "INVALID_AUTHORIZATION_ENDPOINT",
  );
  assertMicrosoftHttpsEndpoint(metadata.token_endpoint, allowedHosts, "INVALID_TOKEN_ENDPOINT");
  const jwksEndpoint = assertMicrosoftHttpsEndpoint(metadata.jwks_uri, allowedHosts, "INVALID_JWKS_ENDPOINT");

  const jwksResponse = await fetchWithTimeout(
    fetchImpl,
    jwksEndpoint,
    { headers: { accept: "application/json" }, redirect: "error" },
    timeoutMs,
  );
  const jwks = await readJson(jwksResponse, "JWKS_FAILED");
  if (!Array.isArray(jwks.keys) || !jwks.keys.some((key) => key && key.kid && key.kty)) fail("JWKS_EMPTY");

  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: callback.toString(),
    response_mode: "query",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "none",
  }).toString();

  const authorizeResponse = await fetchWithTimeout(
    fetchImpl,
    authorizationUrl,
    { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "manual" },
    timeoutMs,
  );
  if (authorizeResponse.status < 300 || authorizeResponse.status >= 400) fail("AUTHORIZATION_PROBE_FAILED");
  const location = authorizeResponse.headers.get("location");
  if (!location) fail("AUTHORIZATION_REDIRECT_MISSING");

  let redirect;
  try {
    redirect = new URL(location, authorizationEndpoint);
  } catch {
    fail("AUTHORIZATION_REDIRECT_INVALID");
  }
  if (redirect.origin !== callback.origin || redirect.pathname !== callback.pathname) {
    fail("AUTHORIZATION_CALLBACK_MISMATCH");
  }
  if (redirect.searchParams.get("state") !== state) fail("AUTHORIZATION_STATE_MISMATCH");
  if (redirect.searchParams.has("code")) fail("UNEXPECTED_AUTHORIZATION_CODE");
  if (!redirect.searchParams.has("error")) fail("AUTHORIZATION_RESULT_MISSING");

  return Object.freeze({ authority, callback: callback.toString(), signingKeyCount: jwks.keys.length });
}

export async function runExternalIdQualificationCli(argv = process.argv.slice(2)) {
  const source = argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length) ?? ".env";
  if (argv.some((argument) => !argument.startsWith("--file="))) fail("UNKNOWN_ARGUMENT");
  const parsed = parseEnvironment(await readFile(source, "utf8"));
  if (parsed.duplicates.length) fail("DUPLICATE_ENVIRONMENT_VARIABLE");
  await qualifyExternalId(Object.fromEntries(parsed.values));
  process.stdout.write("Hosted Microsoft Entra External ID real-tenant preflight passed without printing or exchanging credentials.\n");
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  runExternalIdQualificationCli().catch((error) => {
    const code = error instanceof ExternalIdQualificationError ? error.code : "UNEXPECTED_FAILURE";
    process.stderr.write(`Hosted Microsoft Entra External ID qualification failed (${code}). No secret values were printed.\n`);
    process.exitCode = 1;
  });
}
