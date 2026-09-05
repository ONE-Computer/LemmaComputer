import assert from "node:assert/strict";
import test from "node:test";
import { SiteAssetAccessAuthority, redactSiteAssetAccessUrl, siteAssetAccessLifetimeMs, siteAssetHeaders } from "../apps/control-api/src/site-asset-access.js";

test("site asset grants bind account, session, tenant and exact version; reject tampering and expiry", () => {
  let now = Date.now();
  const authority = new SiteAssetAccessAuthority("test-site-access-secret-at-least-32-characters", () => now);
  const input = { tenantId: "acme", handle: "a".repeat(24), version: 1,
    accountUserId: "11111111-1111-4111-8111-111111111111", authenticationSessionId: "22222222-2222-4222-8222-222222222222" };
  const access = authority.issue(input);
  const token = access.entryUrl.split("/access/")[1]!.split("/")[0]!;
  assert.deepEqual(authority.verify(token, input.handle, 1), { ...input, audience: "lemma-site-assets-v1", expiresAt: access.expiresAt });
  for (const [value, handle, version] of [[`${token.slice(0, 10)}x${token.slice(11)}`, input.handle, 1], [token, "b".repeat(24), 1], [token, input.handle, 2], ["malformed", input.handle, 1]] as const) {
    assert.throws(() => authority.verify(value, handle, version), { code: "SITE_NOT_FOUND" });
  }
  assert.ok(!redactSiteAssetAccessUrl(access.entryUrl).includes(token));
  assert.match(redactSiteAssetAccessUrl(access.entryUrl), /access\/\[redacted\]\/assets/);
  assert.ok(!redactSiteAssetAccessUrl(access.entryUrl.replace("/assets/", "/invalid/assets/")).includes(token));
  now += siteAssetAccessLifetimeMs;
  assert.throws(() => authority.verify(token, input.handle, 1), { code: "SITE_NOT_FOUND" });
});

test("sandbox CSP restricts network resources to one bundle without cookies or same-origin authority", () => {
  const base = "https://lemma.example/api/v1/sites/viewer/site/versions/1/access/grant/assets/";
  const headers = siteAssetHeaders(base);
  assert.equal(headers["access-control-allow-origin"], "null");
  assert.ok(!("access-control-allow-credentials" in headers));
  assert.ok(headers["content-security-policy"].includes(`connect-src ${base};`));
  assert.ok(!headers["content-security-policy"].includes("allow-same-origin"));
  assert.equal(headers["cache-control"], "private, no-store");
});
