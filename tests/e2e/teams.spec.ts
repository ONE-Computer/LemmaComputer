import { expect, test } from "@playwright/test";

test("administrator creates a Team, assigns membership, selects the default, and archives it", async ({ page }) => {
  await page.goto("/?view=ai-control-plane&section=teams-budgets");

  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
  await page.getByRole("button", { name: "Add Team" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create Team" });
  await createDialog.getByLabel("Team name").fill("Customer Success");
  await createDialog.getByLabel("Description").fill("Customer-facing AI spend");
  await createDialog.getByLabel("Cost-center code (optional)").fill("CC-220");
  await createDialog.getByRole("button", { name: "Create Team" }).click();

  const teamRow = page.locator(".admin-team-list article").filter({ hasText: "Customer Success" });
  await expect(teamRow).toContainText("CC-220");
  await teamRow.getByRole("button", { name: "Manage" }).click();

  const manageDialog = page.getByRole("dialog", { name: "Manage Customer Success" });
  await manageDialog.getByRole("combobox", { name: "Team member" }).click();
  await page.getByRole("option", { name: "METECH · hello@metech.dev" }).click();
  await manageDialog.getByRole("button", { name: "Assign member" }).click();
  await expect(teamRow).toContainText("1 active member");
  await expect(manageDialog.getByRole("region", { name: "Team membership history" })).toContainText("METECH");

  await manageDialog.getByRole("button", { name: "Make default" }).click();
  await expect(page.getByText("The default spending Team was updated.")).toBeVisible();
  await expect(manageDialog.getByText("Current default")).toBeVisible();

  await manageDialog.getByRole("combobox", { name: "Team member" }).click();
  await page.getByRole("option", { name: "Mike Sun · mike@metech.dev" }).click();
  await manageDialog.getByRole("button", { name: "Assign member" }).click();
  const mikeMembership = manageDialog.locator(".team-membership-list article").filter({ hasText: "Mike Sun" });
  await expect(mikeMembership).toContainText("Active since");
  await mikeMembership.getByRole("button", { name: "Remove" }).click();
  await expect(mikeMembership).toContainText("Ended");
  await expect(mikeMembership.getByRole("button", { name: "Remove" })).toHaveCount(0);

  await manageDialog.getByRole("button", { name: "Archive Team" }).click();
  const confirmation = page.getByRole("dialog", { name: "Archive Customer Success?" });
  await confirmation.getByRole("button", { name: "Archive Team" }).click();
  await expect(teamRow).toContainText("Archived");
  await expect(teamRow.getByRole("button", { name: "Manage" })).toHaveCount(0);
});
