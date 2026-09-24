#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const officeRoundTripFormats = Object.freeze({
  docx: { intermediate: "odt", roundTripFilter: "Office Open XML Text" },
  pptx: { intermediate: "odp", roundTripFilter: "Impress MS PowerPoint 2007 XML" },
  xlsx: { intermediate: "ods", roundTripFilter: "Calc MS Excel 2007 XML" },
});

const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

export function inspectOfficeFixture(file, extension) {
  const inspector = fileURLToPath(new URL("./inspect-office-regression.py", import.meta.url));
  const result = spawnSync("python3", [inspector, "--file", file, "--format", extension], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Office structure inspection failed");
  return JSON.parse(result.stdout);
}

const assertExpectedStructure = (actual, expected, name) => {
  if (!expected || typeof expected !== "object") throw new Error(`Office regression expectations are missing: ${name}`);
  for (const [field, minimum] of Object.entries(expected)) {
    if (!Number.isInteger(minimum) || minimum < 1 || !Number.isInteger(actual[field]) || actual[field] < minimum) {
      throw new Error(`Office regression structure was not preserved for ${name}: ${field}`);
    }
  }
};

const assertOutput = async (file, label) => {
  const metadata = await stat(file).catch(() => null);
  if (!metadata?.isFile() || metadata.size <= 0) throw new Error(`${label} did not produce a non-empty file`);
};

export async function sofficeConvert({
  sofficePath = "soffice",
  profileDirectory,
  inputPath,
  outputDirectory,
  outputExtension,
  outputFilter,
}) {
  const format = outputFilter ? `${outputExtension}:${outputFilter}` : outputExtension;
  const result = spawnSync(sofficePath, [
    "--headless",
    "--nologo",
    "--nodefault",
    "--nolockcheck",
    "--nofirststartwizard",
    `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
    "--convert-to", format,
    "--outdir", outputDirectory,
    inputPath,
  ], { encoding: "utf8", timeout: 120_000 });
  if (result.error?.code === "ENOENT") throw new Error("SOFFICE_UNAVAILABLE: soffice executable was not found");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`SOFFICE_CONVERSION_FAILED: ${result.stderr.trim() || result.stdout.trim()}`);
  const target = path.join(outputDirectory, `${path.basename(inputPath, path.extname(inputPath))}.${outputExtension}`);
  await assertOutput(target, `${path.extname(inputPath).slice(1)} to ${outputExtension}`);
  return target;
}

export async function qualifyOfficeCorpus({
  corpusDir,
  outputDir,
  recordedAt = new Date().toISOString(),
  sofficePath = "soffice",
  convert = sofficeConvert,
  inspect = inspectOfficeFixture,
}) {
  const manifest = JSON.parse(await readFile(path.join(corpusDir, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("invalid Office regression corpus manifest");
  await mkdir(outputDir, { recursive: true });
  const files = [];
  for (const fixture of manifest.files) {
    const inputPath = path.join(corpusDir, fixture.name);
    const extension = path.extname(fixture.name).slice(1).toLowerCase();
    const format = officeRoundTripFormats[extension];
    if (!format) throw new Error(`unsupported Office regression fixture: ${fixture.name}`);
    const inputSha256 = await sha256(inputPath);
    if (inputSha256 !== fixture.sha256) throw new Error(`Office regression fixture checksum mismatch: ${fixture.name}`);
    const inputStructure = await inspect(inputPath, extension);
    assertExpectedStructure(inputStructure, fixture.expectations, fixture.name);
    const runDirectory = path.join(outputDir, path.basename(fixture.name, path.extname(fixture.name)) + `-${extension}`);
    await mkdir(runDirectory, { recursive: false });
    const profileDirectory = path.join(runDirectory, "libreoffice-profile");
    const intermediateDirectory = path.join(runDirectory, "intermediate");
    const roundTripDirectory = path.join(runDirectory, "roundtrip");
    const pdfDirectory = path.join(runDirectory, "pdf");
    await Promise.all([
      mkdir(profileDirectory),
      mkdir(intermediateDirectory),
      mkdir(roundTripDirectory),
      mkdir(pdfDirectory),
    ]);
    const conversion = (input, directory, outputExtension, outputFilter) => convert({
      sofficePath,
      profileDirectory,
      inputPath: input,
      outputDirectory: directory,
      outputExtension,
      outputFilter,
    });
    const intermediatePath = await conversion(inputPath, intermediateDirectory, format.intermediate);
    const roundTripPath = await conversion(intermediatePath, roundTripDirectory, extension, format.roundTripFilter);
    await assertOutput(roundTripPath, `${extension} round trip`);
    const roundTripStructure = await inspect(roundTripPath, extension);
    assertExpectedStructure(roundTripStructure, fixture.expectations, fixture.name);
    const pdfPath = await conversion(roundTripPath, pdfDirectory, "pdf");
    await assertOutput(pdfPath, `${extension} reopen and PDF conversion`);
    files.push({
      name: fixture.name,
      status: "passed",
      features: fixture.features,
      inputStructure,
      roundTripStructure,
      inputSha256,
      intermediatePath,
      roundTripPath,
      roundTripSha256: await sha256(roundTripPath),
      pdfPath,
      pdfSha256: await sha256(pdfPath),
    });
    if (await sha256(inputPath) !== inputSha256) throw new Error(`Office regression corpus was modified: ${fixture.name}`);
  }
  return {
    schemaVersion: 1,
    recordedAt: new Date(recordedAt).toISOString(),
    status: "passed",
    corpus: path.resolve(corpusDir),
    output: path.resolve(outputDir),
    files,
  };
}

const parseArguments = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]) throw new Error(`invalid argument: ${argv[index] ?? ""}`);
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const values = parseArguments(process.argv.slice(2));
  const corpusDir = values.get("corpus");
  const outputDir = values.get("output");
  if (!corpusDir || !outputDir) {
    process.stderr.write("usage: npm run qualify:office-roundtrip -- --corpus DIR --output DIR [--soffice PATH] [--recorded-at ISO]\n");
    process.exitCode = 1;
  } else {
    qualifyOfficeCorpus({
      corpusDir,
      outputDir,
      sofficePath: values.get("soffice") ?? "soffice",
      recordedAt: values.get("recorded-at") ?? new Date().toISOString(),
    }).then(async (report) => {
      const reportPath = path.join(outputDir, "report.json");
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify(report)}\n`);
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
