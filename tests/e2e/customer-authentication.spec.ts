import { expect, test } from "@playwright/test";

const unauthenticated = {
  error: { code: "UNAUTHENTICATED", message: "Authentication is required.", retryable: false },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify(unauthenticated),
  }));
  await page.route("**/api/v1/auth/product-session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify(unauthenticated),
  }));
  await page.route("**/api/v1/auth/customer-capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      emailPassword: true,
      passkey: true,
      socialProviders: ["google", "microsoft"],
    }),
  }));
});

test("a same-email social sign-in explains how to link the provider safely", async ({ page }) => {
  await page.goto("/?signin=error&reason=SOCIAL_SIGNIN_FAILED&provider=microsoft&error=account_not_linked");

  await expect(page.getByRole("alert")).toContainText(
    "An account already exists for this email. Sign in using its existing method, then open Manage account security and link Microsoft.",
  );
});

test("an explicit provider-link failure remains visible on the no-organization screen", async ({ page }) => {
  await page.unroute("**/api/v1/auth/product-session");
  await page.route("**/api/v1/auth/product-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "membership-required",
      account: { id: "11111111-1111-4111-8111-111111111111" },
      user: { id: "11111111-1111-4111-8111-111111111111", name: "Alex Morgan", email: "alex@example.test" },
      memberships: [],
    }),
  }));

  await page.goto("/?signin=error&reason=SOCIAL_LINK_FAILED&provider=microsoft&error=unable_to_link_account");

  await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Microsoft could not be linked to this account. Try again from Manage account security.",
  );
});

test("social sign-in preserves the selected provider in its safe error callback", async ({ page }) => {
  let signInRequest: Record<string, unknown> | null = null;
  await page.route("**/api/v1/auth/customer/sign-in/social", async (route) => {
    signInRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "/provider-started" }),
    });
  });

  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await page.getByRole("button", { name: "Continue with Microsoft" }).click();
  await expect(page).toHaveURL(`${origin}/provider-started`);
  expect(signInRequest).toEqual({
    provider: "microsoft",
    callbackURL: `${origin}/`,
    errorCallbackURL: `${origin}/?signin=error&reason=SOCIAL_SIGNIN_FAILED&provider=microsoft`,
    disableRedirect: true,
  });
});

test("company SSO uses a dedicated email-discovery step", async ({ page }) => {
  let companySsoRequest: Record<string, unknown> | null = null;
  await page.unroute("**/api/v1/auth/customer-capabilities");
  await page.route("**/api/v1/auth/customer-capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      emailPassword: true,
      passkey: true,
      socialProviders: ["google", "microsoft"],
      companySso: true,
    }),
  }));
  await page.route("**/api/v1/auth/customer-sso", async (route) => {
    companySsoRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: "/company-idp-started" }),
    });
  });

  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await expect(page.getByRole("heading", { name: "Sign in with SSO" })).toBeVisible();
  await expect(page.getByLabel("Company work email")).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await page.getByLabel("Company work email").fill("person@EXAMPLE.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page).toHaveURL(`${origin}/company-idp-started`);
  expect(companySsoRequest).toEqual({ email: "person@EXAMPLE.com", returnPath: "/" });
});

test("provider-neutral customer sign-in exposes configured methods and safe account recovery", async ({ page }) => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/v1/auth/customer/sign-up/email", async (route) => {
    requests.push({ path: "signup", body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { id: "new-user" } }) });
  });
  await page.route("**/api/v1/auth/customer/request-password-reset", async (route) => {
    requests.push({ path: "recovery", body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: true }) });
  });
  await page.route("**/api/v1/auth/customer/send-verification-email", async (route) => {
    requests.push({ path: "verification", body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: true }) });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toBeVisible();

  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
  await page.getByLabel("Full name").fill("Alex Morgan");
  await page.getByLabel("Work email").fill("alex@example.test");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  expect(requests[0]).toEqual({
    path: "signup",
    body: { name: "Alex Morgan", email: "alex@example.test", password: "correct horse battery staple" },
  });
  await page.getByRole("button", { name: "Resend verification email" }).click();
  await expect(page.getByRole("status")).toContainText("Verification email sent");
  expect(requests[1]).toEqual({
    path: "verification",
    body: { email: "alex@example.test", callbackURL: expect.stringMatching(/\/$/) },
  });

  await page.getByRole("button", { name: "Back to sign in" }).click();
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.getByLabel("Work email").fill("unknown@example.test");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("If an account exists");
  expect(requests[2]).toEqual({
    path: "recovery",
    body: { email: "unknown@example.test", redirectTo: expect.stringMatching(/\/reset-password$/) },
  });
});

test("sign-in and sign-up actions remain reachable on a compact laptop viewport", async ({ page }) => {
  await page.unroute("**/api/v1/auth/customer-capabilities");
  await page.route("**/api/v1/auth/customer-capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      emailPassword: true,
      passkey: true,
      socialProviders: ["google", "microsoft"],
      companySso: true,
    }),
  }));
  await page.setViewportSize({ width: 1366, height: 650 });
  await page.goto("/");

  await expect(page.getByText("Your managed work computer", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Use a secure method configured for your organization.", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.getByRole("heading", { name: "Sign in", exact: true }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeLessThanOrEqual(30);
  await expect.poll(() => page.getByLabel("Work email").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
  await expect.poll(() => page.getByRole("button", { name: "Sign in", exact: true }).evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(40);

  for (const label of [
    "Sign in",
    "Continue with SSO",
    "Sign in with a passkey",
    "Continue with Google",
    "Continue with Microsoft",
  ]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box, `${label} should have layout bounds`).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0), `${label} should be above the fold`).toBeLessThanOrEqual(650);
  }

  await expect(page.locator(".signin-method-grid")).toHaveCSS("grid-template-columns", /\d+px \d+px/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(650);

  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Back to sign in" })).toBeInViewport();
});

test("an authenticated provider identity can recover when its email still needs verification", async ({ page }) => {
  let verificationRequest = null;
  await page.route("**/api/v1/auth/customer/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      session: {
        id: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      user: {
        id: "22222222-2222-4222-8222-222222222222",
        email: "microsoft-user@example.test",
        name: "Microsoft User",
        emailVerified: false,
      },
    }),
  }));
  await page.route("**/api/v1/auth/customer/send-verification-email", async (route) => {
    verificationRequest = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: true }) });
  });

  await page.goto("/");
  const origin = new URL(page.url()).origin;

  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await expect(page.getByText("Signed in as microsoft-user@example.test")).toBeVisible();
  await page.getByRole("button", { name: "Resend verification email" }).click();
  await expect(page.getByRole("status")).toContainText("Verification email sent");
  expect(verificationRequest).toEqual({
    email: "microsoft-user@example.test",
    callbackURL: `${origin}/`,
  });
});

test("an authenticated customer explicitly selects an active organization before product access", async ({ page }) => {
  const activeMembershipId = "33333333-3333-4333-8333-333333333333";
  let selected = false;
  let selectedBody: Record<string, unknown> | null = null;
  await page.unroute("**/api/v1/auth/session");
  await page.unroute("**/api/v1/auth/product-session");
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: selected ? 200 : 403,
    contentType: "application/json",
    body: JSON.stringify(selected ? {
      user: { id: "tenant-user", displayName: "Alex Morgan", email: "alex@example.test" },
      tenant: { id: "organization-1", displayName: "Example Organization" },
      roles: ["employee"],
      effectivePolicy: null,
    } : {
      error: { code: "ACTIVE_MEMBERSHIP_REQUIRED", message: "Select an active organization to continue", retryable: false },
    }),
  }));
  await page.route("**/api/v1/auth/product-session", async (route) => {
    if (route.request().method() === "PUT") {
      selectedBody = route.request().postDataJSON();
      selected = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ membership: { id: activeMembershipId, organizationId: "organization-1", status: "active", role: "member" } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "membership-required",
        account: { id: "11111111-1111-4111-8111-111111111111" },
        user: { id: "11111111-1111-4111-8111-111111111111", name: "Alex Morgan", email: "alex@example.test" },
        memberships: [
          { membershipId: activeMembershipId, organizationId: "organization-1", organizationDisplayName: "Example Organization", status: "active", role: "member" },
          { membershipId: "44444444-4444-4444-8444-444444444444", organizationId: "organization-2", organizationDisplayName: "Suspended Organization", status: "suspended", role: "member" },
        ],
      }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Choose an organization" })).toBeVisible();
  await expect(page.getByText("alex@example.test")).toBeVisible();
  await expect(page.getByRole("button", { name: /Example Organization/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Suspended Organization/ })).toBeDisabled();
  await page.getByRole("button", { name: /Example Organization/ }).click();
  await expect(page.getByRole("button", { name: /Alex Morgan/ })).toBeVisible();
  expect(selectedBody).toEqual({ membershipId: activeMembershipId });
});

test("a verified customer with no memberships creates an organization and enters it as owner", async ({ page }) => {
  let created = false;
  let organizationRequest: { body: Record<string, unknown>; idempotencyKey: string | undefined } | null = null;
  await page.unroute("**/api/v1/auth/session");
  await page.unroute("**/api/v1/auth/product-session");
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: created ? 200 : 403,
    contentType: "application/json",
    body: JSON.stringify(created ? {
      user: { id: "tenant-owner", displayName: "Alex Morgan", email: "alex@example.test" },
      tenant: { id: "organization-created", displayName: "Example Organization" },
      roles: ["owner", "administrator"],
      capabilities: ["organization.read"],
      resourceCapabilities: [],
      effectivePolicy: null,
    } : {
      error: { code: "ACTIVE_MEMBERSHIP_REQUIRED", message: "Select an active organization to continue", retryable: false },
    }),
  }));
  await page.route("**/api/v1/auth/product-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "membership-required",
      account: { id: "11111111-1111-4111-8111-111111111111" },
      user: { id: "11111111-1111-4111-8111-111111111111", name: "Alex Morgan", email: "alex@example.test" },
      memberships: [],
    }),
  }));
  await page.route("**/api/v1/auth/organizations", async (route) => {
    organizationRequest = {
      body: route.request().postDataJSON(),
      idempotencyKey: route.request().headers()["idempotency-key"],
    };
    created = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        replayed: false,
        organization: { id: "organization-created", slug: "example-organization", displayName: "Example Organization" },
        membership: { id: "33333333-3333-4333-8333-333333333333", status: "active", role: "owner" },
      }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
  await page.getByLabel("Organization name").fill("Example Organization");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("button", { name: /Alex Morgan/ })).toBeVisible();
  expect(organizationRequest?.body).toEqual({ displayName: "Example Organization" });
  expect(organizationRequest?.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("an authenticated customer can manage factors, linked providers, and device sessions", async ({ page }) => {
  const factorRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.unroute("**/api/v1/auth/session");
  await page.route("**/api/v1/auth/customer/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: { id: "customer-account", email: "user@example.test", name: "Example User", twoFactorEnabled: false } }),
  }));
  await page.route("**/api/v1/auth/customer/list-accounts", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{ id: "credential-account", providerId: "credential", accountId: "user@example.test" }]),
  }));
  await page.route("**/api/v1/auth/customer/two-factor/enable", async (route) => {
    factorRequests.push({ path: "enable", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        totpURI: "otpauth://totp/LemmaComputer:user%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=LemmaComputer",
        backupCodes: ["BACKUP-ONE", "BACKUP-TWO"],
      }),
    });
  });
  await page.route("**/api/v1/auth/customer/two-factor/verify-totp", async (route) => {
    factorRequests.push({ path: "verify", body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: true }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Example User/ }).click();
  await expect(page.getByRole("button", { name: "Account security" })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Account security" }).click();

  await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible();
  await expect(page.getByText("Email and password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Link Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link Microsoft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a passkey" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up authenticator" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out other devices" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out all devices" })).toBeVisible();

  await page.getByRole("button", { name: "Set up authenticator" }).click();
  await page.getByLabel("Current password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("img", { name: "Scan this QR code with your authenticator app" })).toBeVisible();
  await page.getByText("Can’t scan the QR code?").click();
  await expect(page.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();
  await expect(page.getByText("BACKUP-ONE")).toBeVisible();
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Verify authenticator" }).click();
  await expect(page.getByRole("button", { name: /Example User/ })).toBeVisible();
  expect(factorRequests).toEqual([
    { path: "enable", body: { password: "correct horse battery staple" } },
    { path: "verify", body: { code: "123456" } },
  ]);
});
