import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext, LemmaComputerError } from "@lemmacomputer/contracts";
import type {
  McpConnectorRegistrationInput,
  OAuthConnectionGateway,
  OAuthConnectionStatus,
  OAuthConnectionTool,
} from "@lemmacomputer/litellm-adapter";
import { MemoryConnectorRegistryStore, MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import { McpConnectionService } from "../apps/control-api/src/connections.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

// Microsoft 365 asks for tenant-wide Graph permissions, so an ordinary
// employee who selects Connect reaches a terminal "Need admin approval" page
// and never comes back. These cover the path that turns that dead end into
// something they can hand to their administrator.
const acme: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" };
const globex: IdentityContext = { tenantId: "globex", subjectId: "sam", audience: "lemmacomputer-control" };
const proxyToken = "proxy-test-token-at-least-24-characters";
const consentSecret = "connector-consent-secret-for-tests-000001";
const clientId = "11111111-2222-3333-4444-555555555555";
const sharePointAdminClientId = "22222222-3333-4444-8555-666666666666";
const acmeDirectory = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const headersFor = (identity: IdentityContext) => ({
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": identity.tenantId,
  "x-lemmacomputer-test-user-id": identity.subjectId,
});

const disconnected: OAuthConnectionStatus = { state: "disconnected", connectedAt: null, expiresAt: null, account: null };

class Gateway implements OAuthConnectionGateway {
  started: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0][] = [];
  async beginUserOAuthConnection(input: Parameters<OAuthConnectionGateway["beginUserOAuthConnection"]>[0]) {
    this.started.push(input);
    return { location: "https://login.microsoftonline.com/authorize", cookies: [] };
  }
  async completeUserOAuthConnection() { return disconnected; }
  async userOAuthConnectionStatus() { return disconnected; }
  async disconnectUserOAuthConnection() { return disconnected; }
  async userOAuthConnectionTools(): Promise<OAuthConnectionTool[]> { return []; }
  async discoverOAuthMcpServer() { return { authorizationOrigin: "https://login.microsoftonline.com", dynamicClientRegistration: false }; }
  async registerOAuthMcpServer(_input: McpConnectorRegistrationInput) {}
  async ensureOAuthMcpServers() {}
  async replaceOAuthMcpServerCredentials() {}
  async removeMcpServer() {}
}

const service = (registry = new MemoryConnectorRegistryStore(), overrides = {}) => new McpConnectionService(new Gateway(), {
  publicWebUrl: "http://localhost:4174",
  authorizationOrigin: "http://localhost:3001",
  registry,
  microsoftAdminConsent: { clientId, consentSecret },
  microsoftSharePointSiteAdministrationConsent: { clientId: sharePointAdminClientId },
  ...overrides,
});

test("the approval link names the application, the organization, and where the provider returns", async () => {
  const connections = service();
  const link = await connections.adminConsentLink(acme, "microsoft-365", "alex");
  const url = new URL(link.consentUrl);

  assert.equal(url.origin, "https://login.microsoftonline.com");
  // `organizations` lets the administrator sign in with their own directory
  // instead of pinning the deployment's.
  assert.equal(url.pathname, "/organizations/v2.0/adminconsent");
  assert.equal(url.searchParams.get("client_id"), clientId);
  // `.default` consents to exactly what the application registration declares,
  // so the request cannot ask for more than an administrator can review.
  assert.equal(url.searchParams.get("scope"), "https://graph.microsoft.com/.default");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://localhost:4174/api/v1/connections/microsoft-365/admin-consent/callback",
  );
  assert.ok(!link.consentUrl.includes(consentSecret), "the signing secret never reaches the link");
  assert.ok(!link.consentUrl.includes("acme"), "the link carries a signed state, not a readable tenant name");
  assert.ok(new Date(link.expiresAt).getTime() > Date.now() + 24 * 60 * 60 * 1000, "an administrator often acts days later");

  await assert.rejects(
    connections.adminConsentLink(acme, "notion", "alex"),
    (error: LemmaComputerError) => error.code === "MCP_ADMIN_CONSENT_UNSUPPORTED",
  );
  await assert.rejects(
    service(new MemoryConnectorRegistryStore(), { microsoftAdminConsent: undefined }).adminConsentLink(acme, "microsoft-365", "alex"),
    (error: LemmaComputerError) => error.code === "MCP_ADMIN_CONSENT_NOT_CONFIGURED",
  );
});

test("consent is recorded only for the organization the signed state names", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const connections = service(registry);
  const link = await connections.adminConsentLink(acme, "microsoft-365", "alex");
  const state = new URL(link.consentUrl).searchParams.get("state")!;

  const connectorGranted = await connections.completeAdminConsent("microsoft-365", {
    state,
    tenant: acmeDirectory,
    admin_consent: "True",
  });
  assert.equal(connectorGranted.outcome, "granted");
  assert.equal(connectorGranted.connectorName, "Microsoft 365");
  assert.ok(connectorGranted.nextConsentUrl);
  const sharePointUrl = new URL(connectorGranted.nextConsentUrl);
  assert.equal(sharePointUrl.pathname, `/${acmeDirectory}/v2.0/adminconsent`);
  assert.equal(sharePointUrl.searchParams.get("client_id"), sharePointAdminClientId);
  assert.equal(
    sharePointUrl.searchParams.get("redirect_uri"),
    "http://localhost:4174/api/v1/connections/microsoft-365/sharepoint-admin-consent/callback",
  );
  const sharePointState = sharePointUrl.searchParams.get("state")!;
  const wrongDirectory = await connections.completeSharePointAdminConsent("microsoft-365", {
    state: sharePointState,
    tenant: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    admin_consent: "True",
  });
  assert.equal(wrongDirectory.outcome, "refused", "the two applications must be approved in the same provider directory");
  assert.equal((await registry.getConnector("acme", "microsoft-365"))?.sharePointAdminConsentGrantedAt, null);
  const sharePointGranted = await connections.completeSharePointAdminConsent("microsoft-365", {
    state: sharePointState,
    tenant: acmeDirectory,
    admin_consent: "True",
  });
  assert.deepEqual(sharePointGranted, { outcome: "granted", connectorName: "Microsoft 365" });

  const acmeRecord = await registry.getConnector("acme", "microsoft-365");
  assert.equal(acmeRecord?.adminConsentProviderTenantId, acmeDirectory);
  assert.equal(acmeRecord?.adminConsentRequestedBy, "alex");
  assert.ok(acmeRecord?.adminConsentGrantedAt);
  assert.equal(acmeRecord?.sharePointAdminConsentProviderTenantId, acmeDirectory);
  assert.equal(acmeRecord?.sharePointAdminConsentRequestedBy, "alex");
  assert.ok(acmeRecord?.sharePointAdminConsentGrantedAt);
  // The grant belongs to the organization named in the state and to no other.
  await connections.list(globex, true);
  assert.equal((await registry.getConnector("globex", "microsoft-365"))?.adminConsentGrantedAt, null);
});

test("a tampered, foreign, expired, or refused approval records nothing", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const connections = service(registry);
  const link = await connections.adminConsentLink(acme, "microsoft-365", "alex");
  const state = new URL(link.consentUrl).searchParams.get("state")!;
  const [payload, signature] = state.split(".");

  const unrecorded = async (query: Record<string, string>, why: string) => {
    const result = await connections.completeAdminConsent("microsoft-365", query);
    assert.notEqual(result.outcome, "granted", why);
    assert.equal((await registry.getConnector("acme", "microsoft-365"))?.adminConsentGrantedAt ?? null, null, why);
  };

  // A state signed by someone else, or edited to name another organization.
  const forged = Buffer.from(JSON.stringify({ t: "globex", c: "microsoft-365", e: Date.now() + 60_000 })).toString("base64url");
  await unrecorded({ state: `${forged}.${signature}`, tenant: acmeDirectory, admin_consent: "True" }, "a re-signed state is refused");
  await unrecorded({ state: `${payload}.${"a".repeat(signature!.length)}`, tenant: acmeDirectory, admin_consent: "True" }, "a wrong signature is refused");
  await unrecorded({ state: payload!, tenant: acmeDirectory, admin_consent: "True" }, "an unsigned state is refused");
  await unrecorded({ tenant: acmeDirectory, admin_consent: "True" }, "a missing state is refused");
  // A state minted for one connector must not approve another, even though it
  // is otherwise a valid, correctly signed, unexpired state.
  const otherConnector = await connections.completeAdminConsent("notion", { state, tenant: acmeDirectory, admin_consent: "True" });
  assert.equal(otherConnector.outcome, "invalid");
  assert.equal((await registry.getConnector("acme", "notion"))?.adminConsentGrantedAt ?? null, null);
  // The provider's own refusal, and a response that never carried a directory.
  await unrecorded({ state, error: "access_denied", error_description: "AADSTS65004" }, "a refusal is not a grant");
  await unrecorded({ state, admin_consent: "True" }, "a grant without a directory id is not recorded");
  await unrecorded({ state, tenant: "not-a-directory", admin_consent: "True" }, "a malformed directory id is not recorded");
  // Every personal Microsoft account lives in one pseudo-directory that has no
  // administrator and nothing tenant-wide to approve.
  await unrecorded(
    { state, tenant: "9188040d-6c67-4c5b-b112-36a304b66dad", admin_consent: "True" },
    "the personal-account directory cannot approve an organization",
  );
  await unrecorded({ state, tenant: acmeDirectory, admin_consent: "False" }, "an explicit decline is not a grant");

  const expiredService = service(registry, { adminConsentTtlMs: 1, now: () => Date.now() });
  const expiredLink = await expiredService.adminConsentLink(acme, "microsoft-365", "alex");
  const expiredState = new URL(expiredLink.consentUrl).searchParams.get("state")!;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const expired = await expiredService.completeAdminConsent("microsoft-365", {
    state: expiredState,
    tenant: acmeDirectory,
    admin_consent: "True",
  });
  assert.equal(expired.outcome, "invalid", "an expired link cannot be redeemed");
});

test("a consent failure from the provider is named, not reported as a refusal", async () => {
  const gateway = new Gateway();
  const connections = new McpConnectionService(gateway, {
    publicWebUrl: "http://localhost:4174",
    authorizationOrigin: "http://localhost:3001",
    registry: new MemoryConnectorRegistryStore(),
    microsoftAdminConsent: { clientId, consentSecret },
  });

  // Microsoft answers a request for tenant-wide permissions from someone who
  // cannot grant them with a consent error, not a refusal. Reporting that as
  // "access was not granted" tells the person to try again, which can never
  // succeed however many times they do it.
  await connections.start(acme, "microsoft-365", true);
  await assert.rejects(
    connections.complete(acme, "microsoft-365", {
      state: gateway.started.at(-1)!.state,
      error: "access_denied",
      errorDescription: "AADSTS90094: The grant requires admin permission.",
    }, true),
    (error: LemmaComputerError) => error.code === "MCP_ADMIN_CONSENT_REQUIRED",
  );

  // An ordinary refusal still reads as a refusal.
  await connections.start(acme, "microsoft-365", true);
  await assert.rejects(
    connections.complete(acme, "microsoft-365", {
      state: gateway.started.at(-1)!.state,
      error: "access_denied",
      errorDescription: "AADSTS65004: User declined to consent.",
    }, true),
    (error: LemmaComputerError) => error.code === "MCP_OAUTH_DENIED",
  );
});

test("an administrator with no LemmaComputer account can complete the approval", async () => {
  const registry = new MemoryConnectorRegistryStore();
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    Object.assign(new Gateway(), {
      ensureGrant: async () => ({ baseUrl: "http://gateway", credential: "scoped-test-credential-000001", modelAlias: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      readiness: async () => ({ models: "ready" as const, tools: "ready" as const }),
      revoke: async () => undefined,
    }),
    "api-fixture-approval-secret-at-least-32-characters",
    {
      publicWebUrl: "http://localhost:4174",
      authorizationOrigin: "http://localhost:3001",
      microsoftAdminConsent: { clientId, consentSecret },
      microsoftSharePointSiteAdministrationConsent: { clientId: sharePointAdminClientId },
      microsoftSharePointSitePermissions: {
        grant: async () => ({ graphSiteId: "site", driveIds: ["documents"], permissionId: "permission" }),
        revoke: async () => ({ revoked: true }),
      },
    },
    { testIdentityMode: true, connectorRegistryStore: registry },
  );
  try {
    const requested = await app.inject({
      method: "GET",
      url: "/v1/connections/microsoft-365/admin-consent",
      headers: headersFor(acme),
    });
    assert.equal(requested.statusCode, 200);
    const state = new URL(requested.json().consentUrl).searchParams.get("state")!;

    // The administrator arrives from their mail client with no session cookie.
    const landed = await app.inject({
      method: "GET",
      url: `/v1/connections/microsoft-365/admin-consent/callback?admin_consent=True&tenant=${acmeDirectory}&state=${encodeURIComponent(state)}`,
      headers: { "x-lemmacomputer-proxy-token": proxyToken },
    });
    assert.equal(landed.statusCode, 303, "the first approval continues directly to SharePoint administration consent");
    const sharePointConsentUrl = new URL(String(landed.headers.location));
    assert.equal(sharePointConsentUrl.searchParams.get("client_id"), sharePointAdminClientId);
    const sharePointState = sharePointConsentUrl.searchParams.get("state")!;
    const completed = await app.inject({
      method: "GET",
      url: `/v1/connections/microsoft-365/sharepoint-admin-consent/callback?admin_consent=True&tenant=${acmeDirectory}&state=${encodeURIComponent(sharePointState)}`,
      headers: { "x-lemmacomputer-proxy-token": proxyToken },
    });
    assert.equal(completed.statusCode, 200, "no LemmaComputer session is required to approve either application");
    assert.match(String(completed.headers["content-type"]), /text\/html/);
    assert.match(completed.body, /Approval recorded/);
    assert.equal(completed.headers["cache-control"], "no-store");
    // The page tells an unauthenticated reader nothing about the organization.
    assert.ok(!completed.body.includes("acme"));
    assert.ok(!completed.body.includes(consentSecret));

    const catalog = await app.inject({ method: "GET", url: "/v1/connections", headers: headersFor(acme) });
    const microsoft = (catalog.json().connections as Array<Record<string, never>>).find((connector) => connector.id === "microsoft-365");
    assert.equal(microsoft?.adminConsent.required, true);
    assert.equal(microsoft?.adminConsent.providerTenantId, acmeDirectory);
    assert.ok(microsoft?.adminConsent.grantedAt);
    assert.equal(microsoft?.adminConsent.sharePointSiteAdministration.providerTenantId, acmeDirectory);
    assert.ok(microsoft?.adminConsent.sharePointSiteAdministration.grantedAt);

    // A rejected approval reports a page rather than recording anything.
    const refused = await app.inject({
      method: "GET",
      url: `/v1/connections/microsoft-365/admin-consent/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      headers: { "x-lemmacomputer-proxy-token": proxyToken },
    });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /Approval was not completed/);

    // A hostile query string cannot inject markup into the page.
    const hostile = await app.inject({
      method: "GET",
      url: "/v1/connections/microsoft-365/admin-consent/callback?state=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      headers: { "x-lemmacomputer-proxy-token": proxyToken },
    });
    assert.equal(hostile.statusCode, 400);
    assert.ok(!hostile.body.includes("<script>"));

    const cleared = await app.inject({
      method: "DELETE",
      url: "/v1/connections/microsoft-365/admin-consent",
      headers: headersFor(acme),
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().connector.adminConsent.grantedAt, null);
    assert.equal(cleared.json().connector.adminConsent.sharePointSiteAdministration.grantedAt, null);
  } finally {
    await app.close();
  }
});

test("the approval landing route is the only connector route reachable without a session", async () => {
  const registry = new MemoryConnectorRegistryStore();
  // A real product authentication boundary that admits nobody. Under this
  // server every route answers 401 unless it is deliberately exempt, which is
  // what the administrator's browser relies on: they arrive from their mail
  // client with no LemmaComputer cookie and usually no account at all.
  const refuseEveryone = { resolve: async () => ({ status: "anonymous" as const }) };
  const linkService = service(registry);
  const link = await linkService.adminConsentLink(acme, "microsoft-365", "alex");
  const state = new URL(link.consentUrl).searchParams.get("state")!;

  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    Object.assign(new Gateway(), {
      ensureGrant: async () => ({ baseUrl: "http://gateway", credential: "scoped-test-credential-000001", modelAlias: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      readiness: async () => ({ models: "ready" as const, tools: "ready" as const }),
      revoke: async () => undefined,
    }),
    "api-fixture-approval-secret-at-least-32-characters",
    {
      publicWebUrl: "http://localhost:4174",
      authorizationOrigin: "http://localhost:3001",
      microsoftAdminConsent: { clientId, consentSecret },
      microsoftSharePointSiteAdministrationConsent: { clientId: sharePointAdminClientId },
      microsoftSharePointSitePermissions: {
        grant: async () => ({ graphSiteId: "site", driveIds: ["documents"], permissionId: "permission" }),
        revoke: async () => ({ revoked: true }),
      },
    },
    {
      customerProductAuthentication: refuseEveryone as never,
      connectorRegistryStore: registry,
      agentBridgeSecret: "consent-test-agent-bridge-secret-at-least-32-characters",
    },
  );
  try {
    const proxied = { "x-lemmacomputer-proxy-token": proxyToken };
    const landed = await app.inject({
      method: "GET",
      url: `/v1/connections/microsoft-365/admin-consent/callback?admin_consent=True&tenant=${acmeDirectory}&state=${encodeURIComponent(state)}`,
      headers: proxied,
    });
    assert.equal(landed.statusCode, 303, "an administrator without an account can continue the approval journey");
    const sharePointState = new URL(String(landed.headers.location)).searchParams.get("state")!;
    const completed = await app.inject({
      method: "GET",
      url: `/v1/connections/microsoft-365/sharepoint-admin-consent/callback?admin_consent=True&tenant=${acmeDirectory}&state=${encodeURIComponent(sharePointState)}`,
      headers: proxied,
    });
    assert.equal(completed.statusCode, 200, "the second approval callback is also sessionless");
    assert.match(completed.body, /Approval recorded/);
    assert.ok(await registry.getConnector("acme", "microsoft-365"));

    // Every neighbouring connector route stays behind the session.
    for (const url of [
      "/v1/connections",
      "/v1/connections/microsoft-365",
      "/v1/connections/microsoft-365/admin-consent",
      "/v1/connections/microsoft-365/authorize",
    ]) {
      const rejected = await app.inject({ method: "GET", url, headers: proxied });
      assert.equal(rejected.statusCode, 401, `${url} must require a session`);
    }
    // The exemption is the landing path itself, not the prefix around it.
    const nearMiss = await app.inject({
      method: "GET",
      url: "/v1/connections/microsoft-365/admin-consent/callback/extra",
      headers: proxied,
    });
    assert.notEqual(nearMiss.statusCode, 200);
    const sharePointNearMiss = await app.inject({
      method: "GET",
      url: "/v1/connections/microsoft-365/sharepoint-admin-consent/callback/extra",
      headers: proxied,
    });
    assert.notEqual(sharePointNearMiss.statusCode, 200);
    // The proxy boundary still applies: a request that never passed the
    // ingress is refused before any of this is considered.
    const unproxied = await app.inject({
      method: "GET",
      url: `/v1/connections/microsoft-365/admin-consent/callback?admin_consent=True&tenant=${acmeDirectory}&state=${encodeURIComponent(state)}`,
    });
    assert.equal(unproxied.statusCode, 401);
  } finally {
    await app.close();
  }
});
