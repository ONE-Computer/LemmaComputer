import assert from "node:assert/strict";
import test from "node:test";

import type { ControllerClient } from "../apps/control-api/src/service.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { TenantSsoAdministrationService } from "../apps/control-api/src/tenant-sso.js";
import { MemoryWorkspaceStore, type SessionPrincipal } from "@lemmacomputer/workspace-store";

const proxyToken = "tenant-sso-api-proxy-token-at-least-24-characters";
const actor: SessionPrincipal = {
  userId: "owner-one",
  tenantId: "organization-one",
  organizationId: "organization-one",
  membershipId: "membership-one",
  membershipStatus: "active",
  role: "owner",
  email: "owner@example.test",
  displayName: "Owner",
  tenantDisplayName: "Example",
  roles: ["employee", "administrator"],
  identity: { tenantId: "organization-one", subjectId: "owner-one", audience: "lemmacomputer-control" },
};
const administrator: SessionPrincipal = {
  ...actor,
  userId: "administrator-one",
  membershipId: "membership-administrator-one",
  role: "admin",
  email: "administrator@example.test",
  displayName: "Administrator",
  identity: { tenantId: "organization-one", subjectId: "administrator-one", audience: "lemmacomputer-control" },
};

test("tenant SSO administration routes bind every action to the authenticated organization and protect enforcement", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const connection = {
    id: "2a0f8eef-132a-4421-9a95-58d6cfcdb0bd",
    organizationId: actor.tenantId,
    authenticationProviderId: "sso_provider",
    protocol: "oidc" as const,
    domain: "example.test",
    issuer: "https://idp.example.test/tenant",
    state: "pending" as const,
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
  const administration = {
    list: async (organizationId: string) => {
      calls.push({ operation: "list", organizationId });
      return [connection];
    },
    register: async (_headers: Headers, input: Record<string, unknown>) => {
      calls.push({ operation: "register", ...input });
      return { connection, domainVerification: { token: "proof", redirectURI: "https://app.example.test/callback" } };
    },
    verifyDomain: async (_headers: Headers, organizationId: string, connectionId: string, actorUserId: string) => {
      calls.push({ operation: "verify", organizationId, connectionId, actorUserId });
      return connection;
    },
    requestDomainVerification: async (_headers: Headers, organizationId: string, connectionId: string) => {
      calls.push({ operation: "proof", organizationId, connectionId });
      return {
        connectionId,
        providerId: connection.authenticationProviderId,
        domain: connection.domain,
        token: "replacement-proof",
        redirectURI: "https://app.example.test/callback",
      };
    },
    startTest: async (_headers: Headers, organizationId: string, connectionId: string) => {
      calls.push({ operation: "test", organizationId, connectionId });
      return {
        location: "https://idp.example.test/authorize",
        cookies: ["better-auth.sso_state=provider-test-state; Path=/; HttpOnly; SameSite=Lax"],
      };
    },
    completeTest: async (_headers: Headers, organizationId: string, connectionId: string, actorUserId: string) => {
      calls.push({ operation: "complete", organizationId, connectionId, actorUserId });
      return connection;
    },
    startEnforcedSignIn: async (_headers: Headers, email: string, returnPath: string) => {
      calls.push({ operation: "company-sign-in", email, returnPath });
      return {
        location: "https://idp.example.test/authorize",
        cookies: ["better-auth.sso_state=enforced-state; Path=/; HttpOnly; SameSite=Lax"],
      };
    },
    startInvitationSignIn: async (_headers: Headers, organizationId: string, email: string) => {
      calls.push({ operation: "invitation-company-sign-in", organizationId, email });
      return {
        location: "https://idp.example.test/invitation-authorize",
        cookies: ["better-auth.sso_state=invitation-state; Path=/; HttpOnly; SameSite=Lax"],
      };
    },
    transition: async (organizationId: string, connectionId: string, action: string, actorUserId: string) => {
      calls.push({ operation: action, organizationId, connectionId, actorUserId });
      return connection;
    },
    rotateCredentials: async (_headers: Headers, input: Record<string, unknown>) => {
      calls.push({ operation: "rotate", ...input });
      return { ...connection, state: "pending", configVersion: 2 };
    },
    refreshMetadata: async (_headers: Headers, input: Record<string, unknown>) => {
      calls.push({ operation: "metadata", ...input });
      return { ...connection, state: "pending", configVersion: 2 };
    },
    disconnect: async (_headers: Headers, organizationId: string, connectionId: string, actorUserId: string) => {
      calls.push({ operation: "disconnect", organizationId, connectionId, actorUserId });
      return connection;
    },
  } as unknown as TenantSsoAdministrationService;
  let stepUps = 0;
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    {},
    {
      customerProductAuthentication: {
        resolve: async (headers: Headers) => {
          const cookie = headers.get("cookie");
          return cookie === "session=valid"
            ? { status: "authorized" as const, principal: actor }
            : cookie === "session=administrator"
              ? { status: "authorized" as const, principal: administrator }
              : { status: "anonymous" as const };
        },
        getInvitationSsoContext: async (_contextToken: string, email: string) => ({
          organizationId: actor.tenantId,
          email,
        }),
        requireRecentStepUp: async () => {
          stepUps += 1;
          return { actorUserId: actor.userId, recentStepUpAt: new Date() };
        },
      } as never,
      tenantSsoAdministration: administration,
      agentBridgeSecret: "tenant-sso-api-agent-bridge-secret-at-least-32-characters",
    } as never,
  );
  const headers = { "x-lemmacomputer-proxy-token": proxyToken, cookie: "session=valid", "content-type": "application/json" };
  try {
    const listed = await app.inject({ method: "GET", url: "/v1/admin/sso", headers });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().connections.length, 1);

    const registered = await app.inject({
      method: "POST",
      url: "/v1/admin/sso",
      headers,
      payload: {
        protocol: "oidc",
        domain: "example.test",
        issuer: "https://idp.example.test/tenant",
        clientId: "client-id",
        clientSecret: "secret-never-returned",
      },
    });
    assert.equal(registered.statusCode, 201);
    assert.doesNotMatch(registered.body, /client-id|secret-never-returned/);

    const administratorRegistration = await app.inject({
      method: "POST",
      url: "/v1/admin/sso",
      headers: { ...headers, cookie: "session=administrator" },
      payload: {
        protocol: "oidc",
        domain: "administrator.example.test",
        issuer: "https://idp.example.test/tenant",
        clientId: "administrator-client",
        clientSecret: "administrator-secret",
      },
    });
    assert.equal(administratorRegistration.statusCode, 403);
    assert.equal(administratorRegistration.json().error.code, "SSO_OWNER_REQUIRED");

    const proof = await app.inject({
      method: "POST",
      url: `/v1/admin/sso/${connection.id}/domain-verification/request`,
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "session=valid" },
    });
    assert.equal(proof.statusCode, 200, proof.body);
    assert.equal(proof.json().token, "replacement-proof");
    assert.deepEqual(calls.at(-1), {
      operation: "proof",
      organizationId: actor.tenantId,
      connectionId: connection.id,
    });

    const providerTest = await app.inject({
      method: "POST",
      url: `/v1/admin/sso/${connection.id}/test`,
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "session=valid" },
    });
    assert.equal(providerTest.statusCode, 200, providerTest.body);
    assert.deepEqual(providerTest.json(), { location: "https://idp.example.test/authorize" });
    assert.match(String(providerTest.headers["set-cookie"]), /better-auth\.sso_state=provider-test-state/);
    assert.deepEqual(calls.at(-1), {
      operation: "test",
      organizationId: actor.tenantId,
      connectionId: connection.id,
    });

    const companySignIn = await app.inject({
      method: "POST",
      url: "/v1/auth/customer-sso",
      headers: { "x-lemmacomputer-proxy-token": proxyToken, "content-type": "application/json" },
      payload: { email: "Person@Example.Test", returnPath: "/" },
    });
    assert.equal(companySignIn.statusCode, 200);
    assert.deepEqual(companySignIn.json(), { location: "https://idp.example.test/authorize" });
    assert.match(String(companySignIn.headers["set-cookie"]), /better-auth\.sso_state=enforced-state/);
    assert.deepEqual(calls.at(-1), { operation: "company-sign-in", email: "person@example.test", returnPath: "/" });

    const invitationSignIn = await app.inject({
      method: "POST",
      url: "/v1/auth/customer-sso",
      headers: {
        "x-lemmacomputer-proxy-token": proxyToken,
        "content-type": "application/json",
        cookie: "lemmacomputer_invitation_context=oic_invitation-context-with-enough-entropy",
      },
      payload: { email: "Invited@Example.Test", returnPath: "/invite" },
    });
    assert.equal(invitationSignIn.statusCode, 200, invitationSignIn.body);
    assert.deepEqual(invitationSignIn.json(), { location: "https://idp.example.test/invitation-authorize" });
    assert.match(String(invitationSignIn.headers["set-cookie"]), /better-auth\.sso_state=invitation-state/);
    assert.deepEqual(calls.at(-1), {
      operation: "invitation-company-sign-in",
      organizationId: actor.tenantId,
      email: "invited@example.test",
    });

    const enforced = await app.inject({
      method: "POST",
      url: `/v1/admin/sso/${connection.id}/enforce`,
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "session=valid" },
    });
    assert.equal(enforced.statusCode, 200, enforced.body);
    assert.equal(stepUps, 1);
    assert.deepEqual(calls.at(-1), {
      operation: "enforce",
      organizationId: actor.tenantId,
      connectionId: connection.id,
      actorUserId: actor.userId,
    });

    const rotated = await app.inject({
      method: "POST",
      url: `/v1/admin/sso/${connection.id}/credentials/rotation`,
      headers,
      payload: { protocol: "oidc", clientId: "replacement-client", clientSecret: "replacement-secret-never-returned" },
    });
    assert.equal(rotated.statusCode, 200, rotated.body);
    assert.equal(rotated.json().state, "pending");
    assert.equal(rotated.json().configVersion, 2);
    assert.doesNotMatch(rotated.body, /replacement-client|replacement-secret-never-returned/);
    assert.equal(stepUps, 2);
    assert.deepEqual(calls.at(-1), {
      operation: "rotate",
      organizationId: actor.tenantId,
      connectionId: connection.id,
      actorUserId: actor.userId,
      protocol: "oidc",
      clientId: "replacement-client",
      clientSecret: "replacement-secret-never-returned",
    });

    const refreshed = await app.inject({
      method: "POST",
      url: `/v1/admin/sso/${connection.id}/metadata/refresh`,
      headers,
      payload: { protocol: "oidc" },
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(refreshed.json().state, "pending");
    assert.equal(stepUps, 3);
    assert.deepEqual(calls.at(-1), {
      operation: "metadata",
      organizationId: actor.tenantId,
      connectionId: connection.id,
      actorUserId: actor.userId,
      protocol: "oidc",
    });
  } finally {
    await app.close();
  }
});
