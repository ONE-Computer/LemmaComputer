import { expect, test } from "@playwright/test";

test("hosted invitation keeps the role fixed and hands authentication to External ID", async ({ page }) => {
  const invitationToken = "oci_playwright_invitation_secret";
  const externalAuthorizationUrl = "https://fixture.ciamlogin.com/fixture-tenant/oauth2/v2.0/authorize";
  let invitationRequest: {
    method: string;
    url: string;
    contentType: string;
    body: Record<string, unknown>;
  } | null = null;

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "UNAUTHENTICATED", message: "Authentication is required.", retryable: false },
    }),
  }));
  await page.route("**/api/v1/auth/external-id/invitation", async (route) => {
    const request = route.request();
    invitationRequest = {
      method: request.method(),
      url: request.url(),
      contentType: request.headers()["content-type"] ?? "",
      body: request.postDataJSON(),
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: externalAuthorizationUrl }),
    });
  });
  await page.route("https://fixture.ciamlogin.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>External ID fixture</title><h1>Microsoft Entra External ID</h1>",
  }));

  await page.goto(`/invite?token=${encodeURIComponent(invitationToken)}`);

  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByRole("heading", { name: "Accept your invitation" })).toBeVisible();
  await expect(page.getByText(/Microsoft manages your password and authenticator verification/)).toBeVisible();
  await expect(page.getByText(/applies only the organization and role chosen in this invitation/)).toBeVisible();
  await expect(page.getByText(/activate only its preassigned organization role/)).toBeVisible();

  await Promise.all([
    page.waitForURL(externalAuthorizationUrl),
    page.getByRole("button", { name: "Continue securely" }).click(),
  ]);
  await expect(page.getByRole("heading", { name: "Microsoft Entra External ID" })).toBeVisible();

  expect(invitationRequest).not.toBeNull();
  expect(invitationRequest?.method).toBe("POST");
  expect(invitationRequest?.url).not.toContain(invitationToken);
  expect(invitationRequest?.contentType).toContain("application/json");
  // Assert the secret value separately so a structural failure prints only a
  // redacted representation of the request body in Playwright output.
  expect(invitationRequest?.body.invitation === invitationToken).toBe(true);
  expect({ ...invitationRequest?.body, invitation: "[REDACTED]" }).toEqual({
    invitation: "[REDACTED]",
    return: "/",
  });
});
