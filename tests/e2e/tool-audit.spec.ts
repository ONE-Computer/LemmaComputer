import { expect, test } from "@playwright/test";

test("organization auditors can review and filter identified agent tool calls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?view=trail");
  await expect(page.getByRole("heading", { name: "Trail" })).toBeVisible();
  await page.getByRole("button", { name: "Tool activity" }).click();

  await expect(page.getByRole("heading", { name: "Agent tool activity" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Workspace and agent" })).toBeVisible();
  await expect(page.getByText("send-teams-message", { exact: true })).toBeVisible();
  await expect(page.getByText("planning-draft.docx", { exact: false })).toBeVisible();

  await page.getByText("send-teams-message", { exact: true }).click();
  const evidence = page.getByRole("complementary", { name: "Tool call evidence" });
  await expect(evidence).toContainText("Compliance evidence");
  await expect(evidence).toContainText("11111111-1111-4111-8111-111111111111");
  await expect(evidence.getByRole("button", { name: "Open protected action" })).toBeVisible();

  await page.getByText("Filters", { exact: true }).click();
  await page.getByRole("combobox", { name: "Tool activity outcome" }).click();
  await page.getByRole("option", { name: "Blocked by policy" }).click();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("delete-drive-item", { exact: true })).toBeVisible();
  await expect(page.getByText("send-teams-message", { exact: true })).toHaveCount(0);
});

test("tool activity remains readable as labelled cards on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto("/?view=trail");
  await page.getByRole("button", { name: "Tool activity" }).click();
  const firstRow = page.locator(".tool-audit-table tbody tr").first();
  await expect(firstRow).toBeVisible();
  await expect(firstRow.locator('td[data-label="Member"]')).toBeVisible();
  await expect(firstRow.locator('td[data-label="Outcome"]')).toBeVisible();
  const bodyWidth = await page.locator("body").evaluate((element) => element.scrollWidth);
  expect(bodyWidth).toBeLessThanOrEqual(600);
});

test("tool activity pagination retains the exact first-page time window", async ({ page }) => {
  let firstWindow = "";
  await page.route("**/api/v1/admin/tool-audit?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const response = await route.fetch();
    const body = await response.json();
    const window = `${requestUrl.searchParams.get("from")}|${requestUrl.searchParams.get("to")}`;
    if (!requestUrl.searchParams.get("cursor")) {
      firstWindow = window;
      await route.fulfill({ response, json: { ...body, events: body.events.slice(0, 1), nextCursor: "fixture-page-2" } });
      return;
    }
    expect(window).toBe(firstWindow);
    await route.fulfill({ response, json: { ...body, events: body.events.slice(1), nextCursor: null } });
  });
  await page.goto("/?view=trail");
  await page.getByRole("button", { name: "Tool activity" }).click();
  await expect(page.getByText("send-teams-message", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("delete-drive-item", { exact: true })).toBeVisible();
});

test("members without audit permission do not see organization tool activity", async ({ page }) => {
  await page.route("**/api/v1/auth/session", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({
      response,
      json: { ...session, roles: ["member"], capabilities: session.capabilities.filter((value: string) => value !== "audit.read") },
    });
  });
  await page.goto("/?view=trail");
  await expect(page.getByRole("heading", { name: "Trail" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tool activity" })).toHaveCount(0);
  await expect(page.getByText("Approval device", { exact: true })).toBeVisible();
});
