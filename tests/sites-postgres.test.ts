import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { IdentityContext } from "@lemmacomputer/contracts";
import { PostgresSiteStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.SITES_TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("PostgreSQL Sites versions, grants, invitations, and tenant scoping are atomic", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const store = PostgresSiteStore.fromConnectionString(connectionString!);
  const suffix = randomUUID();
  const tenantId = `sites-${suffix}`;
  const ownerId = `owner-${suffix}`;
  const ownerAccount = randomUUID();
  const guestAccount = randomUUID();
  const identity: IdentityContext = { tenantId, subjectId: ownerId, audience: "lemmacomputer-control" };
  try {
    await pool.query("INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Sites test')", [tenantId, `external-${tenantId}`]);
    await pool.query("INSERT INTO organizations(id,display_name) VALUES($1,'Sites test')", [tenantId]);
    await pool.query("INSERT INTO account_users(id) VALUES($1),($2)", [ownerAccount, guestAccount]);
    await pool.query("INSERT INTO users(id,tenant_id,email,display_name,account_user_id) VALUES($1,$2,$3,'Owner',$4)", [ownerId, tenantId, `${ownerId}@example.test`, ownerAccount]);
    const prepared = await store.prepareSiteVersion(identity, {
      slug: "executive-dashboard", name: "Executive dashboard", sourceWorkspaceId: randomUUID(), sourceWorkspaceGeneration: 1,
      sourceAgentId: "hermes-claw", sourceProjectPath: "Sites/executive-dashboard", storageBackend: "filesystem",
      archiveSha256: hash("archive"), archiveSizeBytes: 100, manifestSha256: hash("manifest"),
      manifest: { schemaVersion: 1, files: [{ path: "index.html" }] }, extractedSizeBytes: 120, fileCount: 1,
      idempotencyKeyHash: hash("publish-1"),
    });
    assert.equal(prepared.version.version, 1);
    assert.ok(await store.setSiteVersionStagingLocator(identity, prepared.site.id, prepared.version.id, "tenants/test/staging/source"));
    const finalized = await store.finalizeSiteVersion(identity, prepared.site.id, prepared.version.id, "tenants/test/artifacts/version-1/source");
    assert.equal(finalized?.site.currentRevision, 1);
    assert.equal((await store.getAccessiblePublicationByHandle({ tenantId, subjectId: ownerId, accountUserId: ownerAccount }, prepared.site.handle!))?.version?.version, 1);
    assert.equal(await store.getAccessiblePublicationByHandle({ tenantId: "other", subjectId: "guest", accountUserId: guestAccount }, prepared.site.handle!), null);

    const owner = { tenantId, subjectId: ownerId, accountUserId: ownerAccount };
    const orgAdmin = { tenantId, subjectId: "org-admin", accountUserId: guestAccount, isOrganizationAdministrator: true };
    const external = { tenantId: "", subjectId: "", accountUserId: guestAccount };
    assert.equal(await store.getManageableSite(orgAdmin, prepared.site.id), null);
    assert.equal(await store.getAccessiblePublicationByHandle(orgAdmin, prepared.site.handle), null);
    await store.updateSiteVisibility(owner, prepared.site.id, "organization");
    assert.ok(await store.getAccessiblePublicationByHandle(orgAdmin, prepared.site.handle));
    assert.equal(await store.getSiteRole(orgAdmin, prepared.site), "member");
    assert.equal(await store.grantSiteAccess(orgAdmin, prepared.site.id, guestAccount, "admin"), null);
    assert.equal((await store.deleteSite(orgAdmin, prepared.site.id)).deleted, false);
    const adminGrant = await store.grantSiteAccess(owner, prepared.site.id, guestAccount, "admin");
    assert.equal(adminGrant?.permission, "admin");
    assert.ok(await store.getManageableSite(external, prepared.site.id));
    assert.equal(await store.getSiteRole(external, prepared.site), "admin");
    assert.ok(await store.updateSiteVisibility(external, prepared.site.id, "restricted"));
    assert.ok(await store.restoreSiteVersion(external, prepared.site.id, 1));
    assert.equal((await store.deleteSite(external, prepared.site.id)).deleted, false);
    assert.equal(await store.grantSiteAccess(external, prepared.site.id, ownerAccount, "viewer"), null, "the owner cannot be downgraded via a grant");
    await store.grantSiteAccess(owner, prepared.site.id, guestAccount, "viewer");
    assert.equal(await store.getSiteRole(external, prepared.site), "member");
    assert.equal(await store.getManageableSite(external, prepared.site.id), null);
    assert.equal(await store.updateSiteVisibility(external, prepared.site.id, "organization"), null);
    assert.equal(await store.restoreSiteVersion(external, prepared.site.id, 1), null);
    assert.equal(await store.revokeSiteAccess(external, prepared.site.id, adminGrant!.id), false);
    await store.revokeSiteAccess(owner, prepared.site.id, adminGrant!.id);
    assert.equal(await store.getAccessiblePublicationByHandle(external, prepared.site.handle), null);

    assert.ok(await store.grantSiteAccess({ tenantId, subjectId: ownerId }, prepared.site.id, guestAccount));
    assert.equal((await store.getAccessiblePublicationByHandle({ tenantId: "other", subjectId: "guest", accountUserId: guestAccount }, prepared.site.handle!))?.site.id, prepared.site.id);
    const now = new Date();
    const invitation = await store.createSiteInvitation({ tenantId, subjectId: ownerId }, { siteId: prepared.site.id, email: "guest@example.test", tokenHash: hash("token"), idempotencyKeyHash: hash("invite"), expiresAt: new Date(now.getTime() + 60_000), now });
    assert.equal(invitation?.replayed, false);
    assert.equal((await store.acceptSiteInvitation({ tokenHash: hash("token"), accountUserId: guestAccount, email: "guest@example.test", now }))?.siteId, prepared.site.id);
    assert.equal(await store.acceptSiteInvitation({ tokenHash: hash("token"), accountUserId: guestAccount, email: "guest@example.test", now }), null);
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM site_invitation_audit_events WHERE tenant_id=$1 AND site_id=$2", [tenantId, prepared.site.id])).rows[0].count), 2);

    const expiredAt = new Date(now.getTime() - 1_000);
    await store.createSiteInvitation({ tenantId, subjectId: ownerId }, {
      siteId: prepared.site.id, email: "expired@example.test", tokenHash: hash("expired-token"),
      idempotencyKeyHash: hash("expired-invite"), expiresAt: expiredAt, now: new Date(expiredAt.getTime() - 1_000),
    });
    const invitations = await store.listSiteInvitations({ tenantId, subjectId: ownerId }, prepared.site.id, now);
    assert.equal(invitations?.find((item) => item.email === "expired@example.test")?.status, "expired");
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM site_invitation_audit_events WHERE tenant_id=$1 AND site_id=$2 AND event_type='invitation.expired'", [tenantId, prepared.site.id])).rows[0].count), 1);
  } finally {
    await pool.query("DELETE FROM sites WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM users WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM organizations WHERE id=$1", [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    await pool.query("DELETE FROM account_users WHERE id=ANY($1::uuid[])", [[ownerAccount, guestAccount]]);
    await pool.end();
    await store.close();
  }
});
