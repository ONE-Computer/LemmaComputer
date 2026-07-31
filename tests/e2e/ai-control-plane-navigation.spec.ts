import { expect, test } from "@playwright/test";

test("administrator enters the AI control plane from the account menu and navigates its tabs", async ({ page }) => {
  await page.goto("/");
  await page.locator(".sidebar-profile").click();
  const accountMenu = page.getByRole("group", { name: "Account menu" });
  await expect(accountMenu.getByText("Organization", { exact: true })).toBeVisible();
  await expect(accountMenu.getByRole("button", { name: "AI control plane" })).toBeVisible();
  await accountMenu.getByRole("button", { name: "AI control plane" }).click();
  await expect(page).toHaveURL(/\?view=ai-control-plane$/);
  await expect(page.getByRole("heading", { name: "AI control plane", exact: true })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "AI control plane" });
  await expect(tabs.getByRole("button")).toHaveCount(6);
  await expect(tabs.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("button", { name: "Pricing" }).click();
  await expect(page).toHaveURL(/\?view=ai-control-plane&section=pricing$/);
  await expect(page.getByRole("heading", { name: "Pricing", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Token prices / 1M" })).toBeVisible();
  await tabs.getByRole("button", { name: "Model routes" }).click();
  await expect(page).toHaveURL(/\?view=ai-control-plane&section=model-routes$/);
  await expect(page.getByRole("heading", { name: "Model routes" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\?view=ai-control-plane&section=pricing$/);
  await expect(tabs.getByRole("button", { name: "Pricing" })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(/\?view=ai-control-plane$/);
  await expect(tabs.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
});

test("employee cannot discover or deep-link the administrator control plane", async ({ page }) => {
  await page.route("**/v1/auth/session", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, roles: ["employee"] },
    });
  });
  await page.goto("/?view=ai-control-plane");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await page.locator(".sidebar-profile").click();
  const accountMenu = page.getByRole("group", { name: "Account menu" });
  await expect(accountMenu.getByRole("button", { name: "AI control plane" })).toHaveCount(0);
  await expect(accountMenu.getByRole("button", { name: "Settings" })).toBeVisible();
});
