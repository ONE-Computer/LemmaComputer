import { expect, test } from "@playwright/test";

test("local platform sign-in is a separate passkey-only operator surface", async ({ page }) => {
  await page.route("**/api/v1/auth/platform/capabilities", (route) => route.fulfill({
    json: { passkey: true, bootstrap: { mode: "worktree" } },
  }));

  await page.goto("/platform/sign-in?return=https%3A%2F%2Fevil.example.test%2Fcapture");

  await expect(page.getByRole("heading", { name: "Platform administrator sign-in" })).toBeVisible();
  await expect(page.getByText("This separate operator realm controls workspace-node placement and hosted infrastructure settings.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a security key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up platform access" })).toBeVisible();
  await expect(page.getByText("Development only: the temporary bootstrap credential is removed after the first passkey is registered.")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
});
