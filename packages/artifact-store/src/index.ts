import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export type ArtifactStoreBackend = "filesystem" | "s3";

export type StageArtifactInput = {
  tenantId: string;
  uploadId: string;
  mediaType: string;
  bytes: Uint8Array;
  sha256: string;
};

export type FinalizeArtifactInput = {
  tenantId: string;
  uploadId: string;
  artifactId: string;
  revisionId: string;
  stagingLocator: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
};

export type ReadArtifactInput = {
  locator: string;
  byteLength: number;
  sha256: string;
};

export interface ArtifactStore {
  readonly backend: ArtifactStoreBackend;
  stage(input: StageArtifactInput): Promise<string>;
  finalize(input: FinalizeArtifactInput): Promise<string>;
  read(input: ReadArtifactInput): Promise<Buffer>;
  deleteStaging(locator: string): Promise<void>;
  delete(locator: string): Promise<void>;
}

const opaqueComponent = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const uploadId = /^upload-[a-f0-9]{32}$/;
const artifactId = /^artifact-[a-f0-9]{32}$/;
const revisionId = /^revision-[a-f0-9]{32}$/;
const locatorPattern = /^tenants\/[A-Za-z0-9][A-Za-z0-9-]{0,127}\/(?:staging\/upload-[a-f0-9]{32}|artifacts\/artifact-[a-f0-9]{32}\/revisions\/revision-[a-f0-9]{32})\/source$/;

const component = (value: string, pattern: RegExp, label: string) => {
  if (!pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
};

export const artifactStagingLocator = (tenantId: string, value: string) => (
  `tenants/${component(tenantId, opaqueComponent, "tenant identifier")}/staging/${component(value, uploadId, "upload identifier")}/source`
);

export const artifactRevisionLocator = (tenantId: string, artifact: string, revision: string) => (
  `tenants/${component(tenantId, opaqueComponent, "tenant identifier")}/artifacts/${component(artifact, artifactId, "artifact identifier")}/revisions/${component(revision, revisionId, "revision identifier")}/source`
);

const locator = (value: string) => {
  if (!locatorPattern.test(value) || path.posix.normalize(value) !== value) throw new Error("Invalid artifact locator");
  return value;
};

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const verifyBytes = (bytes: Uint8Array, byteLength: number, sha256: string) => {
  if (bytes.byteLength !== byteLength || digest(bytes) !== sha256) {
    throw new Error("Artifact content does not match its declared size and checksum");
  }
};

export class FilesystemArtifactStore implements ArtifactStore {
  readonly backend = "filesystem" as const;
  private rootRealPath?: string;

  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error("Filesystem artifact root must be absolute");
  }

  private async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Filesystem artifact root must be a real directory");
    this.rootRealPath ??= await realpath(this.root);
    return this.rootRealPath;
  }

  private async target(value: string) {
    const root = await this.initialize();
    const resolved = path.resolve(root, ...locator(value).split("/"));
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Artifact locator escaped its configured root");
    return resolved;
  }

  private async secureParent(target: string, create: boolean) {
    const root = await this.initialize();
    const relative = path.relative(root, path.dirname(target));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Artifact parent escaped its configured root");
    }
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if (create) {
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("Artifact directories must not contain symlinks");
      }
    }
  }

  private async assertRegularFile(file: string) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Artifact content must be a regular file");
  }

  async stage(input: StageArtifactInput) {
    verifyBytes(input.bytes, input.bytes.byteLength, input.sha256);
    const key = artifactStagingLocator(input.tenantId, input.uploadId);
    const target = await this.target(key);
    await this.secureParent(target, true);
    const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  }

  async finalize(input: FinalizeArtifactInput) {
    const expectedStaging = artifactStagingLocator(input.tenantId, input.uploadId);
    if (locator(input.stagingLocator) !== expectedStaging) throw new Error("Artifact staging locator does not match its upload");
    const finalLocator = artifactRevisionLocator(input.tenantId, input.artifactId, input.revisionId);
    const source = await this.target(input.stagingLocator);
    const target = await this.target(finalLocator);
    await this.secureParent(source, false);
    await this.assertRegularFile(source);
    const staged = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await staged.readFile();
      verifyBytes(bytes, input.byteLength, input.sha256);
    } finally {
      await staged.close();
    }
    await this.secureParent(target, true);
    try {
      await rename(source, target);
    } catch (error) {
      const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
      if (!existing) throw error;
      try {
        verifyBytes(await existing.readFile(), input.byteLength, input.sha256);
      } finally {
        await existing.close();
      }
      await rm(source, { force: true });
    }
    await this.assertRegularFile(target);
    return finalLocator;
  }

  async read(input: ReadArtifactInput) {
    const target = await this.target(input.locator);
    await this.secureParent(target, false);
    await this.assertRegularFile(target);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await handle.readFile();
      verifyBytes(bytes, input.byteLength, input.sha256);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async deleteStaging(value: string) {
    const checked = locator(value);
    if (!checked.includes("/staging/")) throw new Error("Only a staging locator can be deleted as staging");
    const target = await this.target(checked);
    try {
      await this.secureParent(target, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(target, { force: true });
  }

  async delete(value: string) {
    const target = await this.target(locator(value));
    try {
      await this.secureParent(target, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(target, { force: true });
  }
}

type S3Sender = Pick<S3Client, "send">;

export type S3ArtifactStoreOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  kmsKeyId?: string;
  client?: S3Sender;
};

export class S3ArtifactStore implements ArtifactStore {
  readonly backend = "s3" as const;
  private readonly client: S3Sender;

  constructor(private readonly options: S3ArtifactStoreOptions) {
    if (!options.bucket || !options.region) throw new Error("S3 artifact bucket and region are required");
    const config: S3ClientConfig = {
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
    };
    this.client = options.client ?? new S3Client(config);
  }

  private encryption() {
    return this.options.kmsKeyId
      ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: this.options.kmsKeyId }
      : { ServerSideEncryption: "AES256" as const };
  }

  async stage(input: StageArtifactInput) {
    verifyBytes(input.bytes, input.bytes.byteLength, input.sha256);
    const key = artifactStagingLocator(input.tenantId, input.uploadId);
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      Body: input.bytes,
      ContentLength: input.bytes.byteLength,
      ContentType: input.mediaType,
      ChecksumSHA256: Buffer.from(input.sha256, "hex").toString("base64"),
      Metadata: { sha256: input.sha256 },
      ...this.encryption(),
    }));
    return key;
  }

  private async verifyHead(key: string, byteLength: number, sha256: string) {
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: locator(key) }));
    const checksum = head.ChecksumSHA256 ? Buffer.from(head.ChecksumSHA256, "base64").toString("hex") : head.Metadata?.sha256;
    if (head.ContentLength !== byteLength || checksum !== sha256) {
      throw new Error("Artifact object does not match its declared size and checksum");
    }
  }

  async finalize(input: FinalizeArtifactInput) {
    const expectedStaging = artifactStagingLocator(input.tenantId, input.uploadId);
    if (locator(input.stagingLocator) !== expectedStaging) throw new Error("Artifact staging locator does not match its upload");
    await this.verifyHead(input.stagingLocator, input.byteLength, input.sha256);
    const finalLocator = artifactRevisionLocator(input.tenantId, input.artifactId, input.revisionId);
    await this.client.send(new CopyObjectCommand({
      Bucket: this.options.bucket,
      Key: finalLocator,
      CopySource: `${encodeURIComponent(this.options.bucket)}/${input.stagingLocator.split("/").map(encodeURIComponent).join("/")}`,
      ContentType: input.mediaType,
      MetadataDirective: "COPY",
      ...this.encryption(),
    }));
    await this.verifyHead(finalLocator, input.byteLength, input.sha256);
    await this.deleteStaging(input.stagingLocator);
    return finalLocator;
  }

  async read(input: ReadArtifactInput) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: locator(input.locator) }));
    if (!response.Body) throw new Error("Artifact object has no body");
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    verifyBytes(bytes, input.byteLength, input.sha256);
    return bytes;
  }

  async deleteStaging(value: string) {
    const checked = locator(value);
    if (!checked.includes("/staging/")) throw new Error("Only a staging locator can be deleted as staging");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: checked }));
  }

  async delete(value: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: locator(value) }));
  }
}

/** Test-only adapter with the same locator and integrity contract as deployed stores. */
export class MemoryArtifactStore implements ArtifactStore {
  readonly backend = "filesystem" as const;
  private readonly objects = new Map<string, Buffer>();

  async stage(input: StageArtifactInput) {
    verifyBytes(input.bytes, input.bytes.byteLength, input.sha256);
    const key = artifactStagingLocator(input.tenantId, input.uploadId);
    this.objects.set(key, Buffer.from(input.bytes));
    return key;
  }

  async finalize(input: FinalizeArtifactInput) {
    const bytes = this.objects.get(locator(input.stagingLocator));
    if (!bytes) throw new Error("Artifact staging object not found");
    verifyBytes(bytes, input.byteLength, input.sha256);
    const key = artifactRevisionLocator(input.tenantId, input.artifactId, input.revisionId);
    this.objects.set(key, Buffer.from(bytes));
    this.objects.delete(input.stagingLocator);
    return key;
  }

  async read(input: ReadArtifactInput) {
    const bytes = this.objects.get(locator(input.locator));
    if (!bytes) throw new Error("Artifact object not found");
    verifyBytes(bytes, input.byteLength, input.sha256);
    return Buffer.from(bytes);
  }

  async deleteStaging(value: string) { this.objects.delete(locator(value)); }
  async delete(value: string) { this.objects.delete(locator(value)); }
}
