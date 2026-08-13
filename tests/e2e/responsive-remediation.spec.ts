import { expect, test, type Locator, type Page } from "@playwright/test";

const expectNoDocumentOverflow = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({
    clientWidth: page.viewportSize()?.width,
    scrollWidth: page.viewportSize()?.width,
  });
};

const expectContained = async (controls: Locator, container: Locator) => {
  const containerBox = await container.boundingBox();
  expect(containerBox).not.toBeNull();
  const boxes = await controls.evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right };
  }));
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(containerBox!.x - 1);
    expect(box.right).toBeLessThanOrEqual(containerBox!.x + containerBox!.width + 1);
  }
};

test("administrator row actions reflow inside their owning cards", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 650 });
  await page.goto("/?view=home&section=organization");
  await expectContained(page.locator(".member-workspace-actions button"), page.locator(".member-workspace-table"));

  await page.goto("/?view=firewall");
  await expectContained(page.getByRole("button", { name: "Manage group" }), page.locator(".firewall-security-groups"));

  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/?view=settings&section=people");
  const memberSection = page.getByRole("region", { name: "Organization members" });
  await expectContained(memberSection.locator(".admin-user-actions button"), memberSection);

  await page.goto("/?view=home&section=policies");
  await expectContained(page.locator(".workspace-policy-member-actions button"), page.locator(".workspace-policy-members"));
  const memberCells = page.locator(".workspace-policy-member-row").first().locator("[data-label]");
  const cellBoxes = await memberCells.evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { label: element.getAttribute("data-label"), left: bounds.left, right: bounds.right };
  }));
  const applied = cellBoxes.find((cell) => cell.label === "Applied policy");
  const assignment = cellBoxes.find((cell) => cell.label === "Assignment status");
  expect(applied?.right).toBeLessThanOrEqual(assignment?.left ?? 0);
  await expectNoDocumentOverflow(page);
});

test("mobile dense data stays inside explicit scroll owners and exposes every AI destination", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=ai-control-plane&section=model-routes");
  await expectNoDocumentOverflow(page);

  const routeScroller = page.locator(".route-table-scroll");
  await expect.poll(() => routeScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await routeScroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => routeScroller.evaluate((element) => element.scrollLeft > 0)).toBe(true);

  for (const label of ["Overview", "Models & providers", "Model routes", "Pricing", "Teams & budgets", "Data health"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeInViewport();
  }
});

test("Workspace focus and Chat composer remain visible at responsive breakpoints", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 650 });
  await page.goto("/?view=home&section=policies");
  const workspaceTab = page.getByRole("button", { name: "Organization workspaces" });
  await workspaceTab.focus();
  await expect.poll(() => workspaceTab.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  })).toEqual({ style: "solid", width: 2 });

  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/?view=chat&chat=fixture-session-1");
  const composer = page.locator(".chat-composer:visible");
  await expect(composer).toBeVisible();
  await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(900);
  await expectNoDocumentOverflow(page);
});
