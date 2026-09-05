import { expect, test } from "@playwright/test";

test("builds from the reviewed chat skill and manages the published site", async ({ page }, testInfo) => {
  await page.goto("/?view=chat&chat=fixture-session-1");

  await expect(page.getByLabel("Available skills")).toHaveCount(0);
  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: /^\$site/ }).click();
  const composer = page.getByPlaceholder(/message/i);
  await expect(composer).toHaveValue("$site");
  await composer.fill("Use $site to build and publish a Hello world site with text centered in the page.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Published Hello world/)).toBeVisible();

  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await expect(page).toHaveURL(/view=sites/);
  const row = page.getByRole("article").filter({ hasText: "Hello world" });
  await expect(row).toContainText("Version 1");
  await expect(row.locator("img, svg")).toHaveCount(0);

  const [sitePage] = await Promise.all([
    page.context().waitForEvent("page"),
    row.getByRole("link", { name: "Open Hello world in a new tab" }).click(),
  ]);
  await expect(sitePage).toHaveURL(/\/s\/[A-Za-z0-9_-]{24}$/);
  await expect(sitePage.locator("iframe")).toBeVisible();
  await expect(sitePage.locator("iframe").contentFrame().getByText("Hello world", { exact: true })).toBeVisible();
  expect(await sitePage.evaluate(() => window.opener)).toBeNull();
  await testInfo.attach("site-viewer", { body: await sitePage.screenshot(), contentType: "image/png" });
  await sitePage.close();

  await row.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("heading", { name: "Share Hello world" })).toBeVisible();
  await expect(page.getByText("Email delivery is off for this installation.", { exact: false })).toBeVisible();
  await page.getByPlaceholder("person@example.com").fill("guest@example.test");
  await page.getByRole("button", { name: "Create invite link", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No email was sent");
  await expect(page.getByRole("textbox", { name: "Site invitation link" })).toBeVisible();
  await page.getByRole("combobox", { name: "Visibility" }).click();
  await page.getByRole("option", { name: "Everyone in my organization" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(row).toContainText("Organization");

  const mobilePage = await page.context().newPage();
  await mobilePage.setViewportSize({ width: 390, height: 844 });
  await mobilePage.goto("/?view=sites");
  const mobileRow = mobilePage.getByRole("article").filter({ hasText: "Hello world" });
  await expect(mobileRow.getByRole("link", { name: "Open Hello world in a new tab" })).toBeVisible();
  await expect(mobileRow.getByRole("button", { name: "Delete" })).toBeVisible();
  await mobilePage.close();

  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete site" }).click();
  await expect(page.getByRole("heading", { name: "No sites yet" })).toBeVisible();
});

test("Sites exposes Owner, Admin and Member actions and explicit role changes", async ({ page }, testInfo) => {
  const timestamp = "2026-09-05T00:00:00.000Z";
  const sites = ["owner", "admin", "member"].map((role, index) => ({
    id: `11111111-1111-4111-8111-11111111111${index}`, handle: role.padEnd(24, "x"),
    name: `${role} dashboard`, slug: `${role}-dashboard`, role, canManage: role !== "member", canDelete: role === "owner",
    currentRevision: 1, visibility: "organization", createdAt: timestamp, updatedAt: timestamp,
  }));
  let permission = "viewer";
  const accountUserId = "22222222-2222-4222-8222-222222222222";
  await page.route("**/api/v1/sites", (route) => route.fulfill({ json: { sites } }));
  await page.route(`**/api/v1/sites/${sites[0].id}`, (route) => route.fulfill({ json: {
    site: sites[0], delivery: { mode: "copy-link" }, versions: [],
    invitations: [{ id: "accepted", email: "guest@example.test", status: "accepted", acceptedAccountUserId: accountUserId, expiresAt: timestamp }],
    grants: [{ id: "grant-1", accountUserId, permission, active: true }],
  } }));
  await page.route(`**/api/v1/sites/${sites[0].id}/grants`, async (route) => {
    const body = route.request().postDataJSON();
    expect(body.accountUserId).toBe(accountUserId);
    permission = body.permission;
    await route.fulfill({ json: { id: "grant-1", accountUserId, permission, active: true } });
  });
  await page.goto("/?view=sites");
  const owner = page.getByRole("article").filter({ hasText: "owner dashboard" });
  const admin = page.getByRole("article").filter({ hasText: "admin dashboard" });
  const member = page.getByRole("article").filter({ hasText: "member dashboard" });
  await expect(owner.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  await expect(admin.getByRole("button", { name: "Share", exact: true })).toBeVisible();
  await expect(admin.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await expect(member.getByRole("button")).toHaveCount(0);
  await expect(member.getByRole("link")).toBeVisible();
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  const rolePicker = page.getByRole("combobox", { name: "Role for guest@example.test" });
  await rolePicker.click();
  await expect(page.getByRole("option", { name: /Owner/ })).toHaveCount(0);
  await page.getByRole("option", { name: "Admin — manage access" }).click();
  await expect(rolePicker).toContainText("Admin");
  await rolePicker.click();
  await page.getByRole("option", { name: "Member — read only" }).click();
  await expect(rolePicker).toContainText("Member");
  await testInfo.attach("site-permissions-desktop", { body: await page.screenshot(), contentType: "image/png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePicker.scrollIntoViewIfNeeded();
  await expect(rolePicker).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await testInfo.attach("site-permissions-mobile", { body: await page.screenshot(), contentType: "image/png" });
});
