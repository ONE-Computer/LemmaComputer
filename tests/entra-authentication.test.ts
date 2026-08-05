import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EntraAuthenticationService } from "../apps/control-api/src/auth.js";
import type { IdentityPolicyStore, OidcLoginAttempt, SessionPrincipal } from "@lemmacomputer/workspace-store";

const principal: SessionPrincipal = {
  userId: "alex-morgan",
  tenantId: "acme",
  email: "mike@metech.dev",
  displayName: "Mike",
  tenantDisplayName: "ME TECH",
  roles: ["employee", "administrator"],
  identity: { tenantId: "acme", subjectId: "alex-morgan", audience: "lemmacomputer-control" },
};

test("Entra sign-in binds state, PKCE, nonce, tenant, durable identity, and opaque session", async () => {
  const attempts = new Map<string, OidcLoginAttempt & { expiresAt: Date }>();
  const sessions = new Map<string, SessionPrincipal>();
  let storedIdentity: Record<string, unknown> | undefined;
  let expectedNonce = "";
  const store = {
    createLoginAttempt: async (input) => { attempts.set(input.stateHash, { verifierCiphertext: input.verifierCiphertext, nonce: input.nonce, returnPath: input.returnPath, expiresAt: input.expiresAt }); expectedNonce = input.nonce; },
    consumeLoginAttempt: async (stateHash, now) => {
      const value = attempts.get(stateHash);
      attempts.delete(stateHash);
      return value && value.expiresAt > now ? value : null;
    },
    resolveAuthenticatedIdentity: async (input) => { storedIdentity = input; return principal; },
    createSession: async (input) => { sessions.set(input.tokenHash, principal); },
    getSession: async (tokenHash) => sessions.get(tokenHash) ?? null,
    revokeSession: async (tokenHash) => { sessions.delete(tokenHash); },
  } as unknown as IdentityPolicyStore;
  let tokenRequestBody = "";
  const auth = new EntraAuthenticationService(store, {
    tenantId: "tenant-005",
    clientId: "client-005",
    clientSecret: "test-client-secret-never-returned",
    publicWebUrl: "http://localhost:4174",
    sessionSecret: "test-session-secret-at-least-32-characters",
    bootstrapOwnedTenantId: "acme",
    bootstrapOwnedUserId: "alex-morgan",
    tenantDisplayName: "ME TECH",
    bootstrapOwnerObjectIds: ["entra-object-005"],
    membershipAdmissionMode: "directory-jit",
    fetch: async (_url, init) => {
      tokenRequestBody = String(init?.body);
      return new Response(JSON.stringify({ id_token: "signed-id-token" }), { status: 200, headers: { "content-type": "application/json" } });
    },
    idTokenVerifier: async (token, expected) => {
      assert.equal(token, "signed-id-token");
      assert.deepEqual(expected, { issuer: "https://login.microsoftonline.com/tenant-005/v2.0", audience: "client-005" });
      return { sub: "external-subject", oid: "entra-object-005", tid: "tenant-005", preferred_username: "mike@metech.dev", name: "Mike", nonce: expectedNonce };
    },
  });

  const started = await auth.begin("/?view=connections");
  const location = new URL(started.location);
  const state = location.searchParams.get("state")!;
  const stateCookie = started.cookie.split(";")[0];
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("prompt"), "select_account");

  const completed = await auth.complete({ state, code: "one-time-code", cookie: stateCookie });
  assert.equal(completed.principal.email, "mike@metech.dev");
  assert.equal(completed.returnPath, "/?view=connections");
  assert.match(completed.cookie, /^lemmacomputer_session=/);
  assert.doesNotMatch(completed.cookie, /one-time-code|signed-id-token|test-client-secret/);
  assert.match(tokenRequestBody, /code_verifier=/);
  assert.equal(storedIdentity?.userId, "alex-morgan");
  assert.equal(storedIdentity?.providerObjectId, "entra-object-005");
  assert.equal(storedIdentity?.bootstrapOwner, true);
  assert.equal(storedIdentity?.membershipAdmissionMode, "directory-jit");
  const expectedGatewayUserId = `oc-user-${createHash("sha256").update("lemmacomputer:litellm:user:acme:alex-morgan").digest("base64url")}`;
  assert.equal(storedIdentity?.gatewayUserId, expectedGatewayUserId);

  await assert.rejects(() => auth.complete({ state, code: "replay", cookie: stateCookie }), { code: "OIDC_STATE_EXPIRED" });
});

test("Entra callback rejects a caller without the initiating browser state", async () => {
  const store = {
    createLoginAttempt: async () => undefined,
  } as unknown as IdentityPolicyStore;
  const auth = new EntraAuthenticationService(store, {
    tenantId: "tenant-005", clientId: "client-005", clientSecret: "secret",
    publicWebUrl: "http://localhost:4174", sessionSecret: "test-session-secret-at-least-32-characters",
    bootstrapOwnedTenantId: "acme", bootstrapOwnedUserId: "alex-morgan", tenantDisplayName: "ME TECH",
    bootstrapOwnerObjectIds: [], membershipAdmissionMode: "existing-membership-only",
  });
  const started = await auth.begin();
  const state = new URL(started.location).searchParams.get("state")!;
  await assert.rejects(() => auth.complete({ state, code: "code", cookie: "oc_oidc_state=other" }), { code: "OIDC_STATE_MISMATCH" });
});
