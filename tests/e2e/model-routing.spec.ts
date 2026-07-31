import { expect, test } from "@playwright/test";

test("administrator can inspect alias mappings, pricing coverage, and supported rollout controls", async ({ page }) => {
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Model routing" }).click();

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
  await mappingEditor.getByLabel("Mapping revision note").fill("Move Lite to the reviewed Luna v2 deployment.");
  await mappingEditor.getByLabel("Lite provider model").fill("private/luna-v2");
  await mappingEditor.getByLabel("Lite deployment ID").fill("foundry/luna-v2");
  await mappingEditor.getByRole("button", { name: "Save local draft" }).click();
  await expect(aliasTable.getByText("Azure AI Foundry · private/luna-v2")).toBeVisible();
  await expect(aliasTable.getByText("No card")).toBeVisible();
  await page.getByRole("button", { name: "Publish mapping version" }).click();
  await page.getByRole("dialog", { name: "Publish mapping version?" }).getByRole("button", { name: "Publish mapping version" }).click();
  await expect(page.getByRole("status")).toContainText("Published for policy/shadow evaluation; current Team rollouts are unchanged.");

  const liteRow = aliasTable.getByRole("row").filter({ hasText: "private/luna-v2" });
  await liteRow.getByRole("button", { name: "Add price record" }).click();
  const pricing = page.getByRole("dialog", { name: "New Lite price version" });
  await expect(pricing.getByLabel("Provider account ID")).toHaveValue("foundry-primary");
  await pricing.getByLabel("Input price per 1M tokens").fill("0.4");
  await pricing.getByLabel("Output price per 1M tokens").fill("2");
  await pricing.getByLabel("Cache read price per 1M tokens").fill("0.1");
  await pricing.getByLabel("Cache write price per 1M tokens").fill("0.5");
  await pricing.getByLabel("Price approval reason").fill("Finance-approved enterprise rate update.");
  await pricing.getByRole("button", { name: "Create price record" }).click();
  await expect(page.getByRole("status")).toContainText("attached to the local mapping draft");
  await page.getByRole("button", { name: "Publish mapping version" }).click();
  await page.getByRole("dialog", { name: "Publish mapping version?" }).getByRole("button", { name: "Publish mapping version" }).click();
  await expect(page.getByRole("status")).toContainText("current Team rollouts are unchanged");

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
