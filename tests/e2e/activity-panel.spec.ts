import { expect, test, type Page } from "@playwright/test";

const chatPath = "/?view=chat&chat=fixture-session-1";

const openHistoricalActivity = async (page: Page, overlay = false) => {
  await page.goto(chatPath);
  if (overlay) await page.getByRole("button", { name: "Activity", exact: true }).click();
  const panel = overlay
    ? page.getByRole("dialog", { name: "Activity" })
    : page.getByRole("region", { name: "Activity" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".activity-event")).toHaveCount(11);
  await expect(panel.locator('[aria-live="polite"]')).toContainText("Activity complete.");
  return panel;
};

test.describe("streaming Activity panel", () => {
  test.describe.configure({ mode: "serial" });

  test("renders the complete retained fixture with safe provenance and links", async ({ page }) => {
    const panel = await openHistoricalActivity(page);
    await expect(panel.locator(".activity-event.plan")).toHaveCount(1);
    await expect(panel.locator(".activity-event.progress")).toHaveCount(1);
    await expect(panel.locator(".activity-event.provider_summary")).toHaveCount(1);
    await expect(panel.locator(".activity-event.tool")).toHaveCount(1);
    await expect(panel.locator(".activity-event.web_action")).toHaveCount(1);
    await expect(panel.locator(".activity-event.source")).toHaveCount(1);
    await expect(panel.locator(".activity-event.approval")).toHaveCount(1);
    await expect(panel.locator(".activity-event.computer_action")).toHaveCount(1);
    await expect(panel.locator(".activity-event.notice")).toHaveCount(1);
    await expect(panel.locator(".activity-event.error")).toHaveCount(1);
    await expect(panel.locator(".activity-event.terminal")).toHaveCount(1);
    await expect(panel.getByText("Provider generated", { exact: true })).toHaveCount(2);
    await expect(panel).not.toContainText(/chain of thought|reasoning trace|hidden reasoning/i);

    const links = await panel.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => ({
      href: (anchor as HTMLAnchorElement).href,
      target: anchor.getAttribute("target"),
      rel: anchor.getAttribute("rel"),
    })));
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(new URL(link.href).protocol).toMatch(/^https?:$/);
      expect(link.target).toBe("_blank");
      expect(link.rel?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    }
  });

  test("does not render error payload details when retained activity is unavailable", async ({ page }) => {
    await page.route("**/turns/fixture-turn-1/activity?**", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "ACTIVITY_TURN_NOT_FOUND",
            message: "FOREIGN_TENANT_SECRET_ACTIVITY",
            retryable: false,
          },
        }),
      });
    });
    await page.goto(chatPath);
    const panel = page.getByRole("region", { name: "Activity" });
    await expect(panel).toContainText("Activity is no longer available");
    await expect(panel).not.toContainText("FOREIGN_TENANT_SECRET_ACTIVITY");
    await expect(panel.locator(".activity-event")).toHaveCount(0);
  });

  test("traps focus, expands details, closes with Escape, and returns focus on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(chatPath);
    const toggle = page.getByRole("button", { name: "Activity", exact: true });
    await toggle.click();
    const dialog = page.getByRole("dialog", { name: "Activity" });
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.locator('[aria-live="polite"]')).toContainText("Activity complete.");
    const close = dialog.getByRole("button", { name: "Close Activity" });
    await expect(close).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const plan = dialog.locator("details").first();
    await plan.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(plan).toHaveAttribute("open", "");

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  for (const viewport of [
    { name: "wide", width: 1440, height: 1000, overlay: false },
    { name: "narrow", width: 1100, height: 800, overlay: true },
    { name: "tablet", width: 834, height: 1112, overlay: true },
    { name: "mobile", width: 390, height: 844, overlay: true },
  ]) {
    test(`matches the ${viewport.name} Activity layout`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openHistoricalActivity(page, viewport.overlay);
      await page.addStyleTag({ content: ".activity-event time { visibility: hidden !important; }" });
      await expect(page).toHaveScreenshot(`activity-${viewport.name}.png`, {
        animations: "disabled",
        fullPage: false,
      });
    });
  }

  test("replays after a forced disconnect without missing or duplicate events", async ({ page }) => {
    const activityRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/activity")) activityRequests.push(request.url());
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(chatPath);
    await page.getByRole("textbox", { name: "Message Hermes Agent CLI" }).fill("Validate the Activity reconnect path.");
    await page.getByRole("button", { name: "Send message" }).click();

    const panel = page.getByRole("region", { name: "Activity" });
    await expect(panel.locator(".activity-event")).toHaveCount(5);
    await expect(panel.locator(".activity-event.terminal")).toContainText("Turn completed");
    const sequences = await panel.locator(".activity-event").evaluateAll((events) => (
      events.map((event) => Number((event as HTMLElement).dataset.activitySequence))
    ));
    expect(sequences).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(sequences).size).toBe(sequences.length);
    await expect.poll(() => activityRequests.some((url) => url.includes("/activity?after=2&limit=500"))).toBe(true);
  });
});
