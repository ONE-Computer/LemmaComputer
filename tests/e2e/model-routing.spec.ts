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
  await expect(aliasTable.getByText("No card")).toBeVisible();
  await page.getByRole("button", { name: "Publish mapping version" }).click();
  await page.getByRole("dialog", { name: "Publish mapping version?" }).getByRole("button", { name: "Publish mapping version" }).click();
  await expect(page.getByRole("status")).toContainText("Published for policy/shadow evaluation; current Team rollouts are unchanged.");


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
