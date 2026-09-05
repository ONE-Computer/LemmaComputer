import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { LemmaComputerError } from "@lemmacomputer/contracts";

export const defaultSiteBundleLimits = Object.freeze({
  maxArchiveBytes: 20 * 1024 * 1024,
  maxExtractedBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 500,
});

export type SiteBundleLimits = typeof defaultSiteBundleLimits;

export type SiteBundleManifestFile = {
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
};

export type SiteBundleManifest = {
  schemaVersion: 1;
  files: SiteBundleManifestFile[];
};

export type ValidatedSiteBundle = {
  archiveSha256: string;
  archiveSizeBytes: number;
  extractedSizeBytes: number;
  manifest: SiteBundleManifest;
  manifestSha256: string;
  files: ReadonlyMap<string, Buffer>;
};

const allowedExtensions = new Set([
  ".avif", ".css", ".csv", ".gif", ".html", ".ico", ".jpeg", ".jpg",
  ".js", ".json", ".mjs", ".otf", ".png", ".svg", ".ttf", ".webp",
  ".woff", ".woff2",
]);

const mediaTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".otf", "font/otf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const textExtensions = new Set([".css", ".csv", ".html", ".js", ".json", ".mjs", ".svg"]);
const forbiddenFileNames = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const secretContent = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i;
const remoteHtmlResource = /<(?:script|link|img|source|video|audio|iframe)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:)?\/\//i;
const remoteCssResource = /(?:@import\s+(?:url\()?\s*["']?(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/)/i;
const outboundJavascript = /(?:new\s+(?:WebSocket|EventSource)\s*\(|XMLHttpRequest\s*\(|navigator\.sendBeacon\s*\()/i;
const fetchCall = /\bfetch\s*\(/gi;
const localSnapshotFetch = /\bfetch\s*\(\s*(["'])(\.\/[^"'\\]*)\1/gi;
const directDatabase = /(?:postgres(?:ql)?:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/)/i;

const extensionOf = (value: string) => {
  const slash = value.lastIndexOf("/");
  const dot = value.lastIndexOf(".");
  return dot > slash ? value.slice(dot).toLowerCase() : "";
};

export const siteBundleMediaType = (value: string) => mediaTypes.get(extensionOf(value)) ?? "application/octet-stream";

export const normalizeSiteAssetPath = (raw: string) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new LemmaComputerError("SITE_ASSET_NOT_FOUND", "Site asset not found", 404);
  }
  const value = decoded.replace(/^\/+/, "");
  const segments = value.split("/");
  if (
    !value
    || value.includes("\\")
    || value.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) throw new LemmaComputerError("SITE_ASSET_NOT_FOUND", "Site asset not found", 404);
  return value;
};

const assertBundlePath = (raw: string) => {
  const value = normalizeSiteAssetPath(raw);
  const segments = value.split("/");
  const filename = segments.at(-1)!;
  if (
    raw !== value
    || segments.some((segment) => segment.startsWith("."))
    || segments.some((segment) => segment.toLowerCase() === "__macosx" || segment.toLowerCase() === "node_modules")
    || forbiddenFileNames.test(filename)
    || filename.toLowerCase().endsWith(".map")
  ) throw new LemmaComputerError("SITE_BUNDLE_PATH_INVALID", "The site bundle contains a forbidden path", 400);
  const extension = extensionOf(value);
  if (!allowedExtensions.has(extension)) {
    throw new LemmaComputerError("SITE_BUNDLE_TYPE_INVALID", "The site bundle contains an unsupported file type", 400);
  }
  return value;
};

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

const crc32 = (bytes: Uint8Array) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const invalidBundle = (message = "The site bundle is not a valid supported ZIP archive") => (
  new LemmaComputerError("SITE_BUNDLE_INVALID", message, 400)
);

const readUInt16 = (archive: Buffer, offset: number) => {
  if (offset < 0 || offset + 2 > archive.length) throw invalidBundle();
  return archive.readUInt16LE(offset);
};

const readUInt32 = (archive: Buffer, offset: number) => {
  if (offset < 0 || offset + 4 > archive.length) throw invalidBundle();
  return archive.readUInt32LE(offset);
};

const findEndOfCentralDirectory = (archive: Buffer) => {
  const start = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw invalidBundle();
};

const validateTextContent = (path: string, bytes: Buffer) => {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) {
    throw new LemmaComputerError("SITE_BUNDLE_TEXT_INVALID", "The site bundle contains invalid UTF-8 text", 400);
  }
  if (secretContent.test(text) || directDatabase.test(text)) {
    throw new LemmaComputerError("SITE_BUNDLE_SECRET_INVALID", "The site bundle contains credential or database configuration", 400);
  }
  const extension = extensionOf(path);
  if (extension === ".html") {
    if (!/<html(?:\s|>)/i.test(text)) throw new LemmaComputerError("SITE_BUNDLE_HTML_INVALID", "The site bundle index must be an HTML document", 400);
    if (remoteHtmlResource.test(text) || /<base\b/i.test(text)) {
      throw new LemmaComputerError("SITE_BUNDLE_REMOTE_RESOURCE", "The site bundle must use only local resources", 400);
    }
  }
  if ((extension === ".css" || extension === ".svg") && remoteCssResource.test(text)) {
    throw new LemmaComputerError("SITE_BUNDLE_REMOTE_RESOURCE", "The site bundle must use only local resources", 400);
  }
  if (extension === ".js" || extension === ".mjs") {
    const fetchedPaths = [...text.matchAll(localSnapshotFetch)].map((match) => match[2]!);
    const fetchCount = [...text.matchAll(fetchCall)].length;
    if (
      outboundJavascript.test(text)
      || fetchCount !== fetchedPaths.length
      || fetchedPaths.some((value) => value.split("/").includes(".."))
    ) {
      throw new LemmaComputerError("SITE_BUNDLE_REMOTE_RESOURCE", "The site bundle may load only packaged ./ snapshot files", 400);
    }
  }
  if (extension === ".json") {
    try { JSON.parse(text); } catch { throw new LemmaComputerError("SITE_BUNDLE_JSON_INVALID", "The site bundle contains invalid JSON", 400); }
  }
};

export const validateSiteBundle = (
  value: Uint8Array,
  limits: SiteBundleLimits = defaultSiteBundleLimits,
): ValidatedSiteBundle => {
  const archive = Buffer.from(value);
  if (!archive.length || archive.length > limits.maxArchiveBytes) {
    throw new LemmaComputerError("SITE_BUNDLE_TOO_LARGE", "The site bundle exceeds the archive size limit", 413);
  }
  const eocd = findEndOfCentralDirectory(archive);
  const disk = readUInt16(archive, eocd + 4);
  const centralDisk = readUInt16(archive, eocd + 6);
  const entriesOnDisk = readUInt16(archive, eocd + 8);
  const entryCount = readUInt16(archive, eocd + 10);
  const centralSize = readUInt32(archive, eocd + 12);
  const centralOffset = readUInt32(archive, eocd + 16);
  const commentLength = readUInt16(archive, eocd + 20);
  if (
    disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount
    || entryCount < 1 || entryCount > limits.maxFiles
    || eocd + 22 + commentLength !== archive.length
    || centralOffset + centralSize !== eocd
  ) throw invalidBundle();

  const files = new Map<string, Buffer>();
  let extractedSizeBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(archive, cursor) !== 0x02014b50) throw invalidBundle();
    const versionMadeBy = readUInt16(archive, cursor + 4);
    const flags = readUInt16(archive, cursor + 8);
    const method = readUInt16(archive, cursor + 10);
    const expectedCrc = readUInt32(archive, cursor + 16);
    const compressedSize = readUInt32(archive, cursor + 20);
    const uncompressedSize = readUInt32(archive, cursor + 24);
    const filenameLength = readUInt16(archive, cursor + 28);
    const extraLength = readUInt16(archive, cursor + 30);
    const fileCommentLength = readUInt16(archive, cursor + 32);
    const diskStart = readUInt16(archive, cursor + 34);
    const externalAttributes = readUInt32(archive, cursor + 38);
    const localOffset = readUInt32(archive, cursor + 42);
    const centralEntryEnd = cursor + 46 + filenameLength + extraLength + fileCommentLength;
    if (
      centralEntryEnd > eocd || filenameLength < 1 || diskStart !== 0
      || (flags & 0x0001) !== 0 || ![0, 8].includes(method)
      || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)
      || compressedSize > limits.maxArchiveBytes || uncompressedSize > limits.maxFileBytes
    ) throw invalidBundle();
    const rawName = archive.subarray(cursor + 46, cursor + 46 + filenameLength);
    const decodedName = rawName.toString("utf8");
    if (!Buffer.from(decodedName, "utf8").equals(rawName) || decodedName.endsWith("/")) throw invalidBundle();
    const path = assertBundlePath(decodedName);
    if (files.has(path)) throw new LemmaComputerError("SITE_BUNDLE_DUPLICATE_PATH", "The site bundle contains duplicate paths", 400);
    const hostSystem = versionMadeBy >>> 8;
    const fileType = (externalAttributes >>> 16) & 0o170000;
    if (hostSystem === 3 && (fileType === 0o120000 || fileType === 0o040000)) {
      throw new LemmaComputerError("SITE_BUNDLE_PATH_INVALID", "The site bundle must not contain symbolic links or directories", 400);
    }
    if (readUInt32(archive, localOffset) !== 0x04034b50) throw invalidBundle();
    const localFlags = readUInt16(archive, localOffset + 6);
    const localMethod = readUInt16(archive, localOffset + 8);
    const localNameLength = readUInt16(archive, localOffset + 26);
    const localExtraLength = readUInt16(archive, localOffset + 28);
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      localFlags !== flags || localMethod !== method || !localName.equals(rawName)
      || dataStart < 0 || dataEnd > centralOffset
    ) throw invalidBundle();
    const compressed = archive.subarray(dataStart, dataEnd);
    let bytes: Buffer;
    try {
      bytes = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.min(limits.maxFileBytes, uncompressedSize) });
    } catch {
      throw invalidBundle();
    }
    if (bytes.length !== uncompressedSize || crc32(bytes) !== expectedCrc) throw invalidBundle();
    extractedSizeBytes += bytes.length;
    if (extractedSizeBytes > limits.maxExtractedBytes) {
      throw new LemmaComputerError("SITE_BUNDLE_TOO_LARGE", "The site bundle exceeds the extracted size limit", 413);
    }
    if (textExtensions.has(extensionOf(path))) validateTextContent(path, bytes);
    files.set(path, bytes);
    cursor = centralEntryEnd;
  }
  if (cursor !== eocd || !files.has("index.html")) {
    throw new LemmaComputerError("SITE_BUNDLE_INDEX_MISSING", "The site bundle must contain root index.html", 400);
  }
  const manifest: SiteBundleManifest = {
    schemaVersion: 1,
    files: [...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => ({
      path,
      mediaType: siteBundleMediaType(path),
      sizeBytes: bytes.length,
      sha256: digest(bytes),
    })),
  };
  return {
    archiveSha256: digest(archive),
    archiveSizeBytes: archive.length,
    extractedSizeBytes,
    manifest,
    manifestSha256: digest(Buffer.from(JSON.stringify(manifest))),
    files,
  };
};

export const createDeterministicSiteZip = (inputFiles: ReadonlyMap<string, Uint8Array>) => {
  const files = [...inputFiles.entries()].map(([rawPath, value]) => ({
    path: assertBundlePath(rawPath),
    bytes: Buffer.from(value),
  })).sort((left, right) => left.path.localeCompare(right.path));
  if (!files.length || !files.some((file) => file.path === "index.html")) {
    throw new LemmaComputerError("SITE_BUNDLE_INDEX_MISSING", "The site bundle must contain root index.html", 400);
  }
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const checksum = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, file.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + file.bytes.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
};
