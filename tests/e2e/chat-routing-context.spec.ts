import { expect, test, type Page } from "@playwright/test";

const productWorkspaceId = "4d647d2f-7b42-438e-b1bb-4e91347eb58d";
const fixtureUrl = `http://127.0.0.1:${Number(process.env.ONECOMPUTER_E2E_FIXTURE_PORT ?? 4_399)}`;

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${fixtureUrl}/__test/reset/chat`);
  expect(response.ok()).toBe(true);
});

const choose = async (page: Page, label: string, option: string) => {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
};

test("routes the next turn through the selected workspace, agent, and stable model mode", async ({ page }) => {
  await page.goto("/?view=chat");

  await page.getByRole("button", { name: /Hermes Agent CLI · Acme Workspace · Auto/ }).click();
  await choose(page, "Choose workspace", "Product");
  await expect(page.getByRole("button", { name: /Hermes Agent CLI · Product · Auto/ })).toBeVisible();

  await page.getByRole("button", { name: /Hermes Agent CLI · Product · Auto/ }).click();
  await choose(page, "Choose chat agent", "Codex CLI");
  await expect(page.getByRole("button", { name: /Codex CLI · Product · Auto/ })).toBeVisible();

  await page.getByRole("button", { name: /Codex CLI · Product · Auto/ }).click();
  await choose(page, "Choose model mode", "Pro · highest capability");
  await page.getByRole("button", { name: /Codex CLI · Product · Pro/ }).click();

  const composer = page.getByPlaceholder("Message Codex CLI");
  await composer.fill("Prepare the launch analysis with the selected context.");
  const sent = page.waitForRequest((request) => (
    request.method() === "POST"
    && request.url().includes(`/workspaces/${productWorkspaceId}/chat/agents/codex-cli/`)
    && request.url().endsWith("/messages")
  ));
  await page.getByRole("button", { name: "Send message" }).click();
  const request = await sent;
  const payload = request.postDataJSON();
  expect(payload.requestedServiceClass).toBe("pro");
  expect(payload.message.metadata.agentCatalogId).toBe("codex-cli");

  await page.getByRole("button", { name: /Codex CLI · Product · Pro/ }).click();
  await expect(page.getByRole("combobox", { name: "Choose workspace" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Choose chat agent" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Choose model mode" })).toBeDisabled();
  await expect(page.getByText(/approved destinations/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Choose model mode" })).toBeEnabled();
});
