import { expect, test } from "@playwright/test";

test("administrator filters spend, drills Team to user to 201 tasks, explains cost, and exports the snapshot", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=spend");

  await expect(page.getByRole("heading", { name: "Organization spend" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Some cost data is unavailable");
  await expect(page.getByRole("status")).toContainText("1 unknown-price");
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Previous-period trend" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spend dimensions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Resolved models" })).toBeVisible();
  await expect(page.getByText("anthropic / claude-opus")).toBeVisible();
  await expect(page.getByText(/8,040 cache read/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Export JSON" })).toBeInViewport();

  await page.getByRole("button", { name: /Finance/ }).click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await page.locator("section").filter({ has: page.getByRole("heading", { name: "Users" }) }).getByRole("button", { name: /Mike Sun/ }).click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(page.getByText("200 of 201")).toBeVisible();
  await page.getByRole("button", { name: "Load more tasks" }).click();
  await expect(page.getByText("quarterly-analysis-201", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /quarterly-analysis-001/ }).click();
  await expect(page.getByRole("heading", { name: "quarterly-analysis-001" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Safe cost drivers" })).toBeVisible();
  await expect(page.getByText("Attachments", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Corrected ledger facts included");
  await expect(page.getByRole("heading", { name: "Attempts" })).toBeVisible();
  await expect(page.getByText(/pinned_catalogue 2026-07/)).toBeVisible();
  await expect(page.getByText(/40 cache read/)).toBeVisible();
  await expect(page.getByText(/8 cache write/)).toBeVisible();
  await expect(page.getByText(/prompt|hidden reasoning|secret/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Back to spend" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export CSV" }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toBe("onecomputer-ai-spend.csv");

  await page.getByLabel("Spend from date").fill("2020-01-01");
  await page.getByLabel("Spend to date").fill("2020-02-01");
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(page.getByRole("heading", { name: "No usage recorded" })).toBeVisible();
  await expect(page.getByText(/true empty state/i)).toBeVisible();
});
