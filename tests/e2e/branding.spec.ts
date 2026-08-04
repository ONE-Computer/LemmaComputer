import { expect, test } from "@playwright/test";

test("LemmaComputer branding is visible in the desktop, mobile, and companion shells", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page).toHaveTitle("LemmaComputer");
  const desktopBrand = page.locator(".sidebar .brand");
  await expect(desktopBrand).toHaveAccessibleName("LemmaComputer");
  await expect(desktopBrand).toHaveText("LemmaComputer");
  await expect(page.locator(".workspace-assignment-grid").first()).toContainText("GLM");
  await expect(page.getByText("lemmacomputer-glm", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/lemma-branding-desktop-reviewed.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-brand")).toHaveText("LemmaComputer");

  await page.goto("/companion");
  await expect(page).toHaveTitle("LemmaComputer Companion");
  const companionBrand = page.locator(".companion-brand");
  await expect(companionBrand).toHaveAccessibleName("LemmaComputer");
  await expect(companionBrand).toContainText("LemmaComputer");
});
