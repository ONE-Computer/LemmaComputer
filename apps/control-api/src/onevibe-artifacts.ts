import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pptxgen from "pptxgenjs";

type PptxPresentation = {
  layout: string;
  author: string;
  company: string;
  subject: string;
  title: string;
  lang: string;
  theme: { headFontFace: string; bodyFontFace: string; lang: string };
  ShapeType: { rect: string };
  addSlide(): {
    background: { color: string };
    addShape(shape: string, options: Record<string, unknown>): void;
    addText(text: string, options: Record<string, unknown>): void;
  };
  writeFile(input: { fileName: string }): Promise<string>;
};

// pptxgenjs 3.x declares an ESM default as the module namespace under
// NodeNext, although its runtime default is constructable. Keep that vendor
// mismatch isolated at the adapter boundary rather than weakening app types.
const PptxGenJS = pptxgen as unknown as new () => PptxPresentation;

export const oneVibePptxMimeType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type OneVibePresentationInput = {
  title: string;
  body: string;
};

export type OneVibePresentationArtifact = {
  id: string;
  name: string;
  path: string;
  mimeType: typeof oneVibePptxMimeType;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
};

export type OneVibeArtifactOwner = {
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  taskId: string;
};

export type OneVibeVcrFrame = {
  taskId: string;
  sourceApplication: "browser" | "document" | "desktop";
  path: string;
  mimeType: "image/png" | "image/jpeg";
  sha256: string;
  width: number;
  height: number;
  capturedAt: string;
};

type StoredOneVibePresentationArtifact = OneVibePresentationArtifact & OneVibeArtifactOwner;

const lineLimit = (value: string, maximum: number) => value.trim().slice(0, maximum);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const pngDimensions = (bytes: Uint8Array) => {
  if (bytes.byteLength < 24 || !Buffer.from(bytes.subarray(0, 8)).equals(pngSignature)
    || Buffer.from(bytes.subarray(12, 16)).toString("ascii") !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 && width <= 16_384 && height <= 16_384 ? { width, height } : null;
};

const jpegDimensions = (bytes: Uint8Array) => {
  if (bytes.byteLength < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      return width > 0 && height > 0 && width <= 16_384 && height <= 16_384 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
};

/** Stores a verified screenshot submitted by an internal, task-bound capture sidecar. */
export async function createOneVibeVcrFrame(
  bytes: Uint8Array,
  owner: OneVibeArtifactOwner,
  sourceApplication: OneVibeVcrFrame["sourceApplication"],
  artifactDirectory = process.env.ONEVIBE_ARTIFACT_DIRECTORY ?? "/tmp/onecomputer-onevibe-artifacts",
): Promise<OneVibeVcrFrame> {
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("ONEVIBE_VCR_FRAME_TOO_LARGE");
  const png = pngDimensions(bytes);
  const jpeg = png ? null : jpegDimensions(bytes);
  if (!png && !jpeg) throw new Error("ONEVIBE_VCR_FRAME_INVALID");
  const root = resolve(artifactDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const mimeType = png ? "image/png" as const : "image/jpeg" as const;
  const path = resolve(root, `vcr-${owner.taskId}-${sha256}.${png ? "png" : "jpg"}`);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return { taskId: owner.taskId, sourceApplication, path, mimeType, sha256, ...(png ?? jpeg!), capturedAt: new Date().toISOString() };
}

export async function getOneVibeVcrFrame(
  sha256: string,
  owner: OneVibeArtifactOwner,
  artifactDirectory = process.env.ONEVIBE_ARTIFACT_DIRECTORY ?? "/tmp/onecomputer-onevibe-artifacts",
): Promise<OneVibeVcrFrame | null> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
  try {
    for (const extension of ["png", "jpg"] as const) {
      const path = resolve(artifactDirectory, `vcr-${owner.taskId}-${sha256}.${extension}`);
      try {
        const bytes = await readFile(path);
        const png = pngDimensions(bytes);
        const jpeg = png ? null : jpegDimensions(bytes);
        if ((!png && !jpeg) || createHash("sha256").update(bytes).digest("hex") !== sha256) continue;
        return { taskId: owner.taskId, sourceApplication: "desktop", path, mimeType: png ? "image/png" : "image/jpeg", sha256, ...(png ?? jpeg!), capturedAt: new Date().toISOString() };
      } catch { continue; }
    }
    return null;
  } catch { return null; }
}

/**
 * Produces a single editable slide in Control-owned artifact storage. The
 * caller supplies already-governed task output; this function never sends it
 * to a provider and never accepts a caller-chosen filesystem path.
 */
export async function createOneVibePresentation(
  input: OneVibePresentationInput,
  owner: OneVibeArtifactOwner,
  artifactDirectory = process.env.ONEVIBE_ARTIFACT_DIRECTORY ?? "/tmp/onecomputer-onevibe-artifacts",
): Promise<OneVibePresentationArtifact> {
  const id = randomUUID();
  const root = resolve(artifactDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });

  const presentation = new PptxGenJS();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "ONEVibe-MonoRepo";
  presentation.company = "ONEComputer";
  presentation.subject = "Governed ONEVibe task artifact";
  presentation.title = lineLimit(input.title, 180);
  presentation.lang = "en-SG";
  presentation.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
    lang: "en-SG",
  };

  const slide = presentation.addSlide();
  slide.background = { color: "F7F9FC" };
  slide.addShape(presentation.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.18, fill: { color: "1976D2" }, line: { color: "1976D2" } });
  slide.addText(lineLimit(input.title, 180), {
    x: 0.75, y: 0.78, w: 11.8, h: 0.72,
    fontFace: "Aptos Display", fontSize: 27, bold: true, color: "142033",
    margin: 0,
  });
  slide.addText(lineLimit(input.body, 4_000), {
    x: 0.78, y: 1.82, w: 11.62, h: 4.45,
    fontFace: "Aptos", fontSize: 17, color: "2F3A4B",
    breakLine: false, margin: 0.04, valign: "top",
    paraSpaceAfterPt: 10,
  });
  slide.addText("Generated by ONEVibe-MonoRepo • governed artifact", {
    x: 0.78, y: 7.03, w: 11.6, h: 0.18,
    fontFace: "Aptos", fontSize: 8.5, color: "64748B", margin: 0,
  });

  const path = resolve(root, `${id}.pptx`);
  await presentation.writeFile({ fileName: path });
  const bytes = await readFile(path);
  const artifact: StoredOneVibePresentationArtifact = {
    ...owner,
    id,
    name: `${id}.pptx`,
    path,
    mimeType: oneVibePptxMimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    createdAt: new Date().toISOString(),
  };
  await writeFile(resolve(root, `${id}.json`), JSON.stringify(artifact), { mode: 0o600 });
  return artifact;
}

export async function getOneVibePresentation(
  id: string,
  owner: OneVibeArtifactOwner,
  artifactDirectory = process.env.ONEVIBE_ARTIFACT_DIRECTORY ?? "/tmp/onecomputer-onevibe-artifacts",
): Promise<OneVibePresentationArtifact | null> {
  const root = resolve(artifactDirectory);
  try {
    const stored = JSON.parse(await readFile(resolve(root, `${id}.json`), "utf8")) as StoredOneVibePresentationArtifact;
    if (stored.id !== id
      || stored.tenantId !== owner.tenantId
      || stored.subjectId !== owner.subjectId
      || stored.workspaceId !== owner.workspaceId
      || stored.taskId !== owner.taskId) return null;
    const bytes = await readFile(stored.path);
    if (bytes.byteLength !== stored.sizeBytes
      || createHash("sha256").update(bytes).digest("hex") !== stored.sha256) return null;
    return stored;
  } catch {
    return null;
  }
}
