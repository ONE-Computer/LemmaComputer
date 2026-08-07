import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EntraAuthenticationService, ExternalIdAuthenticationService } from "../apps/control-api/src/auth.js";
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

test("External ID binds one-time invitations to CIAM state and cannot elevate from token claims", async () => {
  const invitationToken = "invitation-token-that-remains-browser-only";
  const invitationTokenHash = createHash("sha256").update(invitationToken).digest("hex");
  const attempts = new Map<string, OidcLoginAttempt & { expiresAt: Date }>();
  let expectedNonce = "";
  let storedIdentity: Record<string, unknown> | undefined;
  const invitedPrincipal: SessionPrincipal = {
    userId: "user-invited",
    accountUserId: "account-invited",
    tenantId: "organization-invited",
    organizationId: "organization-invited",
    membershipId: "membership-invited",
    membershipStatus: "active",
    role: "member",
    permissions: [],
    email: "invited@example.test",
    displayName: "Invited Member",
    tenantDisplayName: "Invited Organization",
    roles: ["employee"],
    identity: { tenantId: "organization-invited", subjectId: "user-invited", audience: "lemmacomputer-control" },
  };
  const invitationContext = {
    organizationId: "organization-invited",
    organizationDisplayName: "Invited Organization",
    invitationId: "11111111-1111-4111-8111-111111111111",
    status: "pending" as const,
  };
  const store = {
    getOrganizationInvitationContext: async (receivedHash: string) => receivedHash === invitationTokenHash ? invitationContext : null,
    createLoginAttempt: async (input) => {
      attempts.set(input.stateHash, {
        verifierCiphertext: input.verifierCiphertext,
        nonce: input.nonce,
        returnPath: input.returnPath,
        expiresAt: input.expiresAt,
      });
      expectedNonce = input.nonce;
    },
    consumeLoginAttempt: async (stateHash, now) => {
      const value = attempts.get(stateHash);
      attempts.delete(stateHash);
      return value && value.expiresAt > now ? value : null;
    },
    resolveAuthenticatedIdentity: async (input) => {
      storedIdentity = input;
      return invitedPrincipal;
    },
    createSession: async () => undefined,
    getSession: async () => null,
    revokeSession: async () => undefined,
    recordInvitationLinkFailure: async () => undefined,
  } as unknown as IdentityPolicyStore;
  let tokenRequestBody = "";
  const auth = new ExternalIdAuthenticationService(store, {
    tenantId: "external-tenant-id",
    tenantSubdomain: "external-tenant",
    clientId: "external-client-id",
    clientSecret: "external-client-secret-never-returned",
    publicWebUrl: "https://hosted.example.test",
    sessionSecret: "external-session-secret-at-least-32-characters",
    bootstrapOwnedTenantId: "must-not-select-this-organization",
    bootstrapOwnedUserId: "must-not-bootstrap-this-user",
    tenantDisplayName: "Must Not Select This Tenant",
    bootstrapOwnerObjectIds: ["malicious-object-id"],
    fetch: async (_url, init) => {
      tokenRequestBody = String(init?.body);
      return new Response(JSON.stringify({ id_token: "fake-valid-external-id-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    idTokenVerifier: async (token, expected) => {
      assert.equal(token, "fake-valid-external-id-token");
      assert.deepEqual(expected, {
        issuer: "https://external-tenant.ciamlogin.com/external-tenant-id/v2.0",
        audience: "external-client-id",
      });
      return {
        sub: "external-subject",
        email: "invited@example.test",
        name: "Invited Member",
        nonce: expectedNonce,
        oid: "malicious-object-id",
        roles: ["owner", "administrator"],
        groups: ["global-admins"],
      };
    },
  });

  const returningUser = await auth.begin("/", undefined);
  assert.equal(new URL(returningUser.location).origin, "https://external-tenant.ciamlogin.com");
  await auth.begin("/\\evil.example/steal", undefined);
  assert.equal([...attempts.values()].at(-1)?.returnPath, "/");
  await assert.rejects(() => auth.begin("/", "different-invalid-invitation-token"), { code: "INVITATION_SIGNIN_FAILED" });

  const started = await auth.begin("/?view=people", invitationToken);
  const location = new URL(started.location);
  const state = location.searchParams.get("state")!;
  const stateCookie = started.cookie.split(";")[0];
  assert.equal(location.origin, "https://external-tenant.ciamlogin.com");
  assert.equal(location.pathname, "/external-tenant-id/oauth2/v2.0/authorize");
  assert.equal(location.searchParams.get("redirect_uri"), "https://hosted.example.test/api/v1/auth/external-id/callback");
  assert.match(started.cookie, /^oc_external_id_state=/);
  assert.doesNotMatch([...attempts.values()].at(-1)!.verifierCiphertext, new RegExp(invitationToken));

  const completed = await auth.complete({ state, code: "provider-authorization-code", cookie: stateCookie });
  assert.equal(completed.principal.role, "member");
  assert.equal(completed.principal.roles.includes("administrator"), false);
  assert.equal(completed.returnPath, "/?view=people");
  assert.equal(storedIdentity?.provider, "entra-external-id");
  assert.equal(storedIdentity?.organizationId, invitationContext.organizationId);
  assert.equal(storedIdentity?.invitationTokenHash, invitationTokenHash);
  assert.equal(storedIdentity?.membershipAdmissionMode, "existing-membership-only");
  assert.match(String((storedIdentity?.browserSession as { tokenHash?: string } | undefined)?.tokenHash), /^[a-f0-9]{64}$/);
  assert.equal("roles" in (storedIdentity ?? {}), false);
  assert.equal("groups" in (storedIdentity ?? {}), false);
  assert.match(tokenRequestBody, /code_verifier=/);
  assert.doesNotMatch(completed.cookie, /provider-authorization-code|fake-valid-external-id-token|external-client-secret/);

  await assert.rejects(() => auth.complete({ state, code: "replay", cookie: stateCookie }), { code: "OIDC_STATE_EXPIRED" });
});

test("External ID rejects a token from the wrong issuer before identity resolution", async () => {
  const invitationToken = "wrong-issuer-invitation-token-value";
  const invitationTokenHash = createHash("sha256").update(invitationToken).digest("hex");
  const attempts = new Map<string, OidcLoginAttempt & { expiresAt: Date }>();
  let identityResolutionCalls = 0;
  const store = {
    getOrganizationInvitationContext: async (receivedHash: string) => receivedHash === invitationTokenHash ? {
      organizationId: "organization-invited",
      organizationDisplayName: "Invited Organization",
      invitationId: "22222222-2222-4222-8222-222222222222",
      status: "pending" as const,
    } : null,
    createLoginAttempt: async (input) => attempts.set(input.stateHash, { ...input }),
    consumeLoginAttempt: async (stateHash) => {
      const value = attempts.get(stateHash) ?? null;
      attempts.delete(stateHash);
      return value;
    },
    resolveAuthenticatedIdentity: async () => { identityResolutionCalls += 1; return principal; },
    createSession: async () => undefined,
    getSession: async () => null,
    revokeSession: async () => undefined,
    recordOrganizationAccessEvent: async () => undefined,
  } as unknown as IdentityPolicyStore;
  const auth = new ExternalIdAuthenticationService(store, {
    tenantId: "external-tenant-id",
    tenantSubdomain: "external-tenant",
    clientId: "external-client-id",
    clientSecret: "secret",
    publicWebUrl: "https://hosted.example.test",
    sessionSecret: "external-session-secret-at-least-32-characters",
    bootstrapOwnedTenantId: "bootstrap",
    bootstrapOwnedUserId: "bootstrap",
    tenantDisplayName: "Bootstrap",
    bootstrapOwnerObjectIds: [],
    fetch: async () => new Response(JSON.stringify({ id_token: "token-signed-by-wrong-issuer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    idTokenVerifier: async (_token, expected) => {
      assert.equal(expected.issuer, "https://external-tenant.ciamlogin.com/external-tenant-id/v2.0");
      throw new Error("JWT issuer is not allowed");
    },
  });
  const started = await auth.begin("/", invitationToken);
  const state = new URL(started.location).searchParams.get("state")!;
  await assert.rejects(
    () => auth.complete({ state, code: "code", cookie: started.cookie.split(";")[0] }),
    { code: "OIDC_ID_TOKEN_INVALID" },
  );
  assert.equal(identityResolutionCalls, 0);
});
