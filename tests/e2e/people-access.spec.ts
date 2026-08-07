import { expect, test } from "@playwright/test";

test("organization administrator invites a person and manages member access", async ({ page }) => {
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "People and access" }).click();
  await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
  await expect(page.getByText("Identity-provider credentials remain outside LemmaComputer.")).toBeVisible();

  await page.getByRole("button", { name: "Invite person" }).click();
  const inviteDialog = page.getByRole("dialog", { name: "Invite a person" });
  await inviteDialog.getByLabel("Email address").fill("new.user@example.test");
  await inviteDialog.getByRole("combobox", { name: "Invited organization role" }).click();
  await page.getByRole("option", { name: "Administrator" }).click();
  await inviteDialog.getByRole("button", { name: "Create invitation" }).click();

  const invitation = page.locator(".admin-invitation-list article").filter({ hasText: "new.user@example.test" });
  await expect(invitation).toContainText("Administrator");
  await expect(invitation).toContainText("pending");
  const invitationLink = page.getByLabel("Invitation link");
  await expect(invitationLink).toHaveValue(/\/invite\?token=oci_fixture_invitation_token$/);

  await invitation.getByRole("button", { name: "Resend" }).click();
  await expect(invitationLink).toHaveValue(/\/invite\?token=oci_fixture_rotated_token$/);
  await invitation.getByRole("button", { name: "Revoke" }).click();
  const revokeDialog = page.getByRole("dialog", { name: /Revoke the invitation/ });
  await revokeDialog.getByRole("button", { name: "Revoke invitation" }).click();
  await expect(invitation).toContainText("revoked");

  const member = page.locator(".admin-user-list article").filter({ hasText: "hello@metech.dev" });
  await member.getByRole("combobox", { name: "Organization role for METECH" }).click();
  await page.getByRole("option", { name: "Administrator" }).click();
  const roleDialog = page.getByRole("dialog", { name: "Change METECH to Administrator?" });
  await roleDialog.getByRole("button", { name: "Change role" }).click();
  await expect(member).toContainText("Administrator");

  await member.getByRole("button", { name: "Suspend", exact: true }).click();
  const suspendDialog = page.getByRole("dialog", { name: "Suspend METECH?" });
  await suspendDialog.getByRole("button", { name: "Suspend", exact: true }).click();
  await expect(member).toContainText("suspended");
  await member.getByRole("button", { name: "Reactivate" }).click();
  await page.getByRole("dialog", { name: "Reactivate METECH?" }).getByRole("button", { name: "Reactivate" }).click();
  await expect(member.getByText("suspended", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/people-access-reviewed.png", fullPage: true });
});
