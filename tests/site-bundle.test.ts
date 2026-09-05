import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createDeterministicSiteZip, normalizeSiteAssetPath, validateSiteBundle } from "../apps/control-api/src/site-bundle.js";

test("validates a deterministic multi-file site bundle and manifest", () => {
  const zip = createDeterministicSiteZip(new Map([
    ["index.html", Buffer.from("<!doctype html><html><script src=\"./assets/app.js\"></script></html>")],
    ["assets/app.js", Buffer.from("fetch('./snapshot.json').then(() => { document.body.dataset.ready = 'yes' })")],
    ["assets/snapshot.json", Buffer.from("{\"ready\":true}")],
    ["data/snapshot.json", Buffer.from("{\"value\":42}")],
  ]));
  const checked = validateSiteBundle(zip);
  assert.equal(checked.manifest.files.length, 4);
  assert.deepEqual(checked.manifest.files.map((file) => file.path), ["assets/app.js", "assets/snapshot.json", "data/snapshot.json", "index.html"]);
  assert.equal(checked.files.get("data/snapshot.json")?.toString(), "{\"value\":42}");
  assert.equal(validateSiteBundle(zip).archiveSha256, checked.archiveSha256);
});

test("rejects unsafe paths, secrets, direct databases, and remote resources", () => {
  for (const [path, content] of [
    [".env", "PASSWORD='not-for-sites'"],
    ["config.json", "{\"database\":\"postgres://db.example/test\"}"],
    ["app.js", "fetch('https://example.com/data')"],
    ["app.js", "fetch('/api/v1/sites')"],
    ["app.js", "fetch(variableUrl)"],
    ["app.js", "fetch('./../api/v1/sites')"],
    ["app.js", "navigator.sendBeacon('./collect', 'data')"],
    ["style.css", "@import 'https://example.com/style.css'"],
  ]) {
    assert.throws(() => {
      const zip = createDeterministicSiteZip(new Map([["index.html", Buffer.from("<html></html>")], [path, Buffer.from(content)]]));
      validateSiteBundle(zip);
    });
  }
  assert.throws(() => createDeterministicSiteZip(new Map([["index.html", Buffer.from("<html></html>")], ["../escape.js", Buffer.from("")]])));
  assert.throws(() => normalizeSiteAssetPath("%2e%2e/secret"));
});

test("accepts the deterministic ZIP emitted by the workspace publisher", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemmacomputer-site-bundle-"));
  const dist = join(root, "dist");
  try {
    await mkdir(join(dist, "data"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<!doctype html><html><script src=\"./app.js\"></script></html>");
    await writeFile(join(dist, "app.js"), "document.body.dataset.ready = 'yes'");
    await writeFile(join(dist, "data", "snapshot.json"), "{\"value\":42}");
    const script = [
      "import base64, importlib.util, json, sys",
      "from pathlib import Path",
      "sys.dont_write_bytecode=True",
      "spec=importlib.util.spec_from_file_location('site_publisher', sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "archive,manifest,manifest_sha=module.bundle(Path(sys.argv[2]))",
      "print(json.dumps({'archive':base64.b64encode(archive).decode(),'manifestSha256':manifest_sha}))",
    ].join(";");
    const result = spawnSync("python3", ["-c", script, resolve("docker/workspace/lemmacomputer-sites.py"), dist], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { archive: string; manifestSha256: string };
    const validated = validateSiteBundle(Buffer.from(output.archive, "base64"));
    assert.equal(validated.manifestSha256, output.manifestSha256);
    assert.deepEqual(validated.manifest.files.map((file) => file.path), ["app.js", "data/snapshot.json", "index.html"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed archives and missing root index", () => {
  assert.throws(() => validateSiteBundle(Buffer.from("not a zip")));
  assert.throws(() => createDeterministicSiteZip(new Map([["nested/index.html", Buffer.from("<html></html>")]])));
});
