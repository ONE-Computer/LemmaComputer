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
    "lemmacomputer.routing-mapping-draft:v2:acme:alex-morgan",
  ]);
});

test("an incremental route draft counts only explicit assignments and keeps provider identity internal", async ({ page }) => {
  const providerAccountId = "openai-primary";
  let submittedProviderAccountId = "";
  const deployments = [
    { id: "openai-sol", providerAccountId, providerModelId: "gpt-5.6-sol", providerDeployment: "openai/gpt-5.6-sol", displayName: "OpenAI GPT-5.6 Sol" },
    { id: "openai-terra", providerAccountId, providerModelId: "gpt-5.6-terra", providerDeployment: "openai/gpt-5.6-terra", displayName: "OpenAI GPT-5.6 Terra" },
    { id: "openai-luna", providerAccountId, providerModelId: "gpt-5.6-luna", providerDeployment: "openai/gpt-5.6-luna", displayName: "OpenAI GPT-5.6 Luna" },
  ];
  await page.route("**/api/v1/admin/provider-settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ providers: [{
        provider: "openai",
        state: "active",
        selectedModelIds: deployments.map((deployment) => deployment.providerModelId),
        deployments,
        modelOptions: deployments.map((deployment) => ({ id: deployment.providerModelId, displayName: deployment.displayName })),
        lastTestedAt: "2026-08-18T09:08:27.000Z",
      }] }),
    });
  });
  await page.route("**/api/v1/admin/ai-usage/rate-cards", async (route) => {
    if (route.request().method() === "POST") {
      submittedProviderAccountId = route.request().postDataJSON().providerAccountId;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "openai-sol-price-v2" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rateCards: [{
        id: "openai-sol-price",
        provider: "openai",
        providerAccountId,
        baseModel: "gpt-5.6-sol",
        deploymentId: "openai/gpt-5.6-sol",
        region: null,
        providerServiceTier: null,
        currency: "USD",
        sourceVersion: "manual-2026-08-19",
        effectiveFrom: "2026-08-19T00:00:00.000Z",
        rates: [
          { unit: "input_uncached_token", amountPerUnit: "5", unitScale: "1000000" },
          { unit: "output_token", amountPerUnit: "30", unitScale: "1000000" },
          { unit: "cache_read_token", amountPerUnit: "0.5", unitScale: "1000000" },
          { unit: "cache_write_token", amountPerUnit: "6.25", unitScale: "1000000" },
        ],
      }] }),
    });
  });
  await page.route("**/api/v1/admin/routing/mappings/latest", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mapping: null }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem("lemmacomputer.routing-mapping-draft:v1:acme:alex-morgan", JSON.stringify({
      schemaVersion: 1,
      draft: { revisionNote: "Legacy silently populated routes", deployments: [{ serviceClass: "lite" }, { serviceClass: "balanced" }, { serviceClass: "pro" }] },
    }));
  });

  await page.goto("/?view=ai-control-plane&section=models-providers");

  const readiness = page.getByRole("region", { name: "Organization route readiness" });
  await expect(readiness).toContainText("0 of 3 routes ready");
  await expect(readiness.getByRole("button", { name: /Resolve/ })).toHaveCount(0);

  const inspector = page.getByRole("complementary", { name: "Model details" });
  await inspector.getByRole("button", { name: "Add price version" }).click();
  const priceEditor = page.getByRole("dialog", { name: "New OpenAI GPT-5.6 Sol price version" });
  await expect(priceEditor.getByLabel("Provider account ID")).toHaveCount(0);
  await expect(priceEditor.getByLabel("Pricing currency")).toHaveValue("USD");
  await priceEditor.getByLabel("Price approval reason").fill("Approved contract price update.");
  await priceEditor.getByRole("button", { name: "Create price record" }).click();
  await expect.poll(() => submittedProviderAccountId).toBe(providerAccountId);

  await inspector.getByRole("button", { name: "Assign route" }).click();
  const routeEditor = page.getByRole("dialog", { name: "Create a mapping draft" });
  await expect(routeEditor.getByLabel("Lite provider deployment")).toContainText("Not assigned");
  await expect(routeEditor.getByLabel("Balanced provider deployment")).toContainText("Not assigned");
  await expect(routeEditor.getByLabel("Pro provider deployment")).toContainText("Not assigned");
  await routeEditor.getByLabel("Pro provider deployment").click();
  await page.getByRole("option", { name: "OpenAI GPT-5.6 Sol · OpenAI" }).click();
  await routeEditor.getByLabel("Mapping revision note").fill("Use Sol for the Pro route.");
  await routeEditor.getByRole("button", { name: "Save local draft" }).click();

  await expect(readiness).toContainText("1 of 3 routes ready");
  await expect(readiness).toContainText("2 organization routes still need an assigned model with complete pricing");
  const inventory = page.getByRole("region", { name: "Provider accounts and enabled models" });
  await expect(inventory.locator(".models-routing-row").filter({ hasText: "OpenAI GPT-5.6 Sol" })).toContainText("Pro");
  await expect(inventory.locator(".models-routing-row").filter({ hasText: "OpenAI GPT-5.6 Terra" })).toContainText("Not assigned");
  await expect(inventory.locator(".models-routing-row").filter({ hasText: "OpenAI GPT-5.6 Luna" })).toContainText("Not assigned");
  await page.reload();
  await expect(readiness).toContainText("1 of 3 routes ready");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("lemmacomputer.routing-mapping-draft:")))).toEqual([
    "lemmacomputer.routing-mapping-draft:v2:acme:alex-morgan",
  ]);
  await page.getByRole("button", { name: "Review & publish" }).click();
  const publishDialog = page.getByRole("dialog", { name: "Publish organization routes?" });
  await expect(publishDialog.getByRole("button", { name: "Publish route version" })).toBeDisabled();
});

test("legacy model-route URLs resolve to the unified maintenance surface", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=model-routes");
  await expect(page.getByRole("heading", { name: "Models & routing", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "AI control plane" }).getByRole("button", { name: "Models & routing" })).toHaveAttribute("aria-current", "page");
});
