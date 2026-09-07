import { expect, test, type Page } from "@playwright/test";

const choose = async (page: Page, label: string, option: string) => {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
};

test("selects and saves only model and thinking options available to the workspace agent", async ({ page }) => {
  await page.goto("/?view=schedules");
  await page.getByRole("button", { name: "Create schedule" }).click();

  const dialog = page.getByRole("dialog", { name: "Create schedule" });
  await expect(dialog.getByRole("combobox", { name: "Model" })).toHaveText("Balanced · everyday work");
  await expect(dialog.getByRole("combobox", { name: "Thinking" })).toHaveCount(0);

  await choose(page, "Workspace", "Product");
  await choose(page, "Agent", "Claude Code");
  await choose(page, "Model", "Pro · highest capability");
  await choose(page, "Thinking", "High · deepest, highest latency and cost");

  await dialog.getByLabel("Name").fill("Weekly architecture review");
  await dialog.getByLabel("Prompt").fill("Review the architecture and recommend the next action.");
  const created = page.waitForRequest((request) => (
    request.method() === "POST" && request.url().endsWith("/api/v1/schedules")
  ));
  await dialog.getByRole("button", { name: "Create schedule" }).click();

  expect((await created).postDataJSON()).toMatchObject({
    agentCatalogId: "claude-cli",
    requestedServiceClass: "pro",
    reasoningEffort: "high",
  });
});
