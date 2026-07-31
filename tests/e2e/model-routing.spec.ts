import {expect,test} from "@playwright/test";

test("administrator reviews shadow evidence, configures Team policy, explicitly enables, and kills routing",async({page})=>{
  await page.goto("/?view=settings");await page.getByRole("button",{name:"Model routing"}).click();
  await expect(page.getByRole("heading",{name:"Model routing"})).toBeVisible();await expect(page.getByLabel("Routing Team")).toHaveValue("11111111-1111-4111-8111-111111111111");
  await expect(page.getByText("shadow",{exact:true})).toBeVisible();await expect(page.getByRole("heading",{name:"Enablement report"})).toBeVisible();await expect(page.getByText("240",{exact:true})).toBeVisible();await expect(page.getByText("USD 31.42")).toBeVisible();
  await page.getByLabel("Pro").uncheck();await page.getByRole("button",{name:"Save Team policy"}).click();await expect(page.getByLabel("Pro")).not.toBeChecked();
  await expect(page.getByRole("button",{name:"Enable production routing"})).toBeDisabled();
  await page.getByRole("button",{name:"Review evidence"}).click();const review=page.getByRole("dialog",{name:"Review routing evidence"});await review.getByLabel("Routing review note").fill("Finance sample passed the configured quality and cost thresholds.");await review.getByLabel("Evidence passed the configured evaluation threshold.").check();await review.getByRole("button",{name:"Record review"}).click();
  await page.getByRole("button",{name:"Enable production routing"}).click();const dialog=page.getByRole("dialog",{name:"Enable production routing"});await expect(dialog.getByRole("button",{name:"Enable Auto routing"})).toBeDisabled();await dialog.getByLabel("I reviewed the shadow evidence and understand this changes the executed deployment.").check();await dialog.getByRole("button",{name:"Enable Auto routing"}).click();await expect(page.getByText("enabled",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:/Lite complexity classifier/}).click();const detail=page.getByRole("dialog",{name:"Routing decision details"});await expect(detail.getByText("bedrock",{exact:true})).toBeVisible();await expect(detail.getByText("private/terra",{exact:true})).toBeVisible();await expect(detail.getByText("22222222-2222-4222-8222-222222222222",{exact:true})).toBeVisible();await detail.getByRole("button",{name:"Close details"}).click();
  await page.getByRole("button",{name:"Activate kill switch"}).click();await expect(page.getByText("disabled",{exact:true})).toBeVisible();
  await page.screenshot({path:"test-results/model-routing-admin-reviewed.png",fullPage:true});
});
