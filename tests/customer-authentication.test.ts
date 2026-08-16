import assert from "node:assert/strict";
import test from "node:test";

import { MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import { base32 } from "@better-auth/utils/base32";
import Fastify from "fastify";

import {
  createCustomerAuthentication,
  createCustomerSsoAuthentication,
  createInMemoryCustomerAuthenticationDatabase,
  customerAuthenticationBasePath,
  customerAuthenticationControlPath,
  customerAuthenticationOperationOutcome,
  parseVersionedBetterAuthSecrets,
  registerCustomerAuthenticationRoutes,
} from "../apps/control-api/src/customer-authentication.js";
import { CaptureTransactionalEmailAdapter } from "../apps/control-api/src/transactional-email.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";
import { createBetterAuthSessionReader } from "../apps/control-api/src/customer-product-authentication.js";

const origin = "http://localhost:4174";
const companySsoOrigin = "https://idp.example.test";
const request = (path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) => new Request(
  `${origin}${customerAuthenticationBasePath}${path}`,
  {
    method: body ? "POST" : "GET",
    headers: { origin, "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  },
);
const responseCookie = (response: Response, pattern: RegExp) => response.headers.getSetCookie()
  .map((cookie) => cookie.split(";", 1)[0]!)
  .find((cookie) => pattern.test(cookie)) ?? "";

const fixture = () => {
  const email = new CaptureTransactionalEmailAdapter();
  const authentication = createCustomerAuthentication({
    database: createInMemoryCustomerAuthenticationDatabase(),
    baseUrl: origin,
    trustedOrigins: [origin],
    ssoTrustedOrigins: [companySsoOrigin],
    versionedSecrets: [{ version: 1, value: "test-better-auth-secret-at-least-32-characters" }],
    installationKind: "worktree",
    email,
    passkey: { rpId: "localhost", origin },
    socialProviders: {
      google: { clientId: "google-client", clientSecret: "google-secret" },
      microsoft: { clientId: "microsoft-client", clientSecret: "microsoft-secret", tenantId: "common" },
    },
  });
  return { authentication, email };
};

test("customer authentication applies the fail-closed Better Auth security contract", async () => {
  const { authentication } = fixture();
  const options = authentication.options;
  assert.equal(options.baseURL, origin);
  assert.equal(options.basePath, customerAuthenticationBasePath);
  assert.equal(typeof options.trustedOrigins, "function");
  const trustedOrigins = options.trustedOrigins as (request?: Request) => Promise<string[]> | string[];
  assert.deepEqual(await trustedOrigins(), [origin, companySsoOrigin]);
  assert.deepEqual(await trustedOrigins(new Request(`${origin}/`)), [origin]);
  assert.equal(options.emailAndPassword?.enabled, true);
  assert.equal(options.emailAndPassword?.requireEmailVerification, true);
  assert.equal(options.emailAndPassword?.autoSignIn, false);
  assert.equal(options.emailVerification?.autoSignInAfterVerification, true);
  assert.equal(options.emailAndPassword?.revokeSessionsOnPasswordReset, true);
  assert.equal(options.account?.encryptOAuthTokens, true);
  assert.equal(options.account?.accountLinking?.disableImplicitLinking, true);
  assert.equal(options.account?.accountLinking?.allowDifferentEmails, false);
  assert.equal(options.account?.accountLinking?.allowUnlinkingAll, false);
  assert.deepEqual(options.account?.accountLinking?.trustedProviders, ["microsoft"]);
  assert.equal(options.verification?.storeIdentifier, "hashed");
  assert.equal(options.rateLimit?.enabled, true);
  assert.equal(options.rateLimit?.storage, "database");
  assert.equal(options.advanced?.disableCSRFCheck, false);
  assert.equal(options.advanced?.disableOriginCheck, false);
  assert.equal(options.advanced?.crossSubDomainCookies?.enabled, false);
  assert.deepEqual(options.plugins?.map((plugin) => plugin.id), ["two-factor", "passkey", "sso"]);
  assert.equal(options.plugins?.find((plugin) => plugin.id === "two-factor")?.options.allowPasswordless, false);
  const sso = options.plugins?.find((plugin) => plugin.id === "sso");
  assert.equal(sso?.options.disableImplicitSignUp, false);
  assert.equal(sso?.options.organizationProvisioning?.disabled, true);
  assert.deepEqual(sso?.options.domainVerification, { enabled: true, tokenPrefix: "lemmacomputer-sso" });
  assert.equal(sso?.options.saml?.enableInResponseToValidation, true);
  assert.equal(sso?.options.saml?.allowIdpInitiated, false);
  assert.equal(sso?.options.saml?.requireTimestamps, true);
  assert.equal(sso?.options.saml?.algorithms?.onDeprecated, "reject");
  assert.equal(sso?.options.saml?.maxResponseSize, 256 * 1024);
  assert.equal(sso?.options.saml?.maxMetadataSize, 100 * 1024);
  assert.deepEqual(Object.keys(options.socialProviders ?? {}).sort(), ["google", "microsoft"]);
});

test("company SSO authentication permits linking only in its isolated verified-provider callback", () => {
  const database = createInMemoryCustomerAuthenticationDatabase();
  const common = {
    database,
    baseUrl: origin,
    trustedOrigins: [origin],
    ssoTrustedOrigins: [companySsoOrigin],
    versionedSecrets: [{ version: 1, value: "test-better-auth-secret-at-least-32-characters" }],
    installationKind: "worktree" as const,
    email: new CaptureTransactionalEmailAdapter(),
    passkey: { rpId: "localhost", origin },
    socialProviders: {
      google: { clientId: "google-client", clientSecret: "google-secret" },
      microsoft: { clientId: "microsoft-client", clientSecret: "microsoft-secret", tenantId: "common" },
    },
  };
  const customer = createCustomerAuthentication(common);
  const companySso = createCustomerSsoAuthentication(common);

  assert.equal(customer.options.account?.accountLinking?.disableImplicitLinking, true);
  assert.equal(companySso.options.account?.accountLinking?.disableImplicitLinking, false);
  assert.equal(companySso.options.account?.accountLinking?.requireLocalEmailVerified, true);
  assert.equal(companySso.options.basePath, customer.options.basePath);
  assert.deepEqual(companySso.options.secrets, customer.options.secrets);
  assert.deepEqual(Object.keys(companySso.options.socialProviders ?? {}), []);
});

test("customer auth routing delegates only SSO callbacks to the isolated company SSO instance", async () => {
  const calls: string[] = [];
  const options = { baseURL: origin, basePath: customerAuthenticationBasePath };
  const api = { getSession: async () => null };
  const response = () => new Response(null, { status: 204 });
  const customer = { options, api, handler: async () => { calls.push("customer"); return response(); } };
  const companySso = { options, api, handler: async () => { calls.push("company-sso"); return response(); } };
  const app = Fastify();
  registerCustomerAuthenticationRoutes(app, customer as never, companySso as never);
  await app.ready();
  try {
    await app.inject({ method: "GET", url: `${customerAuthenticationControlPath}/callback/microsoft` });
    await app.inject({ method: "GET", url: `${customerAuthenticationControlPath}/sso/callback/provider-one` });
    await app.inject({ method: "POST", url: `${customerAuthenticationControlPath}/sso/saml2/sp/acs/provider-one` });
  } finally {
    await app.close();
  }
  assert.deepEqual(calls, ["customer", "company-sso", "company-sso"]);
});

test("SSO provider administration cannot bypass LemmaComputer tenant authorization", async () => {
  const { authentication } = fixture();
  const app = Fastify();
  registerCustomerAuthenticationRoutes(app, authentication);
  await app.ready();
  try {
    for (const path of [
      "/sso/register",
      "/sso/update-provider",
      "/sso/delete-provider",
      "/sso/request-domain-verification",
      "/sso/verify-domain",
      "/sign-in/sso",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `${customerAuthenticationControlPath}${path}`,
        headers: { origin, "content-type": "application/json" },
        payload: { providerId: "attacker-controlled" },
      });
      assert.equal(response.statusCode, 404, `${path} must be reachable only through guarded product routes`);
    }
    const list = await app.inject({
      method: "GET",
      url: `${customerAuthenticationControlPath}/sso/providers`,
      headers: { origin },
    });
    assert.equal(list.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("company SSO discovery origins must be explicit exact HTTPS origins", () => {
  const common = {
    database: createInMemoryCustomerAuthenticationDatabase(),
    baseUrl: origin,
    trustedOrigins: [origin],
    versionedSecrets: [{ version: 1, value: "test-better-auth-secret-at-least-32-characters" }],
    installationKind: "worktree" as const,
    email: new CaptureTransactionalEmailAdapter(),
    passkey: { rpId: "localhost", origin },
  };
  assert.throws(
    () => createCustomerAuthentication({ ...common, ssoTrustedOrigins: ["https://idp.example.test/path"] }),
    /exact origin/,
  );
  assert.throws(
    () => createCustomerAuthentication({ ...common, ssoTrustedOrigins: ["http://idp.example.test"] }),
    /HTTPS/,
  );
  assert.throws(
    () => createCustomerAuthentication({ ...common, ssoTrustedOrigins: ["https://*.example.test"] }),
    /valid URL|exact origin/,
  );
});

test("authentication audit outcomes treat OAuth error redirects as failures", () => {
  assert.equal(customerAuthenticationOperationOutcome(new Response(null, { status: 401 })), "failed");
  assert.equal(customerAuthenticationOperationOutcome(new Response(null, {
    status: 302,
    headers: { location: `${origin}/provider-error?error=unable_to_link_account` },
  })), "failed");
  assert.equal(customerAuthenticationOperationOutcome(new Response(null, {
    status: 302,
    headers: { location: `${origin}/provider-complete` },
  })), "succeeded");
});

test("disabled social providers are omitted without weakening credential validation", () => {
  const common = {
    database: createInMemoryCustomerAuthenticationDatabase(),
    baseUrl: origin,
    trustedOrigins: [origin],
    versionedSecrets: [{ version: 1, value: "test-better-auth-secret-at-least-32-characters" }],
    installationKind: "worktree" as const,
    email: new CaptureTransactionalEmailAdapter(),
    passkey: { rpId: "localhost", origin },
  };

  const authentication = createCustomerAuthentication({
    ...common,
    socialProviders: { google: undefined, microsoft: undefined },
  });
  assert.deepEqual(authentication.options.socialProviders, {});

  assert.throws(() => createCustomerAuthentication({
    ...common,
    socialProviders: { google: { clientId: "", clientSecret: "configured-secret" } },
  }), /Google social authentication requires both client ID and client secret/i);
});

test("email signup requires verification and duplicate signup is non-enumerating", async () => {
  const { authentication, email } = fixture();
  const body = { name: "Alex Morgan", email: "alex@example.com", password: "correct horse battery staple" };

  const first = await authentication.handler(request("/sign-up/email", body));
  assert.equal(first.status, 200);
  assert.equal(first.headers.has("set-cookie"), false);
  const firstShape = Object.keys(await first.json()).sort();
  const verification = email.take(body.email, "email-verification");
  assert.ok(verification);
  assert.match(verification.subject, /verify/i);
  assert.doesNotMatch(verification.text, /correct horse|battery staple/);

  const duplicate = await authentication.handler(request("/sign-up/email", body));
  assert.equal(duplicate.status, 200);
  assert.deepEqual(Object.keys(await duplicate.json()).sort(), firstShape);
});

test("verification, credential sign-in, and password recovery work through captured links", async () => {
  const { authentication, email } = fixture();
  const credentials = { name: "Alex Morgan", email: "alex@example.com", password: "correct horse battery staple" };
  await authentication.handler(request("/sign-up/email", credentials));
  const verification = email.take(credentials.email, "email-verification");
  assert.ok(verification);
  const verificationUrl = verification.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(verificationUrl);
  const verified = await authentication.handler(new Request(verificationUrl, { headers: { origin } }));
  assert.equal(verified.status, 302);
  assert.match(verified.headers.get("set-cookie") ?? "", /better-auth\.session_token=/);

  const sessionCookie = verified.headers.get("set-cookie") ?? "";
  const customerSession = await createBetterAuthSessionReader(authentication).getSession(
    new Headers({ cookie: sessionCookie }),
  ) as { session?: { id?: string; userId?: string }; user?: { id?: string; emailVerified?: boolean } } | null;
  assert.match(customerSession?.session?.id ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(customerSession?.session?.userId, customerSession?.user?.id);
  assert.equal(customerSession?.user?.emailVerified, true);

  const existingRecovery = await authentication.handler(request("/request-password-reset", {
    email: credentials.email,
    redirectTo: `${origin}/reset-password`,
  }));
  const unknownRecovery = await authentication.handler(request("/request-password-reset", {
    email: "nobody@example.com",
    redirectTo: `${origin}/reset-password`,
  }));
  assert.equal(existingRecovery.status, 200);
  assert.equal(unknownRecovery.status, 200);
  assert.deepEqual(await unknownRecovery.json(), await existingRecovery.json());
  assert.ok(email.take(credentials.email, "password-recovery"));
  assert.equal(email.take("nobody@example.com", "password-recovery"), null);
});

test("TOTP enrollment requires password proof, verification, challenge, and single-use backup codes", async () => {
  const { authentication, email } = fixture();
  const credentials = { name: "Alex Morgan", email: "alex@example.com", password: "correct horse battery staple" };
  await authentication.handler(request("/sign-up/email", credentials));
  const verificationUrl = email.take(credentials.email, "email-verification")?.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(verificationUrl);
  await authentication.handler(new Request(verificationUrl, { headers: { origin } }));
  const signedIn = await authentication.handler(request("/sign-in/email", {
    email: credentials.email,
    password: credentials.password,
  }));
  const initialCookie = (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0]!;

  const missingProof = await authentication.handler(request("/two-factor/enable", {}, { cookie: initialCookie }));
  assert.equal(missingProof.status, 400);

  const enabled = await authentication.handler(request("/two-factor/enable", {
    password: credentials.password,
  }, { cookie: initialCookie }));
  assert.equal(enabled.status, 200);
  const enrollment = await enabled.json() as { totpURI: string; backupCodes: string[] };
  assert.equal(enrollment.backupCodes.length, 10);
  const confirmedTotp = await authentication.api.getTOTPURI({
    headers: new Headers({ cookie: initialCookie }),
    body: { password: credentials.password },
  });
  assert.equal(confirmedTotp.totpURI, enrollment.totpURI);
  const encodedSecret = new URL(confirmedTotp.totpURI).searchParams.get("secret");
  assert.ok(encodedSecret);
  const secret = new TextDecoder().decode(base32.decode(encodedSecret));

  const invalidEnrollment = await authentication.handler(request("/two-factor/verify-totp", {
    code: "000000",
  }, { cookie: initialCookie }));
  assert.ok(invalidEnrollment.status >= 400);

  const enrollmentCode = (await authentication.api.generateTOTP({ body: { secret } })).code;
  const verifiedEnrollment = await authentication.handler(request("/two-factor/verify-totp", {
    code: enrollmentCode,
  }, { cookie: initialCookie }));
    assert.equal(verifiedEnrollment.status, 200);
  const enrolledCookie = (verifiedEnrollment.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
  assert.match(enrolledCookie, /better-auth\.session_token=/);

  await authentication.handler(request("/sign-out", {}, { cookie: enrolledCookie }));
  const challenged = await authentication.handler(request("/sign-in/email", {
    email: credentials.email,
    password: credentials.password,
  }));
  assert.equal((await challenged.clone().json() as { twoFactorRedirect?: boolean }).twoFactorRedirect, true);
  const challengeCookie = responseCookie(challenged, /two_factor/i);
  assert.match(challengeCookie, /two_factor/i);
  const challengeCode = (await authentication.api.generateTOTP({ body: { secret } })).code;
  const challengedSession = await authentication.handler(request("/two-factor/verify-totp", {
    code: challengeCode,
  }, { cookie: challengeCookie }));
  assert.equal(challengedSession.status, 200);

  const challengedSessionCookie = (challengedSession.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
  const invalidStepUp = await authentication.handler(request("/two-factor/verify-totp", {
    code: "000000",
    trustDevice: false,
  }, { cookie: challengedSessionCookie }));
  assert.ok(invalidStepUp.status >= 400);
  const stepUpCode = (await authentication.api.generateTOTP({ body: { secret } })).code;
  const verifiedStepUp = await authentication.handler(request("/two-factor/verify-totp", {
    code: stepUpCode,
    trustDevice: false,
  }, { cookie: challengedSessionCookie }));
  assert.equal(verifiedStepUp.status, 200);

  await authentication.handler(request("/sign-out", {}, { cookie: challengedSessionCookie }));
  const backupChallenge = await authentication.handler(request("/sign-in/email", {
    email: credentials.email,
    password: credentials.password,
  }));
  const backupChallengeCookie = responseCookie(backupChallenge, /two_factor/i);
  const backupSession = await authentication.handler(request("/two-factor/verify-backup-code", {
    code: enrollment.backupCodes[0],
  }, { cookie: backupChallengeCookie }));
  assert.equal(backupSession.status, 200);

  const backupSessionCookie = (backupSession.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
  await authentication.handler(request("/sign-out", {}, { cookie: backupSessionCookie }));
  const replayChallenge = await authentication.handler(request("/sign-in/email", {
    email: credentials.email,
    password: credentials.password,
  }));
  const replayChallengeCookie = responseCookie(replayChallenge, /two_factor/i);
  const replayed = await authentication.handler(request("/two-factor/verify-backup-code", {
    code: enrollment.backupCodes[0],
  }, { cookie: replayChallengeCookie }));
  assert.ok(replayed.status >= 400);
});

test("password recovery and device revocation converge every Better Auth session", async () => {
  const { authentication, email } = fixture();
  const credentials = { name: "Alex Morgan", email: "alex@example.com", password: "correct horse battery staple" };
  await authentication.handler(request("/sign-up/email", credentials));
  const verificationUrl = email.take(credentials.email, "email-verification")?.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(verificationUrl);
  await authentication.handler(new Request(verificationUrl, { headers: { origin } }));
  const signIn = async (password: string) => authentication.handler(request("/sign-in/email", {
    email: credentials.email,
    password,
  }));
  const first = await signIn(credentials.password);
  const second = await signIn(credentials.password);
  const firstCookie = responseCookie(first, /session_token=.*[^=]$/);
  const secondCookie = responseCookie(second, /session_token=.*[^=]$/);
  assert.ok(firstCookie && secondCookie && firstCookie !== secondCookie);

  await authentication.handler(request("/request-password-reset", {
    email: credentials.email,
    redirectTo: `${origin}/reset-password`,
  }));
  const recoveryUrl = email.take(credentials.email, "password-recovery")?.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(recoveryUrl);
  const recoveryToken = new URL(recoveryUrl).pathname.split("/").at(-1);
  assert.ok(recoveryToken);
  const recovered = await authentication.handler(request("/reset-password", {
    newPassword: "new correct horse battery staple",
    token: recoveryToken,
  }));
  assert.equal(recovered.status, 200);
  const reader = createBetterAuthSessionReader(authentication);
  assert.equal(await reader.getSession(new Headers({ cookie: firstCookie })), null);
  assert.equal(await reader.getSession(new Headers({ cookie: secondCookie })), null);
  assert.ok((await signIn(credentials.password)).status >= 400);

  const current = await signIn("new correct horse battery staple");
  const other = await signIn("new correct horse battery staple");
  const currentCookie = responseCookie(current, /session_token=.*[^=]$/);
  const otherCookie = responseCookie(other, /session_token=.*[^=]$/);
  const revokedOther = await authentication.handler(request("/revoke-other-sessions", {}, { cookie: currentCookie }));
  assert.equal(revokedOther.status, 200);
  assert.ok(await reader.getSession(new Headers({ cookie: currentCookie })));
  assert.equal(await reader.getSession(new Headers({ cookie: otherCookie })), null);

  const revokedAll = await authentication.handler(request("/revoke-sessions", {}, { cookie: currentCookie }));
  assert.equal(revokedAll.status, 200);
  assert.equal(await reader.getSession(new Headers({ cookie: currentCookie })), null);
});

test("hosted authentication rejects insecure origins and untrusted proxy configuration", () => {
  const common = {
    database: createInMemoryCustomerAuthenticationDatabase(),
    trustedOrigins: ["http://login.example.com"],
    versionedSecrets: [{ version: 1, value: "test-better-auth-secret-at-least-32-characters" }],
    installationKind: "hosted" as const,
    email: new CaptureTransactionalEmailAdapter(),
    passkey: { rpId: "login.example.com", origin: "http://login.example.com" },
  };
  assert.throws(() => createCustomerAuthentication({ ...common, baseUrl: "http://login.example.com", trustedProxyCidrs: ["192.0.2.10"] }), /HTTPS/);
  assert.throws(() => createCustomerAuthentication({ ...common, baseUrl: "https://login.example.com", trustedOrigins: ["https://login.example.com"], passkey: { rpId: "login.example.com", origin: "https://login.example.com" } }), /trusted proxy/);
  assert.throws(() => createCustomerAuthentication({ ...common, baseUrl: "https://login.example.com", trustedOrigins: ["https://login.example.com"], passkey: { rpId: "login.example.com", origin: "https://login.example.com" }, trustedProxyCidrs: ["not-a-network"] }), /valid IP address or CIDR/);
  const hosted = createCustomerAuthentication({
    ...common,
    baseUrl: "https://login.example.com",
    trustedOrigins: ["https://login.example.com"],
    passkey: { rpId: "login.example.com", origin: "https://login.example.com" },
    trustedProxyCidrs: ["10.0.0.0/8", "2001:db8::/32"],
  });
  assert.deepEqual(hosted.options.advanced?.ipAddress?.trustedProxies, ["10.0.0.0/8", "2001:db8::/32"]);
});

test("mutating authentication requests reject an untrusted browser origin", async () => {
  const { authentication } = fixture();
  const response = await authentication.handler(new Request(`${origin}${customerAuthenticationBasePath}/sign-up/email`, {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: JSON.stringify({
      name: "Mallory",
      email: "mallory@example.test",
      password: "correct horse battery staple",
    }),
  }));
  assert.equal(response.status, 403);
  assert.equal(response.headers.has("set-cookie"), false);
});

test("database-backed abuse limits are shared by independent Better Auth replicas", async () => {
  const database = createInMemoryCustomerAuthenticationDatabase();
  const options = {
    database,
    baseUrl: origin,
    trustedOrigins: [origin],
    versionedSecrets: [{ version: 1, value: "shared-rate-limit-secret-at-least-32-characters" }],
    installationKind: "worktree" as const,
    email: new CaptureTransactionalEmailAdapter({ capacity: 20 }),
    passkey: { rpId: "localhost", origin },
  };
  const replicas = [createCustomerAuthentication(options), createCustomerAuthentication(options)];
  const statuses: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    statuses.push((await replicas[index % replicas.length]!.handler(request("/sign-up/email", {
      name: `Rate Limited ${index}`,
      email: `rate-limited-${index}@example.test`,
      password: "correct horse battery staple",
    }))).status);
  }
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(statuses[5], 429);
});

test("versioned secrets accept a bounded previous key and fail closed after retirement", async () => {
  const database = createInMemoryCustomerAuthenticationDatabase();
  const common = {
    database,
    baseUrl: origin,
    trustedOrigins: [origin],
    installationKind: "worktree" as const,
    email: new CaptureTransactionalEmailAdapter(),
    passkey: { rpId: "localhost", origin },
  };
  const previousSecret = "previous-better-auth-secret-at-least-32-characters";
  const currentSecret = "current-better-auth-secret-at-least-32-characters";
  const previous = createCustomerAuthentication({
    ...common,
    versionedSecrets: [{ version: 1, value: previousSecret }],
  });
  await previous.handler(request("/sign-up/email", {
    name: "Rotation Tester",
    email: "rotation@example.test",
    password: "correct horse battery staple",
  }));
  const verificationUrl = common.email.take("rotation@example.test", "email-verification")?.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(verificationUrl);
  await previous.handler(new Request(verificationUrl, { headers: { origin } }));
  const signedIn = await previous.handler(request("/sign-in/email", {
    email: "rotation@example.test",
    password: "correct horse battery staple",
  }));
  const oldCookie = responseCookie(signedIn, /session_token/);
  assert.ok(oldCookie);
  const enrollment = await previous.handler(request("/two-factor/enable", {
    password: "correct horse battery staple",
  }, { cookie: oldCookie }));
  assert.equal(enrollment.status, 200);

  const duringRotation = createCustomerAuthentication({
    ...common,
    versionedSecrets: [
      { version: 2, value: currentSecret },
      { version: 1, value: previousSecret },
    ],
  });
  assert.equal(await createBetterAuthSessionReader(duringRotation).getSession(new Headers({ cookie: oldCookie })), null,
    "rotating the signing key must fail closed for an old signed browser cookie");
  const rotatedSignIn = await duringRotation.handler(request("/sign-in/email", {
    email: "rotation@example.test",
    password: "correct horse battery staple",
  }));
  const rotatedCookie = responseCookie(rotatedSignIn, /session_token/);
  assert.ok(rotatedCookie);
  const retainedTotp = await duringRotation.api.getTOTPURI({
    headers: new Headers({ cookie: rotatedCookie }),
    body: { password: "correct horse battery staple" },
  });
  assert.match(retainedTotp.totpURI, /^otpauth:\/\/totp\//);

  const afterRetirement = createCustomerAuthentication({
    ...common,
    versionedSecrets: [{ version: 2, value: currentSecret }],
  });
  const retiredSignIn = await afterRetirement.handler(request("/sign-in/email", {
    email: "rotation@example.test",
    password: "correct horse battery staple",
  }));
  const retiredCookie = responseCookie(retiredSignIn, /session_token/);
  assert.ok(retiredCookie);
  await assert.rejects(() => afterRetirement.api.getTOTPURI({
    headers: new Headers({ cookie: retiredCookie }),
    body: { password: "correct horse battery staple" },
  }));
});

test("same-email Google identity is not merged until the signed-in account completes explicit provider proof", async () => {
  const { authentication, email } = fixture();
  const credentials = { name: "Alex Morgan", email: "alex@example.com", password: "correct horse battery staple" };
  await authentication.handler(request("/sign-up/email", credentials));
  const verificationUrl = email.take(credentials.email, "email-verification")?.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(verificationUrl);
  await authentication.handler(new Request(verificationUrl, { headers: { origin } }));
  const signedIn = await authentication.handler(request("/sign-in/email", {
    email: credentials.email,
    password: credentials.password,
  }));
  const sessionCookie = responseCookie(signedIn, /session_token/);
  assert.ok(sessionCookie);

  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const providerIdToken = `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: "google-subject-123",
    email: credentials.email,
    email_verified: true,
    name: credentials.name,
    iss: "https://accounts.google.com",
    aud: "google-client",
    exp: Math.floor(Date.now() / 1000) + 300,
  })}.fixture-signature`;
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const safeLogs: string[] = [];
  console.error = (...values: unknown[]) => { safeLogs.push(values.map(String).join(" ")); };
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("code"), "provider-authorization-code");
    assert.ok(body.get("code_verifier"));
    return new Response(JSON.stringify({
      access_token: "provider-access-token-secret",
      id_token: providerIdToken,
      token_type: "Bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const begin = async (path: "/sign-in/social" | "/link-social", cookie = "") => {
    const started = await authentication.handler(request(path, {
      provider: "google",
      callbackURL: `${origin}/provider-complete`,
      errorCallbackURL: `${origin}/provider-error`,
      disableRedirect: true,
    }, cookie ? { cookie } : {}));
    assert.equal(started.status, 200);
    const payload = await started.json() as { url: string };
    const state = new URL(payload.url).searchParams.get("state");
    assert.ok(state);
    const stateCookies = started.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    assert.ok(stateCookies);
    return { state, stateCookies };
  };
  const complete = (state: string, cookies: string) => authentication.handler(new Request(
    `${origin}${customerAuthenticationBasePath}/callback/google?code=provider-authorization-code&state=${encodeURIComponent(state)}`,
    { headers: { origin, cookie: cookies } },
  ));
  try {
    const implicit = await begin("/sign-in/social");
    const rejected = await complete(implicit.state, implicit.stateCookies);
    assert.equal(rejected.status, 302);
    assert.match(rejected.headers.get("location") ?? "", /provider-error/);
    assert.equal(new URL(rejected.headers.get("location")!).searchParams.get("error"), "account_not_linked");
    assert.deepEqual((await authentication.handler(request("/list-accounts", undefined, { cookie: sessionCookie }))).status, 200);
    const beforeLink = await (await authentication.handler(request("/list-accounts", undefined, { cookie: sessionCookie }))).json() as Array<{ providerId: string }>;
    assert.deepEqual(beforeLink.map((account) => account.providerId), ["credential"]);

    const explicit = await begin("/link-social", sessionCookie);
    const linked = await complete(explicit.state, `${sessionCookie}; ${explicit.stateCookies}`);
    assert.equal(linked.status, 302);
    assert.equal(linked.headers.get("location"), `${origin}/provider-complete`);
    const afterLink = await (await authentication.handler(request("/list-accounts", undefined, { cookie: sessionCookie }))).json() as Array<{ providerId: string }>;
    assert.deepEqual(afterLink.map((account) => account.providerId).sort(), ["credential", "google"]);
    assert.doesNotMatch(JSON.stringify(afterLink), /provider-access-token-secret|authorization-code/i);
    const replayed = await complete(explicit.state, `${sessionCookie}; ${explicit.stateCookies}`);
    assert.equal(replayed.status, 302);
    assert.match(replayed.headers.get("location") ?? "", /error=state_mismatch/);
    assert.ok(safeLogs.length > 0);
    assert.match(safeLogs.join("\n"), /authentication_operation_failed/);
    assert.doesNotMatch(safeLogs.join("\n"), new RegExp(`${explicit.state}|provider-access-token-secret|provider-authorization-code`));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("explicit Microsoft linking trusts provider proof without enabling implicit email linking", async () => {
  const { authentication, email } = fixture();
  const credentials = { name: "Alex Morgan", email: "alex@example.com", password: "correct horse battery staple" };
  await authentication.handler(request("/sign-up/email", credentials));
  const verificationUrl = email.take(credentials.email, "email-verification")?.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(verificationUrl);
  await authentication.handler(new Request(verificationUrl, { headers: { origin } }));
  const signedIn = await authentication.handler(request("/sign-in/email", {
    email: credentials.email,
    password: credentials.password,
  }));
  const sessionCookie = responseCookie(signedIn, /session_token/);
  assert.ok(sessionCookie);

  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const providerIdToken = `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: "microsoft-personal-subject-123",
    email: credentials.email,
    name: credentials.name,
    iss: "https://login.microsoftonline.com/consumers/v2.0",
    aud: "microsoft-client",
    exp: Math.floor(Date.now() / 1_000) + 300,
  })}.fixture-signature`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
      return new Response(JSON.stringify({
        access_token: "microsoft-provider-access-token",
        refresh_token: "microsoft-provider-refresh-token",
        id_token: providerIdToken,
        token_type: "Bearer",
        expires_in: 3_600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/photos/")) return new Response(null, { status: 404 });
    throw new Error(`Unexpected Microsoft fixture request: ${url}`);
  };
  const begin = async (path: "/sign-in/social" | "/link-social", cookie = "") => {
    const started = await authentication.handler(request(path, {
      provider: "microsoft",
      callbackURL: `${origin}/provider-complete`,
      errorCallbackURL: `${origin}/provider-error`,
      disableRedirect: true,
    }, cookie ? { cookie } : {}));
    assert.equal(started.status, 200);
    const state = new URL((await started.json() as { url: string }).url).searchParams.get("state");
    assert.ok(state);
    const stateCookies = started.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    return { state, stateCookies };
  };
  const complete = (state: string, cookies: string) => authentication.handler(new Request(
    `${origin}${customerAuthenticationBasePath}/callback/microsoft?code=provider-authorization-code&state=${encodeURIComponent(state)}`,
    { headers: { origin, cookie: cookies } },
  ));
  try {
    const implicit = await begin("/sign-in/social");
    const rejected = await complete(implicit.state, implicit.stateCookies);
    assert.equal(rejected.status, 302);
    assert.equal(new URL(rejected.headers.get("location")!).searchParams.get("error"), "account_not_linked");

    const explicit = await begin("/link-social", sessionCookie);
    const linked = await complete(explicit.state, `${sessionCookie}; ${explicit.stateCookies}`);
    assert.equal(linked.status, 302);
    assert.equal(linked.headers.get("location"), `${origin}/provider-complete`);
    const accounts = await (await authentication.handler(request("/list-accounts", undefined, { cookie: sessionCookie }))).json() as Array<{ providerId: string }>;
    assert.deepEqual(accounts.map((account) => account.providerId).sort(), ["credential", "microsoft"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid direct provider claims and provider outages fail closed without an authentication cookie", async () => {
  const { authentication } = fixture();
  const invalidClaims = await authentication.handler(request("/sign-in/social", {
    provider: "google",
    idToken: {
      token: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({
        iss: "https://attacker.example",
        aud: "wrong-audience",
        nonce: "wrong-nonce",
        sub: "attacker",
        email: "attacker@example.test",
        email_verified: true,
      })).toString("base64url")}.unsigned`,
      nonce: "expected-nonce",
    },
    callbackURL: `${origin}/provider-complete`,
  }));
  assert.ok(invalidClaims.status >= 400);
  assert.equal(invalidClaims.headers.has("set-cookie"), false);

  const started = await authentication.handler(request("/sign-in/social", {
    provider: "microsoft",
    callbackURL: `${origin}/provider-complete`,
    errorCallbackURL: `${origin}/provider-error`,
    disableRedirect: true,
  }));
  assert.equal(started.status, 200);
  const authorizationUrl = new URL((await started.json() as { url: string }).url);
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);
  const stateCookies = started.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("provider unavailable", { status: 503 });
  try {
    const failed = await authentication.handler(new Request(
      `${origin}${customerAuthenticationBasePath}/callback/microsoft?code=provider-code&state=${encodeURIComponent(state)}`,
      { headers: { origin, cookie: stateCookies } },
    ));
    assert.equal(failed.status, 302);
    assert.match(failed.headers.get("location") ?? "", /provider-error/);
    assert.equal(failed.headers.getSetCookie().some((cookie) => /session_token=/.test(cookie) && !/session_token=;/.test(cookie)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider linking requires a recent authenticated session before OAuth is started", async () => {
  const { authentication, email } = fixture();
  const credentials = { name: "Alex Morgan", email: "alex@example.com", password: "correct horse battery staple" };
  await authentication.handler(request("/sign-up/email", credentials));
  const verificationUrl = email.take(credentials.email, "email-verification")?.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(verificationUrl);
  await authentication.handler(new Request(verificationUrl, { headers: { origin } }));
  const signedIn = await authentication.handler(request("/sign-in/email", {
    email: credentials.email,
    password: credentials.password,
  }));
  const sessionCookie = responseCookie(signedIn, /session_token/);
  assert.ok(sessionCookie);

  const app = Fastify();
  registerCustomerAuthenticationRoutes(app, {
    ...authentication,
    api: {
      ...authentication.api,
      getSession: async () => ({
        session: {
          createdAt: new Date(Date.now() - 60 * 60 * 1_000),
          updatedAt: new Date(Date.now() - 60 * 60 * 1_000),
        },
      }),
    } as typeof authentication.api,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `${customerAuthenticationControlPath}/link-social`,
      headers: { origin, cookie: sessionCookie, "content-type": "application/json" },
      payload: {
        provider: "google",
        callbackURL: `${origin}/provider-complete`,
        disableRedirect: true,
      },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      code: "SESSION_NOT_FRESH",
      message: "Sign in again before linking another identity provider.",
    });
  } finally {
    await app.close();
  }
});

test("versioned authentication secrets are explicit, ordered, and rotation-safe", () => {
  assert.deepEqual(parseVersionedBetterAuthSecrets("3:current-secret-value-with-at-least-32-characters,2:previous-secret-value-with-at-least-32-characters"), [
    { version: 3, value: "current-secret-value-with-at-least-32-characters" },
    { version: 2, value: "previous-secret-value-with-at-least-32-characters" },
  ]);
  assert.throws(() => parseVersionedBetterAuthSecrets(""), /required/);
  assert.throws(() => parseVersionedBetterAuthSecrets("1:short"), /32 characters/);
  assert.throws(() => parseVersionedBetterAuthSecrets("1:12345678901234567890123456789012,1:abcdefghijklmnopqrstuvwxyz123456"), /strictly descending/);
  assert.throws(() => parseVersionedBetterAuthSecrets("1:12345678901234567890123456789012,2:abcdefghijklmnopqrstuvwxyz123456"), /strictly descending/);
});

test("Control mounts the embedded handler only under the customer authentication namespace", async () => {
  const { authentication, email } = fixture();
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    "customer-auth-test-proxy-token-at-least-24-characters",
    undefined,
    undefined,
    { publicWebUrl: origin },
    { customerAuthentication: authentication, developmentEmailCapture: email, testIdentityMode: true },
  );
  try {
    const available = await app.inject({
      method: "GET",
      url: `${customerAuthenticationControlPath}/ok`,
      headers: {
        origin,
        "x-lemmacomputer-proxy-token": "customer-auth-test-proxy-token-at-least-24-characters",
      },
    });
    assert.equal(available.statusCode, 200);

    const capabilities = await app.inject({
      method: "GET",
      url: "/v1/auth/customer-capabilities",
      headers: { "x-lemmacomputer-proxy-token": "customer-auth-test-proxy-token-at-least-24-characters" },
    });
    assert.equal(capabilities.statusCode, 200);
    assert.deepEqual(capabilities.json(), {
      emailPassword: true,
      passkey: true,
      socialProviders: ["google", "microsoft"],
      companySso: false,
      developmentEmailCapture: true,
    });

    await email.send({
      kind: "email-verification",
      to: "person@example.test",
      subject: "Verify your email for LemmaComputer",
      text: `Finish creating your account.\n\n${origin}/api/v1/auth/customer/verify-email?token=secret\n\nIgnore this email if it was unexpected.`,
      html: "<p>Captured locally.</p>",
    });
    const captured = await app.inject({
      method: "POST",
      url: "/v1/auth/development-email-capture",
      headers: {
        origin,
        "content-type": "application/json",
        "x-lemmacomputer-proxy-token": "customer-auth-test-proxy-token-at-least-24-characters",
      },
      payload: { email: "PERSON@example.test", kind: "email-verification" },
    });
    assert.equal(captured.statusCode, 200);
    assert.deepEqual(captured.json(), { url: `${origin}/api/v1/auth/customer/verify-email?token=secret` });

    const consumed = await app.inject({
      method: "POST",
      url: "/v1/auth/development-email-capture",
      headers: {
        origin,
        "content-type": "application/json",
        "x-lemmacomputer-proxy-token": "customer-auth-test-proxy-token-at-least-24-characters",
      },
      payload: { email: "person@example.test", kind: "email-verification" },
    });
    assert.equal(consumed.statusCode, 404);

    const bypass = await app.inject({ method: "GET", url: `${customerAuthenticationControlPath}/ok` });
    assert.equal(bypass.statusCode, 401);

    const outside = await app.inject({
      method: "GET",
      url: `${customerAuthenticationBasePath}/ok`,
      headers: { "x-lemmacomputer-proxy-token": "customer-auth-test-proxy-token-at-least-24-characters" },
    });
    assert.equal(outside.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("anonymous worktree signup can consume its captured verification link", async () => {
  const { authentication, email } = fixture();
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    "customer-auth-test-proxy-token-at-least-24-characters",
    undefined,
    undefined,
    { publicWebUrl: origin },
    {
      customerAuthentication: authentication,
      developmentEmailCapture: email,
      customerProductAuthentication: { resolve: async () => ({ status: "anonymous" }) } as never,
      agentBridgeSecret: "customer-auth-capture-agent-secret-at-least-32-characters",
    },
  );
  try {
    await email.send({
      kind: "email-verification",
      to: "anonymous@example.test",
      subject: "Verify your email for LemmaComputer",
      text: `Finish creating your account.\n\n${origin}/api/v1/auth/customer/verify-email?token=secret\n\nIgnore this email if it was unexpected.`,
      html: "<p>Captured locally.</p>",
    });

    const captured = await app.inject({
      method: "POST",
      url: "/v1/auth/development-email-capture",
      headers: {
        origin,
        "content-type": "application/json",
        "x-lemmacomputer-proxy-token": "customer-auth-test-proxy-token-at-least-24-characters",
      },
      payload: { email: "anonymous@example.test", kind: "email-verification" },
    });

    assert.equal(captured.statusCode, 200);
    assert.deepEqual(captured.json(), { url: `${origin}/api/v1/auth/customer/verify-email?token=secret` });
  } finally {
    await app.close();
  }
});
