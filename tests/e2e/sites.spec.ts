import { expect, test } from "@playwright/test";

test("builds from the reviewed chat skill and manages the published site", async ({ page }, testInfo) => {
  await page.goto("/?view=chat&chat=fixture-session-1");

  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: /^Site/ }).click();
  const composer = page.getByPlaceholder(/message/i);
  await expect(composer).toHaveValue("Use $site to create or update and publish a small dashboard site.");
  await composer.fill("Use $site to build and publish a Hello world site with text centered in the page.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Published Hello world/)).toBeVisible();

  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await expect(page).toHaveURL(/view=sites/);
  const row = page.getByRole("article").filter({ hasText: "Hello world" });
  await expect(row).toContainText("Version 1");
  await expect(row.locator("img, svg")).toHaveCount(0);

  const [sitePage] = await Promise.all([
    page.context().waitForEvent("page"),
    row.getByRole("link", { name: "Open Hello world in a new tab" }).click(),
  ]);
  await expect(sitePage).toHaveURL(/\/s\/[A-Za-z0-9_-]{24}$/);
  await expect(sitePage.locator("iframe")).toBeVisible();
  await expect(sitePage.locator("iframe").contentFrame().getByText("Hello world", { exact: true })).toBeVisible();
  expect(await sitePage.evaluate(() => window.opener)).toBeNull();
  await testInfo.attach("site-viewer", { body: await sitePage.screenshot(), contentType: "image/png" });
  await sitePage.close();

  await row.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("heading", { name: "Share Hello world" })).toBeVisible();
  await page.getByRole("combobox", { name: "Visibility" }).click();
  await page.getByRole("option", { name: "Everyone in my organization" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(row).toContainText("Organization");

  const mobilePage = await page.context().newPage();
  await mobilePage.setViewportSize({ width: 390, height: 844 });
  await mobilePage.goto("/?view=sites");
  const mobileRow = mobilePage.getByRole("article").filter({ hasText: "Hello world" });
  await expect(mobileRow.getByRole("link", { name: "Open Hello world in a new tab" })).toBeVisible();
  await expect(mobileRow.getByRole("button", { name: "Delete" })).toBeVisible();
  await mobilePage.close();

  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete site" }).click();
  await expect(page.getByRole("heading", { name: "No sites yet" })).toBeVisible();
});
