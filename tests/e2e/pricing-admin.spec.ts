import { expect, test } from "@playwright/test";

test("administrator prices configured provider deployments independently of routing", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=pricing");

  await expect(page.getByRole("heading", { name: "Pricing", exact: true })).toBeVisible();
  await expect(page.getByText("Configured deployments").locator("..").getByText("3", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Provider deployment" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Cache write" })).toBeVisible();

  const anthropicRow = page.getByRole("row").filter({ hasText: "Anthropic Claude Sonnet 4.6" });
  await expect(anthropicRow.getByText("Not priced")).toBeVisible();
  await anthropicRow.getByRole("button", { name: "Set pricing" }).click();

  const editor = page.getByRole("dialog", { name: "Create price version" });
  await expect(editor.getByLabel("Price provider deployment")).toContainText("Anthropic Claude Sonnet 4.6");
  await editor.getByLabel("Input price per 1M tokens").fill("3");
  const deploymentField = await editor.locator(".modal-field").filter({ hasText: "Provider deployment" }).boundingBox();
  const deploymentSummary = await editor.getByRole("note").boundingBox();
  expect(deploymentField).not.toBeNull();
  expect(deploymentSummary).not.toBeNull();
  expect(deploymentSummary!.y - (deploymentField!.y + deploymentField!.height)).toBeGreaterThanOrEqual(8);

  await editor.getByLabel("Output price per 1M tokens").fill("15");
  await editor.getByLabel("Cache read price per 1M tokens").fill("0.3");
  await editor.getByLabel("Cache write price per 1M tokens").fill("3.75");
  await editor.getByLabel("Price approval reason").fill("Finance-approved enterprise contract rate.");
  await editor.getByRole("button", { name: "Create immutable price" }).click();

  await expect(page.getByRole("status")).toContainText("created for Anthropic Claude Sonnet 4.6");
  await expect(anthropicRow.getByText("Complete")).toBeVisible();
  await expect(anthropicRow.getByText("$15.00")).toBeVisible();
});

test("Pricing points an empty provider inventory to Models and providers", async ({ page }) => {
  await page.route("**/api/v1/admin/provider-settings", async (route) => {
    await route.fulfill({ json: { providers: [] } });
  });

  await page.goto("/?view=ai-control-plane&section=pricing");

  await expect(page.getByText("No configured provider deployments")).toBeVisible();
  const action = page.getByRole("link", { name: "Open Models & providers" });
  await expect(action).toHaveAttribute("href", "?view=ai-control-plane&section=models-providers");
});
