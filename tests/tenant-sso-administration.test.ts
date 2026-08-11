import assert from "node:assert/strict";
import test from "node:test";

import {
  createBetterAuthTenantSsoAuthenticationAdministration,
  TenantSsoAdministrationService,
  type TenantSsoAuthenticationAdministration,
} from "../apps/control-api/src/tenant-sso.js";
import type {
  OrganizationSsoConnectionSummary,
  OrganizationSsoTransition,
} from "@lemmacomputer/workspace-store";

const headers = new Headers({ cookie: "better-auth.session_token=opaque" });
const baseConnection: OrganizationSsoConnectionSummary = {
  id: "2a0f8eef-132a-4421-9a95-58d6cfcdb0bd",
  organizationId: "organization-one",
  authenticationProviderId: "sso_generated_provider",
  protocol: "oidc",
  domain: "example.test",
  issuer: "https://idp.example.test/tenant",
  state: "pending",
  configVersion: 1,
  domainVerifiedAt: null,
  lastTestedAt: null,
  recoveryConfirmedAt: null,
  enforcedAt: null,
  suspendedAt: null,
  disconnectedAt: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

test("tenant SSO registration sends credentials only to Better Auth and compensates projection failures", async () => {
  const authenticationCalls: Array<Record<string, unknown>> = [];
  let deletedProvider = "";
  const authentication: TenantSsoAuthenticationAdministration = {
    registerProvider: async (_headers, input) => {
      authenticationCalls.push(input as unknown as Record<string, unknown>);
      return { domainVerificationToken: "dns-proof", redirectURI: "https://app.example.test/sso/callback" };
    },
    requestDomainVerification: async () => ({ domainVerificationToken: "dns-proof", redirectURI: "https://app.example.test/sso/callback" }),
    verifyDomain: async () => undefined,
    startSignIn: async () => ({ url: "https://idp.example.test/authorize", redirect: true, cookies: [] }),
    listAccounts: async () => [],
    updateProvider: async () => undefined,
    refreshProviderMetadata: async () => undefined,
    deleteProvider: async (_headers, providerId) => { deletedProvider = providerId; },
  };
  const storedInputs: Array<Record<string, unknown>> = [];
  let failProjection = false;
  const store = {
    listOrganizationSsoConnections: async () => [],
    createOrganizationSsoConnection: async (input: Record<string, unknown>) => {
      storedInputs.push(input);
      if (failProjection) throw new Error("projection failed");
      return baseConnection;
    },
    transitionOrganizationSsoConnection: async () => baseConnection,
  };
  const service = new TenantSsoAdministrationService(authentication, store, () => "sso_generated_provider");
  await assert.rejects(() => service.register(headers, {
    organizationId: "organization-one",
    actorUserId: "owner-one",
    protocol: "oidc",
    domain: "example.test",
    issuer: "https://idp.example.test/tenant",
    clientId: "duplicated-credential",
    clientSecret: "duplicated-credential",
  }), { code: "SSO_CREDENTIALS_INVALID" });
  assert.equal(authenticationCalls.length, 0);
  assert.equal(storedInputs.length, 0);

  const created = await service.register(headers, {
    organizationId: "organization-one",
    actorUserId: "owner-one",
    protocol: "oidc",
    domain: "example.test",
    issuer: "https://idp.example.test/tenant",
    clientId: "client-id",
    clientSecret: "client-secret-never-project",
  });
  assert.equal(created.connection.authenticationProviderId, "sso_generated_provider");
  assert.deepEqual(created.domainVerification, { token: "dns-proof", redirectURI: "https://app.example.test/sso/callback" });
  assert.match(JSON.stringify(authenticationCalls), /client-secret-never-project/);
  assert.doesNotMatch(JSON.stringify(storedInputs), /client-secret-never-project|client-id/);
  assert.doesNotMatch(JSON.stringify(created), /client-secret-never-project|client-id/);

  failProjection = true;
  await assert.rejects(() => service.register(headers, {
    organizationId: "organization-one",
    actorUserId: "owner-one",
    protocol: "oidc",
    domain: "second.example.test",
    issuer: "https://idp.example.test/second",
    clientId: "second-client",
    clientSecret: "second-secret",
  }), /projection failed/);
  assert.equal(deletedProvider, "sso_generated_provider");
});

test("domain proof, real account proof, and product transitions remain server ordered", async () => {
  const authenticationOrder: string[] = [];
  const signIns: Array<Record<string, unknown>> = [];
  let accounts: Array<{ providerId: string }> = [];
  const authentication: TenantSsoAuthenticationAdministration = {
    registerProvider: async () => ({ domainVerificationToken: "proof", redirectURI: "https://app/callback" }),
    requestDomainVerification: async (_headers, providerId) => {
      authenticationOrder.push(`authentication.proof:${providerId}`);
      return { domainVerificationToken: "replacement-proof", redirectURI: "https://app/callback" };
    },
    verifyDomain: async () => { authenticationOrder.push("authentication.domain_verified"); },
    startSignIn: async (_headers, input) => {
      authenticationOrder.push("authentication.sign_in");
      signIns.push(input);
      return { url: "https://idp.example.test/authorize", redirect: true, cookies: [] };
    },
    listAccounts: async () => accounts,
    updateProvider: async () => undefined,
    refreshProviderMetadata: async (_headers, providerId, input) => {
      authenticationOrder.push(`authentication.metadata:${providerId}:${input.protocol}`);
    },
    deleteProvider: async () => undefined,
  };
  const transitions: OrganizationSsoTransition[] = [];
  const store = {
    listOrganizationSsoConnections: async () => [baseConnection],
    createOrganizationSsoConnection: async () => baseConnection,
    transitionOrganizationSsoConnection: async (input: { action: OrganizationSsoTransition }) => {
      transitions.push(input.action);
      return { ...baseConnection, state: input.action === "test_succeeded" ? "active" as const : baseConnection.state };
    },
  };
  const service = new TenantSsoAdministrationService(authentication, store);
  const proof = await service.requestDomainVerification(headers, "organization-one", baseConnection.id);
  assert.deepEqual(proof, {
    connectionId: baseConnection.id,
    providerId: baseConnection.authenticationProviderId,
    domain: baseConnection.domain,
    token: "replacement-proof",
    redirectURI: "https://app/callback",
  });
  await service.verifyDomain(headers, "organization-one", baseConnection.id, "owner-one");
  assert.deepEqual(authenticationOrder, [
    `authentication.proof:${baseConnection.authenticationProviderId}`,
    "authentication.domain_verified",
  ]);
  assert.deepEqual(transitions, ["domain_verified"]);

  const started = await service.startTest(headers, "organization-one", baseConnection.id);
  assert.equal(started.location, "https://idp.example.test/authorize");
  assert.deepEqual(authenticationOrder.slice(-2), [
    `authentication.metadata:${baseConnection.authenticationProviderId}:oidc`,
    "authentication.sign_in",
  ]);
  assert.deepEqual(signIns, [{
    providerId: baseConnection.authenticationProviderId,
    callbackURL: `/sso-test/${baseConnection.id}`,
    errorCallbackURL: `/sso-test/${baseConnection.id}`,
  }]);
  accounts = [{ providerId: "credential" }];
  await assert.rejects(
    () => service.completeTest(headers, "organization-one", baseConnection.id, "owner-one"),
    { code: "SSO_TEST_PROOF_MISSING" },
  );
  accounts = [{ providerId: baseConnection.authenticationProviderId }];
  await service.completeTest(headers, "organization-one", baseConnection.id, "owner-one");
  assert.deepEqual(transitions, ["domain_verified", "test_succeeded"]);
});

test("Better Auth administration uses hardened provider shapes without delegating product organization authority", async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const authentication = {
    options: {
      baseURL: "https://app.example.test",
      basePath: "/api/v1/auth/customer",
      trustedOrigins: () => ["https://app.example.test", "https://idp.example.test"],
    },
    api: {
      registerSSOProvider: async (input: Record<string, unknown>) => {
        calls.push({ operation: "register", input });
        return { domainVerificationToken: "dns-proof", redirectURI: "https://app.example.test/oidc-callback" };
      },
      verifyDomain: async (input: Record<string, unknown>) => { calls.push({ operation: "verify", input }); },
      signInSSO: async (input: Record<string, unknown>) => {
        calls.push({ operation: "sign-in", input });
        const responseHeaders = new Headers();
        responseHeaders.append("set-cookie", "better-auth.sso_state=signed-state; Path=/; HttpOnly; SameSite=Lax");
        responseHeaders.append("set-cookie", "better-auth.sso_pkce=signed-verifier; Path=/; HttpOnly; SameSite=Lax");
        return new Response(JSON.stringify({ url: "https://idp.example.test/authorize", redirect: true }), {
          status: 200,
          headers: responseHeaders,
        });
      },
      listUserAccounts: async (input: Record<string, unknown>) => {
        calls.push({ operation: "accounts", input });
        return [{ providerId: "sso_provider" }];
      },
      getSSOProvider: async (input: Record<string, unknown>) => {
        calls.push({ operation: "get", input });
        return { oidcConfig: { discoveryEndpoint: "https://idp.example.test/.well-known/openid-configuration" } };
      },
      updateSSOProvider: async (input: Record<string, unknown>) => { calls.push({ operation: "update", input }); },
      deleteSSOProvider: async (input: Record<string, unknown>) => { calls.push({ operation: "delete", input }); },
    },
  };
  const adapter = createBetterAuthTenantSsoAuthenticationAdministration(authentication as never);
  await adapter.registerProvider(headers, {
    providerId: "sso_provider",
    organizationId: "product-org-only",
    protocol: "oidc",
    domain: "example.test",
    issuer: "https://idp.example.test/tenant",
    clientId: "client-id",
    clientSecret: "client-secret",
  });
  const oidcBody = calls[0]!.input.body as Record<string, unknown>;
  assert.equal(oidcBody.organizationId, undefined);
  assert.deepEqual(oidcBody.oidcConfig, {
    clientId: "client-id",
    clientSecret: "client-secret",
    pkce: true,
    scopes: ["openid", "email", "profile", "offline_access"],
    mapping: { id: "sub", email: "email", emailVerified: "email_verified", name: "name" },
  });

  await adapter.registerProvider(headers, {
    providerId: "sso_entra_provider",
    organizationId: "product-org-only",
    protocol: "oidc",
    domain: "example.test",
    issuer: "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0",
    clientId: "entra-client-id",
    clientSecret: "entra-client-secret",
  });
  const entraBody = calls[1]!.input.body as Record<string, unknown>;
  assert.deepEqual(entraBody.oidcConfig, {
    clientId: "entra-client-id",
    clientSecret: "entra-client-secret",
    pkce: true,
    scopes: ["openid", "email", "profile", "offline_access"],
    mapping: { id: "sub", email: "email", emailVerified: "email_verified", name: "name" },
  });

  await adapter.registerProvider(headers, {
    providerId: "sso_saml_provider",
    organizationId: "product-org-only",
    protocol: "saml",
    domain: "saml.example.test",
    issuer: "https://saml.example.test/entity",
    entryPoint: "https://saml.example.test/login",
    certificate: "certificate",
  });
  const samlBody = calls[2]!.input.body as Record<string, unknown>;
  assert.equal(samlBody.organizationId, undefined);
  assert.deepEqual(samlBody.samlConfig, {
    entryPoint: "https://saml.example.test/login",
    cert: "certificate",
    callbackUrl: "https://app.example.test/api/v1/auth/customer/sso/saml2/sp/acs/sso_saml_provider",
    spMetadata: {},
    wantAssertionsSigned: true,
    authnRequestsSigned: false,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    mapping: { id: "nameID", email: "email", name: "displayName" },
  });

  const started = await adapter.startSignIn(headers, {
    providerId: "sso_provider",
    callbackURL: "/invite",
    requestSignUp: true,
  }) as { url: string; redirect: boolean; cookies?: string[] };
  assert.equal(started.url, "https://idp.example.test/authorize");
  assert.equal(started.redirect, true);
  assert.deepEqual(started.cookies, [
    "better-auth.sso_state=signed-state; Path=/; HttpOnly; SameSite=Lax",
    "better-auth.sso_pkce=signed-verifier; Path=/; HttpOnly; SameSite=Lax",
  ]);
  const signInCall = calls.findLast((call) => call.operation === "sign-in")?.input;
  assert.equal(signInCall?.asResponse, true);
  assert.deepEqual(signInCall?.body, {
    providerId: "sso_provider",
    callbackURL: "/invite",
    errorCallbackURL: "/invite",
    newUserCallbackURL: "/invite",
    requestSignUp: true,
  });

  await adapter.startSignIn(headers, {
    providerId: "sso_provider",
    callbackURL: "/sso-test/success",
    errorCallbackURL: "/sso-test/failure",
  });
  const testSignInCall = calls.findLast((call) => call.operation === "sign-in")?.input;
  assert.deepEqual(testSignInCall?.body, {
    providerId: "sso_provider",
    callbackURL: "/sso-test/success",
    errorCallbackURL: "/sso-test/failure",
    newUserCallbackURL: "/sso-test/success",
    requestSignUp: false,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    issuer: "https://idp.example.test/tenant",
    authorization_endpoint: "https://idp.example.test/oauth2/authorize",
    token_endpoint: "https://idp.example.test/oauth2/token",
    jwks_uri: "https://idp.example.test/oauth2/jwks",
    userinfo_endpoint: "https://idp.example.test/oauth2/userinfo",
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await adapter.refreshProviderMetadata(headers, "sso_provider", {
      protocol: "oidc",
      issuer: "https://idp.example.test/tenant",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const oidcRefresh = calls.findLast((call) => call.operation === "update")?.input.body as Record<string, unknown>;
  assert.deepEqual(oidcRefresh, {
    providerId: "sso_provider",
    oidcConfig: {
      discoveryEndpoint: "https://idp.example.test/.well-known/openid-configuration",
      authorizationEndpoint: "https://idp.example.test/oauth2/authorize",
      tokenEndpoint: "https://idp.example.test/oauth2/token",
      jwksEndpoint: "https://idp.example.test/oauth2/jwks",
      userInfoEndpoint: "https://idp.example.test/oauth2/userinfo",
      tokenEndpointAuthentication: "client_secret_basic",
      scopes: ["openid", "email", "profile", "offline_access"],
      mapping: { id: "sub", email: "email", emailVerified: "email_verified", name: "name" },
    },
  });
  await adapter.refreshProviderMetadata(headers, "sso_saml_provider", {
    protocol: "saml",
    metadata: "<EntityDescriptor>bounded identity provider metadata</EntityDescriptor>",
  });
  assert.deepEqual(calls.findLast((call) => call.operation === "update")?.input.body, {
    providerId: "sso_saml_provider",
    samlConfig: { idpMetadata: { metadata: "<EntityDescriptor>bounded identity provider metadata</EntityDescriptor>" } },
  });
});

test("public company sign-in resolves only enforced domains and never accepts a provider identifier from the browser", async () => {
  const signIns: Array<Record<string, unknown>> = [];
  const authentication: TenantSsoAuthenticationAdministration = {
    registerProvider: async () => ({ domainVerificationToken: "proof", redirectURI: "https://app/callback" }),
    requestDomainVerification: async () => ({ domainVerificationToken: "proof", redirectURI: "https://app/callback" }),
    verifyDomain: async () => undefined,
    startSignIn: async (_headers, input) => {
      signIns.push(input);
      return { url: "https://idp.example.test/authorize", redirect: true, cookies: [] };
    },
    listAccounts: async () => [],
    updateProvider: async () => undefined,
    refreshProviderMetadata: async () => undefined,
    deleteProvider: async () => undefined,
  };
  let resolvedDomain = "";
  const store = {
    listOrganizationSsoConnections: async () => [],
    findEnforcedOrganizationSsoConnectionByDomain: async (domain: string) => {
      resolvedDomain = domain;
      return domain === "example.test" ? { ...baseConnection, state: "enforced" as const } : null;
    },
    createOrganizationSsoConnection: async () => baseConnection,
    transitionOrganizationSsoConnection: async () => baseConnection,
  };
  const service = new TenantSsoAdministrationService(authentication, store);
  const started = await service.startEnforcedSignIn(headers, "Person@Example.Test", "/");
  assert.equal(resolvedDomain, "example.test");
  assert.equal(started.location, "https://idp.example.test/authorize");
  assert.deepEqual(signIns, [{
    providerId: baseConnection.authenticationProviderId,
    callbackURL: "/",
    requestSignUp: true,
    loginHint: "person@example.test",
  }]);
  await assert.rejects(
    () => service.startEnforcedSignIn(headers, "person@unknown.test", "/"),
    { code: "COMPANY_SSO_UNAVAILABLE" },
  );
});

test("an invitation uses only a verified and successfully tested provider", async () => {
  const signIns: Array<Record<string, unknown>> = [];
  const authentication: TenantSsoAuthenticationAdministration = {
    registerProvider: async () => ({ domainVerificationToken: "proof", redirectURI: "https://app/callback" }),
    requestDomainVerification: async () => ({ domainVerificationToken: "proof", redirectURI: "https://app/callback" }),
    verifyDomain: async () => undefined,
    startSignIn: async (_headers, input) => {
      signIns.push(input);
      return { url: "https://idp.example.test/authorize", redirect: true, cookies: [] };
    },
    listAccounts: async () => [],
    updateProvider: async () => undefined,
    refreshProviderMetadata: async () => undefined,
    deleteProvider: async () => undefined,
  };
  const pendingVerified = { ...baseConnection, domainVerifiedAt: "2026-08-10T00:10:00.000Z" };
  let connections: OrganizationSsoConnectionSummary[] = [pendingVerified];
  const store = {
    listOrganizationSsoConnections: async (organizationId: string) => organizationId === baseConnection.organizationId
      ? connections
      : [],
    findEnforcedOrganizationSsoConnectionByDomain: async () => null,
    createOrganizationSsoConnection: async () => baseConnection,
    transitionOrganizationSsoConnection: async () => baseConnection,
  };
  const service = new TenantSsoAdministrationService(authentication, store);
  assert.equal(await service.isInvitationSignInAvailable(baseConnection.organizationId, "invited@example.test"), false);
  await assert.rejects(
    () => service.startInvitationSignIn(headers, baseConnection.organizationId, "invited@example.test"),
    { code: "COMPANY_SSO_UNAVAILABLE" },
  );

  connections = [{
    ...pendingVerified,
    state: "active",
    lastTestedAt: "2026-08-10T00:20:00.000Z",
  }];
  assert.equal(await service.isInvitationSignInAvailable(baseConnection.organizationId, "invited@example.test"), true);
  assert.equal(await service.isInvitationSignInAvailable(baseConnection.organizationId, "invited@unknown.test"), false);
  const started = await service.startInvitationSignIn(headers, baseConnection.organizationId, "invited@example.test");
  assert.equal(started.location, "https://idp.example.test/authorize");
  assert.deepEqual(signIns, [{
    providerId: baseConnection.authenticationProviderId,
    callbackURL: "/invite",
    requestSignUp: true,
    loginHint: "invited@example.test",
  }]);
  await assert.rejects(
    () => service.startInvitationSignIn(headers, "organization-two", "invited@example.test"),
    { code: "COMPANY_SSO_UNAVAILABLE" },
  );
});

test("credential rotation fences enforced routing before changing Better Auth secrets", async () => {
  const order: string[] = [];
  const authentication: TenantSsoAuthenticationAdministration = {
    registerProvider: async () => ({ domainVerificationToken: "proof", redirectURI: "https://app/callback" }),
    requestDomainVerification: async () => ({ domainVerificationToken: "proof", redirectURI: "https://app/callback" }),
    verifyDomain: async () => undefined,
    startSignIn: async () => ({ url: "https://idp.example.test/authorize", redirect: true, cookies: [] }),
    listAccounts: async () => [],
    updateProvider: async (_headers, providerId, input) => {
      order.push(`authentication:${providerId}:${JSON.stringify(input)}`);
    },
    refreshProviderMetadata: async () => undefined,
    deleteProvider: async () => undefined,
  };
  const enforced = {
    ...baseConnection,
    state: "enforced" as const,
    domainVerifiedAt: "2026-08-10T00:10:00.000Z",
    lastTestedAt: "2026-08-10T00:20:00.000Z",
    recoveryConfirmedAt: "2026-08-10T00:30:00.000Z",
    enforcedAt: "2026-08-10T00:40:00.000Z",
  };
  const pending = {
    ...enforced,
    state: "pending" as const,
    configVersion: 2,
    lastTestedAt: null,
    recoveryConfirmedAt: null,
    enforcedAt: null,
  };
  const store = {
    listOrganizationSsoConnections: async () => [enforced],
    findEnforcedOrganizationSsoConnectionByDomain: async () => enforced,
    createOrganizationSsoConnection: async () => enforced,
    transitionOrganizationSsoConnection: async () => enforced,
    prepareOrganizationSsoConfigurationChange: async (input: Record<string, unknown>) => {
      order.push(`projection:${JSON.stringify(input)}`);
      return pending;
    },
  };
  const service = new TenantSsoAdministrationService(authentication, store);
  await assert.rejects(() => service.rotateCredentials(headers, {
    organizationId: enforced.organizationId,
    connectionId: enforced.id,
    actorUserId: "owner-one",
    protocol: "oidc",
    clientId: "duplicated-credential",
    clientSecret: "duplicated-credential",
  }), { code: "SSO_CREDENTIALS_INVALID" });
  assert.deepEqual(order, []);

  const rotated = await service.rotateCredentials(headers, {
    organizationId: enforced.organizationId,
    connectionId: enforced.id,
    actorUserId: "owner-one",
    protocol: "oidc",
    clientId: "replacement-client",
    clientSecret: "replacement-secret",
  });

  assert.equal(rotated.state, "pending");
  assert.equal(rotated.configVersion, 2);
  assert.match(order[0]!, /^projection:/);
  assert.match(order[1]!, /^authentication:sso_generated_provider:/);
  assert.deepEqual(JSON.parse(order[1]!.split(":").slice(2).join(":")), {
    oidcConfig: { clientId: "replacement-client", clientSecret: "replacement-secret" },
  });
});

test("metadata refresh fences routing before replacing authentication metadata", async () => {
  const order: string[] = [];
  const authentication: TenantSsoAuthenticationAdministration = {
    registerProvider: async () => ({ domainVerificationToken: "proof", redirectURI: "https://app/callback" }),
    requestDomainVerification: async () => ({ domainVerificationToken: "proof", redirectURI: "https://app/callback" }),
    verifyDomain: async () => undefined,
    startSignIn: async () => ({ url: "https://idp.example.test/authorize", redirect: true, cookies: [] }),
    listAccounts: async () => [],
    updateProvider: async () => undefined,
    refreshProviderMetadata: async (_headers, providerId, input) => {
      order.push(`authentication:${providerId}:${JSON.stringify(input)}`);
    },
    deleteProvider: async () => undefined,
  };
  const enforced = { ...baseConnection, state: "enforced" as const };
  const pending = { ...enforced, state: "pending" as const, configVersion: 2 };
  const store = {
    listOrganizationSsoConnections: async () => [enforced],
    findEnforcedOrganizationSsoConnectionByDomain: async () => enforced,
    createOrganizationSsoConnection: async () => enforced,
    transitionOrganizationSsoConnection: async () => enforced,
    prepareOrganizationSsoConfigurationChange: async (input: Record<string, unknown>) => {
      order.push(`projection:${JSON.stringify(input)}`);
      return pending;
    },
  };
  const service = new TenantSsoAdministrationService(authentication, store);
  const refreshed = await service.refreshMetadata(headers, {
    organizationId: enforced.organizationId,
    connectionId: enforced.id,
    actorUserId: "owner-one",
    protocol: "oidc",
  });
  assert.equal(refreshed.state, "pending");
  assert.match(order[0]!, /"change":"metadata_refreshed"/);
  assert.deepEqual(JSON.parse(order[1]!.split(":").slice(2).join(":")), {
    protocol: "oidc",
    issuer: enforced.issuer,
  });
});
