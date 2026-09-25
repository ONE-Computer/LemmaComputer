import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { initializeEnvironment, parseEnvironment } from "../scripts/setup/environment-template.mjs";
import { readEnvironmentFiles, writeEnvironmentFiles } from "../scripts/setup/environment-files.mjs";
import {
  projectServiceEnvironment,
  renderEnvironmentTemplate,
  serializeEnvironment,
  validateDeploymentEnvironment,
  worktreeEnvironmentOverrides,
} from "../scripts/setup/deployment-config.mjs";

const initial = {
  ...Object.fromEntries(parseEnvironment(initializeEnvironment(renderEnvironmentTemplate(), "Etc/UTC")).values),
  ...Object.fromEntries(worktreeEnvironmentOverrides({ slug: "lemmacomputer-test", id: "test", portOffset: 1234 })),
};
const run = (script: string, file: string, ...args: string[]) => spawnSync(process.execPath, [
  `scripts/setup/${script}.mjs`, `--file=${file}`, ...args,
], { encoding: "utf8" });

test("worktree configuration can be read before npm dependencies are installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-bootstrap-"));
  try {
    for (const file of [
      "scripts/setup/environment-files.mjs",
      "scripts/setup/deployment-config.mjs",
      "packages/deployment-profile/src/index.mjs",
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await copyFile(file, join(root, file));
    }
    await writeFile(join(root, ".env"), "LEMMACOMPUTER_INSTALLATION_KIND=worktree\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
      'import { readEnvironmentFiles } from "./scripts/setup/environment-files.mjs";',
      'if (readEnvironmentFiles().LEMMACOMPUTER_INSTALLATION_KIND !== "worktree") process.exit(1);',
    ].join("\n")], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup preserves service inputs, resource identity, custom values and secret literals across repeated updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-cleanup-"));
  const source = join(root, ".env");
  const values = {
    ...initial,
    LEMMACOMPUTER_POSTGRES_PASSWORD: "literal$secret#with'quotes",
    LEMMACOMPUTER_CHANNEL_POLL_INTERVAL_MS: "1700",
    LEMMACOMPUTER_PLATFORM_AUTH_BOOTSTRAP_SECRET: "", // Deliberately retired after enrollment.
    LEMMACOMPUTER_OPENAI_API_KEY: "retired-provider-secret",
  };
  try {
    await writeFile(source, serializeEnvironment(values), { mode: 0o600 });
    const before = projectServiceEnvironment(values);
    const updated = run("update-env", source, "--write");
    assert.equal(updated.status, 0, updated.stderr);
    const cleaned = await readFile(source, "utf8");
    assert.doesNotMatch(cleaned, /IMAGE=|PASSWORD=|OPENAI_API_KEY=/);
    assert.match(cleaned, /LEMMACOMPUTER_CHANNEL_POLL_INTERVAL_MS=1700/);
    assert.equal(parseEnvironment(cleaned).values.size, 6);
    assert.deepEqual(projectServiceEnvironment(readEnvironmentFiles(source)), before);
    assert.deepEqual(readEnvironmentFiles(source, { resolved: true }), values);
    const state = await readFile(`${source}.state`, "utf8");
    assert.equal((await stat(source)).mode & 0o777, 0o600);
    assert.equal((await stat(`${source}.state`)).mode & 0o777, 0o600);
    assert.equal(run("update-env", source, "--check").status, 0);
    assert.equal(run("update-env", source, "--write").status, 0);
    assert.equal(await readFile(source, "utf8"), cleaned);
    assert.equal(await readFile(`${source}.state`, "utf8"), state);
    assert.doesNotMatch(updated.stdout + updated.stderr, /retired-provider-secret|literal\$secret/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh initialization produces a small operator file and refuses to replace existing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-init-"));
  const source = join(root, ".env");
  try {
    const initialized = run("initialize-env", source, "--profile=worktree");
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(parseEnvironment(await readFile(source, "utf8")).values.size, 5);
    validateDeploymentEnvironment(readEnvironmentFiles(source), { strict: true });
    await unlink(source);
    assert.notEqual(run("initialize-env", source, "--profile=worktree").status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing state and conflicting values fail without generating replacement keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-state-"));
  const source = join(root, ".env");
  try {
    await writeEnvironmentFiles(source, initial);
    const operator = await readFile(source, "utf8");
    // An interrupted single-file migration can leave identical duplicate entries.
    await writeFile(source, operator + `LEMMACOMPUTER_POSTGRES_PASSWORD=${initial.LEMMACOMPUTER_POSTGRES_PASSWORD}\n`);
    assert.equal(readEnvironmentFiles(source).LEMMACOMPUTER_POSTGRES_PASSWORD, initial.LEMMACOMPUTER_POSTGRES_PASSWORD);
    await writeFile(source, operator + "LEMMACOMPUTER_POSTGRES_PASSWORD=conflict\n");
    assert.throws(() => readEnvironmentFiles(source), /conflicting values/);
    await writeFile(source, operator);
    await unlink(`${source}.state`);
    assert.throws(() => readEnvironmentFiles(source), /restore installation state/);
    const update = run("update-env", source, "--write");
    assert.notEqual(update.status, 0);
    assert.equal(await readFile(source, "utf8"), operator);
    await assert.rejects(stat(`${source}.state`), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
