import assert from "node:assert/strict";
import test from "node:test";
import { MicrosoftSharePointSitePermissionClient } from "../apps/control-api/src/microsoft-sharepoint-site-permissions.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const administrationClientId = "22222222-2222-4222-8222-222222222222";
const connectorClientId = "33333333-3333-4333-8333-333333333333";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

test("the isolated SharePoint administration client grants read access with an app-only token", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, method: request.method, headers: request.headers, body: await request.text() });
    if (request.url.includes("/oauth2/v2.0/token")) return json({ access_token: "short-lived-admin-token" });
    if (request.url.includes("/sites/contoso.sharepoint.com:/sites/Finance")) {
      return json({ id: "contoso.sharepoint.com,collection,finance", webUrl: "https://contoso.sharepoint.com/sites/Finance" });
    }
    if (request.method === "GET" && request.url.endsWith("/permissions")) return json({ value: [] });
    if (request.method === "POST" && request.url.endsWith("/permissions")) return json({ id: "permission-finance", roles: ["read"] }, 201);
    if (request.method === "GET" && request.url.includes("/drives?")) return json({ value: [{ id: "finance-documents" }] });
    return json({ error: { message: "Unexpected request" } }, 500);
  };
  const client = new MicrosoftSharePointSitePermissionClient({
    fallbackProviderTenantId: tenantId,
    administrationClientId,
    administrationClientSecret: "admin-secret-never-sent-to-graph",
    fetch: fetchMock,
  });

  assert.deepEqual(await client.grant({ hostname: "contoso.sharepoint.com", sitePath: "sites/Finance", connectorClientId, accessLevel: "read" }), {
    graphSiteId: "contoso.sharepoint.com,collection,finance",
    driveIds: ["finance-documents"],
    permissionId: "permission-finance",
  });
  assert.equal(requests[0]?.url, `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`);
  assert.match(requests[0]?.body ?? "", /grant_type=client_credentials/);
  assert.equal(requests[1]?.headers.get("authorization"), "Bearer short-lived-admin-token");
  const grantRequest = requests.find((request) => request.method === "POST" && request.url.endsWith("/permissions"));
  const grantBody = JSON.parse(grantRequest?.body ?? "{}") as {
    roles?: string[];
    grantedToIdentities?: Array<{ application?: { id?: string } }>;
  };
  assert.deepEqual(grantBody.roles, ["read"]);
  assert.equal(grantBody.grantedToIdentities?.[0]?.application?.id, connectorClientId);
});

test("an existing broader grant is reduced to read and revocation rechecks the site and connector identity", async () => {
  const methods: string[] = [];
  const bodies: string[] = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    methods.push(request.method);
    bodies.push(await request.text());
    if (request.url.includes("/oauth2/v2.0/token")) return json({ access_token: "admin-token" });
    if (request.url.includes("/sites/contoso.sharepoint.com:/sites/Finance")) {
      return json({ id: "contoso.sharepoint.com,collection,finance", webUrl: "https://contoso.sharepoint.com/sites/Finance" });
    }
    if (request.method === "GET" && request.url.endsWith("/permissions")) {
      return json({ value: [{
        id: "permission-finance",
        roles: ["write"],
        grantedToIdentitiesV2: [{ application: { id: connectorClientId } }],
      }] });
    }
    if (request.method === "PATCH") return json({ id: "permission-finance", roles: ["read"] });
    if (request.method === "GET" && request.url.includes("/drives?")) return json({ value: [{ id: "finance-documents" }] });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return json({ error: { message: "Unexpected request" } }, 500);
  };
  const client = new MicrosoftSharePointSitePermissionClient({
    fallbackProviderTenantId: tenantId,
    administrationClientId,
    administrationClientSecret: "admin-secret",
    fetch: fetchMock,
  });

  const grant = await client.grant({ hostname: "contoso.sharepoint.com", sitePath: "sites/Finance", connectorClientId, accessLevel: "read" });
  assert.equal(grant.permissionId, "permission-finance");
  assert.ok(methods.includes("PATCH"));
  assert.deepEqual(JSON.parse(bodies[methods.indexOf("PATCH")] ?? "{}"), { roles: ["read"] });

  assert.deepEqual(await client.revoke({
    hostname: "contoso.sharepoint.com",
    sitePath: "sites/Finance",
    connectorClientId,
    graphSiteId: grant.graphSiteId,
    permissionId: grant.permissionId,
  }), { revoked: true });
  assert.equal(methods.at(-1), "DELETE");
});

test("a selected site can be granted read and write access", async () => {
  const bodies: string[] = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    bodies.push(await request.text());
    if (request.url.includes("/oauth2/v2.0/token")) return json({ access_token: "admin-token" });
    if (request.url.includes("/sites/contoso.sharepoint.com:/sites/Finance")) {
      return json({ id: "contoso.sharepoint.com,collection,finance", webUrl: "https://contoso.sharepoint.com/sites/Finance" });
    }
    if (request.method === "GET" && request.url.endsWith("/permissions")) return json({ value: [] });
    if (request.method === "POST" && request.url.endsWith("/permissions")) return json({ id: "permission-finance", roles: ["write"] }, 201);
    if (request.method === "GET" && request.url.includes("/drives?")) return json({ value: [{ id: "finance-documents" }, { id: "finance-assets" }] });
    return json({ error: { message: "Unexpected request" } }, 500);
  };
  const client = new MicrosoftSharePointSitePermissionClient({
    fallbackProviderTenantId: tenantId,
    administrationClientId,
    administrationClientSecret: "admin-secret",
    fetch: fetchMock,
  });

  const grant = await client.grant({
    hostname: "contoso.sharepoint.com",
    sitePath: "sites/Finance",
    connectorClientId,
    accessLevel: "write",
  });
  assert.deepEqual(grant.driveIds, ["finance-assets", "finance-documents"]);
  assert.ok(bodies.some((body) => body.startsWith("{") && (JSON.parse(body) as { roles?: string[] }).roles?.[0] === "write"));
});
