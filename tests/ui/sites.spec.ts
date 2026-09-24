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
  await expect(row.getByRole("button", { name: "Delete", exact: true }).locator("svg")).toHaveCount(1);

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

  const [titleSitePage] = await Promise.all([
    page.context().waitForEvent("page"),
    row.getByRole("link", { name: "Hello world in a new tab", exact: true }).click(),
  ]);
  await expect(titleSitePage).toHaveURL(/\/s\/[A-Za-z0-9_-]{24}$/);
  await titleSitePage.close();

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

test("Sites shares view-only access with owner controls and one scroll container", async ({ page }, testInfo) => {
  const timestamp = "2026-09-05T00:00:00.000Z";
  const sites = ["owner", "viewer"].map((role, index) => ({
    id: `11111111-1111-4111-8111-11111111111${index}`, handle: role.padEnd(24, "x"),
    name: `${role} dashboard`, slug: `${role}-dashboard`, role, canManage: role === "owner", canDelete: role === "owner",
    currentRevision: 1, visibility: "organization", createdAt: timestamp, updatedAt: timestamp,
  }));
  let active = true;
  const accountUserId = "22222222-2222-4222-8222-222222222222";
  let invitations = [
    { id: "accepted", email: "guest@example.test", status: "accepted", acceptedAccountUserId: accountUserId, expiresAt: timestamp },
    { id: "revoked", email: "revoked@example.test", status: "revoked", acceptedAccountUserId: null, expiresAt: timestamp },
    { id: "expired", email: "expired@example.test", status: "expired", acceptedAccountUserId: null, expiresAt: timestamp },
  ];
  await page.route("**/api/v1/sites", (route) => route.fulfill({ json: { sites } }));
  await page.route(`**/api/v1/sites/${sites[0].id}`, (route) => route.fulfill({ json: {
    site: sites[0], delivery: { mode: "copy-link" }, versions: Array.from({ length: 10 }, (_, index) => ({
      id: `version-${index}`, version: index + 1, state: "ready", fileCount: 4, createdAt: timestamp,
    })),
    invitations,
    grants: [{ id: "grant-1", accountUserId, permission: "viewer", active }],
  } }));
  await page.route(`**/api/v1/sites/${sites[0].id}/invitations/*/remove`, async (route) => {
    expect(route.request().method()).toBe("POST");
    const invitationId = route.request().url().split("/").at(-2)!;
    invitations = invitations.filter((invitation) => invitation.id !== invitationId);
    await route.fulfill({ status: 204 });
  });
  await page.route(`**/api/v1/sites/${sites[0].id}/grants/grant-1`, async (route) => {
    expect(route.request().method()).toBe("DELETE");
    active = false;
    await route.fulfill({ status: 204 });
  });
  await page.goto("/?view=sites");
  const owner = page.getByRole("article").filter({ hasText: "owner dashboard" });
  const viewer = page.getByRole("article").filter({ hasText: "viewer dashboard" });
  await expect(owner.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Delete", exact: true })).toHaveClass(/secondary-button/);
  await expect(owner.getByRole("button", { name: "Delete", exact: true }).locator("svg")).toHaveCount(1);
  await expect(viewer).toContainText("Can view");
  await expect(viewer.getByRole("button")).toHaveCount(0);
  await expect(viewer.getByRole("link", { name: /Open viewer dashboard/ })).toBeVisible();
  for (const viewport of [{ width: 1366, height: 650 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const open = await owner.getByRole("link", { name: /Open owner dashboard/ }).boundingBox();
    const share = await owner.getByRole("button", { name: "Share", exact: true }).boundingBox();
    expect(open!.width).toBe(share!.width);
    expect(open!.height).toBe(share!.height);
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Only you, the owner");
    await expect(dialog.getByRole("combobox")).toHaveCount(1);
    await expect(dialog).not.toContainText(/\bAdmin\b|\bMember\b|Can edit/);
    const inviteInput = dialog.getByPlaceholder("person@example.com");
    const inviteButton = dialog.getByRole("button", { name: "Create invite link", exact: true });
    const inviteInputBounds = await inviteInput.boundingBox();
    const inviteButtonBounds = await inviteButton.boundingBox();
    if (viewport.width > 720) expect(inviteButtonBounds!.y).toBe(inviteInputBounds!.y);
    else expect(inviteButtonBounds!.y).toBeGreaterThan(inviteInputBounds!.y);
    expect(await dialog.evaluate((element) => [element, ...element.querySelectorAll("*")].filter((node) => {
      const style = getComputedStyle(node);
      return /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    }).length)).toBe(1);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await testInfo.attach(`site-sharing-${viewport.width}`, { body: await page.screenshot({ path: testInfo.outputPath(`site-sharing-${viewport.width}.png`) }), contentType: "image/png" });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  const revokedRow = page.locator(".site-manage-row").filter({ hasText: "revoked@example.test" });
  await expect(revokedRow.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await revokedRow.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(revokedRow).toHaveCount(0);
  const expiredRow = page.locator(".site-manage-row").filter({ hasText: "expired@example.test" });
  await expect(expiredRow.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await expiredRow.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(expiredRow).toHaveCount(0);
  const grantRow = page.locator(".site-manage-row").filter({ has: page.getByRole("button", { name: "Remove", exact: true }) });
  await expect(grantRow).toContainText("Can view");
  await grantRow.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(grantRow).toHaveCount(0);
});
