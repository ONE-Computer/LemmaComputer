import { expect, test } from "@playwright/test";

const workspaceManagerSession = {
  user: { id: "workspace-manager", displayName: "Workspace Manager", email: "manager@example.test" },
  tenant: { id: "acme", displayName: "Example Organization" },
  roles: ["member", "employee"],
  capabilities: ["organization.read", "workspace.use", "workspace.manage"],
  resourceCapabilities: [],
};

const managedWorkspace = (id: string, name: string, state = "ready") => ({
  id,
  name,
  state,
  health: { status: state === "ready" ? "healthy" : state === "failed" ? "needs_attention" : "transitioning", reasonCode: state === "failed" ? "RUNTIME_UNAVAILABLE" : null },
  profile: { id: "kasm-persistent-standard", executionMode: "managed" },
  policyAssignment: { authority: "protected_baseline", version: 1, hash: "a".repeat(64) },
  lastActivityAt: "2026-08-12T01:30:00.000Z",
  lastTransitionAt: "2026-08-12T01:45:00.000Z",
  createdAt: "2026-08-11T01:00:00.000Z",
});

test("organization administrator invites a person and manages member access", async ({ page }) => {
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "People and access" }).click();
  await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
  await expect(page).toHaveURL(/\?view=settings&section=people$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
  await expect(page.getByText("Identity-provider credentials remain outside LemmaComputer.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Office worker workspace" })).toHaveCount(0);

  await page.goto("/?view=home&section=policies");
  await expect(page.getByRole("heading", { name: "Workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Workspace policies" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Office worker workspace" })).toBeVisible();
  await expect(page.getByText("Immutable · v1")).toBeVisible();
  const protectedMember = page.locator('[aria-label="Protected workspace policy assignments"] article').filter({ hasText: "Example Admin" });
  await protectedMember.getByRole("button", { name: "Assign baseline" }).click();
  await expect(protectedMember).toContainText("Baseline assigned · version 1");
  await expect(protectedMember).toContainText("Restart workspace to apply policy change");
  await protectedMember.getByRole("button", { name: "Revoke workspace access" }).click();
  await expect(protectedMember).toContainText("Workspace access revoked");

  await page.goto("/?view=settings&section=people");

  const sectionActions = ["Invite person", "Initiate organization closure", "Add connection", "Create custom role"];
  for (const name of sectionActions) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box?.width).toBeCloseTo(260, 0);
    expect(box?.height).toBeCloseTo(56, 0);
  }
  const ownerSessionAction = page.locator(".admin-user-list article").first().getByRole("button", { name: "Sign out sessions" });
  const ownerSessionBox = await ownerSessionAction.boundingBox();
  expect(ownerSessionBox?.width).toBeCloseTo(180, 0);
  expect(ownerSessionBox?.height).toBeCloseTo(40, 0);

  const memberRow = page.locator(".admin-user-list article").filter({ hasText: "admin@example.test" });
  const memberRowBox = await memberRow.boundingBox();
  const memberActionsBox = await memberRow.locator(".admin-user-actions").boundingBox();
  expect((memberActionsBox?.y ?? 0) - (memberRowBox?.y ?? 0)).toBeGreaterThanOrEqual(16);
  expect(
    ((memberRowBox?.y ?? 0) + (memberRowBox?.height ?? 0))
      - ((memberActionsBox?.y ?? 0) + (memberActionsBox?.height ?? 0)),
  ).toBeGreaterThanOrEqual(16);

  await page.getByRole("button", { name: "Invite person" }).click();
  const inviteDialog = page.getByRole("dialog", { name: "Invite a person" });
  await inviteDialog.getByLabel("Email address").fill("new.user@example.test");
  await inviteDialog.getByRole("combobox", { name: "Invited organization role" }).click();
  await page.getByRole("option", { name: "Administrator" }).click();
  await inviteDialog.getByRole("button", { name: "Create invitation" }).click();

  const invitation = page.locator(".admin-invitation-list article").filter({ hasText: "new.user@example.test" });
  await expect(invitation).toContainText("Administrator");
  await expect(invitation).toContainText("pending");
  const invitationLink = page.getByLabel("Invitation link");
  await expect(invitationLink).toHaveValue(/\/invite\?token=oci_fixture_invitation_token$/);

  await invitation.getByRole("button", { name: "Resend" }).click();
  await expect(invitationLink).toHaveValue(/\/invite\?token=oci_fixture_rotated_token$/);
  await invitation.getByRole("button", { name: "Revoke" }).click();
  const revokeDialog = page.getByRole("dialog", { name: /Revoke the invitation/ });
  await revokeDialog.getByRole("button", { name: "Revoke invitation" }).click();
  await expect(invitation).toContainText("revoked");

  const member = page.locator(".admin-user-list article").filter({ hasText: "admin@example.test" });
  await member.getByRole("combobox", { name: "Organization role for Example Admin" }).click();
  await page.getByRole("option", { name: "Administrator" }).click();
  const roleDialog = page.getByRole("dialog", { name: "Change Example Admin to Administrator?" });
  await roleDialog.getByRole("button", { name: "Change role" }).click();
  await expect(member).toContainText("Administrator");

  await member.getByRole("button", { name: "Suspend", exact: true }).click();
  const suspendDialog = page.getByRole("dialog", { name: "Suspend Example Admin?" });
  await suspendDialog.getByRole("button", { name: "Suspend", exact: true }).click();
  await expect(member).toContainText("suspended");
  await member.getByRole("button", { name: "Reactivate" }).click();
  await page.getByRole("dialog", { name: "Reactivate Example Admin?" }).getByRole("button", { name: "Reactivate" }).click();
  await expect(member.getByText("suspended", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/people-access-reviewed.png", fullPage: true });
});

test("settings subsections keep their location across refresh", async ({ page }) => {
  await page.route("**/api/v1/auth/customer-capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ emailPassword: true, passkey: true, socialProviders: [], companySso: true }),
  }));
  await page.route("**/api/v1/auth/customer/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: { id: "customer-account", email: "user@example.test", name: "Example User", twoFactorEnabled: true } }),
  }));
  await page.route("**/api/v1/auth/customer/list-accounts", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{ id: "credential-account", providerId: "credential", accountId: "user@example.test" }]),
  }));
  await page.goto("/?view=settings");

  await page.getByRole("button", { name: "Credentials" }).click();
  await expect(page).toHaveURL(/\?view=settings&section=credentials$/);
  await expect(page.getByRole("heading", { name: "Credentials", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Credentials", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to Settings" }).click();
  await page.getByRole("button", { name: "Account security" }).click();
  await expect(page).toHaveURL(/\?view=settings&section=security$/);
  const securityDialog = page.getByRole("dialog", { name: "Account security" });
  await expect(securityDialog).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Account security" })).toBeVisible();
  await expect(page.getByText("Passkeys can sign you in, but protected owner actions—including Company SSO changes—require an authenticator code.")).toBeVisible();
});

test("organization owner registers company SSO without exposing its client secret", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let connection: Record<string, unknown> | null = null;
  let registration: Record<string, unknown> | null = null;
  await page.route("**/api/v1/admin/sso**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/v1/admin/sso")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ connections: connection ? [connection] : [] }),
      });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/v1/admin/sso")) {
      registration = request.postDataJSON();
      connection = {
        id: "77777777-7777-4777-8777-777777777777",
        organizationId: "acme",
        authenticationProviderId: "sso_fixture_provider",
        protocol: "oidc",
        domain: "example.com",
        issuer: "https://idp.example.com/",
        state: "pending",
        configVersion: 1,
        domainVerifiedAt: null,
        lastTestedAt: null,
        recoveryConfirmedAt: null,
        enforcedAt: null,
        suspendedAt: null,
        disconnectedAt: null,
        createdAt: "2026-08-10T01:00:00.000Z",
        updatedAt: "2026-08-10T01:00:00.000Z",
      };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          connection,
          domainVerification: {
            token: "better-auth-domain-proof",
            redirectURI: "http://127.0.0.1:4399/api/auth/sso/callback/sso_fixture_provider",
          },
        }),
      });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/domain-verification/request") && connection) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          connectionId: connection.id,
          providerId: connection.authenticationProviderId,
          domain: connection.domain,
          token: "refreshed-better-auth-domain-proof",
          redirectURI: "http://127.0.0.1:4399/api/auth/sso/callback/sso_fixture_provider",
        }),
      });
      return;
    }
    await route.abort("failed");
  });

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "People and access" }).click();
  await expect(page.getByRole("heading", { name: "Company SSO" })).toBeVisible();
  await expect(page.getByText("No company SSO connection is configured.")).toBeVisible();

  await page.getByRole("button", { name: "Add connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Add company SSO" });
  await dialog.getByLabel("Verified email domain").fill("example.com");
  const issuerField = dialog.getByLabel("Issuer URL");
  const clientIdField = dialog.getByLabel("Client ID");
  await issuerField.fill("https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0");
  await clientIdField.fill("11111111-2222-4333-8444-555555555555");
  await expect(dialog.getByText("This is the Directory (tenant) ID. Paste the Application (client) ID instead.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save connection" })).toBeDisabled();
  await issuerField.fill("https://idp.example.com");
  await clientIdField.fill("lemma-client");
  await dialog.getByLabel("Client secret", { exact: true }).fill("top-secret-value");
  await expect(dialog.getByLabel("Client secret", { exact: true })).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Show client secret" }).click();
  await expect(dialog.getByLabel("Client secret", { exact: true })).toHaveAttribute("type", "text");
  await dialog.getByRole("button", { name: "Hide client secret" }).click();
  await expect(dialog.getByLabel("Client secret", { exact: true })).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Save connection" }).click();

  await expect(page.getByText("DNS TXT record")).toBeVisible();
  await expect(page.getByLabel("DNS TXT host", { exact: true })).toHaveValue("_lemmacomputer-sso-sso_fixture_provider");
  await expect(page.getByLabel("DNS TXT value", { exact: true })).toHaveValue("better-auth-domain-proof");
  await expect(page.getByLabel("OIDC redirect URI", { exact: true })).toHaveValue("http://127.0.0.1:4399/api/auth/sso/callback/sso_fixture_provider");
  await expect(page.getByRole("button", { name: "Copy DNS TXT host" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy DNS TXT value" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy OIDC redirect URI" })).toBeVisible();
  await page.getByRole("button", { name: "Copy DNS TXT host" }).click();
  await expect(page.getByRole("button", { name: "DNS TXT host copied" })).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("_lemmacomputer-sso-sso_fixture_provider");
  await expect(page.getByText("example.com", { exact: true })).toBeVisible();
  await expect(page.getByText("DNS proof required")).toBeVisible();
  await expect(page.getByText("top-secret-value")).toHaveCount(0);
  const configurationBox = await page.locator(".sso-configuration-details").boundingBox();
  const connectionRow = page.locator(".sso-connection-list article").first();
  const connectionBox = await connectionRow.boundingBox();
  const firstActionBox = await connectionRow.getByRole("button", { name: "Show DNS proof" }).boundingBox();
  expect((connectionBox?.y ?? 0) - ((configurationBox?.y ?? 0) + (configurationBox?.height ?? 0))).toBeGreaterThanOrEqual(20);
  expect((firstActionBox?.y ?? 0) - (connectionBox?.y ?? 0)).toBeGreaterThanOrEqual(16);
  await page.screenshot({ path: "test-results/company-sso-polish-reviewed.png", fullPage: true });
  await page.getByRole("button", { name: "Show DNS proof" }).click();
  await expect(page.getByLabel("DNS TXT value", { exact: true })).toHaveValue("refreshed-better-auth-domain-proof");
  expect(registration).toEqual({
    protocol: "oidc",
    domain: "example.com",
    issuer: "https://idp.example.com",
    clientId: "lemma-client",
    clientSecret: "top-secret-value",
  });
});

test("failed company SSO test callback keeps the saved connection visible after refresh", async ({ page }) => {
  const connectionId = "77777777-7777-4777-8777-777777777776";
  const connection = {
    id: connectionId,
    organizationId: "acme",
    authenticationProviderId: "sso_fixture_saved",
    protocol: "oidc",
    domain: "example.com",
    issuer: "https://idp.example.com/",
    state: "pending",
    configVersion: 1,
    domainVerifiedAt: "2026-08-10T01:00:00.000Z",
    lastTestedAt: null,
    recoveryConfirmedAt: null,
    enforcedAt: null,
    suspendedAt: null,
    disconnectedAt: null,
    createdAt: "2026-08-10T01:00:00.000Z",
    updatedAt: "2026-08-10T01:00:00.000Z",
  };
  let listRequests = 0;
  await page.route("**/api/v1/admin/sso**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith(`/${connectionId}/test/complete`)) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INVALID_REQUEST", message: "The request is invalid" } }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/v1/admin/sso")) {
      listRequests += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [connection] }) });
      return;
    }
    await route.abort("failed");
  });

  await page.goto(`/?view=settings&sso_test=${connectionId}`);
  await page.getByRole("button", { name: "People and access" }).click();

  await expect(page.getByText("Company SSO test could not be completed. The saved connection is unchanged.")).toBeVisible();
  await expect(page.getByText("example.com", { exact: true })).toBeVisible();
  await expect(page.getByText("No company SSO connection is configured.")).toHaveCount(0);
  await expect.poll(() => listRequests).toBeGreaterThan(0);
  await expect.poll(() => new URL(page.url()).searchParams.has("sso_test")).toBe(false);

  await page.reload();
  await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
  await expect(page.getByText("example.com", { exact: true })).toBeVisible();
});

test("company SSO provider errors remain separate from the connection ID and explain the next action", async ({ page }) => {
  const connectionId = "77777777-7777-4777-8777-777777777775";
  const connection = {
    id: connectionId,
    organizationId: "acme",
    authenticationProviderId: "sso_fixture_saved",
    protocol: "oidc",
    domain: "example.com",
    issuer: "https://login.microsoftonline.com/tenant/v2.0",
    state: "pending",
    configVersion: 2,
    domainVerifiedAt: "2026-08-10T01:00:00.000Z",
    lastTestedAt: null,
    recoveryConfirmedAt: null,
    enforcedAt: null,
    suspendedAt: null,
    disconnectedAt: null,
    createdAt: "2026-08-10T01:00:00.000Z",
    updatedAt: "2026-08-10T01:00:00.000Z",
  };
  let completionRequests = 0;
  await page.route("**/api/v1/admin/sso**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/test/complete")) {
      completionRequests += 1;
      await route.fulfill({ status: 500, body: "should not be called" });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/v1/admin/sso")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [connection] }) });
      return;
    }
    await route.abort("failed");
  });

  await page.goto(`/sso-test/${connectionId}?error=invalid_provider&error_description=token_response_not_found`);

  await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
  await expect(page.getByText("Microsoft did not return a usable sign-in token. Confirm the Application (client) ID, client secret value, and exact OIDC redirect URI, then test again.")).toBeVisible();
  await expect(page.getByText("example.com", { exact: true })).toBeVisible();
  expect(completionRequests).toBe(0);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("settings");
  await expect.poll(() => new URL(page.url()).searchParams.get("section")).toBe("people");
  await expect.poll(() => new URL(page.url()).searchParams.has("error")).toBe(false);
});

test("company SSO provider callback preserves the safe Microsoft failure detail", async ({ page }) => {
  const connectionId = "77777777-7777-4777-8777-777777777779";
  const connection = {
    id: connectionId,
    organizationId: "acme",
    authenticationProviderId: "sso_fixture_saved",
    protocol: "oidc",
    domain: "example.com",
    issuer: "https://login.microsoftonline.com/tenant/v2.0",
    state: "pending",
    configVersion: 2,
    domainVerifiedAt: "2026-08-10T01:00:00.000Z",
    lastTestedAt: null,
    recoveryConfirmedAt: null,
    enforcedAt: null,
    suspendedAt: null,
    disconnectedAt: null,
    createdAt: "2026-08-10T01:00:00.000Z",
    updatedAt: "2026-08-10T01:00:00.000Z",
  };
  await page.route("**/api/v1/admin/sso**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/v1/admin/sso")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [connection] }) });
      return;
    }
    await route.abort("failed");
  });

  const providerDetail = "AADSTS7000215: Invalid client secret is provided.";
  await page.goto(`/sso-test/${connectionId}?error=invalid_provider&error_description=${encodeURIComponent(providerDetail)}`);

  await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
  await expect(page.getByText("Microsoft rejected the client secret. Paste the secret value, not its Secret ID, then test again.")).toBeVisible();
  await expect(page.getByText("Microsoft reference: AADSTS7000215")).toBeVisible();
});

test("organization owner rotates company SSO credentials through protected fail-closed state", async ({ page }) => {
  const connection = {
    id: "77777777-7777-4777-8777-777777777778",
    organizationId: "acme",
    authenticationProviderId: "sso_fixture_enforced",
    protocol: "oidc",
    domain: "example.com",
    issuer: "https://idp.example.com/",
    state: "enforced",
    configVersion: 1,
    domainVerifiedAt: "2026-08-10T01:00:00.000Z",
    lastTestedAt: "2026-08-10T01:10:00.000Z",
    recoveryConfirmedAt: "2026-08-10T01:20:00.000Z",
    enforcedAt: "2026-08-10T01:30:00.000Z",
    suspendedAt: null,
    disconnectedAt: null,
    createdAt: "2026-08-10T01:00:00.000Z",
    updatedAt: "2026-08-10T01:30:00.000Z",
  };
  let rotation: Record<string, unknown> | null = null;
  await page.route("**/api/v1/admin/sso**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/v1/admin/sso")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [connection] }) });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/credentials/rotation")) {
      rotation = request.postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...connection,
          state: "pending",
          configVersion: 2,
          lastTestedAt: null,
          recoveryConfirmedAt: null,
          enforcedAt: null,
        }),
      });
      return;
    }
    await route.abort("failed");
  });
  await page.route("**/api/v1/auth/owner-step-up", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ verifiedAt: "2026-08-10T02:00:00.000Z", validForSeconds: 600 }),
  }));

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "People and access" }).click();
  await page.getByRole("button", { name: "Rotate credentials" }).click();
  const dialog = page.getByRole("dialog", { name: "Rotate credentials" });
  await expect(dialog).toContainText("Paste the secret Value from the identity provider, not its Secret ID");
  await expect(dialog).toContainText("six-digit code from the LemmaComputer entry in your authenticator app");
  await dialog.getByLabel("Client ID").fill("replacement-client");
  await dialog.getByLabel("Client secret", { exact: true }).fill("replacement-secret");
  await expect(dialog.getByLabel("Client secret", { exact: true })).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Show client secret" }).click();
  await expect(dialog.getByLabel("Client secret", { exact: true })).toHaveAttribute("type", "text");
  await dialog.getByLabel("Authenticator code").fill("123456");
  await dialog.getByRole("button", { name: "Rotate credentials" }).click();

  await expect(page.getByRole("status")).toContainText("pending until the provider is tested again");
  await expect(page.getByText("replacement-secret")).toHaveCount(0);
  expect(rotation).toEqual({
    protocol: "oidc",
    clientId: "replacement-client",
    clientSecret: "replacement-secret",
  });
});

test("organization owner refreshes OIDC metadata through protected fail-closed state", async ({ page }) => {
  const connection = {
    id: "77777777-7777-4777-8777-777777777779",
    organizationId: "acme",
    authenticationProviderId: "sso_fixture_metadata",
    protocol: "oidc",
    domain: "example.com",
    issuer: "https://idp.example.com/",
    state: "enforced",
    configVersion: 1,
    domainVerifiedAt: "2026-08-10T01:00:00.000Z",
    lastTestedAt: "2026-08-10T01:10:00.000Z",
    recoveryConfirmedAt: "2026-08-10T01:20:00.000Z",
    enforcedAt: "2026-08-10T01:30:00.000Z",
    suspendedAt: null,
    disconnectedAt: null,
    createdAt: "2026-08-10T01:00:00.000Z",
    updatedAt: "2026-08-10T01:30:00.000Z",
  };
  let refresh: Record<string, unknown> | null = null;
  await page.route("**/api/v1/admin/sso**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/v1/admin/sso")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [connection] }) });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/metadata/refresh")) {
      refresh = request.postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...connection,
          state: "pending",
          configVersion: 2,
          lastTestedAt: null,
          recoveryConfirmedAt: null,
          enforcedAt: null,
        }),
      });
      return;
    }
    await route.abort("failed");
  });
  await page.route("**/api/v1/auth/owner-step-up", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ verifiedAt: "2026-08-10T02:00:00.000Z", validForSeconds: 600 }),
  }));

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "People and access" }).click();
  await page.getByRole("button", { name: "Refresh metadata" }).click();
  const dialog = page.getByRole("dialog", { name: "Refresh metadata" });
  await expect(dialog).toContainText("fetch the issuer discovery document again");
  await dialog.getByLabel("Authenticator code").fill("123456");
  await dialog.getByRole("button", { name: "Refresh metadata" }).click();

  await expect(page.getByRole("status")).toContainText("pending until the provider is tested again");
  expect(refresh).toEqual({ protocol: "oidc" });
});

test("organization owner creates a reviewed custom role and assigns it without changing protected roles", async ({ page }) => {
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "People and access" }).click();

  await expect(page.getByRole("heading", { name: "Custom roles" })).toBeVisible();
  await expect(page.getByText("Owner, Administrator, and Member remain protected")).toBeVisible();
  await page.getByRole("button", { name: "Create custom role" }).click();

  const editor = page.getByRole("dialog", { name: "Create custom role" });
  await editor.getByLabel("Role name").fill("Workspace reviewer");
  await editor.getByLabel("Role description").fill("Reviews workspace activity");
  await editor.getByRole("checkbox", { name: "Read organization audit records" }).check();
  await editor.getByRole("combobox", { name: "Scope for Read organization audit records" }).click();
  await expect(page.getByRole("option", { name: "Selected workspace" })).toHaveCount(0);
  await page.getByRole("option", { name: "All organization resources" }).click();
  await editor.getByRole("button", { name: "Create role" }).click();

  const role = page.locator(".admin-custom-role-card").filter({ hasText: "Workspace reviewer" });
  await expect(role).toContainText("Version 1");
  await role.getByRole("combobox", { name: "Assign Workspace reviewer to member" }).click();
  await page.getByRole("option", { name: "Example Admin" }).click();
  await role.getByRole("button", { name: "Assign role" }).click();
  await expect(role).toContainText("Assigned to Example Admin");

  await role.getByRole("button", { name: "Edit Workspace reviewer" }).click();
  const updateEditor = page.getByRole("dialog", { name: "Edit Workspace reviewer" });
  await updateEditor.getByRole("checkbox", { name: "Read organization usage and spend records" }).check();
  await updateEditor.getByRole("button", { name: "Save new version" }).click();
  await expect(role).toContainText("Version 2");
});

test("organization owner uses explicit step-up protected transfer and closure initiation", async ({ page }) => {
  const requests: Array<{ path: string; body: Record<string, unknown>; idempotencyKey?: string }> = [];
  await page.route("**/api/v1/auth/owner-step-up", async (route) => {
    requests.push({ path: "step-up", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ verifiedAt: "2026-08-09T02:00:00.000Z", validForSeconds: 600 }),
    });
  });
  await page.route("**/api/v1/admin/organization/ownership-transfer", async (route) => {
    requests.push({ path: "transfer", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        previousOwner: { membershipId: "b1111111-1111-4111-8111-111111111111", role: "admin" },
        owner: { membershipId: "b2222222-2222-4222-8222-222222222222", userId: "example-admin", role: "owner" },
        revokedSessions: 1,
      }),
    });
  });
  await page.route("**/api/v1/admin/organization/closure", async (route) => {
    requests.push({
      path: "closure",
      body: route.request().postDataJSON(),
      idempotencyKey: route.request().headers()["idempotency-key"],
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        replayed: false,
        request: {
          id: "77777777-7777-4777-8777-777777777777",
          status: "pending",
          requestedAt: "2026-08-09T02:00:00.000Z",
          executeAfter: "2026-08-16T02:00:00.000Z",
        },
      }),
    });
  });

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "People and access" }).click();

  await page.getByRole("button", { name: "Initiate organization closure" }).click();
  const closure = page.getByRole("dialog", { name: "Initiate organization closure" });
  await closure.getByLabel("Reason for closure").fill("The organization owner requested a controlled account closure");
  await closure.getByLabel("Authenticator code").fill("123456");
  await closure.getByRole("button", { name: "Initiate closure" }).click();
  await expect(page.getByText("Organization closure is pending")).toBeVisible();

  const target = page.locator(".admin-user-list article").filter({ hasText: "admin@example.test" });
  await target.getByRole("button", { name: "Transfer ownership" }).click();
  const transfer = page.getByRole("dialog", { name: "Transfer organization ownership" });
  await transfer.getByLabel("Authenticator code").fill("654321");
  await transfer.getByRole("button", { name: "Transfer ownership" }).click();
  await expect(page.getByText("Organization ownership was transferred")).toBeVisible();

  expect(requests[0]).toEqual({
    path: "step-up",
    body: { code: "123456" },
  });
  expect(requests[1]).toEqual({
    path: "closure",
    body: { reason: "The organization owner requested a controlled account closure" },
    idempotencyKey: requests[1]?.idempotencyKey,
  });
  expect(requests[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[2]).toEqual({
    path: "step-up",
    body: { code: "654321" },
  });
  expect(requests[3]).toEqual({
    path: "transfer",
    body: { targetMembershipId: "b2222222-2222-4222-8222-222222222222" },
  });
});

test("custom role administrator reaches only the granted People and Access controls", async ({ page }) => {
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "scoped-admin", displayName: "Scoped Admin", email: "scoped@example.test" },
        tenant: { id: "acme", displayName: "Example Organization" },
        roles: ["member", "employee"],
        capabilities: ["organization.read", "workspace.use", "organization.manage_roles"],
      }),
    });
  });
  await page.goto("/?view=settings");
  await expect(page.getByRole("button", { name: "People and access" })).toBeVisible();
  await page.getByRole("button", { name: "People and access" }).click();
  await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Custom roles" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create custom role" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite person" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Organization members" })).toHaveCount(0);
});

test("workspace manager sees a content-free empty member workspace console", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(workspaceManagerSession),
  }));
  await page.route("**/api/v1/admin/member-workspaces", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ members: [] }),
  }));

  await page.goto("/?view=settings");
  await expect(page.getByRole("button", { name: "People and access" })).toHaveCount(0);
  await page.goto("/?view=home&section=organization");
  await expect(page.getByRole("button", { name: "Organization workspaces" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No member workspaces are assigned to you.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite person" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Organization members" })).toHaveCount(0);
  await expect(page.locator(".member-workspace-console").getByRole("button", { name: /open|view|files|chat/i })).toHaveCount(0);
});

test("workspace manager operates multiple runtimes with confirmation and bounded status refresh", async ({ page }) => {
  const baseWorkspaces = [
    managedWorkspace("workspace-a", "Personal workspace"),
    managedWorkspace("workspace-b", "Finance workspace"),
  ];
  let transitionReads = 0;
  let commandCount = 0;
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(workspaceManagerSession),
  }));
  await page.route("**/api/v1/admin/member-workspaces", (route) => {
    const transitioning = transitionReads > 0;
    if (transitioning) transitionReads -= 1;
    const workspaces = baseWorkspaces.map((workspace) => workspace.id === "workspace-a" && transitioning
      ? managedWorkspace(workspace.id, workspace.name, "restarting")
      : workspace);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        members: [{
          userId: "member-a",
          displayName: "Alex Morgan",
          email: "alex@example.test",
          status: "active",
          membershipStatus: "active",
          workspaceCount: workspaces.length,
          workspaces,
        }, {
          userId: "member-empty",
          displayName: "No Workspace",
          email: "empty@example.test",
          status: "active",
          membershipStatus: "active",
          workspaceCount: 0,
          workspaces: [],
        }],
      }),
    });
  });
  await page.route("**/api/v1/admin/users/*/workspaces/*/runtime/*", (route) => {
    commandCount += 1;
    transitionReads = 2;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        command: { id: "command-a", status: "succeeded", replayed: false },
        workspace: { id: "workspace-a", state: "restarting", failureCode: null, updatedAt: "2026-08-12T02:00:00.000Z" },
      }),
    });
  });

  await page.goto("/?view=home&section=organization");
  await expect(page.locator(".member-workspace-summary").getByText("2 workspaces", { exact: true })).toBeVisible();
  await expect(page.getByText("No workspace has been created yet.")).toBeVisible();
  const personal = page.getByRole("row", { name: "Personal workspace for Alex Morgan" });
  await expect(personal.getByText("Healthy")).toBeVisible();
  await expect(personal.getByText("kasm-persistent-standard")).toBeVisible();
  await expect(personal.getByText(/Policy v1/)).toBeVisible();
  await expect(personal.getByRole("button", { name: /open|view|files|chat/i })).toHaveCount(0);

  const search = page.getByPlaceholder("Search members or workspaces");
  await search.fill("Finance");
  await expect(personal).toHaveCount(0);
  await expect(page.getByRole("row", { name: "Finance workspace for Alex Morgan" })).toBeVisible();
  await search.clear();

  await personal.getByRole("button", { name: "Restart" }).click();
  const restartDialog = page.getByRole("dialog", { name: "Restart Personal workspace?" });
  await expect(restartDialog.getByText("Persistent files are retained.")).toBeVisible();
  await restartDialog.getByRole("button", { name: "Cancel" }).click();
  expect(commandCount).toBe(0);

  await personal.getByRole("button", { name: "Restart" }).click();
  await page.getByRole("dialog", { name: "Restart Personal workspace?" }).getByRole("button", { name: "Restart workspace" }).click();
  await expect(page.getByText("Personal workspace runtime restarted.")).toBeVisible();
  expect(commandCount).toBe(1);

  const finance = page.getByRole("row", { name: "Finance workspace for Alex Morgan" });
  await finance.getByRole("button", { name: "Terminate runtime" }).click();
  const terminateDialog = page.getByRole("dialog", { name: "Terminate Finance workspace runtime?" });
  await expect(terminateDialog.getByText("Persistent files are retained and the workspace record is not deleted.")).toBeVisible();
  await terminateDialog.getByRole("button", { name: "Cancel" }).click();
  expect(commandCount).toBe(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("row", { name: "Finance workspace for Alex Morgan" }).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("workspace command failures stay scoped and actionable", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(workspaceManagerSession),
  }));
  await page.route("**/api/v1/admin/member-workspaces", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      members: [{
        userId: "member-a",
        displayName: "Alex Morgan",
        email: "alex@example.test",
        status: "active",
        membershipStatus: "active",
        workspaceCount: 1,
        workspaces: [managedWorkspace("workspace-a", "Personal workspace")],
      }],
    }),
  }));
  await page.route("**/api/v1/admin/users/*/workspaces/*/runtime/*", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "WORKSPACE_COMMAND_FAILED", message: "Runtime control is temporarily unavailable.", retryable: false } }),
  }));

  await page.goto("/?view=home&section=organization");
  const personal = page.getByRole("row", { name: "Personal workspace for Alex Morgan" });
  await personal.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("dialog", { name: "Stop Personal workspace?" }).getByRole("button", { name: "Stop workspace" }).click();
  await expect(page.getByRole("alert")).toContainText("Runtime control is temporarily unavailable.");
  await expect(page.getByRole("alert")).not.toContainText("WORKSPACE_COMMAND_FAILED");
});

test("member manager cannot change protected roles and manages only an exact workspace", async ({ page }) => {
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "member-manager", displayName: "Member Manager", email: "manager@example.test" },
        tenant: { id: "acme", displayName: "Example Organization" },
        roles: ["member", "employee"],
        capabilities: ["organization.read", "workspace.use", "organization.manage_members"],
        resourceCapabilities: [
          { permission: "workspace.manage", scope: { type: "workspace", resourceId: "workspace-a" } },
        ],
      }),
    });
  });
  await page.route("**/api/v1/admin/users", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const target = body.users.find((user) => user.userId === "example-admin");
    await route.fulfill({
      response,
      json: {
        ...body,
        delegableBuiltInRoles: ["member"],
        users: [{
          ...target,
          workspaces: [
            { ...target.workspaces[0], id: "workspace-a", grantId: "workspace-a" },
            { ...target.workspaces[0], id: "workspace-b", grantId: "workspace-b" },
          ],
        }],
      },
    });
  });

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "People and access" }).click();
  const member = page.locator(".admin-user-list article").filter({ hasText: "admin@example.test" });
  await expect(member.getByRole("combobox", { name: "Organization role for Example Admin" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Manage A" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Manage B" })).toHaveCount(0);

  await page.getByRole("button", { name: "Invite person" }).click();
  await page.getByRole("combobox", { name: "Invited organization role" }).click();
  await expect(page.getByRole("option", { name: "Member" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Administrator" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Owner" })).toHaveCount(0);
});

test("scoped role delegator sees only server-derived grants and resource IDs", async ({ page }) => {
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "role-delegator", displayName: "Role Delegator", email: "roles@example.test" },
        tenant: { id: "acme", displayName: "Example Organization" },
        roles: ["member", "employee"],
        capabilities: ["organization.read", "workspace.use", "organization.manage_roles"],
        resourceCapabilities: [
          { permission: "workspace.manage", scope: { type: "workspace", resourceId: "workspace-a" } },
        ],
      }),
    });
  });
  await page.route("**/api/v1/admin/roles", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        catalog: {
          version: 2,
          permissions: [
            { key: "organization.manage_roles", description: "Manage organization roles", scopeTypes: ["organization"] },
            { key: "workspace.manage", description: "Manage organization workspaces", scopeTypes: ["workspace"], resourceIds: { workspace: ["workspace-a"] } },
          ],
        },
        delegableBuiltInRoles: ["member"],
        memberships: [],
        roles: [],
      }),
    });
  });

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "People and access" }).click();
  await page.getByRole("button", { name: "Create custom role" }).click();
  const editor = page.getByRole("dialog", { name: "Create custom role" });
  await expect(editor.getByRole("checkbox", { name: "Manage organization roles" })).toBeVisible();
  await expect(editor.getByRole("checkbox", { name: "Manage organization workspaces" })).toBeVisible();
  await expect(editor.getByRole("checkbox", { name: "Read organization audit records" })).toHaveCount(0);
  await editor.getByRole("checkbox", { name: "Manage organization workspaces" }).check();
  await expect(editor.getByRole("combobox", { name: "Scope for Manage organization workspaces" })).toHaveText("Selected workspace");
  await editor.getByRole("combobox", { name: "Manage organization workspaces resource ID" }).click();
  await expect(page.getByRole("option", { name: "workspace-a" })).toBeVisible();
  await expect(page.getByRole("option", { name: "workspace-b" })).toHaveCount(0);
});

test("scoped provider administrator sees only server-granted provider and connector controls", async ({ page }) => {
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "provider-admin", displayName: "Provider Admin", email: "provider@example.test" },
        tenant: { id: "acme", displayName: "Example Organization" },
        roles: ["member", "employee"],
        capabilities: ["organization.read", "workspace.use"],
        resourceCapabilities: [
          { permission: "provider.manage", scope: { type: "provider", resourceId: "openai" } },
          { permission: "provider.manage", scope: { type: "provider", resourceId: "linear" } },
        ],
      }),
    });
  });
  await page.route("**/api/v1/admin/provider-settings", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { providers: body.providers.filter((provider) => provider.provider === "openai") } });
  });
  await page.route("**/api/v1/connections", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { connections: body.connections.map((connector) => ({
      ...connector,
      canAdministerConnector: connector.id === "linear",
      canManageConnection: true,
    })) } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Provider Admin/ }).click();
  await expect(page.getByRole("button", { name: "AI control plane" })).toBeVisible();
  await page.getByRole("button", { name: "AI control plane" }).click();
  await expect(page.getByRole("button", { name: "Models & providers" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Provider settings" })).toBeVisible();
  await expect(page.getByText("OpenAI", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Connections" }).click();
  const linear = page.locator(".connector-catalog-card").filter({ hasText: "Linear" });
  await linear.getByRole("button", { name: "Manage" }).click();
  await expect(page.getByRole("heading", { name: "Member connection policy" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tools & approvals" })).toBeVisible();
});
