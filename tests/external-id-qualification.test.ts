import assert from "node:assert/strict";
import test from "node:test";
import { qualifyExternalId } from "../scripts/qualify-external-id.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";
const tenantSubdomain = "lemma-external-test";
const clientSecret = "qualification-client-secret-must-never-leave-process";
const publicWebUrl = "https://hosted.example.test";
const authorityHost = `${tenantSubdomain}.ciamlogin.com`;
const authority = `https://${authorityHost}/${tenantId}/v2.0`;
const callback = `${publicWebUrl}/api/v1/auth/external-id/callback`;

const hostedEnvironment = Object.freeze({
  LEMMACOMPUTER_INSTALLATION_KIND: "hosted",
  LEMMACOMPUTER_EXTERNAL_ID_TENANT_ID: tenantId,
  LEMMACOMPUTER_EXTERNAL_ID_TENANT_SUBDOMAIN: tenantSubdomain,
  LEMMACOMPUTER_EXTERNAL_ID_CLIENT_ID: clientId,
  LEMMACOMPUTER_EXTERNAL_ID_CLIENT_SECRET: clientSecret,
  LEMMACOMPUTER_PUBLIC_WEB_URL: publicWebUrl,
});

type FakeFetchOptions = {
  issuer?: string;
  authorizationEndpoint?: string;
  callbackMode?: "exact" | "wrong-callback" | "wrong-state";
};

const fakeExternalId = ({
  issuer = authority,
  authorizationEndpoint = `${authority}/oauth2/v2.0/authorize`,
  callbackMode = "exact",
}: FakeFetchOptions = {}) => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    requests.push({ url: url.toString(), init });
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: `${authority}/oauth2/v2.0/token`,
        jwks_uri: `${authority}/discovery/v2.0/keys`,
      });
    }
    if (url.pathname.endsWith("/discovery/v2.0/keys")) {
      return Response.json({ keys: [{ kid: "qualification-signing-key", kty: "RSA" }] });
    }
    if (url.pathname.endsWith("/oauth2/v2.0/authorize")) {
      const returnedCallback = callbackMode === "wrong-callback"
        ? new URL("https://attacker.example.test/callback")
        : new URL(url.searchParams.get("redirect_uri")!);
      returnedCallback.searchParams.set("error", "login_required");
      returnedCallback.searchParams.set(
        "state",
        callbackMode === "wrong-state" ? "different-state" : url.searchParams.get("state")!,
      );
      return new Response(null, { status: 302, headers: { location: returnedCallback.toString() } });
    }
    throw new Error(`Unexpected qualification request: ${url}`);
  };
  return { fetchImpl, requests };
};

const assertSafeFailure = async (operation: () => Promise<unknown>, expectedCode: string) => {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, expectedCode);
    assert.equal((error as Error).message, expectedCode);
    assert.doesNotMatch(String((error as Error).stack), new RegExp(clientSecret));
    return true;
  });
};

test("External ID qualification verifies exact hosted CIAM metadata and returns an intact callback state", async () => {
  const fake = fakeExternalId();
  const result = await qualifyExternalId(hostedEnvironment, { fetchImpl: fake.fetchImpl, timeoutMs: 1_000 });

  assert.deepEqual(result, {
    authority,
    callback,
    signingKeyCount: 1,
  });
  assert.equal(fake.requests.length, 3);
  assert.equal(fake.requests[0]!.url, `${authority}/.well-known/openid-configuration`);
  assert.equal(fake.requests[1]!.url, `${authority}/discovery/v2.0/keys`);
  assert.equal(fake.requests[0]!.init?.redirect, "error");
  assert.equal(fake.requests[1]!.init?.redirect, "error");

  const authorization = new URL(fake.requests[2]!.url);
  assert.equal(authorization.origin, `https://${authorityHost}`);
  assert.equal(authorization.pathname, `/${tenantId}/v2.0/oauth2/v2.0/authorize`);
  assert.equal(authorization.searchParams.get("client_id"), clientId);
  assert.equal(authorization.searchParams.get("redirect_uri"), callback);
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("response_mode"), "query");
  assert.equal(authorization.searchParams.get("scope"), "openid profile email");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorization.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{32}$/);
  assert.match(authorization.searchParams.get("nonce") ?? "", /^[A-Za-z0-9_-]{32}$/);
  assert.match(authorization.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fake.requests[2]!.init?.redirect, "manual");

  const serializedNetworkBoundary = JSON.stringify(fake.requests);
  assert.doesNotMatch(serializedNetworkBoundary, new RegExp(clientSecret));
  assert.doesNotMatch(serializedNetworkBoundary, /client_secret/i);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(clientSecret));
});

test("External ID qualification fails customer-managed, issuer, callback, and state mismatches with stable safe codes", async () => {
  await assertSafeFailure(
    () => qualifyExternalId({ ...hostedEnvironment, LEMMACOMPUTER_INSTALLATION_KIND: "customer-managed" }),
    "HOSTED_PROFILE_REQUIRED",
  );

  const wrongIssuer = fakeExternalId({ issuer: "https://wrong-tenant.ciamlogin.com/wrong/v2.0" });
  await assertSafeFailure(
    () => qualifyExternalId(hostedEnvironment, { fetchImpl: wrongIssuer.fetchImpl }),
    "ISSUER_MISMATCH",
  );

  const wrongCallback = fakeExternalId({ callbackMode: "wrong-callback" });
  await assertSafeFailure(
    () => qualifyExternalId(hostedEnvironment, { fetchImpl: wrongCallback.fetchImpl }),
    "AUTHORIZATION_CALLBACK_MISMATCH",
  );

  const wrongState = fakeExternalId({ callbackMode: "wrong-state" });
  await assertSafeFailure(
    () => qualifyExternalId(hostedEnvironment, { fetchImpl: wrongState.fetchImpl }),
    "AUTHORIZATION_STATE_MISMATCH",
  );

  const networkEvidence = JSON.stringify([
    ...wrongIssuer.requests,
    ...wrongCallback.requests,
    ...wrongState.requests,
  ]);
  assert.doesNotMatch(networkEvidence, new RegExp(clientSecret));
  assert.doesNotMatch(networkEvidence, /client_secret/i);
});
