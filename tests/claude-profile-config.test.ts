import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const configurator = path.resolve(import.meta.dirname, "../docker/workspace/lemmacomputer-claude-config.py");

test("Claude receives exactly the three governed product modes with one explicit default", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lemmacomputer-claude-profile-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, "managed-settings.json");
  const configure = async (serviceClass: string) => {
    await execute("python3", [
      configurator,
      output,
      "claude-sonnet-4-6",
      "lemmacomputer-auto",
      serviceClass,
      "Claude — organization route",
      "true",
      "true",
    ]);
    return JSON.parse(await readFile(output, "utf8"));
  };

  const managed = await configure("pro");
  assert.deepEqual(managed.inferenceModels, [
    { name: "claude-sonnet-4-6-20260103", labelOverride: "Pro — organization route", anthropicFamilyTier: "sonnet", isFamilyDefault: true },
    { name: "claude-sonnet-4-6-20260101", labelOverride: "Lite — organization route", anthropicFamilyTier: "sonnet", isFamilyDefault: false },
    { name: "claude-sonnet-4-6-20260102", labelOverride: "Balanced — organization route", anthropicFamilyTier: "sonnet", isFamilyDefault: false },
  ]);
  assert.ok(managed.inferenceModels.every((model: { name: string }) => (
    model.name.replace(/-20\d{6}$/, "") === "claude-sonnet-4-6"
  )), "pinned Claude must recognize every mode as effort-capable sonnet-4-6");
  assert.equal(managed.modelDiscoveryEnabled, false);
  assert.equal(managed.inferenceGatewayBaseUrl, "http://127.0.0.1:4312");
  assert.equal(managed.autoModeEnabled, false);

  const legacy = await configure("auto");
  assert.equal(legacy.inferenceModels[0]?.name, "claude-sonnet-4-6-20260102");
  assert.equal(legacy.inferenceModels.find((model: { isFamilyDefault: boolean }) => model.isFamilyDefault)?.name, "claude-sonnet-4-6-20260102");
});
