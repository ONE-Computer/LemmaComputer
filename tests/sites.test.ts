import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { LemmaComputerError, type IdentityContext } from "@lemmacomputer/contracts";
import { MemorySiteStore } from "@lemmacomputer/workspace-store";
import { SitesService } from "../apps/control-api/src/sites.js";

const owner: IdentityContext = {
  tenantId: "acme",
  subjectId: "alex",
  audience: "lemmacomputer-control",
};
const otherOwner: IdentityContext = {
  tenantId: "acme",
  subjectId: "sam",
  audience: "lemmacomputer-control",
};
const otherTenant: IdentityContext = {
  tenantId: "globex",
  subjectId: "alex",
  audience: "lemmacomputer-control",
};
const workspaceId = "11111111-1111-4111-8111-111111111111";
const html = "<!doctype html><html lang=\"en\"><body>Hello world</body></html>";
const artifact = Buffer.from(html);
const publishInput = {
  name: "Hello world",
  slug: "hello-world",
  htmlBase64: artifact.toString("base64"),
  artifactSha256: createHash("sha256").update(artifact).digest("hex"),
  sourceWorkspaceId: workspaceId,
  sourceAgentId: "agent-alex:claude",
};

test("publishes immutable revisions and scopes sites to their owner", async () => {
  const service = new SitesService(new MemorySiteStore());
  const first = await service.publish(owner, publishInput);
  const second = await service.publish(owner, { ...publishInput, name: "Hello again" });

  assert.equal(first.id, second.id);
  assert.equal(first.currentRevision, 1);
  assert.equal(second.currentRevision, 2);
  assert.deepEqual((await service.list(owner)).sites.map((site) => site.id), [first.id]);
  assert.deepEqual((await service.list(otherOwner)).sites, []);
  assert.deepEqual((await service.list(otherTenant)).sites, []);

  const preview = await service.preview(owner, first.id);
  assert.equal(preview.html, html);
  assert.equal(preview.revision, 2);
  await assert.rejects(() => service.preview(otherOwner, first.id), { code: "SITE_NOT_FOUND" });
  await assert.rejects(() => service.preview(otherTenant, first.id), { code: "SITE_NOT_FOUND" });
  const denial = async (siteId: string) => {
    try {
      await service.preview(otherTenant, siteId);
      assert.fail("site access should be denied");
    } catch (error) {
      assert.ok(error instanceof LemmaComputerError);
      return { code: error.code, message: error.message, statusCode: error.statusCode, retryable: error.retryable };
    }
  };
  assert.deepEqual(
    await denial(first.id),
    await denial("00000000-0000-4000-8000-000000000000"),
    "a foreign site must be indistinguishable from a nonexistent site",
  );

  await service.delete(owner, first.id);
  assert.deepEqual((await service.list(owner)).sites, []);
});

test("rejects malformed or changed static artifacts", async () => {
  const service = new SitesService(new MemorySiteStore());
  await assert.rejects(
    () => service.publish(owner, { ...publishInput, artifactSha256: "0".repeat(64) }),
    { code: "SITE_ARTIFACT_MISMATCH" },
  );
  const notHtml = Buffer.from("Hello world");
  await assert.rejects(
    () => service.publish(owner, {
      ...publishInput,
      htmlBase64: notHtml.toString("base64"),
      artifactSha256: createHash("sha256").update(notHtml).digest("hex"),
    }),
    { code: "SITE_ARTIFACT_INVALID" },
  );
});
