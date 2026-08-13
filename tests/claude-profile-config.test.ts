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
    { name: "lemmacomputer-claude-haiku-lite", labelOverride: "Lite — organization route", anthropicFamilyTier: "haiku", isFamilyDefault: false },
    { name: "lemmacomputer-claude-sonnet-balanced", labelOverride: "Balanced — organization route", anthropicFamilyTier: "sonnet", isFamilyDefault: false },
    { name: "lemmacomputer-claude-opus-pro", labelOverride: "Pro — organization route", anthropicFamilyTier: "opus", isFamilyDefault: true },
  ]);
  assert.ok(managed.inferenceModels.every((model: { name: string }) => model.name.includes("claude")), "pinned Claude rejects gateway IDs that are not Anthropic-shaped");
  assert.equal(managed.modelDiscoveryEnabled, false);
  assert.equal(managed.inferenceGatewayBaseUrl, "http://127.0.0.1:4312");
  assert.equal(managed.autoModeEnabled, false);

  const legacy = await configure("auto");
  assert.equal(legacy.inferenceModels.find((model: { isFamilyDefault: boolean }) => model.isFamilyDefault)?.name, "lemmacomputer-claude-sonnet-balanced");
});
