import { expect, test } from "@playwright/test";

const fixtureUrl = `http://127.0.0.1:${Number(process.env.LEMMACOMPUTER_E2E_FIXTURE_PORT ?? 4_399)}`;

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${fixtureUrl}/__test/reset/chat`);
  expect(response.ok()).toBe(true);
});

test("browses, searches, downloads, and traces durable artifacts from their primary destination", async ({ page }) => {
  await page.goto("/?view=artifacts");

  await expect(page.getByRole("button", { name: "Artifacts" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Artifacts", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Application navigation" }).getByText("Saved files", { exact: true })).toHaveCount(0);

  const download = page.getByRole("link", { name: "Download project-handover.md" });
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute("href", /\/api\/v1\/chat\/artifacts\/artifact-1111.*revision=revision-1111/);
  await expect(page.getByText("Markdown", { exact: true })).toBeVisible();
  await expect(page.getByText("Project Workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  const searchRequest = page.waitForRequest((request) => request.method() === "GET"
    && request.url().includes("/v1/chat/artifacts?")
    && request.url().includes("query=project"));
  await page.getByPlaceholder("Search by filename").fill("project");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await searchRequest;
  await expect(download).toBeVisible();

  await page.getByPlaceholder("Search by filename").fill("missing");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No matching artifacts" })).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();

  await page.getByRole("button", { name: "Project handover" }).click();
  await expect(page).toHaveURL(/view=chat.*chat=fixture-session-archived/);
  await expect(page.getByText(/Saved from Project Workspace\. Choose an agent to continue/)).toBeVisible();
});
