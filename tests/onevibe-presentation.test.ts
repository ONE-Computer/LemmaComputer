import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOneVibePresentation, getOneVibePresentation, oneVibePptxMimeType } from "../apps/control-api/src/onevibe-artifacts.js";

test("ONEVibe creates an editable PPTX artifact with an integrity digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onevibe-pptx-"));
  try {
    const artifact = await createOneVibePresentation({
      title: "Executive update",
      body: "The governed workspace completed its first ONEVibe-MonoRepo task.",
    }, { tenantId: "tenant-a", subjectId: "employee-a", workspaceId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002" }, directory);
    const bytes = await readFile(artifact.path);
    assert.equal(artifact.mimeType, oneVibePptxMimeType);
    assert.ok(bytes.byteLength > 10_000, "PPTX output is unexpectedly small");
    assert.equal(bytes.subarray(0, 2).toString("utf8"), "PK");
    assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.ok(await getOneVibePresentation(artifact.id, { tenantId: "tenant-a", subjectId: "employee-a", workspaceId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002" }, directory));
    assert.equal(await getOneVibePresentation(artifact.id, { tenantId: "tenant-a", subjectId: "employee-b", workspaceId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002" }, directory), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
