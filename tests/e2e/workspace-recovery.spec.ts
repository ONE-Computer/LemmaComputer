import { expect, test } from "@playwright/test";

test("keeps a retryable workspace start in Preparing instead of Needs attention", async ({ page }) => {
  let attempts = 0;
  const idempotencyKeys: string[] = [];
  await page.route("**/api/v1/workspaces", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    attempts += 1;
    idempotencyKeys.push((await route.request().allHeaders())["idempotency-key"] ?? "");
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "DOCKER_UNAVAILABLE", message: "Docker is reconciling workspace networking", retryable: true } }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "3c536c1f-6a31-427d-af8f-dbb0c63f8d70",
        grantId: "sandbox-research",
        state: "provisioning",
        readiness: { identity: "checking", network: "checking", models: "checking", tools: "checking" },
        applications: ["google-chrome"],
        agents: [{ id: "hermes-desktop", displayName: "Hermes Agent Desktop", clientVersion: "0.17.0", agentId: "agent-alex:research", state: "starting" }],
        policyAssignment: { version: 4, hash: "a".repeat(64) },
        profile: {
          id: "disposable-open-v1",
          client: "LemmaComputer open workspace",
          clientVersion: "disposable-open-v1",
          modelAlias: "onecomputer-openai",
          executionMode: "disposable-open",
          egressMode: "full-web",
          persistence: "persistent-home",
          network: "gateway-only",
        },
      }),
    });
  });

  await page.goto("/");
  const card = page.getByRole("article", { name: "Research" });
  await expect(card).toContainText("Stopped");
  await card.getByRole("button", { name: "Start workspace" }).click();

  await expect.poll(() => attempts).toBe(2);
  expect(idempotencyKeys[0]).toBeTruthy();
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  await expect(card).toContainText("Preparing");
  await expect(page.getByText("Needs attention", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("workspace model route tiers persist after save and refresh", async ({ page }) => {
  await page.goto("/");
  const workspace = page.getByRole("article", { name: "Research" });
  await workspace.getByRole("button", { name: "Manage configuration" }).click();

  await expect(page.getByRole("heading", { name: "Default model mode" })).toBeVisible();
  await expect(page.getByText("Choose the default quality and cost mode for this workspace. You can choose a different mode for each conversation in Chat.")).toBeVisible();
  const modelRoutes = page.getByRole("radiogroup", { name: "Default model mode" });
  await expect(modelRoutes.getByRole("radio")).toHaveCount(4);
  await modelRoutes.getByText("Pro", { exact: true }).click();
  await expect(modelRoutes.getByRole("radio", { name: /^Pro/ })).toBeChecked();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByText("Workspace configuration saved. Restart the workspace to apply changes.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Restart required" })).toHaveCount(0);

  await page.reload();
  await page.getByRole("article", { name: "Research" }).getByRole("button", { name: "Manage configuration" }).click();
  await expect(page.getByRole("radiogroup", { name: "Default model mode" }).getByRole("radio", { name: /^Pro/ })).toBeChecked();
});
