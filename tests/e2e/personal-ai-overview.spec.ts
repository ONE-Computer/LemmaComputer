import { expect, test } from "@playwright/test";

const openFromAccountMenu = async (page) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Example User/ }).click();
  await page.getByRole("button", { name: "My AI usage" }).click();
};

test("member navigates to a private personal AI overview and reviews all partial-data states", async ({ page }) => {
  await openFromAccountMenu(page);
  await expect(page).toHaveURL(/\?view=ai-usage$/);
  await expect(page.getByRole("heading", { name: "My AI usage" })).toBeVisible();
  await expect(page.getByText("Private member view")).toBeVisible();
  await expect(page.getByText("34,773")).toBeVisible();
  await expect(page.getByText(/€12.*\$173\.75/)).toBeVisible();
  await expect(page.getByText("1 unpriced usage event")).toBeVisible();
  await expect(page.getByText("1 request is awaiting a usage report")).toBeVisible();
  await expect(page.getByText("1 ledger correction included")).toBeVisible();
  await expect(page.getByText("Mixed currencies stay separate")).toBeVisible();
  await expect(page.getByRole("heading", { name: "By workspace" })).toBeVisible();
  await expect(page.getByText("Personal workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("Hermes Agent CLI", { exact: true })).toBeVisible();
  await expect(page.getByText(/81% accounted-token coverage/)).toBeVisible();
  await expect(page.getByText("image usage is outside this text-token method.")).toBeVisible();
  await expect(page.getByText("Private by membership")).toBeVisible();
  await expect(page.getByText(/other people’s activity are not included/)).toBeVisible();
  await expect(page.getByRole("link", { name: /export/i })).toHaveCount(0);
  await expect(page.getByText(/Team budgets/i)).toHaveCount(0);

  const methodButton = page.getByRole("button", { name: "How this estimate works" });
  await methodButton.focus();
  await expect(methodButton).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "How this estimate works" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("operational-token-v1");
  await expect(dialog).toContainText("Singapore");
  await expect(dialog).toContainText("0.402 kg CO₂e/kWh");
  await expect(dialog).toContainText("It does not control or prove the provider’s physical serving location.");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(methodButton).toBeFocused();
});

test("personal AI overview renders true empty and methodology-unavailable states without zero-cost claims", async ({ page }) => {
  await page.route("**/api/v1/me/ai-usage?*", async (route) => {
    await route.fulfill({ json: { report: {
      contractVersion: 1,
      range: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-13T00:00:00.000Z" },
      asOf: "2026-08-13T00:00:00.000Z",
      state: "empty",
      totals: { costs: [], providerConfirmedCosts: [], usage: {}, attemptCount: 0, eventCount: 0, failedAttemptCount: 0, unknownCostEventCount: 0, incompleteCostEventCount: 0, correctedEventCount: 0, delayedAttemptCount: 0 },
      costCoverage: { status: "complete", unpricedUsage: { activeEventCount: 0, missingPriceEventCount: 0, partialPriceEventCount: 0, acknowledgedEventCount: 0 }, delayedReporting: { attemptCount: 0 }, failedWithoutUsage: { attemptCount: 0 } },
      breakdowns: { workspaces: [], agents: [] },
      providerUsage: [], servingGridAssumptions: [], trend: null,
      privacy: { scope: "authenticated_member", description: "Only AI usage attributed to your active organization membership is included.", contentExcluded: true },
    } } });
  });
  await page.goto("/?view=ai-usage");
  await expect(page.getByRole("heading", { name: "No AI usage recorded this month" })).toBeVisible();
  await expect(page.getByText(/not assumed to be zero/)).toBeVisible();
  await expect(page.getByText("$0.00")).toHaveCount(0);

  await page.unroute("**/api/v1/me/ai-usage?*");
  const fixture = await page.request.get("/api/v1/me/ai-usage");
  const payload = await fixture.json();
  await page.route("**/api/v1/me/ai-usage?*", (route) => route.fulfill({
    json: { report: { ...payload.report, servingGridAssumptions: [] } },
  }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Method unavailable" })).toBeVisible();
  await expect(page.getByText(/No supported serving-grid assumption is configured/)).toBeVisible();
  await page.getByRole("button", { name: "How this estimate works" }).click();
  await expect(page.getByRole("dialog", { name: "How this estimate works" })).toContainText("An administrator has not selected a supported serving-grid assumption");
});

test("personal AI overview hands off to a narrow responsive shell without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=ai-usage");
  await expect(page.getByRole("heading", { name: "My AI usage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By agent" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const workspaceBox = await page.getByRole("heading", { name: "By workspace" }).boundingBox();
  const agentBox = await page.getByRole("heading", { name: "By agent" }).boundingBox();
  expect(agentBox?.y).toBeGreaterThan(workspaceBox?.y ?? 0);
});
