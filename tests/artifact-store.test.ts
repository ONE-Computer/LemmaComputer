import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FilesystemArtifactStore,
  MemoryArtifactStore,
  S3ArtifactStore,
  artifactRevisionLocator,
  type ArtifactStore,
} from "@lemmacomputer/artifact-store";
import type { ArtifactStagingRecord, ChatStore } from "@lemmacomputer/workspace-store";
import { DurableChatService } from "../apps/control-api/src/durable-chat.js";

const bytes = Buffer.from("durable artifact bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");

const exercise = async (store: ArtifactStore) => {
  const staging = await store.stage({ tenantId: "tenant-123", uploadId: "upload-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mediaType: "text/plain", bytes, sha256 });
  const locator = await store.finalize({
    tenantId: "tenant-123", uploadId: "upload-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    artifactId: "artifact-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    revisionId: "revision-cccccccccccccccccccccccccccccccc",
    stagingLocator: staging, mediaType: "text/plain", byteLength: bytes.length, sha256,
  });
  assert.equal(locator, artifactRevisionLocator(
    "tenant-123", "artifact-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "revision-cccccccccccccccccccccccccccccccc",
  ));
  assert.deepEqual(await store.read({ locator, byteLength: bytes.length, sha256 }), bytes);
  await assert.rejects(() => store.read({ locator, byteLength: bytes.length + 1, sha256 }));
};

test("filesystem and memory ArtifactStore adapters preserve opaque locators and integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemmacomputer-artifacts-"));
  try {
    await exercise(new FilesystemArtifactStore(root));
    await exercise(new MemoryArtifactStore());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Compose initializes the canonical artifact volume before non-root Control starts", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const initializer = compose.slice(compose.indexOf("  artifact-data-init:"), compose.indexOf("  control-api:"));
  const control = compose.slice(compose.indexOf("  control-api:"), compose.indexOf("  channel-broker:"));

  assert.match(initializer, /user: root/);
  assert.match(initializer, /network_mode: none/);
  assert.match(initializer, /cap_add:\s+- CHOWN\s+- FOWNER/);
  assert.match(initializer, /chown node:node \/var\/lib\/lemmacomputer\/artifacts/);
  assert.match(initializer, /chmod 0700 \/var\/lib\/lemmacomputer\/artifacts/);
  assert.match(initializer, /artifact-data:\/var\/lib\/lemmacomputer\/artifacts/);
  assert.match(control, /user: node/);
  assert.match(control, /artifact-data:\/var\/lib\/lemmacomputer\/artifacts/);
  assert.match(control, /artifact-data-init:\s+condition: service_completed_successfully/);
});

test("FilesystemArtifactStore rejects symlinks in every locator directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemmacomputer-artifacts-root-"));
  const outside = await mkdtemp(join(tmpdir(), "lemmacomputer-artifacts-outside-"));
  try {
    await symlink(outside, join(root, "tenants"), "dir");
    const store = new FilesystemArtifactStore(root);
    await assert.rejects(() => store.stage({
      tenantId: "tenant-123",
      uploadId: "upload-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mediaType: "text/plain",
      bytes,
      sha256,
    }), /must not contain symlinks/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test("S3ArtifactStore performs staged copy with checksum metadata and KMS", async () => {
  const objects = new Map<string, Buffer>();
  const inputs: Array<Record<string, unknown>> = [];
  const client = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      const input = command.input;
      inputs.push({ command: command.constructor.name, ...input });
      const objectKey = String(input.Key);
      if (command.constructor.name === "PutObjectCommand") {
        objects.set(objectKey, Buffer.from(input.Body as Uint8Array));
        return {};
      }
      if (command.constructor.name === "HeadObjectCommand") {
        const value = objects.get(objectKey);
        if (!value) throw new Error("missing object");
        return { ContentLength: value.length, Metadata: { sha256 } };
      }
      if (command.constructor.name === "CopyObjectCommand") {
        const source = decodeURIComponent(String(input.CopySource).split("/").slice(1).join("/"));
        objects.set(objectKey, Buffer.from(objects.get(source)!));
        return {};
      }
      if (command.constructor.name === "DeleteObjectCommand") { objects.delete(objectKey); return {}; }
      if (command.constructor.name === "GetObjectCommand") {
        const value = objects.get(objectKey)!;
        return { Body: { transformToByteArray: async () => value } };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
  await exercise(new S3ArtifactStore({ bucket: "artifacts", region: "ap-southeast-1", kmsKeyId: "alias/artifacts", client: client as never }));
  const writes = inputs.filter((input) => input.command === "PutObjectCommand" || input.command === "CopyObjectCommand");
  assert.equal(writes.every((input) => input.ServerSideEncryption === "aws:kms" && input.SSEKMSKeyId === "alias/artifacts"), true);
  assert.equal(inputs.some((input) => input.command === "PutObjectCommand" && input.ChecksumSHA256 === Buffer.from(sha256, "hex").toString("base64")), true);
});

test("expired finalizing uploads remain retryable until staging and promoted bytes are both deleted", async () => {
  const finalStorageLocator = "tenants/tenant-123/artifacts/artifact-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/revisions/revision-cccccccccccccccccccccccccccccccc/source";
  const upload: ArtifactStagingRecord = {
    id: "upload-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tenantId: "tenant-123", workspaceId: "workspace-1",
    conversationId: "conversation-1", ownerSubjectId: "user-1", direction: "output",
    originalFilename: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    expectedByteLength: bytes.length, expectedSha256: sha256, workspaceNodeId: "node-1", accessGeneration: 3,
    storageBackend: "s3", stagingLocator: "tenants/tenant-123/staging/upload-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/source",
    artifactId: "artifact-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    revisionId: "revision-cccccccccccccccccccccccccccccccc", finalStorageLocator,
    state: "finalizing", expiresAt: new Date(0),
  };
  const abandoned: string[] = [];
  const chats = {
    listExpiredStaging: async () => [upload],
    abandonStaging: async (_tenantId: string, uploadId: string) => { abandoned.push(uploadId); return true; },
  } as unknown as ChatStore;
  const deleted: string[] = [];
  let stagingDeleteFails = true;
  const artifacts = {
    backend: "s3",
    delete: async (locator: string) => { deleted.push(locator); },
    deleteStaging: async (locator: string) => {
      deleted.push(locator);
      if (stagingDeleteFails) throw new Error("temporary object store outage");
    },
  } as unknown as ArtifactStore;
  const service = new DurableChatService(chats, artifacts, { requireNodePlacement: true });

  await service.cleanupExpiredStaging();
  assert.deepEqual(abandoned, []);
  stagingDeleteFails = false;
  await service.cleanupExpiredStaging();
  assert.deepEqual(abandoned, [upload.id]);
  assert.deepEqual(deleted, [finalStorageLocator, upload.stagingLocator, finalStorageLocator, upload.stagingLocator]);
});
