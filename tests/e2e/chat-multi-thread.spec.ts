import { expect, test } from "@playwright/test";

const fixtureUrl = `http://127.0.0.1:${Number(process.env.LEMMACOMPUTER_E2E_FIXTURE_PORT ?? 4_399)}`;

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${fixtureUrl}/__test/reset/chat`);
  expect(response.ok()).toBe(true);
});

test("keeps two chat threads mounted and streams both turns independently", async ({ page }) => {
  await page.goto("/?view=chat&chat=fixture-session-1");

  const postedSessions: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/messages")) return;
    const match = request.url().match(/\/sessions\/([^/]+)\/messages$/);
    if (match) postedSessions.push(decodeURIComponent(match[1]));
  });

  const firstComposer = page.locator("textarea:visible");
  await firstComposer.fill("Keep working on the dashboard layout in the first thread.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".chat-thread-tab").filter({ hasText: "Quarterly planning" }).locator(".chat-thread-running")).toBeVisible();

  await page.getByRole("button", { name: "Start a new chat thread" }).click();
  await expect(page.getByRole("tab", { name: "New thread" })).toBeVisible();
  await page.locator("textarea:visible").fill("Keep working on the dashboard layout in the second thread.");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect.poll(() => postedSessions.length).toBe(2);
  expect(new Set(postedSessions).size).toBe(2);
  await expect(page.locator(".chat-thread-running")).toHaveCount(2);

  await page.getByRole("tab", { name: /Quarterly planning/ }).click();
  await expect(page.locator(".chat-thread-pane:not([hidden])").getByText("Keep working on the dashboard layout in the first thread.")).toBeVisible();

  await page.getByRole("tab", { name: /Conversation 2/ }).click();
  await expect(page.locator(".chat-thread-pane:not([hidden])").getByText("Keep working on the dashboard layout in the second thread.")).toBeVisible();

  await expect(page.locator(".chat-thread-running")).toHaveCount(0, { timeout: 10_000 });
});
