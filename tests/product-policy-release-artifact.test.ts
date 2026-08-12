import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { productReleaseVerificationKeySetSchema, signedProtectedBaselineTemplateSchema } from "@lemmacomputer/contracts";
import { verifyProtectedBaselineTemplate } from "@lemmacomputer/policy-integrity";
import { parseProductPolicyRelease } from "../apps/control-api/src/protected-workspace-policy.js";

const root = new URL("../", import.meta.url);
const readJson = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8")) as unknown;

test("the packaged office-worker baseline verifies against the explicit product release trust root", async () => {
  const trustRootInput = await readJson("config/product-policy/product-release-trust.json");
  const envelopeInput = await readJson("config/product-policy/protected-baselines/office-worker-claude-v1.json");
  const trustRoot = productReleaseVerificationKeySetSchema.parse(trustRootInput);
  const envelope = signedProtectedBaselineTemplateSchema.parse(envelopeInput);
  const serializedConfiguration = JSON.stringify({ trustRootInput, envelopeInput }).toLowerCase();

  assert.doesNotMatch(serializedConfiguration, /private.?key|pkcs8|secret|seed/);
  assert.equal(trustRoot.keys.length, 1);
  assert.equal(trustRoot.keys[0]?.keyId, envelope.keyId);
  const verified = verifyProtectedBaselineTemplate(envelope, trustRoot, {
    now: new Date("2026-08-12T05:00:00.000Z"),
  });
  assert.equal(verified.payload.templateId, "pbt_office_worker_claude");
  assert.equal(verified.payload.templateVersionId, "pbtv_office_worker_claude_1");
  assert.equal(verified.payload.release.releaseId, "0.5-policy-foundation-1");
  assert.equal(verified.payload.release.sourceCommit, "30e04d9610a17d24a0d6717fc3f99f562c5626e9");
  assert.equal(envelope.payloadDigest, "ba7285ccfa6365dc5226a0a23c6afd6663dd7c62139f22a340b8f6b1d7ee5448");
  assert.deepEqual(verified.payload.document.constraints.agents, {
    allow: ["claude-desktop", "claude-cli"],
    deny: ["codex-cli", "hermes-desktop", "hermes-claw"],
  });
  assert.deepEqual(verified.payload.document.constraints.applications, {
    allow: ["firefox", "google-chrome"],
    deny: [],
  });
  assert.deepEqual(verified.payload.document.constraints.connectors.allow, ["microsoft-365"]);
  assert.equal(
    verified.payload.document.constraints.connectors.toolPolicies["microsoft-365"]?.["send-mail"],
    "approval_required",
  );
});

test("the Control runtime image contains the signed product policy release", async () => {
  const dockerfile = await readFile(new URL("docker/Dockerfile.node", root), "utf8");
  assert.match(dockerfile, /^COPY config\/product-policy \.\/config\/product-policy$/m);
});

test("product policy release loading fails closed for a tampered checked-in envelope", async () => {
  const trustRoot = await readJson("config/product-policy/product-release-trust.json");
  const envelope = await readJson("config/product-policy/protected-baselines/office-worker-claude-v1.json") as Record<string, unknown>;
  assert.throws(
    () => parseProductPolicyRelease(trustRoot, { ...envelope, payloadDigest: "0".repeat(64) }, new Date("2026-08-12T05:00:00.000Z")),
    /digest/i,
  );
});
