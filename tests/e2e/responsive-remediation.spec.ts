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
  await expectContained(page.locator(".workspace-policy-primary-action"), page.locator(".workspace-policy-admin"));
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

test("desktop density keeps primary work visible on a 14-inch laptop", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 650 });
  await page.goto("/?view=home");

  const sidebar = page.locator(".sidebar");
  const sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox?.width).toBeGreaterThanOrEqual(210);
  expect(sidebarBox?.width).toBeLessThanOrEqual(216);

  const navRows = await page.locator(".nav-button").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(navRows.length).toBeGreaterThanOrEqual(7);
  expect(Math.max(...navRows)).toBeLessThanOrEqual(36);

  const headingSize = await page.getByRole("heading", { name: "Workspace", exact: true }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(headingSize).toBeLessThanOrEqual(36);

  const createButton = page.getByRole("button", { name: "Create workspace" });
  const createButtonBox = await createButton.boundingBox();
  expect(createButtonBox?.height).toBeLessThanOrEqual(36);

  const cards = page.locator(".workspace-overview-card");
  expect(await cards.count()).toBeGreaterThanOrEqual(2);
  const secondCardBox = await cards.nth(1).boundingBox();
  expect(secondCardBox?.y).toBeLessThan(650);
  await expectNoDocumentOverflow(page);
});

test("account menu floats beyond the sidebar and settings subsections share one content anchor", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route("**/api/v1/admin/sso", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ connections: [] }),
  }));
  await page.setViewportSize({ width: 1470, height: 730 });
  await page.goto("/?view=home");

  const sidebar = page.locator(".sidebar");
  await page.locator(".sidebar-profile").click();
  const accountMenu = page.getByRole("group", { name: "Account menu" });
  await expect(accountMenu).toBeVisible();
  const [sidebarBox, menuBox] = await Promise.all([sidebar.boundingBox(), accountMenu.boundingBox()]);
  expect(menuBox?.width).toBeGreaterThanOrEqual(300);
  expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeGreaterThan((sidebarBox?.x ?? 0) + (sidebarBox?.width ?? 0) + 80);
  await expect(accountMenu.getByRole("button", { name: "My AI usage" }).locator("span")).toHaveCSS("white-space", "nowrap");
  expect(await accountMenu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/?view=settings&section=credentials");
  const credentialsBackX = (await page.getByRole("button", { name: "Back to Settings" }).boundingBox())?.x;
  const [mainBox, secondaryBox] = await Promise.all([
    page.locator(".main-content").boundingBox(),
    page.locator(".secondary-screen").boundingBox(),
  ]);
  await page.goto("/?view=settings&section=people");
  const peopleBackX = (await page.getByRole("button", { name: "Back to Settings" }).boundingBox())?.x;
  expect(credentialsBackX).toBeDefined();
  expect(peopleBackX).toBeDefined();
  expect(Math.abs((credentialsBackX ?? 0) - (peopleBackX ?? 0))).toBeLessThanOrEqual(1);
  const leftInset = (secondaryBox?.x ?? 0) - (mainBox?.x ?? 0);
  const rightInset = ((mainBox?.x ?? 0) + (mainBox?.width ?? 0)) - ((secondaryBox?.x ?? 0) + (secondaryBox?.width ?? 0));
  expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(1);
  expect(secondaryBox?.width).toBe(1440);
  await expectNoDocumentOverflow(page);
  expect(consoleErrors).toEqual([]);
});
