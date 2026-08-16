import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { FilesystemArtifactStore, S3ArtifactStore, type ArtifactStore } from "@lemmacomputer/artifact-store";

const run = promisify(execFile);
const image = "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const container = `lemmacomputer-artifact-qualification-${suffix}`;
const accessKey = `qualifier${suffix}`;
const secretKey = `qualifier-secret-${suffix}-${randomUUID()}`;
const bucket = `artifacts-${suffix}`;
const bytes = Buffer.from("LemmaComputer artifact qualification");
const sha256 = createHash("sha256").update(bytes).digest("hex");

const exercise = async (store: ArtifactStore) => {
  const uploadId = `upload-${randomUUID().replaceAll("-", "")}`;
  const artifactId = `artifact-${randomUUID().replaceAll("-", "")}`;
  const revisionId = `revision-${randomUUID().replaceAll("-", "")}`;
  const stagingLocator = await store.stage({ tenantId: "qualification", uploadId, mediaType: "text/plain", bytes, sha256 });
  const locator = await store.finalize({
    tenantId: "qualification", uploadId, artifactId, revisionId, stagingLocator,
    mediaType: "text/plain", byteLength: bytes.length, sha256,
  });
  const restored = await store.read({ locator, byteLength: bytes.length, sha256 });
  if (!restored.equals(bytes)) throw new Error("ArtifactStore qualification read did not match its write");
  await store.delete(locator);
};

const root = await mkdtemp(join(tmpdir(), "lemmacomputer-artifact-qualification-"));
try {
  await exercise(new FilesystemArtifactStore(root));
  await run("docker", [
    "run", "--rm", "-d", "--name", container,
    "-e", `MINIO_ROOT_USER=${accessKey}`,
    "-e", `MINIO_ROOT_PASSWORD=${secretKey}`,
    "-p", "127.0.0.1::9000",
    image, "server", "/data", "--address", ":9000",
  ]);
  const { stdout } = await run("docker", ["port", container, "9000/tcp"]);
  const port = stdout.trim().split(":").at(-1);
  if (!port) throw new Error("MinIO qualification port was not published");
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/minio/health/ready`);
      if (response.ok) break;
    } catch {
      // MinIO is still starting.
    }
    if (attempt === 59) throw new Error("MinIO qualification service did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const credentials = { accessKeyId: accessKey, secretAccessKey: secretKey };
  const client = new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  await exercise(new S3ArtifactStore({ bucket, region: "us-east-1", endpoint, forcePathStyle: true, client }));
  process.stdout.write("ArtifactStore qualification passed: filesystem and isolated local S3 stage, finalize, integrity read, and delete.\n");
} finally {
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
