import { expect, test } from "@playwright/test";

test("model limits validate, save without a key, and persist after reload", async ({ page }) => {
  let limits = { contextTokens: 128000, outputTokens: 32768 };
  let received: unknown;
  const provider = () => ({ provider: "openai", state: "active", deployments: [{ id: "test-model", providerAccountId: "test-account", providerModel: "openai/gpt-5.6-terra", providerDeployment: "test-deployment", displayName: "OpenAI GPT-5.6 Terra", modelLimits: limits }] });
  await page.route("**/api/v1/admin/provider-settings", (route) => route.fulfill({ json: { providers: [provider()] } }));
  await page.route("**/api/v1/admin/routing/mappings/latest", (route) => route.fulfill({ json: { mapping: null } }));
  await page.route("**/api/v1/admin/provider-settings/openai/model-limits", (route) => {
    received = route.request().postDataJSON();
    limits = (received as { limits: typeof limits }).limits;
    return route.fulfill({ json: { provider: provider(), mapping: null } });
  });
  await page.goto("/?view=ai-control-plane&section=models-providers");
  const inspector = page.getByRole("complementary", { name: "Model details" });
  await inspector.getByRole("button", { name: "Edit model limits" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit model limits" });
  await expect(dialog.getByLabel("Context window (tokens)")).toHaveValue("128000");
  await dialog.getByLabel("Context window (tokens)").fill("2000");
  await expect(dialog.getByRole("button", { name: "Save model limits" })).toBeDisabled();
  await dialog.getByLabel("Context window (tokens)").fill("1000000");
  await page.screenshot({ path: "test-results/model-limits-editor.png" });
  await dialog.getByRole("button", { name: "Save model limits" }).click();
  await expect(dialog).toBeHidden();
  expect(received).toEqual({ deploymentId: "test-model", limits: { contextTokens: 1000000, outputTokens: 32768 } });
  await expect(inspector).toContainText("1,000,000 context");
  await page.reload();
  await expect(inspector).toContainText("1,000,000 context");
});

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
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
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
  await editor.getByRole("button", { name: "Continue" }).click();

  const saveDialog = page.getByRole("dialog", { name: "Save organization routes?" });
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Route changes are ready" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" }).first()).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("lemmacomputer.routing-mapping-draft:")))).toEqual([
    "lemmacomputer.routing-mapping-draft:v2:acme:alex-morgan",
  ]);
});

test("an incremental route draft counts only explicit assignments and keeps provider identity internal", async ({ page }) => {
  const providerAccountId = "openai-primary";
  let submittedProviderAccountId = "";
  let publishedServiceClasses: string[] = [];
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
  await page.route("**/api/v1/admin/routing/mappings", async (route) => {
    const input = route.request().postDataJSON();
    publishedServiceClasses = input.deployments.map((deployment: { serviceClass: string }) => deployment.serviceClass);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ mapping: {
        id: "11111111-1111-4111-8111-111111111111",
        tenantId: "acme",
        createdBy: "alex-morgan",
        createdAt: "2026-08-19T01:00:00.000Z",
        ...input,
      } }),
    });
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
  await routeEditor.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("dialog", { name: "Save organization routes?" }).getByRole("button", { name: "Cancel" }).click();

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
  await page.getByRole("button", { name: "Save changes" }).first().click();
  const publishDialog = page.getByRole("dialog", { name: "Save organization routes?" });
  await expect(publishDialog.getByRole("button", { name: "Save 1 route" })).toBeEnabled();
  await publishDialog.getByRole("button", { name: "Save 1 route" }).click();
  await expect.poll(() => publishedServiceClasses).toEqual(["pro"]);

  await inspector.getByRole("button", { name: "Remove from Pro" }).click();
  await expect(readiness).toContainText("0 of 3 routes ready");
  const removalDialog = page.getByRole("dialog", { name: "Save organization routes?" });
  await expect(removalDialog).toContainText("makes every organization route unavailable");
  await removalDialog.getByRole("button", { name: "Save route removal" }).click();
  await expect.poll(() => publishedServiceClasses).toEqual([]);
});

test("administrator can disconnect a provider account from the unified screen", async ({ page }) => {
  let connected = true;
  let deleteCalled = false;
  const provider = () => ({
    provider: "openai",
    state: connected ? "active" : "not-configured",
    selectedModelIds: connected ? ["gpt-5.6-luna"] : [],
    deployments: connected ? [{
      id: "openai-luna",
      providerAccountId: "openai-primary",
      providerModelId: "gpt-5.6-luna",
      providerDeployment: "openai/gpt-5.6-luna",
      displayName: "OpenAI GPT-5.6 Luna",
    }] : [],
    modelOptions: [{ id: "gpt-5.6-luna", displayName: "OpenAI GPT-5.6 Luna" }],
    emissionsRegion: "sg",
    lastTestedAt: "2026-08-19T01:00:00.000Z",
  });
  await page.route("**/api/v1/admin/provider-settings", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: [provider()] }) });
  });
  await page.route("**/api/v1/admin/provider-settings/openai", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleteCalled = true;
    connected = false;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        deleted: true,
        mapping: { id: "77777777-7777-4777-8777-777777777777", deployments: [] },
        workspaceGrants: { revoked: 1, failed: 0 },
        restartRequired: true,
      }),
    });
  });
  await page.route("**/api/v1/admin/ai-usage/rate-cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rateCards: [] }) });
  });
  await page.route("**/api/v1/admin/routing/mappings/latest", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mapping: null }) });
  });

  await page.goto("/?view=ai-control-plane&section=models-providers");
  await page.getByRole("button", { name: "Manage account" }).click();
  const providerDialog = page.getByRole("dialog", { name: "Manage OpenAI" });
  await providerDialog.getByRole("button", { name: "Disconnect provider" }).click();
  const confirmDialog = page.getByRole("dialog", { name: "Disconnect OpenAI?" });
  await expect(confirmDialog).toContainText("stored API key and every organization route");
  await confirmDialog.getByRole("button", { name: "Disconnect provider" }).click();

  await expect.poll(() => deleteCalled).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "OpenAI was disconnected" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Provider accounts and enabled models" })).toContainText("Not connected");
});

test("legacy model-route URLs resolve to the unified maintenance surface", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=model-routes");
  await expect(page.getByRole("heading", { name: "Models & routing", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "AI control plane" }).getByRole("button", { name: "Models & routing" })).toHaveAttribute("aria-current", "page");
});

for (const providerName of ["foundry", "vertex"] as const) {
  test(`administrator connects ${providerName} with its cloud configuration and write-only credential`, async ({ page }) => {
    const displayName = providerName === "foundry" ? "Azure AI Foundry" : "Google Vertex AI";
    const modelId = providerName === "foundry" ? "gpt-4.1" : "gemini-2.5-flash";
    const provider = { provider: providerName, state: "not-configured", selectedModelIds: [], deployments: [], modelOptions: [{ id: modelId, displayName: modelId }], emissionsRegion: "sg" };
    let submitted: Record<string, any> | undefined;
    await page.route("**/api/v1/admin/provider-settings", (route) => route.fulfill({ json: { providers: [provider] } }));
    await page.route(`**/api/v1/admin/provider-settings/${providerName}`, async (route) => {
      submitted = route.request().postDataJSON();
      await route.fulfill({ json: { provider: { ...provider, state: "active", selectedModelIds: [modelId] } } });
    });
    await page.goto("/?view=ai-control-plane&section=models-providers");
    await page.getByRole("button", { name: "Connect account" }).click();
    const dialog = page.getByRole("dialog", { name: `Connect ${displayName}` });
    await expect(dialog.getByRole("button", { name: "Connect account" })).toBeDisabled();
    const secret = providerName === "foundry" ? "azure-browser-fixture-key" : '{"type":"service_account","private_key":"browser-fixture-only"}';
    await dialog.getByRole("checkbox").check();
    if (providerName === "foundry") {
      await dialog.getByLabel("Foundry OpenAI v1 endpoint").fill("https://example-resource.openai.azure.com/openai/v1/");
      await dialog.getByLabel("gpt-4.1 deployment name").fill("company-gpt");
      await dialog.getByLabel("Azure AI Foundry API key").fill(secret);
    } else {
      await dialog.getByLabel("Google Cloud project ID").fill("example-project");
      await dialog.getByLabel("Google service account JSON").fill(secret);
      await expect(dialog).toContainText("Global does not pin inference to one region");
    }
    await expect(dialog.locator('input[type="password"]')).toHaveValue(secret);
    await page.screenshot({ path: `/tmp/${providerName}-provider-editor.png`, fullPage: true });
    await dialog.getByRole("button", { name: "Connect account" }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => submitted?.modelIds).toEqual([modelId]);
    if (providerName === "foundry") {
      expect(submitted?.foundry).toEqual({ endpoint: "https://example-resource.openai.azure.com/openai/v1/", deployments: { "gpt-4.1": "company-gpt" }, protocols: { "gpt-4.1": "openai" } });
      expect(submitted?.apiKey).toBe(secret);
    } else {
      expect(submitted?.vertex).toEqual({ projectId: "example-project", location: "global" });
      expect(submitted?.serviceAccountJson).toBe(secret);
      expect(submitted?.apiKey).toBeUndefined();
    }
    await expect(page.locator("body")).not.toContainText(secret);
    await page.getByRole("button", { name: "Manage account" }).click();
    await expect(page.getByRole("dialog").locator('input[type="password"]')).toHaveValue("");
  });
}

test("dynamic catalog searches new models, preserves selections on refresh failure, and reuses saved credentials", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const provider = { provider: "vertex", state: "active", selectedModelIds: ["gemini-future"], deployments: [],
    modelOptions: [{ id: "gemini-future", displayName: "Existing Gemini" }], emissionsRegion: "sg", vertex: { projectId: "example-project", location: "global" } };
  let failRefresh = false;
  let submitted: any;
  await page.route("**/api/v1/admin/provider-settings", (route) => route.fulfill({ json: { providers: [provider] } }));
  await page.route("**/api/v1/admin/provider-settings/vertex/catalog", (route) => failRefresh
    ? route.fulfill({ status: 503, json: { error: { message: "Unavailable" } } })
    : route.fulfill({ json: { models: [{ id: "claude-sonnet-5", displayName: "Claude Sonnet 5", publisher: "Anthropic", source: "litellm", capabilities: { tools: true } }], fetchedAt: new Date().toISOString(), source: "mixed" } }));
  await page.route("**/api/v1/admin/provider-settings/vertex", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { provider: { ...provider, selectedModelIds: submitted.modelIds } } });
  });
  await page.goto("/?view=ai-control-plane&section=models-providers");
  await page.getByRole("button", { name: "Manage account" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Google Vertex AI" });
  await expect(dialog.getByRole("checkbox", { name: /Claude Sonnet 5/ })).toHaveAccessibleName(/LiteLLM metadata/);
  const searchBox = await dialog.getByLabel("Search models").boundingBox();
  const filterBox = await dialog.getByRole("combobox", { name: "Filter models by capability" }).boundingBox();
  const refresh = dialog.getByRole("button", { name: "Refresh models" });
  const refreshBox = await refresh.boundingBox();
  expect(Math.abs(searchBox!.y - filterBox!.y)).toBeLessThan(2);
  expect(Math.abs(searchBox!.y - refreshBox!.y)).toBeLessThan(2);
  expect(refreshBox!.width).toBe(44);
  await expect(refresh).toHaveText("");
  await dialog.getByRole("combobox", { name: "Filter models by capability" }).click();
  await page.getByRole("option", { name: "Function tools", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: /Existing Gemini/ })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "Filter models by capability" }).click();
  await page.getByRole("option", { name: "All models", exact: true }).click();
  await page.screenshot({ path: "/tmp/model-catalog-toolbar-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDialog = await dialog.boundingBox();
  const mobileRefresh = await refresh.boundingBox();
  expect(mobileRefresh!.height).toBe(44);
  expect(mobileRefresh!.x + mobileRefresh!.width).toBeLessThanOrEqual(mobileDialog!.x + mobileDialog!.width);
  await page.screenshot({ path: "/tmp/model-catalog-toolbar-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByLabel("Search models").fill("Anthropic");
  await dialog.getByRole("checkbox", { name: /Claude Sonnet 5/ }).check();
  await dialog.getByLabel("Model ID", { exact: true }).fill("deepseek-ai/deepseek-future-maas");
  await dialog.getByRole("button", { name: "Add by model ID" }).click();
  await expect(dialog.getByRole("checkbox", { name: /Existing Gemini/ })).toBeChecked();
  failRefresh = true;
  await dialog.getByRole("button", { name: "Refresh models" }).click();
  await expect(dialog.getByRole("status")).toContainText("Your selection is preserved");
  await expect(dialog.getByRole("checkbox", { name: /Claude Sonnet 5/ })).toBeChecked();
  await page.screenshot({ path: "/tmp/dynamic-model-catalog-editor.png", fullPage: true });
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect.poll(() => submitted?.modelIds).toEqual(["gemini-future", "claude-sonnet-5", "deepseek-ai/deepseek-future-maas"]);
  expect(submitted.apiKey).toBeUndefined();
  expect(submitted.serviceAccountJson).toBeUndefined();
});
