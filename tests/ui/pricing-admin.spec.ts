import { expect, test } from "@playwright/test";

test("administrator prices an enabled model without leaving Models and routing", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=models-providers");

  const anthropic = page.locator(".models-routing-provider").filter({ hasText: "Anthropic" });
  const sonnet = anthropic.locator(".models-routing-row").filter({ hasText: "Anthropic Claude Sonnet 4.6" });
  await sonnet.click();
  const inspector = page.getByRole("complementary", { name: "Model details" });
  await expect(inspector).toContainText("Pricing missing");
  await inspector.getByRole("button", { name: "Add pricing" }).click();

  const editor = page.getByRole("dialog", { name: /New .* price version/ });
  await editor.getByLabel("Input price per 1M tokens").fill("3");
  await editor.getByLabel("Output price per 1M tokens").fill("15");
  await editor.getByLabel("Cache read price per 1M tokens").fill("0.3");
  await editor.getByLabel("Cache write price per 1M tokens").fill("3.75");
  await editor.getByLabel("Price approval reason").fill("Finance-approved enterprise contract rate.");
  await editor.getByRole("button", { name: "Create price record" }).click();

  await expect(page.getByRole("status")).toContainText("Price version");
  await expect(sonnet).toContainText("$3.00 / $15.00");
  await expect(inspector).toContainText("$3.00 input · $15.00 output");
});

test("pricing history remains contextual to the selected model", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=models-providers");
  const inspector = page.getByRole("complementary", { name: "Model details" });
  await inspector.getByRole("button", { name: "View pricing history" }).click();
  await expect(page.getByRole("dialog", { name: "Pricing history" })).toBeVisible();
});

test("legacy pricing URLs resolve to the unified maintenance surface", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=pricing");
  await expect(page.getByRole("heading", { name: "Models & routing", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "AI control plane" }).getByRole("button", { name: "Models & routing" })).toHaveAttribute("aria-current", "page");
});
