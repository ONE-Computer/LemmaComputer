import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PlatformOperatorSession } from "@lemmacomputer/workspace-store";
import {
  PlatformOperatorAuthenticationService,
  type PlatformOperatorAuthenticationStore,
} from "../apps/control-api/src/platform-operator-auth.js";

const operatorId = "33333333-3333-4333-8333-333333333333";
const operatorSession: PlatformOperatorSession = {
  principal: {
    realm: "platform-operator",
    operatorSessionId: "22222222-2222-4222-8222-222222222222",
    operatorId,
    identity: {
      provider: "workforce-entra",
      issuer: "https://login.microsoftonline.com/workforce-tenant/v2.0",
      subject: "operator-object-id",
    },
    assurance: { level: "aal2", factors: ["federated", "totp"] },
    authenticatedAt: "2026-08-09T03:00:00.000Z",
    recentStepUpAt: "2026-08-09T03:00:00.000Z",
  },
  roles: ["support-operator"],
};

test("platform workforce OIDC has a separate client, callback, state, audience, cookie, role source, and dedicated recent step-up", async () => {
  const attempts = new Map<string, { verifierCiphertext: string; nonce: string; returnPath: string; expiresAt: Date; createdAt: Date; purpose: "login" | "step-up"; operatorSessionId: string | null }>();
  const sessions = new Map<string, PlatformOperatorSession>();
  let expectedNonce = "";
  let resolvedIdentity: Record<string, unknown> | null = null;
  let tokenRequestBody = "";
  let tokenExchangeCount = 0;
  let stepUpContextValid = true;
  const stepUpMarks: Array<{ authenticationContext: string }> = [];
  const store = {
    createOperatorLoginAttempt: async (input) => {
      attempts.set(input.stateHash, input);
      expectedNonce = input.nonce;
    },
    consumeOperatorLoginAttempt: async (stateHash, now) => {
      const value = attempts.get(stateHash);
      attempts.delete(stateHash);
      return value && value.expiresAt > now ? value : null;
    },
    resolveWorkforceOperator: async (input) => {
      resolvedIdentity = input;
      return { operatorId, issuer: input.issuer, subject: input.subject, roles: ["support-operator"] as const };
    },
    createSession: async (input) => {
      sessions.set(input.tokenHash, { ...operatorSession, principal: { ...operatorSession.principal, assurance: input.assurance, recentStepUpAt: input.recentStepUpAt?.toISOString() ?? null } });
      return sessions.get(input.tokenHash)!;
    },
    markSessionStepUp: async (input) => {
      stepUpMarks.push(input);
      for (const [key, value] of sessions) if (value.principal.operatorSessionId === input.operatorSessionId) {
        const updated = { ...value, principal: { ...value.principal, recentStepUpAt: input.authenticatedAt.toISOString() } };
        sessions.set(key, updated);
        return updated;
      }
      return null;
    },
    getSession: async (tokenHash) => sessions.get(tokenHash) ?? null,
    revokeSession: async () => true,
  } satisfies PlatformOperatorAuthenticationStore;
  const auth = new PlatformOperatorAuthenticationService(store, {
    tenantId: "workforce-tenant",
    clientId: "platform-operator-client",
    clientSecret: "platform-operator-client-secret",
    publicWebUrl: "https://hosted.example.test",
    stepUpAuthenticationContext: "c1",
    sessionSecret: "separate-platform-session-secret-at-least-32-characters",
    now: () => new Date("2026-08-09T03:00:00.000Z"),
    fetch: async (_url, init) => {
      tokenRequestBody = String(init?.body);
      tokenExchangeCount += 1;
      return new Response(JSON.stringify({ id_token: tokenExchangeCount === 1 ? "signed-platform-id-token" : "signed-step-up-id-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    idTokenVerifier: async (token, expected) => {
      assert.ok(["signed-platform-id-token", "signed-step-up-id-token"].includes(token));
      assert.deepEqual(expected, {
        issuer: "https://login.microsoftonline.com/workforce-tenant/v2.0",
        audience: "platform-operator-client",
      });
      return {
        sub: "application-specific-subject",
        oid: "operator-object-id",
        tid: "workforce-tenant",
        preferred_username: "operator@example.test",
        name: "Support Operator",
        nonce: expectedNonce,
        roles: ["Global Administrator", "platform-administrator"],
        groups: ["tenant-owners"],
        ...(token === "signed-step-up-id-token" ? {
          auth_time: Math.floor(new Date("2026-08-09T03:00:00.000Z").getTime() / 1_000),
          acrs: stepUpContextValid ? ["c1"] : ["c2"],
        } : { amr: ["pwd", "mfa"] }),
      };
    },
  });

  const started = await auth.begin("/platform?view=support");
  const location = new URL(started.location);
  const state = location.searchParams.get("state")!;
  assert.equal(location.searchParams.get("client_id"), "platform-operator-client");
  assert.equal(location.searchParams.get("redirect_uri"), "https://hosted.example.test/api/v1/platform/auth/callback");
  assert.equal(location.searchParams.get("prompt"), "login");
  assert.match(started.cookie, /^oc_platform_oidc_state=/);
  assert.match(started.cookie, /Path=\/api\/v1\/platform\/auth\/callback/);

  const completed = await auth.complete({
    state,
    code: "one-time-platform-code",
    cookie: started.cookie.split(";", 1)[0],
  });
  assert.equal(completed.session.principal.realm, "platform-operator");
  assert.deepEqual(completed.session.roles, ["support-operator"]);
  assert.equal(completed.session.principal.assurance.level, "aal2");
  assert.equal(completed.session.principal.recentStepUpAt, null, "ordinary login does not fabricate recent step-up from amr=mfa");
  assert.equal(completed.returnPath, "/platform?view=support");
  assert.match(completed.cookie, /^oc_platform_session=/);
  assert.match(completed.cookie, /Path=\/api\/v1\/platform/);
  assert.match(completed.cookie, /SameSite=Lax/);
  assert.doesNotMatch(completed.cookie, /SameSite=Strict/);
  assert.doesNotMatch(completed.cookie, /one-time-platform-code|signed-platform-id-token|client-secret/);
  assert.match(tokenRequestBody, /code_verifier=/);
  assert.deepEqual(resolvedIdentity, {
    issuer: "https://login.microsoftonline.com/workforce-tenant/v2.0",
    subject: "operator-object-id",
    workforceTenantId: "workforce-tenant",
  });
  assert.equal("roles" in (resolvedIdentity ?? {}), false, "provider claims never assign platform roles");
  assert.equal("groups" in (resolvedIdentity ?? {}), false);

  const stepUpStarted = await auth.beginStepUp(completed.cookie, "/platform");
  const stepUpLocation = new URL(stepUpStarted.location);
  const stepUpState = stepUpLocation.searchParams.get("state")!;
  assert.equal(stepUpLocation.searchParams.get("redirect_uri"), "https://hosted.example.test/api/v1/platform/auth/step-up/callback");
  assert.equal(stepUpLocation.searchParams.get("max_age"), "0");
  assert.equal(stepUpLocation.searchParams.get("acr_values"), "c1");
  assert.match(stepUpLocation.searchParams.get("claims") ?? "", /auth_time/);
  assert.match(stepUpStarted.cookie, /^oc_platform_step_up_state=/);
  const steppedUp = await auth.completeStepUp({
    state: stepUpState,
    code: "one-time-step-up-code",
    cookie: `${completed.cookie.split(";", 1)[0]}; ${stepUpStarted.cookie.split(";", 1)[0]}`,
  });
  assert.equal(steppedUp.session.principal.recentStepUpAt, "2026-08-09T03:00:00.000Z");
  assert.equal(stepUpMarks[0]?.authenticationContext, "c1", "validated Conditional Access context is persisted as the step-up assurance source");

  const invalidContextStarted = await auth.beginStepUp(completed.cookie, "/platform");
  stepUpContextValid = false;
  await assert.rejects(() => auth.completeStepUp({
    state: new URL(invalidContextStarted.location).searchParams.get("state")!,
    code: "invalid-context-code",
    cookie: `${completed.cookie.split(";", 1)[0]}; ${invalidContextStarted.cookie.split(";", 1)[0]}`,
  }), { code: "PLATFORM_STEP_UP_CONTEXT_INVALID" });

  assert.equal((await auth.authenticate(completed.cookie))?.principal.operatorId, operatorId);
  assert.equal(await auth.authenticate("lemmacomputer_session=customer-session"), null);
  await assert.rejects(
    () => auth.complete({ state, code: "replay", cookie: started.cookie.split(";", 1)[0] }),
    { code: "PLATFORM_OIDC_STATE_EXPIRED" },
  );
});

test("platform workforce OIDC denies wrong-tenant and unprovisioned identities", async () => {
  const attempts = new Map<string, { verifierCiphertext: string; nonce: string; returnPath: string; expiresAt: Date; createdAt: Date; purpose: "login" | "step-up"; operatorSessionId: string | null }>();
  let expectedNonce = "";
  const store = {
    createOperatorLoginAttempt: async (input) => { attempts.set(input.stateHash, input); expectedNonce = input.nonce; },
    consumeOperatorLoginAttempt: async (stateHash) => {
      const value = attempts.get(stateHash) ?? null;
      attempts.delete(stateHash);
      return value;
    },
    resolveWorkforceOperator: async () => null,
    createSession: async () => { throw new Error("must not create session"); },
    markSessionStepUp: async () => null,
    getSession: async () => null,
    revokeSession: async () => false,
  } satisfies PlatformOperatorAuthenticationStore;
  const auth = new PlatformOperatorAuthenticationService(store, {
    tenantId: "workforce-tenant",
    clientId: "platform-operator-client",
    clientSecret: "platform-operator-client-secret",
    publicWebUrl: "https://hosted.example.test",
    stepUpAuthenticationContext: "c1",
    sessionSecret: "separate-platform-session-secret-at-least-32-characters",
    fetch: async () => new Response(JSON.stringify({ id_token: "signed-platform-id-token" }), { status: 200 }),
    idTokenVerifier: async () => ({
      oid: "unprovisioned-object-id",
      tid: "wrong-workforce-tenant",
      nonce: expectedNonce,
      amr: ["mfa"],
    }),
  });
  const started = await auth.begin();
  const state = new URL(started.location).searchParams.get("state")!;
  await assert.rejects(
    () => auth.complete({ state, code: "code", cookie: started.cookie.split(";", 1)[0] }),
    { code: "PLATFORM_OIDC_IDENTITY_INVALID" },
  );

  assert.equal(createHash("sha256").update("sentinel").digest("hex").length, 64);
});
