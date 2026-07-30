import { expect, test } from "@playwright/test";

test("builds from the reviewed chat skill and manages the published site", async ({ page }) => {
  await page.goto("/?view=chat&chat=fixture-session-1");

  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: /Make a site/ }).click();
  const composer = page.getByPlaceholder(/message/i);
  await expect(composer).toHaveValue("Use $make-a-site to build and publish a simple site.");
  await composer.fill("Use $make-a-site to build and publish a Hello world site with text centered in the page.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Published Hello world/)).toBeVisible();

  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await expect(page).toHaveURL(/view=sites/);
  const row = page.getByRole("article").filter({ hasText: "Hello world" });
  await expect(row).toContainText("Revision 1");
  await expect(row.locator("img, svg")).toHaveCount(0);

  const [sitePage] = await Promise.all([
    page.context().waitForEvent("page"),
    row.getByRole("link", { name: "Open Hello world in a new tab" }).click(),
  ]);
  await expect(sitePage).toHaveURL(/\/api\/v1\/sites\/[0-9a-f-]+\/content$/);
  await expect(sitePage.getByText("Hello world", { exact: true })).toBeVisible();
  expect(await sitePage.evaluate(() => window.opener)).toBeNull();
  await sitePage.close();

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
