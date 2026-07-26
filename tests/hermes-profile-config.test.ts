import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const configurator = path.join(root, "infra/issue-010/onecomputer-hermes-config.py");
const officeSkills = ["docx", "ocr-and-documents", "pdf", "powerpoint", "xlsx"];

const installSkill = async (bundle: string, name: string) => {
  const directory = path.join(bundle, "productivity", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name} skill.\n---\n\n# ${name}\n`,
  );
};

test("Hermes defaults only Office skills on and preserves later employee toggles", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "onecomputer-hermes-profile-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "profile");
  const bundle = path.join(temporary, "bundle");
  const modules = path.join(temporary, "modules");
  await mkdir(modules, { recursive: true });
  await writeFile(
    path.join(modules, "toolsets.py"),
    "TOOLSETS = {}\ndef resolve_toolset(name):\n    return {name}\n",
  );
  for (const skill of [...officeSkills, "teams-meeting-pipeline"]) {
    await installSkill(bundle, skill);
  }

  const configure = () => execute("python3", [
    configurator,
    home,
    "onecomputer-glm",
    "allowed-tool",
    "4314",
    "disposable-open",
    bundle,
  ], {
    env: { ...process.env, PYTHONPATH: modules },
  });

  await configure();
  const first = JSON.parse(await readFile(path.join(home, "config.yaml"), "utf8"));
  assert.deepEqual(first.skills.disabled, ["teams-meeting-pipeline"]);
  for (const skill of officeSkills) {
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
    await readFile(path.join(home, ".onecomputer-skill-defaults.json"), "utf8"),
  );
  assert.equal(state.version, 1);
  assert.ok(state.bundledSkills.includes("airtable"));
  assert.ok(state.bundledSkills.includes("teams-meeting-pipeline"));
});
