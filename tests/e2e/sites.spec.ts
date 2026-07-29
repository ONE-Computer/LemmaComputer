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
  const card = page.getByRole("article").filter({ hasText: "Hello world" });
  await expect(card).toContainText("Revision 1");
  await card.getByRole("button", { name: "Open" }).click();

  const preview = page.frameLocator('iframe[title="Hello world site"]');
  await expect(preview.getByText("Hello world", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All sites" }).click();
  await card.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete site" }).click();
  await expect(page.getByRole("heading", { name: "No sites yet" })).toBeVisible();
});
