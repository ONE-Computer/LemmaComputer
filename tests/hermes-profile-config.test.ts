import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const configurator = path.join(root, "docker/workspace/lemmacomputer-hermes-config.py");
const officeSkills = ["docx", "ocr-and-documents", "pdf", "powerpoint", "xlsx"];

const installSkill = async (bundle: string, name: string) => {
  const directory = path.join(bundle, "productivity", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name} skill.\n---\n\n# ${name}\n`,
  );
};

test("Hermes enables reviewed default skills and preserves later employee toggles", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lemmacomputer-hermes-profile-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "profile");
  const bundle = path.join(temporary, "bundle");
  const modules = path.join(temporary, "modules");
  await mkdir(modules, { recursive: true });
  await writeFile(
    path.join(modules, "toolsets.py"),
    "TOOLSETS = {}\ndef resolve_toolset(name):\n    return {name}\n",
  );
  for (const skill of [...officeSkills, "make-a-site", "teams-meeting-pipeline"]) {
    await installSkill(bundle, skill);
  }

  const configure = () => execute("python3", [
    configurator,
    home,
    "lemmacomputer-auto",
    "balanced",
    "allowed-tool",
    "4314",
    "disposable-open",
    bundle,
  ], {
    env: { ...process.env, PYTHONPATH: modules, LEMMACOMPUTER_MODEL_LIMITS: JSON.stringify({ balanced: { contextTokens: 1000000, outputTokens: 32768 }, pro: { contextTokens: 2000000, outputTokens: 65536 } }) },
  });

  await configure();
  const first = JSON.parse(await readFile(path.join(home, "config.yaml"), "utf8"));
  assert.equal(first.model.default, "lemmacomputer-balanced");
  assert.equal(first.model.provider, "custom");
  assert.equal(first.model.context_length, undefined, "do not pin all aliases to the default tier");
  assert.equal(first.model.max_tokens, 32768);
  assert.equal(first.custom_providers[0].models["lemmacomputer-balanced"].context_length, 1000000);
  assert.equal(first.custom_providers[0].models["lemmacomputer-pro"].context_length, 2000000);
  assert.deepEqual(first.compression, { enabled: true });
  assert.deepEqual(first.auxiliary.compression, { provider: "main" });
  assert.deepEqual(first.mcp_servers.lemmacomputer_connectors.env, {
    LEMMACOMPUTER_CONNECTORS_BROKER: "http://127.0.0.1:4314",
    LEMMACOMPUTER_CONNECTOR_RECOVERY_DEADLINE_SECONDS: "60",
    LEMMACOMPUTER_CONNECTOR_RECOVERY_STATE_FILE: path.join(home, ".lemmacomputer-connectors-recovery.json"),
  });

  const legacyHome = path.join(temporary, "legacy-profile");
  await execute("python3", [
    configurator,
    legacyHome,
    "lemmacomputer-auto",
    "auto",
    "allowed-tool",
    "4314",
    "disposable-open",
    bundle,
  ], {
    env: { ...process.env, PYTHONPATH: modules },
  });
  const legacy = JSON.parse(await readFile(path.join(legacyHome, "config.yaml"), "utf8"));
  assert.equal(legacy.model.default, "lemmacomputer-balanced", "legacy Auto workspace defaults migrate safely to Balanced");
  assert.deepEqual(first.skills.disabled, ["teams-meeting-pipeline"]);
  for (const skill of [...officeSkills, "make-a-site"]) {
    assert.ok(!first.skills.disabled.includes(skill));
  }

  // Model the employee enabling Teams and disabling DOCX in Hermes Desktop.
  first.skills.disabled = ["docx"];
  first.skills.platform_disabled = { api_server: ["pdf"] };
  await writeFile(path.join(home, "config.yaml"), JSON.stringify(first));
  await installSkill(bundle, "airtable");

  await configure();
  const second = JSON.parse(await readFile(path.join(home, "config.yaml"), "utf8"));
  assert.deepEqual(second.skills.disabled, ["airtable", "docx"]);
  assert.deepEqual(second.skills.platform_disabled, { api_server: ["pdf"] });
  assert.ok(!second.skills.disabled.includes("teams-meeting-pipeline"));

  const state = JSON.parse(
    await readFile(path.join(home, ".lemmacomputer-skill-defaults.json"), "utf8"),
  );
  assert.equal(state.version, 1);
  assert.ok(state.bundledSkills.includes("airtable"));
  assert.ok(state.bundledSkills.includes("teams-meeting-pipeline"));
});
