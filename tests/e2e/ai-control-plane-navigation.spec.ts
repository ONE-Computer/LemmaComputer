import { expect, test } from "@playwright/test";

test("administrator enters the AI control plane from the account menu and navigates its tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.goto("/");
  await page.locator(".sidebar-profile").click();
  const accountMenu = page.getByRole("group", { name: "Account menu" });
  await expect(accountMenu.getByText("Organization", { exact: true })).toBeVisible();
  await expect(accountMenu.getByRole("button", { name: "AI control plane" })).toBeVisible();
  await accountMenu.getByRole("button", { name: "AI control plane" }).click();
  await expect(page).toHaveURL(/\?view=ai-control-plane$/);
  await expect(page.getByRole("heading", { name: "AI control plane", exact: true })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "AI control plane" });
  await expect(tabs.getByRole("button")).toHaveCount(6);
  await expect(tabs.getByRole("button", { name: "Audit log" })).toHaveCount(0);
  await expect(tabs.getByRole("button", { name: "Data health" })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Route readiness", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Explainability" })).toHaveCount(0);
  const emissions = page.getByRole("region", { name: "Estimated AI-related emissions" });
  await expect(emissions).toBeVisible();
  await expect(page.locator(".ai-overview-columns .ai-emissions")).toHaveCount(1);
  await expect(page.locator(".ai-budget-numbers dl")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(emissions.getByText("Coming Soon", { exact: true })).toHaveCount(0);
  await expect(emissions.getByText("Why spend changed")).toHaveCount(0);
  await expect(emissions.getByText("Retry activity")).toHaveCount(0);
  await expect(emissions.getByText("Cache-read share")).toHaveCount(0);
  await expect(emissions.getByText("Routing impact")).toHaveCount(0);
  await expect(emissions.getByRole("heading", { name: "0.92 gCO₂e" })).toBeVisible();
  await expect(emissions.getByText(/19% token coverage/)).toBeVisible();
  await expect(page.getByText(/evidence coverage/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "US grid factor" })).toHaveAttribute("href", "https://www.epa.gov/egrid/summary-data");
  const emissionsInfo = page.getByRole("button", { name: "Open AI emissions calculation details" });
  const emissionsBoxBeforeHover = await emissions.boundingBox();
  await emissionsInfo.hover();
  await expect(page.getByRole("dialog", { name: "How this estimate is calculated" })).toHaveCount(0);
  expect((await emissions.boundingBox())?.height).toBe(emissionsBoxBeforeHover?.height);
  await emissionsInfo.click();
  const emissionsDialog = page.getByRole("dialog", { name: "How this estimate is calculated" });
  await expect(emissionsDialog).toBeVisible();
  await expect(emissionsDialog).toContainText("United States");
  await expect(emissionsDialog).toContainText("0.349667 kg CO₂e/kWh");
  await expect(emissionsDialog).toContainText("input, output, cache-read, cache-write, and reasoning text tokens");
  await expect(page).toHaveScreenshot("ai-emissions-modal-desktop.png");
  await emissionsDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(emissionsDialog).toHaveCount(0);
  await expect(emissionsInfo).toBeFocused();
  await tabs.getByRole("button", { name: "Pricing" }).click();
  await expect(page).toHaveURL(/\?view=ai-control-plane&section=pricing$/);
  await expect(page.getByRole("heading", { name: "Pricing", exact: true })).toBeVisible();
  await tabs.getByRole("button", { name: "Model routes" }).click();
  await expect(page).toHaveURL(/\?view=ai-control-plane&section=model-routes$/);
  await expect(page.getByRole("heading", { name: "Model routes" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\?view=ai-control-plane&section=pricing$/);
  await expect(tabs.getByRole("button", { name: "Pricing" })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(/\?view=ai-control-plane$/);
  await expect(tabs.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
});

test("Settings keeps account and workspace controls without duplicating AI governance", async ({ page }) => {
  await page.goto("/?view=settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Credentials" })).toBeVisible();
  await expect(page.getByRole("button", { name: "People and access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Provider settings" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "AI spend" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Model routing" })).toHaveCount(0);
  await page.getByRole("button", { name: "People and access" }).click();
  await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Teams" })).toHaveCount(0);
});

test("provider setup shows configured deployments and selects more than one routing model", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=models-providers");
  await expect(page.getByRole("heading", { name: "Provider settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Settings" })).toHaveCount(0);

  const anthropic = page.locator(".provider-settings-inventory article").filter({ hasText: "Anthropic" });
  await expect(anthropic.getByRole("list", { name: "Anthropic configured deployments" })).toContainText("Anthropic Claude Sonnet 4.6");
  await expect(anthropic.getByRole("list", { name: "Anthropic configured deployments" })).toContainText("Anthropic Claude Opus 4.8");
  await anthropic.getByRole("button", { name: "Configure" }).click();

  const dialog = page.getByRole("dialog", { name: "Configure Anthropic" });
  await expect(dialog.getByRole("combobox", { name: "Estimated serving grid for emissions" })).toHaveText(/United States/);
  await expect(dialog.getByText(/does not control or guarantee the provider’s inference location/)).toBeVisible();
  const sonnet = dialog.getByRole("checkbox", { name: /Anthropic Claude Sonnet 4.6/ });
  const opus = dialog.getByRole("checkbox", { name: /Anthropic Claude Opus 4.8/ });
  await expect(sonnet).toBeChecked();
  await expect(opus).toBeChecked();
  await opus.uncheck();
  await expect(sonnet).toBeChecked();
  await expect(opus).not.toBeChecked();
});

test("provider model selection discloses reviewed OpenAI model capabilities", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=models-providers");
  const openai = page.locator(".provider-settings-inventory article").filter({ hasText: "OpenAI" });
  await openai.getByRole("button", { name: "Connect" }).click();

  const dialog = page.getByRole("dialog", { name: "Connect OpenAI" });
  await expect(dialog.getByText("Function tools")).toHaveCount(3);
  await expect(dialog.getByText("Vision")).toHaveCount(3);
  await expect(dialog.getByText("Streaming")).toHaveCount(3);
});

test("Teams and budgets is the sole Team-management surface", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=teams-budgets");
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Team" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open organization administration" })).toHaveCount(0);
});

test("employee cannot discover or deep-link the administrator control plane", async ({ page }) => {
  await page.route("**/v1/auth/session", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, roles: ["employee"], capabilities: [], resourceCapabilities: [] },
    });
  });
  await page.goto("/?view=ai-control-plane");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await page.locator(".sidebar-profile").click();
  const accountMenu = page.getByRole("group", { name: "Account menu" });
  await expect(accountMenu.getByRole("button", { name: "AI control plane" })).toHaveCount(0);
  await expect(accountMenu.getByRole("button", { name: "Settings" })).toBeVisible();
});
