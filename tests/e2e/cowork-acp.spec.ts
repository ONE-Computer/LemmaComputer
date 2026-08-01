import { expect, test } from "@playwright/test";

test("ephemeral Cowork streams chat, exposes E2B VCR frames, and creates PPTX", async ({ page }) => {
  await page.goto("/?view=cowork");
  await page.getByRole("button", { name: "Cowork", exact: true }).click();
  await page.getByRole("button", { name: "Start ephemeral sandbox" }).click();

  await expect(page.getByText("Ephemeral E2B sandbox · task-scoped")).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message OpenCode CLI" });
  await composer.fill("Draft an executive update using the ephemeral sandbox.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("I’ll check the workspace context first, then summarize what I can do.")).toBeVisible();

  await expect(page.getByRole("button", { name: "Event 4" })).toBeVisible();
  await page.getByRole("button", { name: "Event 4" }).click();
  await expect(page.getByAltText("browser frame at event 4")).toBeVisible();
  await page.getByRole("button", { name: "Previous VCR frame" }).click();
  await expect(page.getByAltText("browser frame at event 3")).toBeVisible();
  await page.getByRole("button", { name: "Next VCR frame" }).click();
  await expect(page.getByAltText("browser frame at event 4")).toBeVisible();
  await page.getByRole("button", { name: "Event 2" }).click();
  await page.getByRole("button", { name: "Play VCR replay" }).click();
  await expect(page.getByRole("button", { name: "Pause VCR replay" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to live" })).toBeVisible();
  await page.getByRole("button", { name: "Jump to live" }).click();
  await expect(page.getByText("Following live evidence")).toBeVisible();

  await page.getByRole("button", { name: "Generate PowerPoint" }).click();
  const artifact = page.getByRole("link", { name: /Editable PowerPoint/ });
  await expect(artifact).toBeVisible();
  await expect(artifact).toHaveAttribute("href", /presentations\//);
});

test("ephemeral Cowork can switch the same governed flow to Codex ACP", async ({ page }) => {
  await page.goto("/?view=cowork");
  await page.getByRole("button", { name: "Cowork", exact: true }).click();
  await page.getByRole("button", { name: "Start ephemeral sandbox" }).click();
  await expect(page.getByRole("combobox", { name: "Choose chat agent" })).toBeVisible();
  await page.getByRole("combobox", { name: "Choose chat agent" }).click();
  await page.getByRole("option", { name: "Codex CLI" }).click();
  const composer = page.getByRole("textbox", { name: "Message Codex CLI" });
  await composer.fill("Use Codex ACP to validate this ephemeral task.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("I’ll check the workspace context first, then summarize what I can do.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Event 4" })).toBeVisible();
});
