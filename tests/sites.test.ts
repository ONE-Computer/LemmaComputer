import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MemoryArtifactStore } from "@lemmacomputer/artifact-store";
import { type IdentityContext, LemmaComputerError } from "@lemmacomputer/contracts";
import { MemorySiteStore } from "@lemmacomputer/workspace-store";
import { createDeterministicSiteZip, validateSiteBundle } from "../apps/control-api/src/site-bundle.js";
import { SitesService } from "../apps/control-api/src/sites.js";

const owner: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const archiveFor = (label: string) => createDeterministicSiteZip(new Map([
  ["index.html", Buffer.from(`<!doctype html><html lang="en"><link rel="stylesheet" href="./assets/app.css"><body>${label}</body></html>`)],
  ["assets/app.css", Buffer.from("body{color:#123}")],
  ["data/snapshot.json", Buffer.from(JSON.stringify({ label }))],
]));
const publishInput = (label: string, siteId?: string) => {
  const archive = archiveFor(label);
  const bundle = validateSiteBundle(archive);
  return {
    ...(siteId ? { siteId } : {}),
    name: label,
    slug: "hello-world",
    bundleBase64: archive.toString("base64"),
    archiveSha256: bundle.archiveSha256,
    archiveSizeBytes: archive.length,
    manifestSha256: bundle.manifestSha256,
    idempotencyKey: createHash("sha256").update(label).digest("hex"),
    sourceWorkspaceId: workspaceId,
    sourceWorkspaceGeneration: 1,
    sourceAgentId: "agent-alex:hermes",
    sourceProjectPath: "Sites/hello-world",
  };
};

test("publishes immutable artifact versions and restores the live pointer", async () => {
  const store = new MemorySiteStore();
  const artifacts = new MemoryArtifactStore();
  const service = new SitesService(store, artifacts, { publicWebUrl: "https://lemma.example" });
  const first = await service.publish(owner, publishInput("Hello world"));
  const second = await service.publish(owner, publishInput("Hello again", first.id));
  assert.equal(second.id, first.id);
  assert.equal(second.currentRevision, 2);
  assert.equal(second.stableUrl, first.stableUrl);

  const viewer = await service.viewer({ tenantId: "acme", subjectId: "alex" }, first.handle);
  const live = await service.asset({ tenantId: "acme", subjectId: "alex" }, first.handle, viewer.version, "index.html");
  assert.match(live.bytes.toString(), /Hello again/);
  await service.restore({ tenantId: "acme", subjectId: "alex" }, first.id, 1);
  assert.equal((await service.viewer({ tenantId: "acme", subjectId: "alex" }, first.handle)).version, 1);
});

test("enforces private, organization, and invited-account access without leaking existence", async () => {
  const service = new SitesService(new MemorySiteStore(), new MemoryArtifactStore());
  const published = await service.publish(owner, publishInput("Access"));
  const outsider = { tenantId: "globex", subjectId: "sam", accountUserId: "22222222-2222-4222-8222-222222222222" };
  await assert.rejects(() => service.viewer(outsider, published.handle), { code: "SITE_NOT_FOUND" });
  await service.visibility({ tenantId: "acme", subjectId: "alex" }, published.id, { visibility: "organization" });
  assert.equal((await service.viewer({ tenantId: "acme", subjectId: "sam" }, published.handle)).site.id, published.id);
  await service.visibility({ tenantId: "acme", subjectId: "alex" }, published.id, { visibility: "restricted" });
  await service.grant({ tenantId: "acme", subjectId: "alex" }, published.id, { accountUserId: outsider.accountUserId });
  assert.equal((await service.viewer(outsider, published.handle)).site.id, published.id);

  const denial = async (handle: string) => {
    try { await service.viewer({ tenantId: "globex", subjectId: "other" }, handle); assert.fail(); }
    catch (error) {
      assert.ok(error instanceof LemmaComputerError);
      return { code: error.code, status: error.statusCode, message: error.message };
    }
  };
  assert.deepEqual(await denial(published.handle), await denial("x".repeat(24)));
});

test("single-use email invitations grant the verified account", async () => {
  const service = new SitesService(new MemorySiteStore(), new MemoryArtifactStore());
  const published = await service.publish(owner, publishInput("Invite"));
  const invitation = await service.invite({ tenantId: "acme", subjectId: "alex" }, published.id, { email: "guest@example.com", idempotencyKey: "invite-guest-0001" });
  assert.ok(invitation.token);
  await service.acceptInvitation(invitation.token!, { accountUserId: "33333333-3333-4333-8333-333333333333", email: "guest@example.com" });
  await assert.rejects(() => service.acceptInvitation(invitation.token!, { accountUserId: "33333333-3333-4333-8333-333333333333", email: "guest@example.com" }), { code: "SITE_INVITATION_INVALID" });
  assert.equal((await service.viewer({ tenantId: "", subjectId: "", accountUserId: "33333333-3333-4333-8333-333333333333" }, published.handle)).site.id, published.id);
});

test("only owners manage sites; organization members and invited accounts can only view", async () => {
  const service = new SitesService(new MemorySiteStore(), new MemoryArtifactStore());
  const site = await service.publish(owner, publishInput("Roles"));
  const member = { tenantId: owner.tenantId, subjectId: "org-admin", accountUserId: "22222222-2222-4222-8222-222222222222", isOrganizationAdministrator: true };
  const external = { tenantId: "", subjectId: "", accountUserId: "33333333-3333-4333-8333-333333333333" };
  await assert.rejects(() => service.viewer(member, site.handle), { code: "SITE_NOT_FOUND" });
  await service.visibility(owner, site.id, { visibility: "organization" });
  assert.equal((await service.viewer(member, site.handle)).site.role, "viewer");
  assert.equal((await service.list(member)).sites[0]?.canManage, false);
  const grant = await service.grant(owner, site.id, { accountUserId: external.accountUserId });
  const invitation = await service.invite(owner, site.id, { email: "reader@example.test", idempotencyKey: "owner-invite-0001" });
  assert.equal((await service.viewer(external, site.handle)).site.role, "viewer");
  assert.equal((await service.viewer(external, site.handle)).site.canManage, false);
  assert.equal((await service.viewer(external, site.handle)).site.canDelete, false);
  for (const actor of [member, external]) {
    for (const operation of [
      () => service.manage(actor, site.id),
      () => service.visibility(actor, site.id, { visibility: "organization" }),
      () => service.grant(actor, site.id, { accountUserId: actor.accountUserId }),
      () => service.invite(actor, site.id, { email: "nobody@example.test", idempotencyKey: "unauthorized-001" }),
      () => service.resendInvitation(actor, site.id, invitation.invitation.id),
      () => service.revokeInvitation(actor, site.id, invitation.invitation.id),
      () => service.revokeGrant(actor, site.id, grant.id),
      () => service.restore(actor, site.id, 1),
      () => service.delete(actor, site.id),
      () => service.publish({ ...actor, audience: owner.audience }, publishInput("Unauthorized edit", site.id)),
    ]) await assert.rejects(operation, { code: "SITE_NOT_FOUND" });
  }
  for (const permission of ["admin", "editor", "owner"]) {
    await assert.rejects(() => service.grant(owner, site.id, { accountUserId: external.accountUserId, permission }));
  }
  await service.visibility(owner, site.id, { visibility: "restricted" });
  await service.restore(owner, site.id, 1);
  await service.resendInvitation(owner, site.id, invitation.invitation.id);
  await service.revokeInvitation(owner, site.id, invitation.invitation.id);
  await service.revokeGrant(owner, site.id, grant.id);
  await assert.rejects(() => service.viewer(external, site.handle), { code: "SITE_NOT_FOUND" });
  await service.delete(owner, site.id);
});

test("keeps the previous version live when artifact finalization fails", async () => {
  const artifacts = new MemoryArtifactStore();
  const service = new SitesService(new MemorySiteStore(), artifacts);
  const first = await service.publish(owner, publishInput("Stable"));
  const originalFinalize = artifacts.finalize.bind(artifacts);
  artifacts.finalize = async () => { throw new Error("storage down"); };
  await assert.rejects(() => service.publish(owner, publishInput("Broken", first.id)), { code: "SITE_STORAGE_UNAVAILABLE" });
  artifacts.finalize = originalFinalize;
  const viewer = await service.viewer({ tenantId: "acme", subjectId: "alex" }, first.handle);
  assert.equal(viewer.version, 1);
});

test("recovers an idempotent publish when artifact finalization completed before its response was lost", async () => {
  const artifacts = new MemoryArtifactStore();
  const service = new SitesService(new MemorySiteStore(), artifacts);
  const originalFinalize = artifacts.finalize.bind(artifacts);
  let loseResponse = true;
  artifacts.finalize = async (input) => {
    const locator = await originalFinalize(input);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("finalize response lost");
    }
    return locator;
  };
  const published = await service.publish(owner, publishInput("Recovered"));
  assert.equal(published.published, true);
  assert.equal((await service.viewer({ tenantId: "acme", subjectId: "alex" }, published.handle)).version, 1);
});

test("preserves a committed publication when the database commit response is lost", async () => {
  const artifacts = new MemoryArtifactStore();
  const store = new MemorySiteStore();
  const service = new SitesService(store, artifacts);
  const originalFinalize = store.finalizeSiteVersion.bind(store);
  let loseResponse = true;
  store.finalizeSiteVersion = async (...input) => {
    const finalized = await originalFinalize(...input);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("commit response lost");
    }
    return finalized;
  };
  const published = await service.publish(owner, publishInput("Committed"));
  const viewer = await service.viewer({ tenantId: "acme", subjectId: "alex" }, published.handle);
  const asset = await service.asset({ tenantId: "acme", subjectId: "alex" }, published.handle, viewer.version, "index.html");
  assert.match(asset.bytes.toString(), /Committed/);
});
