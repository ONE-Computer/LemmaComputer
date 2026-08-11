import assert from "node:assert/strict";
import test from "node:test";

import { MemoryWorkspaceStore, type SessionPrincipal } from "@lemmacomputer/workspace-store";

import {
  CustomerProductAuthenticationService,
  type CustomerAuthenticationSessionReader,
  type CustomerProductSessionStore,
} from "../apps/control-api/src/customer-product-authentication.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const accountUserId = "11111111-1111-4111-8111-111111111111";
const authenticationSessionId = "22222222-2222-4222-8222-222222222222";
const membershipId = "33333333-3333-4333-8333-333333333333";

const principal: SessionPrincipal = {
  userId: "tenant-user-1",
  accountUserId,
  tenantId: "organization-1",
  organizationId: "organization-1",
  membershipId,
  membershipStatus: "active",
  role: "owner",
  permissions: [
    "organization.read",
    "organization.manage_members",
    "organization.manage_roles",
    "organization.transfer_ownership",
    "organization.manage_settings",
  ],
  email: "alex@example.test",
  displayName: "Alex Morgan",
  tenantDisplayName: "Example Organization",
  roles: ["employee", "administrator"],
  identity: { tenantId: "organization-1", subjectId: "tenant-user-1", audience: "lemmacomputer-control" },
};

const verifiedSession = {
  session: {
    id: authenticationSessionId,
    userId: accountUserId,
    createdAt: new Date("2026-08-09T01:59:00.000Z"),
    updatedAt: new Date("2026-08-09T01:59:00.000Z"),
    expiresAt: new Date(Date.now() + 60_000),
  },
  user: {
    id: accountUserId,
    email: "alex@example.test",
    name: "Alex Morgan",
    emailVerified: true,
    twoFactorEnabled: true,
  },
};

const headers = new Headers({ cookie: "better-auth.session_token=opaque" });

const fixture = () => {
  let selected: SessionPrincipal | null = null;
  let recentStepUpAt: Date | null = null;
  const mapped: string[] = [];
  const organizationCreations: Array<Record<string, unknown>> = [];
  const invitationContexts: Array<Record<string, unknown>> = [];
  const invitationContextReads: Array<Record<string, unknown>> = [];
  const invitationAcceptances: Array<Record<string, unknown>> = [];
  const reader: CustomerAuthenticationSessionReader = {
    getSession: async (received) => received.get("cookie") ? verifiedSession : null,
  };
  const store: CustomerProductSessionStore = {
    ensureCustomerAccount: async (input) => {
      mapped.push(input.accountUserId);
      return { accountUserId: input.accountUserId, status: "active" };
    },
    listCustomerMemberships: async () => [{
      membershipId,
      organizationId: "organization-1",
      organizationDisplayName: "Example Organization",
      userId: "tenant-user-1",
      status: "active",
      role: "owner",
    }],
    getCustomerProductSession: async () => selected,
    selectCustomerProductSession: async (input) => {
      assert.equal(input.authenticationSessionId, authenticationSessionId);
      assert.equal(input.accountUserId, accountUserId);
      assert.equal(input.membershipId, membershipId);
      selected = principal;
      return principal;
    },
    createCustomerOrganization: async (input) => {
      organizationCreations.push(input);
      selected = principal;
      return {
        replayed: false,
        organization: { id: "organization-1", slug: "example-organization", displayName: "Example Organization" },
        membership: { id: membershipId, status: "active", role: "owner" },
      };
    },
    createCustomerInvitationContext: async (input) => {
      invitationContexts.push(input);
      return {
        organizationId: "organization-1",
        organizationDisplayName: "Inviting Organization",
        email: "alex@example.test",
        role: "admin" as const,
        expiresAt: new Date("2026-08-16T02:00:00.000Z"),
      };
    },
    getCustomerInvitationContext: async (input) => {
      invitationContextReads.push(input);
      return {
        organizationId: "organization-1",
        organizationDisplayName: "Inviting Organization",
        email: "alex@example.test",
        role: "admin" as const,
        expiresAt: new Date("2026-08-16T02:00:00.000Z"),
      };
    },
    acceptCustomerInvitation: async (input) => {
      invitationAcceptances.push(input);
      selected = { ...principal, role: "admin" };
      return selected;
    },
    recordCustomerOwnerStepUp: async (input) => {
      assert.equal(input.accountUserId, accountUserId);
      assert.equal(input.authenticationSessionId, authenticationSessionId);
      recentStepUpAt = input.authenticatedAt;
    },
    getCustomerOwnerStepUp: async (input) => {
      assert.equal(input.accountUserId, accountUserId);
      assert.equal(input.authenticationSessionId, authenticationSessionId);
      return recentStepUpAt;
    },
    revokeCustomerProductSession: async () => { selected = null; },
  };
  return {
    service: new CustomerProductAuthenticationService(reader, store, () => new Date("2026-08-09T02:00:00.000Z"), {
      installationKind: "hosted",
    }),
    mapped,
    organizationCreations,
    invitationContexts,
    invitationContextReads,
    invitationAcceptances,
    store,
  };
};

test("a raw invitation becomes a hashed redirect-safe context and a fresh Better Auth session accepts it", async () => {
  const { service, invitationContexts, invitationContextReads, invitationAcceptances } = fixture();

  const prepared = await service.prepareInvitation("oci_invitation-capability-with-enough-entropy");
  assert.equal(prepared.organizationId, "organization-1");
  assert.equal(prepared.organizationDisplayName, "Inviting Organization");
  assert.equal(prepared.email, "alex@example.test");
  assert.equal(prepared.role, "admin");
  assert.match(prepared.contextToken, /^oic_/);
  assert.equal(invitationContexts.length, 1);
  assert.match(String(invitationContexts[0]?.invitationTokenHash), /^[a-f0-9]{64}$/);
  assert.match(String(invitationContexts[0]?.contextTokenHash), /^[a-f0-9]{64}$/);
  assert.deepEqual(invitationContexts[0]?.expiresAt, new Date("2026-08-16T02:00:00.000Z"));
  assert.doesNotMatch(JSON.stringify(invitationContexts), /oci_invitation-capability/);
  assert.doesNotMatch(JSON.stringify(invitationContexts), new RegExp(prepared.contextToken));

  const restored = await service.getInvitationContext(prepared.contextToken);
  assert.deepEqual(restored, {
    organizationId: "organization-1",
    organizationDisplayName: "Inviting Organization",
    email: "alex@example.test",
    role: "admin",
    expiresAt: "2026-08-16T02:00:00.000Z",
  });
  assert.deepEqual(invitationContextReads, [{
    contextTokenHash: invitationContexts[0]?.contextTokenHash,
    now: new Date("2026-08-09T02:00:00.000Z"),
  }]);

  assert.deepEqual(await service.getInvitationSsoContext(prepared.contextToken, "Alex@Example.Test"), {
    organizationId: "organization-1",
    email: "alex@example.test",
  });
  await assert.rejects(
    () => service.getInvitationSsoContext(prepared.contextToken, "someone-else@example.test"),
    { code: "INVITATION_SIGNIN_FAILED" },
  );

  const accepted = await service.acceptInvitation(headers, prepared.contextToken);
  assert.equal(accepted.role, "admin");
  assert.deepEqual(invitationAcceptances, [{
    accountUserId,
    authenticationSessionId,
    contextTokenHash: invitationContexts[0]?.contextTokenHash,
    email: "alex@example.test",
    userDisplayName: "Alex Morgan",
    expiresAt: verifiedSession.session.expiresAt,
    now: new Date("2026-08-09T02:00:00.000Z"),
  }]);
});

test("invitation acceptance rejects anonymous, unverified, and stale Better Auth sessions", async () => {
  const { service, store } = fixture();
  const prepared = await service.prepareInvitation("oci_invitation-capability-with-enough-entropy");

  await assert.rejects(() => service.acceptInvitation(new Headers(), prepared.contextToken), { code: "UNAUTHENTICATED" });
  const unverified = new CustomerProductAuthenticationService({
    getSession: async () => ({ ...verifiedSession, user: { ...verifiedSession.user, emailVerified: false } }),
  }, store, () => new Date("2026-08-09T02:00:00.000Z"));
  await assert.rejects(() => unverified.acceptInvitation(headers, prepared.contextToken), { code: "UNAUTHENTICATED" });
  const stale = new CustomerProductAuthenticationService({
    getSession: async () => ({
      ...verifiedSession,
      session: { ...verifiedSession.session, createdAt: new Date("2026-08-09T01:44:59.999Z") },
    }),
  }, store, () => new Date("2026-08-09T02:00:00.000Z"));
  await assert.rejects(() => stale.acceptInvitation(headers, prepared.contextToken), { code: "INVITATION_REAUTHENTICATION_REQUIRED" });
});

test("verified Better Auth users map by UUID but receive no tenant authority implicitly", async () => {
  const { service, mapped } = fixture();

  assert.deepEqual(await service.resolve(new Headers()), { status: "anonymous" });
  const resolution = await service.resolve(headers);

  assert.equal(resolution.status, "membership-required");
  if (resolution.status === "anonymous") assert.fail("expected a verified authentication session");
  assert.equal(resolution.accountUserId, accountUserId);
  assert.equal(resolution.user.email, "alex@example.test");
  assert.equal(resolution.memberships.length, 1);
  assert.deepEqual(mapped, [accountUserId]);
});

test("an explicit active membership selection creates the server-side product context", async () => {
  const { service } = fixture();

  const selected = await service.selectMembership(headers, membershipId);
  assert.equal(selected.membershipId, membershipId);

  const resolution = await service.resolve(headers);
  assert.equal(resolution.status, "authorized");
  if (resolution.status === "authorized") assert.equal(resolution.principal.tenantId, "organization-1");

  await service.revokeCurrentSession(headers);
  assert.equal((await service.resolve(headers)).status, "membership-required");
});

test("a verified account can atomically bootstrap an organization owner and product context", async () => {
  const { service, organizationCreations } = fixture();

  const created = await service.createOrganization(headers, {
    displayName: "  Example   Organization  ",
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
  });

  assert.equal(created.organization.displayName, "Example Organization");
  assert.equal(created.membership.role, "owner");
  assert.deepEqual(organizationCreations, [{
    accountUserId,
    authenticationSessionId,
    email: "alex@example.test",
    userDisplayName: "Alex Morgan",
    organizationDisplayName: "Example Organization",
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
    installationKind: "hosted",
    now: new Date("2026-08-09T02:00:00.000Z"),
    expiresAt: verifiedSession.session.expiresAt,
  }]);
  assert.equal((await service.resolve(headers)).status, "authorized");
});

test("organization bootstrap rejects anonymous sessions and fails closed without store support", async () => {
  const { service, store } = fixture();
  const input = {
    displayName: "Example Organization",
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
  };

  await assert.rejects(() => service.createOrganization(new Headers(), input), { code: "UNAUTHENTICATED" });
  const unsupported = new CustomerProductAuthenticationService({ getSession: async () => verifiedSession }, {
    ...store,
    createCustomerOrganization: undefined,
  });
  await assert.rejects(() => unsupported.createOrganization(headers, input), { code: "ORGANIZATION_SIGNUP_NOT_CONFIGURED" });
});

test("protected owner operations require an explicit, session-bound MFA step-up proof", async () => {
  const { service, store } = fixture();

  await assert.rejects(() => service.requireRecentStepUp(headers), { code: "OWNER_STEP_UP_REQUIRED" });
  const recorded = await service.recordRecentStepUp(headers);
  assert.equal(recorded.recentStepUpAt.toISOString(), "2026-08-09T02:00:00.000Z");
  const proof = await service.requireRecentStepUp(headers);
  assert.equal(proof.accountUserId, accountUserId);
  assert.equal(proof.recentStepUpAt.toISOString(), "2026-08-09T02:00:00.000Z");

  const stale = new CustomerProductAuthenticationService({
    getSession: async () => verifiedSession,
  }, {
    ...store,
    getCustomerOwnerStepUp: async () => new Date("2026-08-09T01:49:59.999Z"),
  }, () => new Date("2026-08-09T02:00:00.000Z"));
  await assert.rejects(() => stale.requireRecentStepUp(headers), { code: "OWNER_STEP_UP_REQUIRED" });

  const withoutMfa = new CustomerProductAuthenticationService({
    getSession: async () => ({
      ...verifiedSession,
      user: { ...verifiedSession.user, twoFactorEnabled: false },
    }),
  }, store, () => new Date("2026-08-09T02:00:00.000Z"));
  await assert.rejects(() => withoutMfa.requireRecentStepUp(headers), { code: "OWNER_STEP_UP_REQUIRED" });
});

test("unverified and malformed Better Auth sessions fail closed", async () => {
  const { store } = fixture();
  const unverifiedReader: CustomerAuthenticationSessionReader = {
    getSession: async () => ({ ...verifiedSession, user: { ...verifiedSession.user, emailVerified: false } }),
  };
  const malformedReader: CustomerAuthenticationSessionReader = {
    getSession: async () => ({ ...verifiedSession, session: { ...verifiedSession.session, id: "not-a-uuid" } }),
  };
  assert.deepEqual(await new CustomerProductAuthenticationService(unverifiedReader, store).resolve(headers), { status: "anonymous" });
  await assert.rejects(
    () => new CustomerProductAuthenticationService(malformedReader, store).resolve(headers),
    /authentication session identifier is invalid/i,
  );
});

test("Control exposes explicit product-session selection and denies tenant routes before selection", async () => {
  let active = false;
  const organizationRequests: Array<{ displayName: string; idempotencyKey: string }> = [];
  const protectedOperations: Array<Record<string, unknown>> = [];
  const verifiedStepUpCodes: string[] = [];
  let recordedStepUp = false;
  const customerProductAuthentication = {
    resolve: async () => active ? {
      status: "authorized" as const,
      accountUserId,
      authenticationSessionId,
      user: { id: accountUserId, email: "alex@example.test", name: "Alex Morgan" },
      memberships: [],
      principal,
    } : {
      status: "membership-required" as const,
      accountUserId,
      authenticationSessionId,
      user: { id: accountUserId, email: "alex@example.test", name: "Alex Morgan" },
      memberships: [{
        membershipId,
        organizationId: "organization-1",
        organizationDisplayName: "Example Organization",
        userId: "tenant-user-1",
        status: "active" as const,
        role: "owner" as const,
      }],
    },
    selectMembership: async (_headers: Headers, selectedMembershipId: string) => {
      assert.equal(selectedMembershipId, membershipId);
      active = true;
      return principal;
    },
    createOrganization: async (_headers: Headers, input: { displayName: string; idempotencyKey: string }) => {
      organizationRequests.push(input);
      active = true;
      return {
        replayed: false,
        organization: { id: "organization-1", slug: "example-organization", displayName: input.displayName },
        membership: { id: membershipId, status: "active" as const, role: "owner" as const },
      };
    },
    recordRecentStepUp: async () => {
      recordedStepUp = true;
      return { accountUserId, authenticationSessionId, recentStepUpAt: new Date("2026-08-09T01:59:00.000Z") };
    },
    requireRecentStepUp: async () => ({
      accountUserId,
      authenticationSessionId,
      recentStepUpAt: new Date("2026-08-09T01:59:00.000Z"),
    }),
    revokeCurrentSession: async () => { active = false; },
  };
  const identityPolicyStore = {
    getEffectivePolicy: async () => null,
    transferOrganizationOwnership: async (input: Record<string, unknown>) => {
      protectedOperations.push({ kind: "transfer", ...input });
      return {
        previousOwner: { membershipId, role: "admin" as const },
        owner: { membershipId: "66666666-6666-4666-8666-666666666666", userId: "tenant-user-2", role: "owner" as const },
        revokedSessions: 1,
      };
    },
    initiateOrganizationClosure: async (input: Record<string, unknown>) => {
      protectedOperations.push({ kind: "closure", ...input });
      return {
        replayed: false,
        request: {
          id: "77777777-7777-4777-8777-777777777777",
          status: "pending" as const,
          requestedAt: "2026-08-09T02:00:00.000Z",
          executeAfter: "2026-08-16T02:00:00.000Z",
        },
      };
    },
  };
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    "customer-product-test-proxy-token-at-least-24-characters",
    undefined,
    undefined,
    {},
    {
      customerAuthentication: {
        options: { baseURL: "http://localhost" },
        handler: async (request: Request) => {
          const body = await request.json() as { code: string };
          verifiedStepUpCodes.push(body.code);
          return new Response(JSON.stringify({ status: body.code !== "000000" }), {
            status: body.code === "000000" ? 401 : 200,
            headers: { "content-type": "application/json" },
          });
        },
      } as never,
      customerProductAuthentication,
      identityPolicyStore: identityPolicyStore as never,
      agentBridgeSecret: "customer-product-test-agent-bridge-secret-32-characters",
    },
  );
  const proxyHeaders = {
    "x-lemmacomputer-proxy-token": "customer-product-test-proxy-token-at-least-24-characters",
    cookie: "better-auth.session_token=opaque",
  };
  try {
    const denied = await app.inject({ method: "GET", url: "/v1/auth/session", headers: proxyHeaders });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, "ACTIVE_MEMBERSHIP_REQUIRED");

    const status = await app.inject({ method: "GET", url: "/v1/auth/product-session", headers: proxyHeaders });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().status, "membership-required");

    const missingIdempotency = await app.inject({
      method: "POST",
      url: "/v1/auth/organizations",
      headers: { ...proxyHeaders, "content-type": "application/json" },
      payload: { displayName: "Example Organization" },
    });
    assert.equal(missingIdempotency.statusCode, 400);

    const organizationIdempotencyKey = "55555555-5555-4555-8555-555555555555";
    const organization = await app.inject({
      method: "POST",
      url: "/v1/auth/organizations",
      headers: {
        ...proxyHeaders,
        "content-type": "application/json",
        "idempotency-key": organizationIdempotencyKey,
      },
      payload: { displayName: "Example Organization" },
    });
    assert.equal(organization.statusCode, 201);
    assert.equal(organization.json().membership.role, "owner");
    assert.deepEqual(organizationRequests, [{
      displayName: "Example Organization",
      idempotencyKey: organizationIdempotencyKey,
    }]);

    const selected = await app.inject({
      method: "PUT",
      url: "/v1/auth/product-session",
      headers: { ...proxyHeaders, "content-type": "application/json" },
      payload: { membershipId },
    });
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.json().membership.id, membershipId);

    const authorized = await app.inject({ method: "GET", url: "/v1/auth/session", headers: proxyHeaders });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.json().tenant.id, "organization-1");

    const invalidStepUp = await app.inject({
      method: "POST",
      url: "/v1/auth/owner-step-up",
      headers: { ...proxyHeaders, "content-type": "application/json" },
      payload: { code: "000000" },
    });
    assert.equal(invalidStepUp.statusCode, 401);
    assert.equal(invalidStepUp.json().error.code, "OWNER_STEP_UP_INVALID");
    assert.equal(recordedStepUp, false);

    const steppedUp = await app.inject({
      method: "POST",
      url: "/v1/auth/owner-step-up",
      headers: { ...proxyHeaders, "content-type": "application/json" },
      payload: { code: "123456" },
    });
    assert.equal(steppedUp.statusCode, 200);
    assert.deepEqual(verifiedStepUpCodes, ["000000", "123456"]);
    assert.equal(recordedStepUp, true);

    const transferred = await app.inject({
      method: "POST",
      url: "/v1/admin/organization/ownership-transfer",
      headers: { ...proxyHeaders, "content-type": "application/json" },
      payload: { targetMembershipId: "66666666-6666-4666-8666-666666666666" },
    });
    assert.equal(transferred.statusCode, 200);
    assert.equal(transferred.json().owner.role, "owner");

    const closureIdempotencyKey = "88888888-8888-4888-8888-888888888888";
    const closure = await app.inject({
      method: "POST",
      url: "/v1/admin/organization/closure",
      headers: {
        ...proxyHeaders,
        "content-type": "application/json",
        "idempotency-key": closureIdempotencyKey,
      },
      payload: { reason: "The organization owner requested a controlled account closure" },
    });
    assert.equal(closure.statusCode, 201);
    assert.equal(closure.json().request.status, "pending");
    assert.deepEqual(protectedOperations, [
      {
        kind: "transfer",
        organizationId: "organization-1",
        currentOwnerUserId: "tenant-user-1",
        targetMembershipId: "66666666-6666-4666-8666-666666666666",
        recentStepUpAt: new Date("2026-08-09T01:59:00.000Z"),
        now: protectedOperations[0]?.now,
      },
      {
        kind: "closure",
        organizationId: "organization-1",
        requestedBy: "tenant-user-1",
        reason: "The organization owner requested a controlled account closure",
        idempotencyKey: closureIdempotencyKey,
        recentStepUpAt: new Date("2026-08-09T01:59:00.000Z"),
        now: protectedOperations[1]?.now,
      },
    ]);

    const revoked = await app.inject({ method: "DELETE", url: "/v1/auth/product-session", headers: proxyHeaders });
    assert.equal(revoked.statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/v1/auth/session", headers: proxyHeaders })).statusCode, 403);
  } finally {
    await app.close();
  }
});
