import { expect, test } from "@playwright/test";
import { renderPlatformOperatorUi } from "../../apps/control-api/src/platform-operator-ui.js";

const session = {
  principal: {
    realm: "platform-operator" as const,
    operatorSessionId: "22222222-2222-4222-8222-222222222222",
    operatorId: "33333333-3333-4333-8333-333333333333",
    identity: {
      provider: "workforce-entra" as const,
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: "operator-object-id",
    },
    assurance: { level: "aal2" as const, factors: ["federated" as const, "totp" as const] },
    authenticatedAt: "2026-08-09T03:00:00.000Z",
    recentStepUpAt: "2026-08-09T03:05:00.000Z",
  },
  roles: ["platform-administrator" as const],
};

test("platform operator workbench is a separate workforce surface with operational and elevation controls", async ({ page }, testInfo) => {
  let requestedElevation: Record<string, unknown> | undefined;
  let approved = false;
  await page.route("http://platform.test/api/v1/platform/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/service-health")) return route.fulfill({ json: { health: { status: "degraded", activeIncidents: 1, checkedAt: "2026-08-09T03:10:00.000Z" } } });
    if (path.endsWith("/tenants")) return route.fulfill({ json: { tenants: [{ id: "55555555-5555-4555-8555-555555555555", displayName: "Northwind", lifecycleState: "active" }] } });
    if (path.endsWith("/incidents")) return route.fulfill({ json: { incidents: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Identity callbacks degraded", severity: "high", status: "open", updatedAt: "2026-08-09T03:09:00.000Z" }] } });
    if (path.endsWith("/audit")) return route.fulfill({ json: { events: [] } });
    if (path.endsWith("/support/elevations")) {
      if (route.request().method() === "GET") return route.fulfill({ json: { elevations: [
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          operatorId: session.principal.operatorId,
          targetOrganizationId: "55555555-5555-4555-8555-555555555555",
          scopes: ["support.customer-content.read"],
          status: "pending",
          expiresAt: "2026-08-09T03:30:00.000Z",
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          operatorId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          targetOrganizationId: "55555555-5555-4555-8555-555555555555",
          scopes: ["support.customer-content.read"],
          status: approved ? "active" : "pending",
          expiresAt: "2026-08-09T03:30:00.000Z",
        },
      ] } });
      requestedElevation = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { elevation: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", approvalRequired: true, expiresAt: "2026-08-09T03:30:00.000Z" } } });
    }
    if (path.endsWith("/support/elevations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/approve")) { approved = true; return route.fulfill({ json: {} }); }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.setContent(renderPlatformOperatorUi(session, { baseHref: "http://platform.test/" }));
  await expect(page.getByRole("heading", { name: "Platform operations" })).toBeVisible();
  await expect(page.getByText("Workforce operator realm")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Northwind" })).toBeVisible();
  await expect(page.getByText("Identity callbacks degraded")).toBeVisible();
  await expect(page.getByText("Degraded", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Update organization lifecycle" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create incident" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Update platform configuration" })).toBeVisible();
  const approvableElevation = page.getByRole("row").filter({ hasText: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  await expect(approvableElevation.getByRole("cell", { name: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).toBeVisible();
  const ownElevation = page.getByRole("row").filter({ hasText: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
  await expect(ownElevation.getByText("pending", { exact: true })).toBeVisible();
  await expect(ownElevation.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(approvableElevation.getByText("active", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("platform-operator-workbench.png"), fullPage: true });

  await page.getByLabel("Target organization").selectOption("55555555-5555-4555-8555-555555555555");
  await page.getByLabel("Reason", { exact: true }).fill("Investigate customer-requested authentication incident");
  await page.getByLabel("Scope").selectOption("support.customer-content.read");
  await page.getByRole("button", { name: "Request tenant access" }).click();
  await expect(page.getByText(/Elevation bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb created\. Approval required before use\./)).toBeVisible();
  expect(requestedElevation).toMatchObject({
    targetOrganizationId: "55555555-5555-4555-8555-555555555555",
    scopes: ["support.customer-content.read"],
    durationMinutes: 15,
    kind: "support",
  });
});

test("security auditor workbench hides mutation controls", async ({ page }) => {
  const auditorSession = { ...session, roles: ["security-auditor" as const] };
  await page.route("http://platform.test/api/v1/platform/**", (route) => route.fulfill({ json: { events: [] } }));
  await page.setContent(renderPlatformOperatorUi(auditorSession, { baseHref: "http://platform.test/" }));
  await expect(page.getByRole("heading", { name: "Recent operator audit" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Support elevations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Request tenant access" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Update organization lifecycle" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Create incident" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Update platform configuration" })).toBeHidden();
});

test("Lax operator session reaches a cross-site step-up GET callback but not a cross-site POST", async ({ context, page }) => {
  await context.addCookies([{
    name: "oc_platform_session",
    value: "opaque-session",
    domain: "platform.test",
    path: "/api/v1/platform",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  }]);
  let callbackCookie = "";
  let mutationCookie = "not-observed";
  await page.route("http://source.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<a id="callback" href="http://platform.test/api/v1/platform/auth/step-up/callback?state=x&code=y">Continue</a>
      <form id="mutation" method="post" action="http://platform.test/api/v1/platform/support/elevations"><button>Submit</button></form>`,
  }));
  await page.route("http://platform.test/api/v1/platform/**", (route) => {
    const cookie = route.request().headers().cookie ?? "";
    if (route.request().method() === "GET") callbackCookie = cookie;
    else mutationCookie = cookie;
    return route.fulfill({ status: 204 });
  });
  await page.goto("http://source.test/");
  await page.locator("#callback").click();
  await expect.poll(() => callbackCookie).toContain("oc_platform_session=opaque-session");
  await page.goto("http://source.test/");
  await page.locator("#mutation button").click();
  await expect.poll(() => mutationCookie).toBe("");
});
