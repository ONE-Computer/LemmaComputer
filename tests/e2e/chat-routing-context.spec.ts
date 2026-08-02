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

  let releaseProductAgents = () => {};
  const productAgentsReleased = new Promise<void>((resolve) => {
    releaseProductAgents = resolve;
  });
  await page.route(`**/workspaces/${productWorkspaceId}/chat/agents`, async (route) => {
    await productAgentsReleased;
    await route.continue();
  });

  await page.getByRole("button", { name: /Hermes Agent CLI · Acme Workspace · Auto/ }).click();
  await choose(page, "Choose workspace", "Product");
  await expect(page.getByRole("heading", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(page.locator(".chat-runtime-state")).toBeVisible();
  releaseProductAgents();
  await expect(page.getByRole("button", { name: /Hermes Agent CLI · Product · Auto/ })).toBeVisible();

  await page.getByRole("button", { name: /Hermes Agent CLI · Product · Auto/ }).click();
  await choose(page, "Choose chat agent", "Codex CLI");
  await expect(page.getByRole("button", { name: /Codex CLI · Product · Auto/ })).toBeVisible();

  await page.getByRole("button", { name: /Codex CLI · Product · Auto/ }).click();
  await choose(page, "Choose model mode", "Pro · highest capability");
  await page.getByRole("button", { name: /Codex CLI · Product · Pro/ }).click();

  const composer = page.getByPlaceholder("Message Codex CLI");
  await composer.fill("Line one\nLine two\nLine three\nLine four");
  const [rowBox, actionsBox, contextBox, sendBox] = await Promise.all([
    page.locator(".companion-chat-composer-row").boundingBox(),
    page.getByRole("button", { name: "Chat actions" }).boundingBox(),
    page.getByRole("button", { name: /Codex CLI · Product · Pro/ }).boundingBox(),
    page.getByRole("button", { name: "Send message" }).boundingBox(),
  ]);
  expect(rowBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(contextBox).not.toBeNull();
  expect(sendBox).not.toBeNull();
  const controlBottoms = [actionsBox!, contextBox!, sendBox!].map((box) => box.y + box.height);
  expect(Math.max(...controlBottoms) - Math.min(...controlBottoms)).toBeLessThanOrEqual(1);
  expect(rowBox!.height).toBeGreaterThan(sendBox!.height);

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
  await expect(page.getByRole("combobox", { name: "Choose model mode" })).toHaveText("Pro · highest capability");

  await page.reload();
  await expect(page.getByRole("button", { name: /Codex CLI · Product · Pro/ })).toBeVisible();
  await page.getByRole("button", { name: /Codex CLI · Product · Pro/ }).click();
  await expect(page.getByRole("combobox", { name: "Choose model mode" })).toHaveText("Pro · highest capability");

  await composer.fill("Continue with the same model mode.");
  const sentAgain = page.waitForRequest((nextRequest) => (
    nextRequest.method() === "POST"
    && nextRequest.url().includes(`/workspaces/${productWorkspaceId}/chat/agents/codex-cli/`)
    && nextRequest.url().endsWith("/messages")
  ));
  await page.getByRole("button", { name: "Send message" }).click();
  expect((await sentAgain).postDataJSON().requestedServiceClass).toBe("pro");
});
