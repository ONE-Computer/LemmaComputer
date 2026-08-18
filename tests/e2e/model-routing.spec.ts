import { expect, test } from "@playwright/test";

test("models, pricing, and organization routes form one continuous maintenance surface", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1487, height: 1058 });
  await page.goto("/?view=ai-control-plane&section=models-providers");

  await expect(page.getByRole("heading", { name: "Models & routing", exact: true })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "AI control plane" });
  await expect(navigation.getByRole("button", { name: "Models & routing" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "Model routes" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Pricing" })).toHaveCount(0);

  await expect(page.getByRole("region", { name: "Organization route readiness" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Provider accounts and enabled models" })).toContainText("Anthropic Claude Sonnet 4.6");
  await expect(page.getByRole("region", { name: "Provider accounts and enabled models" })).toContainText("GLM-5");
  await expect(page.getByRole("complementary", { name: "Model details" })).toContainText("Pricing");
  await expect(page.getByRole("complementary", { name: "Model details" })).toContainText("Organization route");
  await expect(page.getByRole("button", { name: "Review & publish" })).toBeDisabled();
  await page.screenshot({ path: "test-results/models-routing-unified.png" });
  expect(consoleErrors).toEqual([]);
});

test("administrator can maintain a local organization-route draft from a model", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=models-providers");

  const anthropic = page.locator(".models-routing-provider").filter({ hasText: "Anthropic" });
  await anthropic.locator(".models-routing-row").filter({ hasText: "Anthropic Claude Sonnet 4.6" }).click();
  await page.getByRole("complementary", { name: "Model details" }).getByRole("button", { name: /Assign route|Change route/ }).click();

  const editor = page.getByRole("dialog", { name: "Create a mapping draft" });
  await expect(editor.getByLabel("Lite provider deployment")).toBeVisible();
  await expect(editor.getByLabel("Balanced provider deployment")).toBeVisible();
  await expect(editor.getByLabel("Pro provider deployment")).toBeVisible();
  await editor.getByLabel("Mapping revision note").fill("Review organization defaults after the model inventory update.");
  await editor.getByRole("button", { name: "Save local draft" }).click();

  await expect(page.getByRole("status")).toContainText("Draft saved");
  await expect(page.getByRole("button", { name: "Review & publish" })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("lemmacomputer.routing-mapping-draft:")))).toEqual([
    "lemmacomputer.routing-mapping-draft:v1:acme:alex-morgan",
  ]);
});

test("legacy model-route URLs resolve to the unified maintenance surface", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=model-routes");
  await expect(page.getByRole("heading", { name: "Models & routing", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "AI control plane" }).getByRole("button", { name: "Models & routing" })).toHaveAttribute("aria-current", "page");
});
