import { expect, test } from "@playwright/test";

test("restores and follows an in-flight chat turn after refresh", async ({ page }) => {
  await page.goto("/?view=chat&chat=fixture-session-1");

  const composer = page.getByPlaceholder(/message/i);
  await composer.fill("Keep working on the dashboard layout.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/check the workspace context first/)).toBeVisible();

  await page.reload();

  await expect(page.getByText("Keep working on the dashboard layout.")).toBeVisible();
  await expect(page.getByText(/check the workspace context first/)).toBeVisible();
  await expect(composer).toBeDisabled();
  await expect(page.getByText(/approved destinations/)).toBeVisible();
  await expect(composer).toBeEnabled();
});
