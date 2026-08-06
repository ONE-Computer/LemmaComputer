import { expect, test } from "@playwright/test";

const fixtureUrl = `http://127.0.0.1:${Number(process.env.LEMMACOMPUTER_E2E_FIXTURE_PORT ?? 4_399)}`;

const composerMetrics = async (page: import("@playwright/test").Page) => page.locator(".chat-composer:visible").evaluate((element) => {
  const bounds = element.getBoundingClientRect();
  return { top: bounds.top, bottom: bounds.bottom };
});

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${fixtureUrl}/__test/reset/chat`);
  expect(response.ok()).toBe(true);
});

test("centers the empty-chat composer and docks it after the first message", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?view=chat&chat=fixture-session-1");

  const viewportHeight = page.viewportSize()?.height;
  expect(viewportHeight).toBe(1000);
  const activeConversation = page.locator(".chat-thread-pane:not([hidden]) .chat-conversation");

  await expect(activeConversation).not.toHaveClass(/is-empty/);
  await expect.poll(async () => viewportHeight - (await composerMetrics(page)).bottom).toBeLessThanOrEqual(32);

  await page.getByRole("button", { name: "Start a new chat" }).click();
  await expect(activeConversation).toHaveClass(/is-empty/);
  await expect(page.locator(".chat-empty-state:visible")).toBeVisible();

  const emptyComposer = await composerMetrics(page);
  expect(emptyComposer.top).toBeGreaterThan(viewportHeight * 0.35);
  expect(emptyComposer.bottom).toBeLessThan(viewportHeight * 0.7);

  await page.locator("textarea:visible").fill("Move this composer to the transcript dock.");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(activeConversation).not.toHaveClass(/is-empty/);
  await expect.poll(async () => viewportHeight - (await composerMetrics(page)).bottom).toBeLessThanOrEqual(32);
});
