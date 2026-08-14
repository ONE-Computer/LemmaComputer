import { expect, test } from "@playwright/test";

test("customer-managed authentication registers and reuses a passkey without a hosted identity service", async ({ context, page }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto("/");
  await page.getByLabel("Work email").fill("passkey@example.test");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();

  await page.getByRole("button", { name: "Manage account security" }).click();
  const securityDialog = page.getByRole("dialog", { name: "Account security" });
  await securityDialog.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Passkey added" })).toBeVisible();
  const credentials = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials.credentials).toHaveLength(1);

  await securityDialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
  await expect(page.getByText("passkey@example.test")).toBeVisible();

  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});
