import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.RESPONSIVE_AUDIT_BASE_URL ?? "http://127.0.0.1:24371";
const outputDirectory = path.resolve("docs/reports/assets/responsive-ux-audit");

const desktopCompact = { width: 1366, height: 650 };
const viewports = {
  compact: desktopCompact,
  retina: { width: 1470, height: 730 },
  laptop: { width: 1440, height: 800 },
  monitor: { width: 1920, height: 900 },
  narrow: { width: 720, height: 900 },
  mobile: { width: 390, height: 844 },
};

const captures = [
  ["01-my-workspaces-1366x650.png", "/?view=home", viewports.compact],
  ["02-organization-workspaces-1366x650.png", "/?view=home&section=organization", viewports.compact],
  ["03-workspace-policies-1366x650.png", "/?view=home&section=policies", viewports.compact],
  ["04-schedules-1366x650.png", "/?view=schedules", viewports.compact],
  ["05-sites-1366x650.png", "/?view=sites", viewports.compact],
  ["06-connectors-1366x650.png", "/?view=connections", viewports.compact],
  ["07-chat-1366x650.png", "/?view=chat&chat=fixture-session-1", viewports.compact],
  ["08-firewall-1366x650.png", "/?view=firewall", viewports.compact],
  ["09-settings-1366x650.png", "/?view=settings", viewports.compact],
  ["10-people-access-1366x650.png", "/?view=settings&section=people", viewports.compact],
  ["11-ai-overview-1366x650.png", "/?view=ai-control-plane", viewports.compact],
  ["12-ai-models-providers-1366x650.png", "/?view=ai-control-plane&section=models-providers", viewports.compact],
  ["13-ai-spend-1366x650.png", "/?view=ai-control-plane&section=spend", viewports.compact],
  ["14-ai-routing-1366x650.png", "/?view=ai-control-plane&section=model-routes", viewports.compact],
  ["15-organization-workspaces-1470x730.png", "/?view=home&section=organization", viewports.retina],
  ["16-people-access-1440x800.png", "/?view=settings&section=people", viewports.laptop],
  ["17-ai-routing-1920x900.png", "/?view=ai-control-plane&section=model-routes", viewports.monitor],
  ["18-organization-workspaces-720x900.png", "/?view=home&section=organization", viewports.narrow],
  ["19-workspace-policies-720x900.png", "/?view=home&section=policies", viewports.narrow],
  ["20-connectors-720x900.png", "/?view=connections", viewports.narrow],
  ["21-people-access-720x900.png", "/?view=settings&section=people", viewports.narrow],
  ["22-ai-spend-720x900.png", "/?view=ai-control-plane&section=spend", viewports.narrow],
  ["23-people-access-390x844.png", "/?view=settings&section=people", viewports.mobile],
  ["24-ai-routing-390x844.png", "/?view=ai-control-plane&section=model-routes", viewports.mobile],
  ["25-connectors-390x844.png", "/?view=connections", viewports.mobile],
  ["42-my-workspaces-1470x730.png", "/?view=home", viewports.retina],
  ["43-my-workspaces-1440x800.png", "/?view=home", viewports.laptop],
  ["44-my-workspaces-1920x900.png", "/?view=home", viewports.monitor],
  ["45-my-workspaces-720x900.png", "/?view=home", viewports.narrow],
  ["46-my-workspaces-390x844.png", "/?view=home", viewports.mobile],
  ["47-chat-1470x730.png", "/?view=chat&chat=fixture-session-1", viewports.retina],
  ["48-chat-1440x800.png", "/?view=chat&chat=fixture-session-1", viewports.laptop],
  ["49-chat-1920x900.png", "/?view=chat&chat=fixture-session-1", viewports.monitor],
  ["50-chat-720x900.png", "/?view=chat&chat=fixture-session-1", viewports.narrow],
  ["51-chat-390x844.png", "/?view=chat&chat=fixture-session-1", viewports.mobile],
];

const waitForStableProduct = async (page) => {
  await page.waitForFunction(() => !document.body.textContent?.includes("Checking your work account"));
  try {
    await page.locator("#primary-navigation").waitFor({ state: "attached", timeout: 15_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({ url: location.href, body: document.body.textContent?.trim().slice(0, 1_000) ?? "" }));
    throw new Error(`Product shell did not load: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  await page.waitForTimeout(1_000);
};

const measure = async (page, name, route, viewport, state = "default") => page.evaluate(({ captureName, captureRoute, captureViewport, captureState }) => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const rect = (element) => {
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom };
  };
  const primaryActions = [...document.querySelectorAll("button.primary-button")].filter(visible).map((element) => ({
    label: element.textContent?.trim() ?? "",
    rect: rect(element),
    fullyVisible: (() => {
      const value = element.getBoundingClientRect();
      return value.left >= 0 && value.top >= 0 && value.right <= window.innerWidth && value.bottom <= window.innerHeight;
    })(),
  }));
  const outOfBounds = [...document.querySelectorAll("body *")].filter((element) => {
    if (!visible(element)) return false;
    const value = element.getBoundingClientRect();
    return value.left < -1 || value.right > window.innerWidth + 1;
  }).slice(0, 30).map((element) => ({
    tag: element.tagName.toLowerCase(),
    className: typeof element.className === "string" ? element.className : "",
    label: element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ").slice(0, 140) || "",
    rect: rect(element),
    overflowX: getComputedStyle(element).overflowX,
  }));
  const clippedInteractives = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')].filter(visible).flatMap((element) => {
    const elementRect = element.getBoundingClientRect();
    let ancestor = element.parentElement;
    let hasHorizontalScrollOwner = false;
    let escapesOuterClipping = getComputedStyle(element).position === "fixed";
    while (ancestor && ancestor !== document.body) {
      const style = getComputedStyle(ancestor);
      if (style.position === "fixed") escapesOuterClipping = true;
      if ([style.overflowX, style.overflow].some((value) => ["auto", "scroll"].includes(value)) && ancestor.scrollWidth > ancestor.clientWidth + 1) {
        hasHorizontalScrollOwner = true;
      }
      if (!escapesOuterClipping && [style.overflowX, style.overflow].some((value) => ["hidden", "clip"].includes(value))) {
        const ancestorRect = ancestor.getBoundingClientRect();
        if (elementRect.left < ancestorRect.left - 1 || elementRect.right > ancestorRect.right + 1) {
          if (hasHorizontalScrollOwner) return [];
          return [{
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === "string" ? element.className : "",
            label: element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ").slice(0, 140) || "",
            rect: rect(element),
            clippedBy: {
              tag: ancestor.tagName.toLowerCase(),
              className: typeof ancestor.className === "string" ? ancestor.className : "",
              rect: rect(ancestor),
              overflowX: style.overflowX,
            },
          }];
        }
      }
      ancestor = ancestor.parentElement;
    }
    return [];
  }).slice(0, 30);
  const scrollContainers = [document.documentElement, document.body, ...document.querySelectorAll("body *")].filter((element) => {
    const style = getComputedStyle(element);
    return visible(element) && (
      element.scrollWidth > element.clientWidth + 1 ||
      element.scrollHeight > element.clientHeight + 1
    ) && [style.overflowX, style.overflowY].some((value) => ["auto", "scroll"].includes(value));
  }).slice(0, 30).map((element) => ({
    tag: element.tagName.toLowerCase(),
    className: typeof element.className === "string" ? element.className : "",
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
    overflowX: getComputedStyle(element).overflowX,
    overflowY: getComputedStyle(element).overflowY,
  }));
  return {
    name: captureName,
    route: captureRoute,
    viewport: captureViewport,
    state: captureState,
    title: document.title,
    heading: document.querySelector("h1")?.textContent?.trim() ?? document.querySelector("h2")?.textContent?.trim() ?? "",
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentScrollHeight: document.documentElement.scrollHeight,
    bodyScrollWidth: document.body.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
    scrollPosition: {
      x: window.scrollX,
      y: window.scrollY,
      visualViewportOffsetLeft: window.visualViewport?.offsetLeft ?? 0,
      visualViewportOffsetTop: window.visualViewport?.offsetTop ?? 0,
    },
    activeElement: (() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        label: element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ").slice(0, 140) || element.getAttribute("placeholder") || "",
        rect: rect(element),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
      };
    })(),
    sidebar: rect(document.querySelector("#primary-navigation")),
    main: rect(document.querySelector("main")),
    dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).map((element) => ({
      label: element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || "",
      rect: rect(element),
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    })),
    primaryActions,
    outOfBounds,
    clippedInteractives,
    scrollContainers,
  };
}, { captureName: name, captureRoute: route, captureViewport: viewport, captureState: state });

const screenshot = async (page, name) => {
  await page.screenshot({ path: path.join(outputDirectory, name) });
};

const unauthenticatedResponse = {
  status: 401,
  contentType: "application/json",
  body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Sign in required." } }),
};

const configureUnauthenticatedContext = async (context) => {
  await context.route("**/api/v1/auth/session", (route) => route.fulfill(unauthenticatedResponse));
  await context.route("**/api/v1/auth/product-session", (route) => route.fulfill(unauthenticatedResponse));
  await context.route("**/api/v1/auth/customer/get-session", (route) => route.fulfill(unauthenticatedResponse));
  await context.route("**/api/v1/auth/customer-capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ passkey: true, companySso: true, socialProviders: ["google", "microsoft"] }),
  }));
};

const visit = async (page, route, viewport) => {
  await page.goto("about:blank");
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded" });
  await waitForStableProduct(page);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
  await page.waitForTimeout(50);
};

const focusTrail = async (page, route, viewport, count = 24) => {
  await visit(page, route, viewport);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");
    entries.push(await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const value = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        label: element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ").slice(0, 120) || element.getAttribute("placeholder") || "",
        rect: { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom },
        fullyVisible: value.left >= 0 && value.top >= 0 && value.right <= window.innerWidth && value.bottom <= window.innerHeight,
        focusIndicator: {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          outlineOffset: style.outlineOffset,
        },
      };
    }));
  }
  return { route, viewport, entries };
};

const focusNamedControl = async (page, route, viewport, expectedLabel, screenshotName) => {
  await visit(page, route, viewport);
  for (let index = 0; index < 120; index += 1) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return "";
      return element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ") || element.getAttribute("placeholder") || "";
    });
    if (label === expectedLabel) {
      await screenshot(page, screenshotName);
      return measure(page, screenshotName, route, viewport, `keyboard-focus-${expectedLabel.toLowerCase().replace(/\s+/g, "-")}`);
    }
  }
  throw new Error(`Keyboard traversal did not reach ${expectedLabel} on ${route}`);
};

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ colorScheme: "light", locale: "en-US", timezoneId: "Asia/Singapore" });
const page = await context.newPage();
page.on("pageerror", (error) => process.stderr.write(`pageerror: ${error.stack ?? error.message}\n`));
const measurements = [];

for (const [name, route, viewport] of captures) {
  const captureContext = await browser.newContext({ colorScheme: "light", locale: "en-US", timezoneId: "Asia/Singapore" });
  const capturePage = await captureContext.newPage();
  capturePage.on("pageerror", (error) => process.stderr.write(`pageerror: ${error.stack ?? error.message}\n`));
  await visit(capturePage, route, viewport);
  await screenshot(capturePage, name);
  measurements.push(await measure(capturePage, name, route, viewport));
  await captureContext.close();
}

await visit(page, "/?view=connections", viewports.mobile);
await page.getByRole("button", { name: "Open navigation" }).focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
await screenshot(page, "28-mobile-navigation-390x844.png");
measurements.push(await measure(page, "28-mobile-navigation-390x844.png", "/?view=connections", viewports.mobile, "navigation-open-keyboard"));

await visit(page, "/?view=home&section=policies", viewports.narrow);
await page.getByRole("button", { name: "Set organization policy" }).focus();
await page.keyboard.press("Enter");
await page.getByRole("dialog").waitFor();
await screenshot(page, "29-organization-policy-dialog-720x900.png");
measurements.push(await measure(page, "29-organization-policy-dialog-720x900.png", "/?view=home&section=policies", viewports.narrow, "organization-policy-dialog-open"));

await visit(page, "/?view=settings&section=people", viewports.mobile);
await page.getByRole("button", { name: "Invite person" }).focus();
await page.keyboard.press("Enter");
await page.getByRole("dialog").waitFor();
await screenshot(page, "30-invite-dialog-390x844.png");
measurements.push(await measure(page, "30-invite-dialog-390x844.png", "/?view=settings&section=people", viewports.mobile, "invite-dialog-open"));

await visit(page, "/?view=home&section=organization", viewports.mobile);
await page.getByRole("button", { name: "Restart", exact: true }).first().focus();
await page.keyboard.press("Enter");
await page.getByRole("dialog").waitFor();
await screenshot(page, "31-restart-dialog-390x844.png");
measurements.push(await measure(page, "31-restart-dialog-390x844.png", "/?view=home&section=organization", viewports.mobile, "restart-dialog-open"));

for (const [name, viewport] of [
  ["52-activity-1366x650.png", viewports.compact],
  ["53-activity-390x844.png", viewports.mobile],
]) {
  await visit(page, "/?view=chat&chat=fixture-session-1", viewport);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const activityDialog = page.getByRole("dialog", { name: "Activity" });
  await activityDialog.waitFor();
  await activityDialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  await screenshot(page, name);
  measurements.push(await measure(page, name, "/?view=chat&chat=fixture-session-1", viewport, "activity-open"));
}

const zoomContext = await browser.newContext({
  colorScheme: "light",
  locale: "en-US",
  timezoneId: "Asia/Singapore",
  viewport: { width: desktopCompact.width / 2, height: desktopCompact.height / 2 },
  deviceScaleFactor: 2,
});
const zoomPage = await zoomContext.newPage();
await zoomPage.goto(`${baseUrl}/?view=home&section=organization`, { waitUntil: "domcontentloaded" });
await waitForStableProduct(zoomPage);
await screenshot(zoomPage, "32-organization-workspaces-200-percent-zoom.png");
measurements.push({
  ...(await measure(zoomPage, "32-organization-workspaces-200-percent-zoom.png", "/?view=home&section=organization", { width: 683, height: 325 }, "200-percent-css-pixel-equivalent")),
  physicalViewport: desktopCompact,
  effectiveCssViewport: { width: 683, height: 325 },
  emulationMethod: "Half-size CSS viewport rendered at deviceScaleFactor 2",
});
await zoomContext.close();

const authContext = await browser.newContext({ colorScheme: "light", locale: "en-US", timezoneId: "Asia/Singapore" });
await configureUnauthenticatedContext(authContext);
const authPage = await authContext.newPage();
for (const [name, viewport] of [
  ["33-sign-in-1366x650.png", viewports.compact],
  ["34-sign-in-390x844.png", viewports.mobile],
]) {
  await authPage.setViewportSize(viewport);
  await authPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await authPage.getByRole("heading", { name: "Sign in to LemmaComputer" }).waitFor();
  await authPage.waitForTimeout(250);
  await screenshot(authPage, name);
  measurements.push(await measure(authPage, name, "/", viewport, "unauthenticated-sign-in"));
}
for (const [name, viewport] of [
  ["54-sign-up-1366x650.png", viewports.compact],
  ["55-sign-up-390x844.png", viewports.mobile],
]) {
  await authPage.setViewportSize(viewport);
  await authPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await authPage.getByRole("button", { name: "Create account" }).click();
  await authPage.getByRole("heading", { name: "Create your account" }).waitFor();
  await authPage.waitForTimeout(250);
  await screenshot(authPage, name);
  measurements.push(await measure(authPage, name, "/", viewport, "unauthenticated-sign-up"));
}
await authContext.close();

await visit(page, "/?view=settings&section=people", viewports.narrow);
await page.getByRole("button", { name: "Sign out sessions", exact: true }).first().scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
await screenshot(page, "35-people-actions-clipped-720x900.png");
measurements.push(await measure(page, "35-people-actions-clipped-720x900.png", "/?view=settings&section=people", viewports.narrow, "member-actions-in-view"));

await visit(page, "/?view=ai-control-plane&section=model-routes", viewports.mobile);
await page.locator(".route-table-scroll").scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
await screenshot(page, "38-ai-routing-table-overflow-390x844.png");
measurements.push(await measure(page, "38-ai-routing-table-overflow-390x844.png", "/?view=ai-control-plane&section=model-routes", viewports.mobile, "route-table-in-view"));

const keyboard = [
  await focusTrail(page, "/?view=connections", viewports.compact, 40),
  await focusTrail(page, "/?view=home&section=policies", viewports.compact, 40),
  await focusTrail(page, "/?view=settings&section=people", viewports.narrow),
  await focusTrail(page, "/?view=ai-control-plane&section=spend", viewports.narrow),
  await focusTrail(page, "/?view=ai-control-plane&section=model-routes", viewports.compact, 50),
];

measurements.push(await focusNamedControl(page, "/?view=settings&section=people", viewports.narrow, "Sign out sessions", "36-people-sign-out-sessions-focus-720x900.png"));
measurements.push(await focusNamedControl(page, "/?view=connections", viewports.mobile, "Open navigation", "37-connections-navigation-focus-390x844.png"));
measurements.push(await focusNamedControl(page, "/?view=home&section=policies", viewports.compact, "Organization workspaces", "39-workspace-tab-focus-1366x650.png"));
measurements.push(await focusNamedControl(page, "/?view=ai-control-plane&section=spend", viewports.narrow, "Spend from date", "40-ai-spend-date-focus-720x900.png"));
measurements.push(await focusNamedControl(page, "/?view=home&section=policies", viewports.narrow, "Assign policy", "41-policy-assign-focus-720x900.png"));

await writeFile(path.join(outputDirectory, "measurements.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, measurements, keyboard }, null, 2)}\n`);
await browser.close();
