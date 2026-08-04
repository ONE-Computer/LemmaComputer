import { expect, test } from "@playwright/test";

const fixtureUrl = `http://127.0.0.1:${Number(process.env.LEMMACOMPUTER_E2E_FIXTURE_PORT ?? 4_399)}`;

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${fixtureUrl}/__test/reset/chat`);
  expect(response.ok()).toBe(true);
});

test("restores and follows an in-flight chat turn after refresh", async ({ page }) => {
  await page.goto("/?view=chat&chat=fixture-session-1");

  const composer = page.getByPlaceholder(/message/i);
  await composer.fill("Keep working on the dashboard layout.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/check the workspace context first/)).toBeVisible();
  await expect(page.getByText("Reviewing the workspace context…")).toBeVisible();
  await expect(page.locator(".chat-tool")).toHaveCount(0);

  await page.reload();

  await expect(page.getByText("Keep working on the dashboard layout.")).toBeVisible();
  await expect(page.getByText(/check the workspace context first/)).toBeVisible();
  await expect(composer).toBeDisabled();
  await expect(page.locator(".chat-tool")).toHaveCount(0);
  await expect(page.getByText(/approved destinations/)).toBeVisible();
  await expect(composer).toBeEnabled();
});

test("Stop explicitly cancels a detached turn after refresh", async ({ page }) => {
  await page.goto("/?view=chat&chat=fixture-session-1");

  const composer = page.getByPlaceholder(/message/i);
  const opening = page.getByText(/check the workspace context first/);
  const openingCount = await opening.count();
  await composer.fill("Keep working on the dashboard layout until I stop you.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(opening).toHaveCount(openingCount + 1);

  await page.reload();
  await expect(page.getByRole("button", { name: /Stop Hermes Agent CLI/ })).toBeVisible();
  const cancelled = page.waitForResponse((response) => (
    response.request().method() === "DELETE"
    && response.url().endsWith("/turns/active")
  ));
  await page.getByRole("button", { name: /Stop Hermes Agent CLI/ }).click();
  expect((await cancelled).status()).toBe(204);

  await expect(page.getByText("Stopped by the employee")).toBeVisible();
  await expect(composer).toBeEnabled();
});

test("Make-a-site finishes and publishes after its browser stream is refreshed", async ({ page }) => {
  await page.goto("/?view=chat&chat=fixture-session-1");

  const composer = page.getByPlaceholder(/message/i);
  await composer.fill("Use $make-a-site to build Hello world and survive refresh.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/build the smallest Vite site/)).toBeVisible();

  await page.reload();
  await expect(page.getByText("Use $make-a-site to build Hello world and survive refresh.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop Hermes Agent CLI/ })).toBeVisible();
  await expect(page.getByText(/Published Hello world/)).toBeVisible();

  await page.getByRole("button", { name: "Sites" }).click();
  await expect(page.getByRole("link", { name: /Open Hello world/ })).toBeVisible();
});
