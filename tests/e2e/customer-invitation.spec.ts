import { expect, test, type Page } from "@playwright/test";

const unauthenticated = {
  error: { code: "UNAUTHENTICATED", message: "Authentication is required.", retryable: false },
};

const invitationToken = `oci_${"playwright-invitation-capability".padEnd(43, "x")}`;

const installAnonymousInvitationRoutes = async (page: Page, companySsoAvailable = false) => {
  let authenticated = false;
  let accepted = false;
  let contextRequests = 0;
  let acceptanceRequests = 0;

  await page.route("**/api/v1/auth/invitations/context", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organizationDisplayName: "Acme Research",
          email: "invitee@example.test",
          role: "admin",
          companySsoAvailable,
          expiresAt: "2026-08-16T02:00:00.000Z",
        }),
      });
      return;
    }
    contextRequests += 1;
    expect(route.request().postDataJSON()).toEqual({ token: invitationToken });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        organizationDisplayName: "Acme Research",
        email: "invitee@example.test",
        role: "admin",
        companySsoAvailable,
        expiresAt: "2026-08-16T02:00:00.000Z",
      }),
    });
  });
  await page.route("**/api/v1/auth/invitations/accept", async (route) => {
    acceptanceRequests += 1;
    if (!authenticated) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(unauthenticated) });
      return;
    }
    accepted = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        organization: { id: "organization-acme", displayName: "Acme Research" },
        membership: { id: "membership-invited", role: "admin", status: "active" },
      }),
    });
  });
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: accepted ? 200 : 401,
    contentType: "application/json",
    body: JSON.stringify(accepted ? {
      user: { id: "invited-user", displayName: "Invited Person", email: "invitee@example.test" },
      tenant: { id: "organization-acme", displayName: "Acme Research" },
      roles: ["employee", "administrator"],
      capabilities: [],
      resourceCapabilities: [],
      effectivePolicy: null,
    } : unauthenticated),
  }));
  await page.route("**/api/v1/auth/product-session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify(unauthenticated),
  }));
  await page.route("**/api/v1/auth/customer/get-session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify(unauthenticated),
  }));
  await page.route("**/api/v1/auth/customer-capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ emailPassword: true, passkey: true, socialProviders: ["google", "microsoft"], companySso: true }),
  }));

  return {
    authenticate: () => { authenticated = true; },
    counts: () => ({ contextRequests, acceptanceRequests }),
  };
};

test("a company SSO invitation locks the invited identity and presents one clear action", async ({ page }) => {
  const fixture = await installAnonymousInvitationRoutes(page, true);

  await page.goto(`/invite?token=${encodeURIComponent(invitationToken)}`);

  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByRole("heading", { name: "Join Acme Research" })).toBeVisible();
  await expect(page.getByLabel("Invited work email", { exact: true })).toHaveValue("invitee@example.test");
  await expect(page.getByLabel("Invited work email", { exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("Full name")).toHaveCount(0);
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue with SSO" })).toBeVisible();
  expect(fixture.counts()).toEqual({ contextRequests: 1, acceptanceRequests: 1 });
  expect(page.url()).not.toContain(invitationToken);
});

test("a company SSO callback failure stays on the invitation with safe recovery guidance", async ({ page }) => {
  await installAnonymousInvitationRoutes(page, true);

  await page.goto("/invite?error=invalid_provider&error_description=token_response_not_found");

  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByRole("heading", { name: "Join Acme Research" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Your organization’s identity provider could not complete sign-in. Ask an administrator to test the Company SSO connection, then try this invitation again.",
  );
  await expect(page.getByRole("alert")).not.toContainText("token_response_not_found");
});

test("a different signed-in account stays on the invitation and can explicitly switch accounts", async ({ page }) => {
  let signedIn = true;
  let signOutRequests = 0;

  await page.route("**/api/v1/auth/invitations/context", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      organizationDisplayName: "Acme Research",
      role: "member",
      expiresAt: "2026-08-16T02:00:00.000Z",
    }),
  }));
  await page.route("**/api/v1/auth/invitations/accept", (route) => route.fulfill({
    status: 403,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "INVITATION_SIGNIN_FAILED", message: "This invitation cannot be used to sign in", retryable: false },
    }),
  }));
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: signedIn ? 200 : 401,
    contentType: "application/json",
    body: JSON.stringify(signedIn ? {
      user: { id: "inviter-user", displayName: "Current Owner", email: "owner@example.test" },
      tenant: { id: "organization-owner", displayName: "Owner Organization" },
      roles: ["employee", "administrator"],
      capabilities: [],
      resourceCapabilities: [],
      effectivePolicy: null,
    } : unauthenticated),
  }));
  await page.route("**/api/v1/auth/product-session", (route) => {
    if (route.request().method() === "DELETE") {
      signOutRequests += 1;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(unauthenticated) });
  });
  await page.route("**/api/v1/auth/logout", (route) => {
    signOutRequests += 1;
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/v1/auth/customer/sign-out", (route) => {
    signOutRequests += 1;
    signedIn = false;
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/v1/auth/customer/get-session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify(unauthenticated),
  }));
  await page.route("**/api/v1/auth/customer-capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ emailPassword: true, passkey: true, socialProviders: [] }),
  }));

  await page.goto(`/invite?token=${encodeURIComponent(invitationToken)}`);

  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByRole("heading", { name: "Continue with the invited account" })).toBeVisible();
  await expect(page.getByText(/Signed in as owner@example\.test/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out and continue" }).click();

  await expect(page.getByRole("heading", { name: "Join Acme Research" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeVisible();
  // Product logout now clears the selected membership server-side, so only
  // Control logout and Better Auth sign-out are separate browser requests.
  expect(signOutRequests).toBe(2);
});

test("a new invitee sees a durable verification step that will finish the invitation", async ({ page }) => {
  await installAnonymousInvitationRoutes(page);
  let signUpBody: Record<string, unknown> | null = null;
  let verificationBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/auth/customer/sign-up/email", async (route) => {
    signUpBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { id: "new-user" } }) });
  });
  await page.route("**/api/v1/auth/customer/send-verification-email", async (route) => {
    verificationBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: true }) });
  });

  await page.goto(`/invite?token=${encodeURIComponent(invitationToken)}`);
  const origin = new URL(page.url()).origin;
  await page.getByLabel("Full name").fill("Invited Person");
  await expect(page.getByLabel("Invited work email", { exact: true })).toHaveValue("invitee@example.test");
  await expect(page.getByLabel("Invited work email", { exact: true })).toHaveAttribute("readonly", "");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText(/verify your email and finish joining Acme Research automatically/)).toBeVisible();
  expect(signUpBody).toEqual({
    name: "Invited Person",
    email: "invitee@example.test",
    password: "correct horse battery staple",
    callbackURL: `${origin}/invite?verified=1`,
  });

  await page.getByRole("button", { name: "Resend verification email" }).click();
  expect(verificationBody).toEqual({ email: "invitee@example.test", callbackURL: `${origin}/invite?verified=1` });
});

test("an invited company SSO identity keeps the invitation in its verification email callback", async ({ page }) => {
  let verificationBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/auth/invitations/context", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      organizationDisplayName: "Acme Research",
      role: "admin",
      expiresAt: "2026-08-16T02:00:00.000Z",
    }),
  }));
  await page.route("**/api/v1/auth/invitations/accept", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify(unauthenticated),
  }));
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: 403,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "ACTIVE_MEMBERSHIP_REQUIRED", message: "Membership required", retryable: false } }),
  }));
  await page.route("**/api/v1/auth/product-session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify(unauthenticated),
  }));
  await page.route("**/api/v1/auth/customer/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      session: { id: "sso-session", userId: "sso-user", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      user: { id: "sso-user", email: "invitee@example.test", name: "Invited Person", emailVerified: false },
    }),
  }));
  await page.route("**/api/v1/auth/customer/send-verification-email", async (route) => {
    verificationBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: true }) });
  });

  await page.goto("/invite");
  const origin = new URL(page.url()).origin;
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await expect(page.getByText(/finish joining Acme Research/)).toBeVisible();
  await page.getByRole("button", { name: "Resend verification email" }).click();

  expect(verificationBody).toEqual({
    email: "invitee@example.test",
    callbackURL: `${origin}/invite?verified=1`,
  });
});

test("the verification callback restores context and completes the invitation without another login", async ({ page }) => {
  let contextRequests = 0;
  let acceptanceRequests = 0;
  await page.route("**/api/v1/auth/invitations/context", async (route) => {
    expect(route.request().method()).toBe("GET");
    contextRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        organizationDisplayName: "Acme Research",
        role: "admin",
        expiresAt: "2026-08-16T02:00:00.000Z",
      }),
    });
  });
  await page.route("**/api/v1/auth/invitations/accept", async (route) => {
    acceptanceRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        organization: { id: "organization-acme", displayName: "Acme Research" },
        membership: { id: "membership-invited", role: "admin", status: "active" },
      }),
    });
  });
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      user: { id: "invited-user", displayName: "Invited Person", email: "invitee@example.test" },
      tenant: { id: "organization-acme", displayName: "Acme Research" },
      roles: ["employee", "administrator"],
      capabilities: [],
      resourceCapabilities: [],
      effectivePolicy: null,
    }),
  }));

  await page.goto("/invite?verified=1");

  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByText("Email verified. You joined Acme Research.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Invited Person/ })).toBeVisible();
  expect({ contextRequests, acceptanceRequests }).toEqual({ contextRequests: 1, acceptanceRequests: 1 });
});

test("an invalid new link never falls through to an older invitation context", async ({ page }) => {
  let acceptanceRequests = 0;
  await page.route("**/api/v1/auth/invitations/context", (route) => route.fulfill({
    status: 403,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "INVITATION_SIGNIN_FAILED", message: "This invitation cannot be used to sign in", retryable: false },
    }),
  }));
  await page.route("**/api/v1/auth/invitations/accept", (route) => {
    acceptanceRequests += 1;
    return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(unauthenticated) });
  });
  for (const path of ["session", "product-session", "customer/get-session"]) {
    await page.route(`**/api/v1/auth/${path}`, (route) => route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify(unauthenticated),
    }));
  }
  await page.route("**/api/v1/auth/customer-capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ emailPassword: true, passkey: true, socialProviders: [] }),
  }));

  await page.goto(`/invite?token=${encodeURIComponent(invitationToken)}`);

  await expect(page.getByRole("alert")).toContainText("This invitation cannot be used to sign in");
  expect(acceptanceRequests).toBe(0);
});

for (const provider of ["google", "microsoft"] as const) {
  test(`${provider} invitation sign-in returns to the opaque invitation context`, async ({ page }) => {
    const fixture = await installAnonymousInvitationRoutes(page);
    let socialRequest: Record<string, unknown> | null = null;
    await page.route("**/api/v1/auth/customer/sign-in/social", async (route) => {
      socialRequest = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: "/provider-started" }),
      });
    });

    await page.goto(`/invite?token=${encodeURIComponent(invitationToken)}`);
    const origin = new URL(page.url()).origin;
    await page.getByRole("button", { name: `Continue with ${provider === "google" ? "Google" : "Microsoft"}` }).click();
    await expect(page).toHaveURL(`${origin}/provider-started`);

    expect(socialRequest).toEqual({
      provider,
      callbackURL: `${origin}/invite`,
      errorCallbackURL: `${origin}/invite?signin=error&reason=SOCIAL_SIGNIN_FAILED&provider=${provider}`,
      disableRedirect: true,
    });
    expect(JSON.stringify(socialRequest)).not.toContain(invitationToken);
    expect(fixture.counts()).toEqual({ contextRequests: 1, acceptanceRequests: 1 });
  });
}

test("email and password accepts the predetermined membership after a fresh Better Auth sign-in", async ({ page }) => {
  const fixture = await installAnonymousInvitationRoutes(page);
  let signInBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/auth/customer/sign-in/email", async (route) => {
    signInBody = route.request().postDataJSON();
    fixture.authenticate();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "invited-user", email: "invitee@example.test" } }),
    });
  });

  await page.goto(`/invite?token=${encodeURIComponent(invitationToken)}`);
  await page.getByRole("button", { name: "I already have an account" }).click();
  await expect(page.getByLabel("Invited work email", { exact: true })).toHaveValue("invitee@example.test");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByRole("button", { name: /Invited Person/ })).toBeVisible();
  expect(signInBody).toEqual({ email: "invitee@example.test", password: "correct horse battery staple" });
  expect(fixture.counts()).toEqual({ contextRequests: 1, acceptanceRequests: 2 });
});
