import { connectorCatalog } from "../../apps/control-api/src/connector-catalog.js";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const connectedConnectorId = "notion";
// Review the fully configured catalog so cards gated on provider OAuth
// applications, such as Gmail and GitHub, stay covered by the icon and layout
// checks.
const catalog = connectorCatalog("acme", "http://127.0.0.1:4399").map((connector) => ({
  ...connector,
  available: true,
  state: connector.id === connectedConnectorId ? "connected" : "disconnected",
  connectedAt: connector.id === connectedConnectorId ? "2026-08-15T00:00:00.000Z" : null,
  expiresAt: null,
  account: null,
  enabled: true,
  membersCanManage: true,
  canManageConnection: true,
  canAdministerConnector: true,
  accessPolicyVersion: 1,
  accessPolicyUpdatedAt: "2026-08-15T00:00:00.000Z",
  activation: { readiness: "ready", action: "connect", message: "This approved service is ready to connect." },
}));

const screenshotSections = async (page: Page, testInfo: TestInfo, prefix: string) => {
  const sections = page.locator(".connector-catalog-section");
  for (let index = 0; index < await sections.count(); index += 1) {
    const section = sections.nth(index);
    const heading = (await section.getByRole("heading", { level: 2 }).textContent()) ?? `category-${index + 1}`;
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: testInfo.outputPath(`${prefix}-${heading.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.png`) });
  }
};

test("the complete built-in connector catalog renders at desktop and mobile widths", async ({ page }, testInfo) => {
  await page.route("**/api/v1/connections", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: catalog }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connectors" }).click();
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.locator(".skip-link").evaluate((element) => (element as HTMLElement).style.setProperty("visibility", "hidden", "important"));
  await expect(page.locator(".connector-catalog-card")).toHaveCount(catalog.length);
  const manage = page.locator(".connector-catalog-card.connected").getByRole("button", { name: "Manage" });
  await expect(manage).toHaveCount(1);
  await expect(manage).toHaveCSS("justify-content", "center");
  await expect(manage.locator("svg")).toHaveCount(0);

  const renderedIcons = await page.locator(".connector-catalog-card").evaluateAll((cards) => cards.map((card) => {
    const image = card.querySelector(".connector-mark img") as HTMLImageElement | null;
    return {
      name: card.querySelector("h3")?.textContent,
      source: image?.getAttribute("src") ?? null,
      loaded: image ? image.naturalWidth > 0 && image.naturalHeight > 0 : false,
    };
  }));
  expect(renderedIcons).toHaveLength(catalog.length);
  expect(renderedIcons.every(({ source, loaded }) => source && loaded)).toBe(true);
  expect(renderedIcons).toEqual(expect.arrayContaining([
    { name: "monday.com", source: "/connector-icons/monday.svg", loaded: true },
    { name: "Calendly", source: "/connector-icons/calendly.svg", loaded: true },
  ]));
  await testInfo.attach("rendered-icon-inventory", { body: JSON.stringify(renderedIcons, null, 2), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("desktop-full.png"), fullPage: true });
  await screenshotSections(page, testInfo, "desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(manage).toHaveCSS("justify-content", "center");
  await expect(manage.locator("svg")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("mobile-full.png"), fullPage: true });
  await screenshotSections(page, testInfo, "mobile");
});
