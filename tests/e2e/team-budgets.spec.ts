import { expect, test } from "@playwright/test";

test("administrator creates, monitors, reconciles, and temporarily overrides a Team budget",async({page})=>{
  await page.goto("/?view=ai-control-plane&section=teams-budgets");
  await page.getByRole("button",{name:"Add Team"}).click();
  const create=page.getByRole("dialog",{name:"Create Team"});
  await create.getByLabel("Team name").fill("AI Platform");
  await create.getByLabel("Description").fill("Shared AI platform spend");
  await create.getByLabel("Cost-center code (optional)").fill("AI-100");
  await create.getByRole("button",{name:"Create Team"}).click();

  const row=page.locator(".admin-team-list article").filter({hasText:"AI Platform"});
  await row.getByRole("button",{name:"Budget"}).click();
  const dialog=page.getByRole("dialog",{name:"AI Platform budget"});
  await expect(dialog.getByText("ONEComputer is the authoritative spend ledger.")).toBeVisible();
  await dialog.getByLabel("Budget limit").fill("1000");
  await dialog.getByLabel("Currency").fill("USD");
  await expect(dialog.getByRole("combobox",{name:"Period"})).toContainText("Calendar month");
  await dialog.getByRole("combobox",{name:"Enforcement"}).click();
  await page.getByRole("option",{name:"Hard · block before dispatch"}).click();
  await dialog.getByLabel("IANA timezone").fill("Asia/Singapore");
  await dialog.getByLabel("Warning thresholds (%)").fill("50, 80, 100");
  await dialog.getByRole("button",{name:"Create budget"}).click();

  const current=dialog.getByRole("region",{name:"Current budget period"});
  await expect(current).toContainText("USD 650");
  await expect(current).toContainText("USD 100");
  await expect(current).toContainText("USD 250");
  await expect(current).toContainText("hard enforcement");
  await expect(dialog.getByRole("status")).toContainText("50% threshold reached");
  await page.screenshot({path:"test-results/team-budget-admin-reviewed.png",fullPage:true});

  const reconciled=page.waitForResponse((response)=>response.url().includes("/budget/reconcile")&&response.status()===200);
  await dialog.getByRole("button",{name:"Reconcile gateway"}).click();
  await reconciled;

  await dialog.getByLabel("Budget limit").fill("1200");
  await dialog.getByRole("combobox",{name:"Enforcement"}).click();
  await page.getByRole("option",{name:"Soft · warn only"}).click();
  await dialog.getByLabel("Warning thresholds (%)").fill("60, 90");
  await dialog.getByRole("button",{name:"Save new version"}).click();
  await expect(current).toContainText("USD 450");
  await expect(current).toContainText("soft enforcement");
  await expect(dialog.getByLabel("Warning thresholds (%)")).toHaveValue("60, 90");

  await dialog.getByRole("button",{name:"Temporary override"}).click();
  const override=dialog.getByRole("region",{name:"Temporary budget override"});
  await override.getByLabel("Temporary limit").fill("1500");
  await override.getByLabel("Reason").fill("Approved launch capacity");
  await override.getByLabel("I confirm this time-bound override will be recorded in the audit history.").check();
  await override.getByRole("button",{name:"Apply override"}).click();
  await expect(current).toContainText("USD 750");
  await expect(current).toContainText("override enforcement");
  await expect(dialog.getByRole("button",{name:"Save new version"})).toBeEnabled();
});
