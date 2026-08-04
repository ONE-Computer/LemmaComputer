import { expect, test } from "@playwright/test";

test("administrator can inspect alias mappings, pricing coverage, and supported rollout controls", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=model-routes");

  await expect(page.getByRole("heading", { name: "Model routes" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Routing Team" })).toContainText("Finance");
  await expect(page.getByText("Publishing is non-activating.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create draft" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Publish mapping version" })).toBeDisabled();

  const aliasTable = page.getByRole("table");
  await expect(aliasTable.getByText("Auto", { exact: true })).toBeVisible();
  await expect(aliasTable.getByText("Lite", { exact: true })).toBeVisible();
  await expect(aliasTable.getByText("Balanced", { exact: true })).toBeVisible();
  await expect(aliasTable.getByText("Pro", { exact: true })).toBeVisible();
  await expect(aliasTable.getByText("Azure AI Foundry · private/luna")).toBeVisible();
  await expect(aliasTable.getByText("Amazon Bedrock · private/terra")).toBeVisible();
  await expect(aliasTable.getByText("$0.350")).toBeVisible();
  await expect(aliasTable.getByText("$15.00")).toHaveCount(2);
  await expect(aliasTable.getByText("2 gaps")).toBeVisible();
  await expect(aliasTable.getByText("Not reported")).toHaveCount(3);

  await page.getByRole("button", { name: "Create draft" }).click();
  const mappingEditor = page.getByRole("dialog", { name: "Create a mapping draft" });
  await mappingEditor.getByLabel("Mapping revision note").fill("init");
  await expect(mappingEditor.getByText("4 more characters needed.")).toBeVisible();
  await expect(mappingEditor.getByText("Add 4 more characters to the revision note to save this draft.")).toBeVisible();
  await expect(mappingEditor.getByRole("button", { name: "Save local draft" })).toBeDisabled();
  await mappingEditor.getByLabel("Mapping revision note").fill("Move Lite to the reviewed Luna v2 deployment.");
  await expect(mappingEditor.getByRole("button", { name: "Save local draft" })).toBeEnabled();

  const revisionField = await mappingEditor.locator(".route-revision-field").boundingBox();
  const mappingList = await mappingEditor.locator(".route-mapping-editor-list").boundingBox();
  const mappingRows = mappingEditor.locator(".route-mapping-editor-row");
  const firstRow = await mappingRows.nth(0).boundingBox();
  const secondRow = await mappingRows.nth(1).boundingBox();
  const routeWarning = await mappingEditor.locator(".route-editor-warning").boundingBox();
  const modalActions = await mappingEditor.locator(".modal-actions").boundingBox();
  const firstProviderField = await mappingRows.nth(0).locator(".modal-field").nth(0).boundingBox();
  const firstPriceField = await mappingRows.nth(0).locator(".modal-field").nth(1).boundingBox();
  expect(revisionField).not.toBeNull();
  expect(mappingList).not.toBeNull();
  expect(firstRow).not.toBeNull();
  expect(secondRow).not.toBeNull();
  expect(routeWarning).not.toBeNull();
  expect(modalActions).not.toBeNull();
  expect(firstProviderField).not.toBeNull();
  expect(firstPriceField).not.toBeNull();
  expect(mappingList!.y - (revisionField!.y + revisionField!.height)).toBeGreaterThanOrEqual(18);
  expect(secondRow!.y - (firstRow!.y + firstRow!.height)).toBeGreaterThanOrEqual(14);
  expect(routeWarning!.y - (mappingList!.y + mappingList!.height)).toBeGreaterThanOrEqual(18);
  expect(modalActions!.y - (routeWarning!.y + routeWarning!.height)).toBeGreaterThanOrEqual(22);
  expect(Math.abs(firstProviderField!.y - firstPriceField!.y)).toBeLessThanOrEqual(1);

  await mappingEditor.getByLabel("Lite provider deployment").click();
  await page.getByRole("option", { name: "Anthropic Claude Sonnet 4.6 · Anthropic" }).click();
  await mappingEditor.getByRole("button", { name: "Save local draft" }).click();
  await expect(aliasTable.getByText("Anthropic · claude-sonnet-4-6")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("saved in this browser");
  await expect(aliasTable.getByText("No card")).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("lemmacomputer.routing-mapping-draft:")))).toEqual([
    "lemmacomputer.routing-mapping-draft:v1:acme:alex-morgan",
  ]);

  await page.reload();
  await expect(page.locator(".route-version").getByText("Local draft", { exact: true })).toBeVisible();
  await expect(page.getByRole("table").getByText("Anthropic · claude-sonnet-4-6")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish mapping version" })).toBeEnabled();
  await page.getByRole("button", { name: "Publish mapping version" }).click();
  await page.getByRole("dialog", { name: "Publish mapping version?" }).getByRole("button", { name: "Publish mapping version" }).click();
  await expect(page.getByRole("status")).toContainText("Published for policy/shadow evaluation; current Team rollouts are unchanged.");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("lemmacomputer.routing-mapping-draft:")))).toEqual([]);

  await page.getByLabel("Pro").uncheck();
  await page.getByRole("button", { name: "Save Team policy" }).click();
  await expect(page.getByLabel("Pro")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Enable production routing" })).toBeDisabled();

  await page.getByRole("button", { name: "Review evidence" }).click();
  const review = page.getByRole("dialog", { name: "Record administrator review" });
  await review.getByLabel("Routing review note").fill("Finance sample passed the configured quality and cost thresholds.");
  await review.getByLabel("Evidence passed the configured evaluation threshold.").check();
  await review.getByRole("button", { name: "Record review" }).click();

  await page.getByRole("button", { name: "Enable production routing" }).click();
  const enable = page.getByRole("dialog", { name: "Enable production routing?" });
  await expect(enable.getByRole("button", { name: "Enable Auto routing" })).toBeDisabled();
  await enable.getByLabel("I reviewed the shadow evidence and understand this changes the executed deployment.").check();
  await enable.getByRole("button", { name: "Enable Auto routing" }).click();
  await expect(page.getByText("enabled", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Lite complexity classifier/ }).click();
  const detail = page.getByRole("dialog", { name: "Routing decision" });
  await expect(detail.getByText("bedrock", { exact: true })).toBeVisible();
  await expect(detail.getByText("private/terra", { exact: true })).toBeVisible();
  await expect(detail.getByText("22222222-2222-4222-8222-222222222222", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Close details" }).click();

  await page.getByRole("button", { name: "Activate kill switch" }).click();
  await expect(page.getByText("disabled", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/model-routing-admin-reviewed.png", fullPage: true });
});

test("administrator can configure the first alias mapping from provider inventory", async ({ page }) => {
  await page.route("**/api/v1/admin/routing/mappings/latest", async (route) => {
    await route.fulfill({ json: { mapping: null } });
  });
  await page.route(/\/api\/v1\/admin\/teams\/[^/]+\/routing$/, async (route) => {
    await route.fulfill({
      json: {
        teamId: "11111111-1111-4111-8111-111111111111",
        policy: null,
        rollout: { mode: "disabled" },
        review: null,
        deployments: [],
      },
    });
  });

  await page.goto("/?view=ai-control-plane&section=model-routes");

  await expect(page.getByText("No model routes yet")).toBeVisible();
  await expect(page.getByText("Auto", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Configure first mapping" }).click();
  const editor = page.getByRole("dialog", { name: "Create a mapping draft" });
  await expect(editor.getByLabel("Lite provider deployment")).toBeVisible();
  await expect(editor.getByLabel("Balanced provider deployment")).toBeVisible();
  await expect(editor.getByLabel("Pro provider deployment")).toBeVisible();
  await editor.getByLabel("Mapping revision note").fill("Create the first reviewed enterprise route map.");
  await editor.getByRole("button", { name: "Save local draft" }).click();
  await expect(page.getByText("Local mapping draft saved")).toBeVisible();
});

test("route drafts inherit Luna tool capability from the provider deployment", async ({ page }) => {
  const mappingId = "22222222-2222-4222-8222-222222222222";
  const deployments = ["lite", "balanced", "pro"].map((serviceClass, index) => ({
    id: `44444444-4444-4444-8444-44444444444${index + 1}`,
    serviceClass,
    provider: "openai",
    providerAccountId: "openai-primary",
    providerModel: serviceClass === "lite" ? "openai/gpt-5.6-luna" : "openai/gpt-5.6-terra",
    providerDeployment: serviceClass === "lite" ? "openai/luna" : `openai/${serviceClass}`,
    rateCardId: null,
    capabilities: { vision: false, tools: false, streaming: true, contextTokens: 32000, outputTokens: 32768, residency: [] },
    approved: true,
    evaluationPassed: true,
  }));
  await page.route("**/v1/admin/routing/mappings/latest", async (route) => {
    await route.fulfill({ json: { mapping: { id: mappingId, tenantId: "acme", revisionNote: "Incorrect legacy capability flags", createdBy: "admin", createdAt: "2026-08-02T00:00:00.000Z", deployments } } });
  });
  await page.route("**/v1/admin/provider-settings", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const openai = payload.providers.find((provider) => provider.provider === "openai");
    openai.state = "active";
    openai.selectedModelIds = ["gpt-5.6-luna"];
    openai.deployments = [{
      id: "openai-luna",
      provider: "openai",
      providerAccountId: "openai-primary",
      providerModel: "openai/gpt-5.6-luna",
      providerDeployment: "openai/luna",
      displayName: "OpenAI GPT-5.6 Luna",
      modelCapabilities: { vision: true, tools: true, streaming: true },
    }];
    await route.fulfill({ response, json: payload });
  });

  await page.goto("/?view=ai-control-plane&section=model-routes");
  await page.getByRole("button", { name: "Create draft" }).click();
  const editor = page.getByRole("dialog", { name: "Create a mapping draft" });
  await expect(editor.getByText("Inherited model capabilities: Function tools · Vision · Streaming")).toBeVisible();
  await editor.getByLabel("Mapping revision note").fill("Correct inherited Luna capability metadata.");
  await editor.getByRole("button", { name: "Save local draft" }).click();
  await expect(page.getByRole("table").getByText("Function tools · Vision · Streaming")).toBeVisible();
});

test("administrator can set up a published mapping for a Team and start first shadow rollout", async ({ page }) => {
  const mappingId = "22222222-2222-4222-8222-222222222222";
  const policyId = "33333333-3333-4333-8333-333333333333";
  const deployments = [
    { id: "44444444-4444-4444-8444-444444444444", serviceClass: "lite", providerModel: "gpt-luna", contextTokens: 32000 },
    { id: "55555555-5555-4555-8555-555555555555", serviceClass: "balanced", providerModel: "gpt-terra", contextTokens: 32000 },
    { id: "66666666-6666-4666-8666-666666666666", serviceClass: "pro", providerModel: "gpt-sol", contextTokens: 128000 },
  ].map((item, index) => ({
    ...item,
    provider: "openai",
    providerAccountId: "openai-primary",
    providerDeployment: `openai/${item.providerModel}`,
    region: "sg",
    providerServiceTier: "standard",
    rateCardId: `99999999-9999-4999-8999-99999999999${index + 1}`,
    capabilities: { vision: item.serviceClass !== "lite", tools: item.serviceClass !== "lite", streaming: true, contextTokens: item.contextTokens, outputTokens: 32768, residency: ["sg"] },
    approved: true,
    evaluationPassed: true,
  }));
  const rates = [
    { unit: "input_uncached_token", amountPerUnit: "1", unitScale: "1000000" },
    { unit: "output_token", amountPerUnit: "2", unitScale: "1000000" },
    { unit: "cache_read_token", amountPerUnit: "0.1", unitScale: "1000000" },
    { unit: "cache_write_token", amountPerUnit: "1.25", unitScale: "1000000" },
  ];
  let policy = null;
  let rollout = null;

  await page.route("**/api/v1/admin/routing/mappings/latest", async (route) => {
    await route.fulfill({ json: { mapping: { id: mappingId, tenantId: "acme", revisionNote: "Initial governed mapping", createdBy: "admin", createdAt: "2026-07-31T00:00:00.000Z", deployments } } });
  });
  await page.route("**/api/v1/admin/ai-usage/rate-cards", async (route) => {
    await route.fulfill({ json: { rateCards: deployments.map((deployment) => ({ id: deployment.rateCardId, provider: "openai", providerAccountId: "openai-primary", baseModel: deployment.providerModel, deploymentId: deployment.providerDeployment, region: "sg", providerServiceTier: "standard", currency: "USD", sourceVersion: "verified-2026-07-31", rates })) } });
  });
  await page.route(/\/api\/v1\/admin\/teams\/[^/]+\/routing$/, async (route) => {
    await route.fulfill({ json: { teamId: "11111111-1111-4111-8111-111111111111", policy, rollout, review: null, deployments: policy ? deployments : [] } });
  });
  await page.route(/\/api\/v1\/admin\/teams\/[^/]+\/routing\/policy$/, async (route) => {
    const savedPolicy = route.request().postDataJSON();
    policy = { id: policyId, ...savedPolicy, createdAt: "2026-07-31T00:00:00.000Z" };
    await route.fulfill({ json: { id: policyId } });
  });
  await page.route(/\/api\/v1\/admin\/teams\/[^/]+\/routing\/shadow-report$/, async (route) => {
    await route.fulfill({ json: { teamId: "11111111-1111-4111-8111-111111111111", sampleSize: 0, fallbackRate: "0", errorRate: "0", regretRate: "0", routerOverheadMs: "0", decisions: [] } });
  });
  await page.route(/\/api\/v1\/admin\/teams\/[^/]+\/routing\/rollout$/, async (route) => {
    const savedRollout = route.request().postDataJSON();
    rollout = { id: "77777777-7777-4777-8777-777777777777", tenantId: "acme", teamId: "11111111-1111-4111-8111-111111111111", ...savedRollout, evidenceReviewId: null, previousRolloutVersionId: null, createdBy: "admin", createdAt: "2026-07-31T00:00:00.000Z" };
    await route.fulfill({ status: 201, json: { rollout } });
  });

  await page.goto("/?view=ai-control-plane&section=model-routes");

  await expect(page.locator(".route-readonly-badge")).toHaveText("Published · not active");
  await expect(page.getByText("Policy not configured", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up Team rollout" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save Team policy" })).toHaveCount(0);

  const policyRequest = page.waitForRequest((request) => request.method() === "PUT" && /\/api\/v1\/admin\/teams\/[^/]+\/routing\/policy$/.test(request.url()));
  await page.getByRole("button", { name: "Set up Team rollout" }).click();

  await expect(page.getByText("Finance is ready for shadow evaluation.")).toBeVisible();
  const savedPolicy = (await policyRequest).postDataJSON();
  expect(savedPolicy.mappingVersionId).toBe(mappingId);
  expect(savedPolicy.billingCurrency).toBe("USD");
  expect(savedPolicy.identity.allowedDeploymentIds).toEqual(deployments.map((deployment) => deployment.id));
  expect(savedPolicy.serviceClassPolicies.balanced.safeDefault).toBe(true);
  await expect(page.locator(".route-readonly-badge")).toHaveText("Ready for shadow");
  await expect(page.getByRole("button", { name: "Start shadow mode" })).toBeEnabled();

  const rolloutRequest = page.waitForRequest((request) => request.method() === "POST" && /\/api\/v1\/admin\/teams\/[^/]+\/routing\/rollout$/.test(request.url()));
  await page.getByRole("button", { name: "Start shadow mode" }).click();

  const savedRollout = (await rolloutRequest).postDataJSON();
  expect(savedRollout.mode).toBe("shadow");
  expect(savedRollout.policyVersionId).toBe(policyId);
  expect(savedRollout.mappingVersionId).toBe(mappingId);
  expect(savedRollout.fixedDeploymentId).toBe(deployments[1].id);
  await expect(page.locator(".route-readonly-badge")).toHaveText("Shadow evaluation");
  await expect(page.getByText("Shadow evaluation started for this Team.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start shadow mode" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Enable production routing" })).toBeDisabled();
});

test("mapping editor keeps a clear vertical rhythm at compact width", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/?view=ai-control-plane&section=model-routes");
  await page.getByRole("button", { name: "Create draft" }).click();

  const editor = page.getByRole("dialog", { name: "Create a mapping draft" });
  await editor.getByLabel("Mapping revision note").fill("Compact layout review");
  const firstRow = editor.locator(".route-mapping-editor-row").first();
  const rowHeader = await firstRow.locator("header").boundingBox();
  const providerField = await firstRow.locator(".modal-field").nth(0).boundingBox();
  const priceField = await firstRow.locator(".modal-field").nth(1).boundingBox();
  expect(rowHeader).not.toBeNull();
  expect(providerField).not.toBeNull();
  expect(priceField).not.toBeNull();
  expect(providerField!.y - (rowHeader!.y + rowHeader!.height)).toBeGreaterThanOrEqual(16);
  expect(priceField!.y - (providerField!.y + providerField!.height)).toBeGreaterThanOrEqual(16);
  expect(providerField!.width).toBeGreaterThanOrEqual(rowHeader!.width - 1);
  expect(priceField!.width).toBeGreaterThanOrEqual(rowHeader!.width - 1);

  const warning = await editor.locator(".route-editor-warning").boundingBox();
  const actions = await editor.locator(".modal-actions").boundingBox();
  expect(warning).not.toBeNull();
  expect(actions).not.toBeNull();
  expect(actions!.y - (warning!.y + warning!.height)).toBeGreaterThanOrEqual(22);
});
