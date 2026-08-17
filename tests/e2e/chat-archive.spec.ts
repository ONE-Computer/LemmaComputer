import { expect, test } from "@playwright/test";

const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
const fixtureUrl = `http://127.0.0.1:${Number(process.env.LEMMACOMPUTER_E2E_FIXTURE_PORT ?? 4_399)}`;

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${fixtureUrl}/__test/reset/chat`);
  expect(response.ok()).toBe(true);
});

test("opens chats and artifacts from a deleted workspace and forks continuation into the current workspace", async ({ page }) => {
  await page.goto("/?view=chat");

  await expect(page.getByRole("button", { name: /Project handover.*Saved from Project Workspace/ })).toBeVisible();
  await expect(page.getByText("Saved files", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /Project handover/ }).click();
  await expect(page.getByText("The project handover is saved.")).toBeVisible();
  await expect(page.getByRole("link", { name: "project-handover.md", exact: true })).toBeVisible();
  await expect(page.getByText(/Saved from Project Workspace\. Choose an agent to continue/)).toBeVisible();
  await expect(page.locator("#chat-message-fixture-session-archived")).toBeDisabled();

  const forkRequest = page.waitForRequest((request) => request.method() === "POST"
    && request.url().includes(`/workspaces/${workspaceId}/chat/sessions/fixture-session-archived/forks`));
  await page.getByRole("button", { name: "Continue with Hermes Agent CLI" }).click();
  expect((await forkRequest).postDataJSON()).toMatchObject({
    fromMessageId: "fixture-archived-assistant-message",
    agentCatalogId: "hermes-claw",
  });

  await expect(page.getByText(/Saved from Project Workspace\. Choose an agent to continue/)).toBeHidden();
  await expect(page.locator('textarea[id^="chat-message-fixture-session-fork-"]')).toBeVisible();
  await expect(page.locator('textarea[id^="chat-message-fixture-session-fork-"]')).toBeEnabled();
});
