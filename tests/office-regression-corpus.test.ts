import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { qualifyOfficeCorpus } from "../scripts/qualify-office-roundtrip.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const generator = path.join(root, "scripts/generate-office-regression-corpus.py");

const generate = async (directory: string) => {
  await execute("python3", [generator, "--output", directory]);
  return JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
};

test("Office regression corpus is deterministic and contains real OOXML feature structures", async (context) => {
  const first = await mkdtemp(path.join(tmpdir(), "lemmacomputer-office-corpus-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "lemmacomputer-office-corpus-b-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  });
  const firstManifest = await generate(first);
  const secondManifest = await generate(second);
  assert.deepEqual(firstManifest, secondManifest);
  assert.deepEqual(firstManifest.files.map((item: { name: string }) => item.name), [
    "office-regression.docx",
    "office-regression.pptx",
    "office-regression.xlsx",
  ]);

  const validation = `
import json, sys, zipfile
from xml.etree import ElementTree
root = sys.argv[1]
checks = {
  "office-regression.docx": ["word/document.xml", "word/media/image1.png"],
  "office-regression.xlsx": ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/charts/chart1.xml"],
  "office-regression.pptx": ["ppt/slides/slide1.xml", "ppt/notesSlides/notesSlide1.xml", "ppt/media/image1.png"],
}
result = {}
for name, required in checks.items():
  with zipfile.ZipFile(root + "/" + name) as archive:
    members = set(archive.namelist())
    valid_xml = all(
      ElementTree.fromstring(archive.read(item)) is not None
      for item in members
      if item.endswith(".xml") or item.endswith(".rels")
    )
    result[name] = archive.testzip() is None and valid_xml and all(item in members for item in required)
print(json.dumps(result, sort_keys=True))
`;
  const { stdout } = await execute("python3", ["-c", validation, first]);
  assert.deepEqual(JSON.parse(stdout), {
    "office-regression.docx": true,
    "office-regression.pptx": true,
    "office-regression.xlsx": true,
  });
});

test("Office round-trip qualification never modifies its corpus and records each conversion stage", async (context) => {
  const corpus = await mkdtemp(path.join(tmpdir(), "lemmacomputer-office-corpus-"));
  const output = await mkdtemp(path.join(tmpdir(), "lemmacomputer-office-output-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([rm(corpus, { recursive: true, force: true }), rm(output, { recursive: true, force: true })]);
  });
  const manifest = await generate(corpus);
  const before = await Promise.all(manifest.files.map(async ({ name }: { name: string }) => [name, await readFile(path.join(corpus, name))] as const));
  const conversions: Array<{ from: string; to: string }> = [];
  const report = await qualifyOfficeCorpus({
    corpusDir: corpus,
    outputDir: output,
    recordedAt: "2026-08-12T05:00:00.000Z",
    convert: async ({ inputPath, outputDirectory, outputExtension }) => {
      const sourceExtension = path.extname(inputPath);
      const target = path.join(outputDirectory, `${path.basename(inputPath, sourceExtension)}.${outputExtension}`);
      conversions.push({ from: sourceExtension.slice(1), to: outputExtension });
      if (outputExtension === "pdf") await writeFile(target, "%PDF-1.7\nfixture\n");
      else await copyFile(inputPath, target);
      return target;
    },
  });

  assert.equal(report.status, "passed");
  assert.equal(report.recordedAt, "2026-08-12T05:00:00.000Z");
  assert.deepEqual(conversions, [
    { from: "docx", to: "odt" }, { from: "odt", to: "docx" }, { from: "docx", to: "pdf" },
    { from: "pptx", to: "odp" }, { from: "odp", to: "pptx" }, { from: "pptx", to: "pdf" },
    { from: "xlsx", to: "ods" }, { from: "ods", to: "xlsx" }, { from: "xlsx", to: "pdf" },
  ]);
  assert.equal(report.files.length, 3);
  for (const item of report.files) {
    assert.equal(item.status, "passed");
    assert.ok(item.inputSha256);
    assert.ok(item.roundTripSha256);
    assert.ok(item.pdfSha256);
    assert.deepEqual(item.roundTripStructure, item.inputStructure);
    assert.ok((await stat(item.roundTripPath)).size > 0);
  }
  for (const [name, bytes] of before) assert.deepEqual(await readFile(path.join(corpus, name)), bytes);
});
