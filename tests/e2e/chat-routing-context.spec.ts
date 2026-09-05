import { expect, test, type Page } from "@playwright/test";

const productWorkspaceId = "4d647d2f-7b42-438e-b1bb-4e91347eb58d";
const fixtureUrl = `http://127.0.0.1:${Number(process.env.LEMMACOMPUTER_E2E_FIXTURE_PORT ?? 4_399)}`;

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${fixtureUrl}/__test/reset/chat`);
  expect(response.ok()).toBe(true);
});

const choose = async (page: Page, label: string, option: string) => {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
};

test("uses the only ready published route as the Chat default", async ({ page }) => {
  await page.route("**/chat/agents", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        serviceClassOptions: [
          { value: "lite", available: true, reasonCode: "ready" },
          { value: "balanced", available: false, reasonCode: "route_unavailable" },
          { value: "pro", available: false, reasonCode: "route_unavailable" },
        ],
      },
    });
  });

  await page.goto("/?view=chat");
  await expect(page.getByRole("button", { name: /Hermes Agent CLI · Acme Workspace · Lite/ })).toBeVisible();
  await page.getByRole("button", { name: /Hermes Agent CLI · Acme Workspace · Lite/ }).click();
  await expect(page.getByRole("combobox", { name: "Choose model mode" })).toHaveText("Lite · lowest cost");
  await expect(page.getByText("Balanced does not have a ready route. Pro does not have a ready route.")).toBeVisible();
  await expect(page.getByText(/Lite does not have a ready route/)).toHaveCount(0);
});

test("routes the next turn through the selected workspace, agent, and stable model mode", async ({ page }) => {
  await page.goto("/?view=chat");

  let releaseProductAgents = () => {};
  const productAgentsReleased = new Promise<void>((resolve) => {
    releaseProductAgents = resolve;
  });
  await page.route(`**/workspaces/${productWorkspaceId}/chat/agents`, async (route) => {
    await productAgentsReleased;
    await route.continue();
  });

  await page.getByRole("button", { name: /Hermes Agent CLI · Acme Workspace · Balanced/ }).click();
  await expect(page.getByText("Lite is not allowed by your organization. Pro does not have a ready route.")).toBeVisible();
  await page.getByRole("combobox", { name: "Choose model mode" }).click();
  await expect(page.getByRole("option", { name: "Balanced · everyday work" })).toBeVisible();
  await expect(page.getByRole("option", { name: /Lite|Pro|Auto/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Hermes Agent CLI · Acme Workspace · Balanced/ }).click();
  await choose(page, "Choose workspace", "Product");
  await expect(page.getByRole("heading", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(page.locator(".chat-runtime-state")).toBeVisible();
  releaseProductAgents();
  await expect(page.getByRole("button", { name: /Hermes Agent CLI · Product · Balanced/ })).toBeVisible();

  await page.getByRole("button", { name: /Hermes Agent CLI · Product · Balanced/ }).click();
  await page.getByRole("combobox", { name: "Choose model mode" }).click();
  await expect(page.getByRole("option", { name: /Auto/ })).toHaveCount(0);
  await page.getByRole("option", { name: "Pro · highest capability" }).click();
  await page.getByRole("button", { name: /Hermes Agent CLI · Product · Pro/ }).click();
  await page.screenshot({ path: "test-results/chat-explicit-model-tiers.png", fullPage: true });

  const composer = page.getByPlaceholder("Message Hermes Agent CLI");
  await composer.fill("Line one\nLine two\nLine three\nLine four");
  const [composerBox, textareaBox, toolbarBox, actionsBox, contextBox, sendBox] = await Promise.all([
    page.locator(".chat-composer:visible").boundingBox(),
    composer.boundingBox(),
    page.locator(".companion-chat-composer-toolbar").boundingBox(),
    page.getByRole("button", { name: "Chat actions" }).boundingBox(),
    page.getByRole("button", { name: /Hermes Agent CLI · Product · Pro/ }).boundingBox(),
    page.getByRole("button", { name: "Send message" }).boundingBox(),
  ]);
  expect(composerBox).not.toBeNull();
  expect(textareaBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(contextBox).not.toBeNull();
  expect(sendBox).not.toBeNull();
  expect(textareaBox!.width).toBeGreaterThan(composerBox!.width - 36);
  expect(textareaBox!.y + textareaBox!.height).toBeLessThanOrEqual(toolbarBox!.y + 1);
  const controlBottoms = [actionsBox!, contextBox!, sendBox!].map((box) => box.y + box.height);
  expect(Math.max(...controlBottoms) - Math.min(...controlBottoms)).toBeLessThanOrEqual(1);
  expect(composerBox!.height).toBeGreaterThan(textareaBox!.height);

  await composer.fill("Prepare the launch analysis with the selected context.");
  const sent = page.waitForRequest((request) => (
    request.method() === "POST"
    && request.url().includes(`/workspaces/${productWorkspaceId}/chat/agents/hermes-claw/`)
    && request.url().endsWith("/messages")
  ));
  await page.getByRole("button", { name: "Send message" }).click();
  const request = await sent;
  const payload = request.postDataJSON();
  expect(payload.requestedServiceClass).toBe("pro");
  expect(payload.message.metadata.agentCatalogId).toBe("hermes-claw");

  await page.getByRole("button", { name: /Hermes Agent CLI · Product · Pro/ }).click();
  await expect(page.getByRole("combobox", { name: "Choose workspace" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Choose chat agent" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Choose model mode" })).toBeDisabled();
  await expect(page.getByText(/approved destinations/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Choose model mode" })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Choose model mode" })).toHaveText("Pro · highest capability");

  await page.reload();
  await expect(page.getByRole("button", { name: /Hermes Agent CLI · Product · Pro/ })).toBeVisible();
  await page.getByRole("button", { name: /Hermes Agent CLI · Product · Pro/ }).click();
  await expect(page.getByRole("combobox", { name: "Choose model mode" })).toHaveText("Pro · highest capability");

  await composer.fill("Continue with the same model mode.");
  const sentAgain = page.waitForRequest((nextRequest) => (
    nextRequest.method() === "POST"
    && nextRequest.url().includes(`/workspaces/${productWorkspaceId}/chat/agents/hermes-claw/`)
    && nextRequest.url().endsWith("/messages")
  ));
  await page.getByRole("button", { name: "Send message" }).click();
  expect((await sentAgain).postDataJSON().requestedServiceClass).toBe("pro");
});

test("keeps unqualified effort controls fail closed and binds a qualified effort to the conversation", async ({ page }) => {
  await page.goto("/?view=chat");
  await page.getByRole("button", { name: /Hermes Agent CLI · Acme Workspace · Balanced/ }).click();
  await choose(page, "Choose workspace", "Product");
  await expect(page.getByRole("button", { name: /Hermes Agent CLI · Product · Balanced/ })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Choose thinking effort" })).toHaveCount(0);

  await page.getByRole("button", { name: /Hermes Agent CLI · Product · Balanced/ }).click();
  await choose(page, "Choose chat agent", "Claude Code");
  await page.getByRole("button", { name: /Claude Code · Product · Balanced · Auto thinking/ }).click();
  await expect(page.getByRole("combobox", { name: "Choose thinking effort" })).toHaveText("Auto · follows your organization maximum");
  await choose(page, "Choose thinking effort", "High · deepest, highest latency and cost");

  const created = page.waitForRequest((request) => request.method() === "POST"
    && request.url().endsWith("/chat/agents/claude-cli/sessions"));
  const sent = page.waitForRequest((request) => request.method() === "POST"
    && request.url().includes("/chat/agents/claude-cli/sessions/")
    && request.url().endsWith("/messages"));
  await page.getByPlaceholder("Message Claude Code").fill("Qualify this architecture decision.");
  await page.getByRole("button", { name: "Send message" }).click();

  expect((await created).postDataJSON()).toMatchObject({
    requestedServiceClass: "balanced",
    reasoningEffort: "high",
  });
  expect((await sent).postDataJSON()).toMatchObject({
    requestedServiceClass: "balanced",
    reasoningEffort: "high",
  });
  await page.getByRole("button", { name: /Claude Code · Product · Balanced · High thinking/ }).click();
  await expect(page.getByRole("combobox", { name: "Choose thinking effort" })).toBeDisabled();
});
