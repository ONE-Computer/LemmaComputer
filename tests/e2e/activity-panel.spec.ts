import { expect, test, type Page } from "@playwright/test";

const chatPath = "/?view=chat&chat=fixture-session-1";

const openHistoricalActivity = async (page: Page) => {
  await page.goto(chatPath);
  const panel = page.getByRole("dialog", { name: "Activity" });
  const toggle = page.getByRole("button", { name: "Activity", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator(".activity-event")).toHaveCount(11);
  await expect(panel.locator('[aria-live="polite"]')).toContainText("Activity complete.");
  return panel;
};

test("chat composer grows with input and stops at the stacked composer's 180px cap", async ({ page }) => {
  await page.goto(chatPath);
  const composer = page.getByPlaceholder(/message/i);
  const size = () => composer.evaluate((field: HTMLTextAreaElement) => ({
    height: field.getBoundingClientRect().height,
    clientHeight: field.clientHeight,
    scrollHeight: field.scrollHeight,
  }));

  const oneLine = await size();
  await composer.fill("One\nTwo\nThree\nFour\nFive");
  const fiveLines = await size();
  await composer.fill("One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine");
  const nineLines = await size();

  expect(fiveLines.height).toBeGreaterThan(oneLine.height);
  // The stacked-composer change replaced the old five-line cap with 180px.
  expect(nineLines.height).toBeGreaterThan(fiveLines.height);
  expect(nineLines.height).toBe(180);
  expect(nineLines.scrollHeight).toBeGreaterThan(nineLines.clientHeight);
  await composer.fill(Array.from({ length: 12 }, (_, index) => `Line ${index}`).join("\n"));
  expect((await size()).height).toBe(nineLines.height);
});

test.describe("streaming Activity panel", () => {
  test.describe.configure({ mode: "serial" });

  test("renders the complete retained fixture with safe provenance and links", async ({ page }) => {
    const panel = await openHistoricalActivity(page);
    await expect(panel.locator(".activity-event.plan")).toHaveCount(1);
    await expect(panel.locator(".activity-event.progress")).toHaveCount(1);
    await expect(panel.locator(".activity-event.provider_summary")).toHaveCount(1);
    await expect(panel.locator(".activity-event.tool")).toHaveCount(1);
    await expect(page.locator(".chat-tool")).toHaveCount(0);
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
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Activity" });
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
    { name: "wide", width: 1440, height: 1000 },
    { name: "narrow", width: 1100, height: 800 },
    { name: "tablet", width: 834, height: 1112 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`matches the ${viewport.name} Activity layout`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openHistoricalActivity(page);
      await page.addStyleTag({ content: ".activity-event time { visibility: hidden !important; }" });
      await expect(page).toHaveScreenshot(`activity-${viewport.name}.png`, {
        animations: "disabled",
        fullPage: false,
      });
    });
  }

  test("anchors the drawer to every viewport edge and connects each timeline step", async ({ page }) => {
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
      { width: 834, height: 1112 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const panel = await openHistoricalActivity(page);
      await panel.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
      const panelBox = await panel.boundingBox();
      expect(panelBox).not.toBeNull();
      expect(panelBox!.x + panelBox!.width).toBeCloseTo(viewport.width, 0);
      expect(panelBox!.y).toBeCloseTo(0, 0);
      expect(panelBox!.height).toBeCloseTo(viewport.height, 0);
      expect(await panel.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");

      const first = panel.locator(".activity-event").nth(0);
      const second = panel.locator(".activity-event").nth(1);
      const [firstBox, firstCardBox, firstIconBox, secondCardBox, secondIconBox, connector] = await Promise.all([
        first.boundingBox(),
        first.locator(".activity-event-body, details").boundingBox(),
        first.locator(".activity-event-icon").boundingBox(),
        second.locator(".activity-event-body, details").boundingBox(),
        second.locator(".activity-event-icon").boundingBox(),
        first.evaluate((element) => {
          const style = getComputedStyle(element, "::before");
          return {
            left: Number.parseFloat(style.left),
            bottom: Number.parseFloat(style.bottom),
            height: Number.parseFloat(style.height),
            width: Number.parseFloat(style.width),
          };
        }),
      ]);
      expect(firstBox).not.toBeNull();
      expect(firstCardBox).not.toBeNull();
      expect(firstIconBox).not.toBeNull();
      expect(secondCardBox).not.toBeNull();
      expect(secondIconBox).not.toBeNull();
      expect(connector.width).toBeCloseTo(1, 0);
      const connectorX = firstBox!.x + connector.left + connector.width / 2;
      const firstIconX = firstIconBox!.x + firstIconBox!.width / 2;
      const secondIconX = secondIconBox!.x + secondIconBox!.width / 2;
      const connectorStartY = firstBox!.y + firstBox!.height - connector.bottom - connector.height;
      const connectorEndY = firstBox!.y + firstBox!.height - connector.bottom;
      const firstCardEndY = firstCardBox!.y + firstCardBox!.height;
      expect(connectorX).toBeCloseTo(secondIconX, 0);
      expect(connectorX).toBeCloseTo(firstIconX, 0);
      expect(connectorStartY).toBeCloseTo(firstCardEndY, 0);
      expect(connectorEndY).toBeCloseTo(secondCardBox!.y, 0);

      await panel.getByRole("button", { name: "Close Activity" }).click();
      await expect(panel).toBeHidden();
    }
  });

  test("replays after a forced disconnect without missing or duplicate events", async ({ page }) => {
    const activityRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/activity")) activityRequests.push(request.url());
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(chatPath);
    await page.getByRole("textbox", { name: "Message Hermes Agent CLI" }).fill("Validate the Activity reconnect path.");
    await page.getByRole("button", { name: "Send message" }).click();

    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Activity" });
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
