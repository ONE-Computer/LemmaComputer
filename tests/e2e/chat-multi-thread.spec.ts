import { expect, test } from "@playwright/test";

const fixtureUrl = `http://127.0.0.1:${Number(process.env.LEMMACOMPUTER_E2E_FIXTURE_PORT ?? 4_399)}`;

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${fixtureUrl}/__test/reset/chat`);
  expect(response.ok()).toBe(true);
});

test("uses the Recent sidebar to switch between independently streaming chat threads", async ({ page }) => {
  const renderErrors: string[] = [];
  page.on("pageerror", (error) => renderErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /maximum update depth|React error #185/i.test(message.text())) {
      renderErrors.push(message.text());
    }
  });
  await page.goto("/?view=chat&chat=fixture-session-1");

  const postedSessions: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/messages")) return;
    const match = request.url().match(/\/sessions\/([^/]+)\/messages$/);
    if (match) postedSessions.push(decodeURIComponent(match[1]));
  });

  const firstComposer = page.getByRole("textbox", { name: "Message Hermes Agent CLI" });
  await firstComposer.fill("Keep working on the dashboard layout in the first thread.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".sidebar-chat-history > button").filter({ hasText: "Quarterly planning" }).locator(".sidebar-chat-running")).toBeVisible();

  await page.getByRole("button", { name: "Start a new chat" }).click();
  await expect(page.locator(".chat-thread-tabs")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message Hermes Agent CLI" }).fill("Keep working on the dashboard layout in the second thread.");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect.poll(() => postedSessions.length).toBe(2);
  expect(new Set(postedSessions).size).toBe(2);
  await expect(page.locator(".sidebar-chat-running")).toHaveCount(2);

  await page.getByRole("button", { name: /Quarterly planning/ }).click();
  await expect(page.locator(".chat-thread-pane:not([hidden])").getByText("Keep working on the dashboard layout in the first thread.")).toBeVisible();

  await page.getByRole("button", { name: /Keep working on the dashboard layout in the second/ }).click();
  await expect(page.locator(".chat-thread-pane:not([hidden])").getByText("Keep working on the dashboard layout in the second thread.")).toBeVisible();

  await expect(page.locator(".sidebar-chat-running")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".chat-thread-pane:not([hidden])").getByText(/approved destinations/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Hermes Agent CLI" })).toBeEnabled();
  await expect(page.getByText(/maximum update depth|Minified React error #185/i)).toHaveCount(0);
  expect(renderErrors).toEqual([]);
});
