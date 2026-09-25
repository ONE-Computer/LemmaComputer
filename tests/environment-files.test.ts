import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { containerMountedFilePaths } from "../scripts/development/dev-doctor-lib.mjs";
import { worktreeId } from "../scripts/development/worktree-names.mjs";
import { initializeEnvironment, parseEnvironment } from "../scripts/setup/environment-template.mjs";
import { readEnvironmentFile, renderCompactEnvironment, writeEnvironmentFile } from "../scripts/setup/environment-files.mjs";
import {
  environmentContract,
  firstPartyImageVariables,
  projectServiceEnvironment,
  renderEnvironmentTemplate,
  serializeEnvironment,
  validateDeploymentEnvironment,
  worktreeEnvironmentOverrides,
} from "../scripts/setup/deployment-config.mjs";

const installationId = "a1b2c3d4e5";
const initial = {
  ...Object.fromEntries(parseEnvironment(initializeEnvironment(renderEnvironmentTemplate(), "Etc/UTC")).values),
  ...Object.fromEntries(worktreeEnvironmentOverrides({
    slug: `lemmacomputer-${installationId}`,
    id: installationId,
    portOffset: 1000 + (Number.parseInt(installationId.slice(0, 6), 16) % 20000),
  })),
  LEMMACOMPUTER_INSTALLATION_ID: installationId,
};
const run = (script: string, file: string, ...args: string[]) => spawnSync(process.execPath, [
  `scripts/setup/${script}.mjs`, `--file=${file}`, ...args,
], { encoding: "utf8" });
const derivedKeys = [
  "LEMMACOMPUTER_COMPOSE_PROJECT_NAME",
  "LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE",
  "LEMMACOMPUTER_OPENVTC_CONSENT_IMAGE",
  "LEMMACOMPUTER_APP_VERSION",
  "LEMMACOMPUTER_MS365_MCP_IMAGE",
  "LEMMACOMPUTER_WORKSPACE_IMAGE",
  "LEMMACOMPUTER_CONTROL_NETWORK",
  "LEMMACOMPUTER_CONTROL_CONTAINER",
  "LEMMACOMPUTER_LITELLM_CONTAINER",
  "LEMMACOMPUTER_WORKSPACE_NODE_ID",
  "LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX",
  "LEMMACOMPUTER_KASM_LOCAL_EGRESS_NETWORK",
];
const integrationPlaceholderKeys = [
  "LEMMACOMPUTER_POSTMARK_SERVER_TOKEN",
  "LEMMACOMPUTER_POSTMARK_FROM",
  "LEMMACOMPUTER_GOOGLE_AUTH_CLIENT_ID",
  "LEMMACOMPUTER_GOOGLE_AUTH_CLIENT_SECRET",
  "LEMMACOMPUTER_MICROSOFT_AUTH_CLIENT_ID",
  "LEMMACOMPUTER_MICROSOFT_AUTH_CLIENT_SECRET",
  "LEMMACOMPUTER_CUSTOMER_SSO_TRUSTED_IDP_ORIGINS",
  "LEMMACOMPUTER_MS365_TENANT_ID",
  "LEMMACOMPUTER_MS365_CLIENT_ID",
  "LEMMACOMPUTER_MS365_CLIENT_SECRET",
  "LEMMACOMPUTER_MS365_SITE_ADMIN_CLIENT_ID",
  "LEMMACOMPUTER_MS365_SITE_ADMIN_CLIENT_SECRET",
  "LEMMACOMPUTER_GOOGLE_WORKSPACE_MCP_CLIENT_ID",
  "LEMMACOMPUTER_GOOGLE_WORKSPACE_MCP_CLIENT_SECRET",
  "LEMMACOMPUTER_GITHUB_MCP_CLIENT_ID",
  "LEMMACOMPUTER_GITHUB_MCP_CLIENT_SECRET",
];

test("worktree configuration resolves before npm dependencies are installed", async () => {
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
    await writeFile(join(root, ".env"), `LEMMACOMPUTER_INSTALLATION_KIND=worktree\nLEMMACOMPUTER_INSTALLATION_ID=${installationId}\n`);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
      'import { readEnvironmentFile } from "./scripts/setup/environment-files.mjs";',
      'const values = readEnvironmentFile(".env", { resolved: true });',
      `if (values.LEMMACOMPUTER_COMPOSE_PROJECT_NAME !== "lemmacomputer-${installationId}") process.exit(1);`,
      `if (values.LEMMACOMPUTER_CONTROL_RUNTIME_IMAGE !== "lemmacomputer/control-runtime:dev-${installationId}") process.exit(1);`,
    ].join("\n")], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy cleanup keeps secrets and effective configuration in one file across repeated updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-cleanup-"));
  const source = join(root, ".env");
  const values: Record<string, string> = {
    ...initial,
    LEMMACOMPUTER_POSTGRES_PASSWORD: "literal$secret#with'quotes",
    LEMMACOMPUTER_CHANNEL_POLL_INTERVAL_MS: "1700",
    LEMMACOMPUTER_PLATFORM_AUTH_BOOTSTRAP_SECRET: "", // Deliberately retired after enrollment.
    LEMMACOMPUTER_OPENAI_API_KEY: "retired-provider-secret",
    OPERATOR_TOOL_SETTING: "keep-this-setting",
  };
  delete values.LEMMACOMPUTER_INSTALLATION_ID;
  try {
    await writeFile(source, serializeEnvironment(values), { mode: 0o600 });
    const before = projectServiceEnvironment(values);
    const updated = run("update-env", source, "--write");
    assert.equal(updated.status, 0, updated.stderr);
    const cleaned = await readFile(source, "utf8");
    const compact = readEnvironmentFile(source);
    assert.equal(compact.LEMMACOMPUTER_INSTALLATION_ID, installationId);
    for (const key of derivedKeys) assert.equal(Object.hasOwn(compact, key), false, key);
    assert.equal(compact.LEMMACOMPUTER_POSTGRES_PASSWORD, values.LEMMACOMPUTER_POSTGRES_PASSWORD);
    assert.equal(compact.LEMMACOMPUTER_CHANNEL_POLL_INTERVAL_MS, "1700");
    assert.equal(compact.LEMMACOMPUTER_PLATFORM_AUTH_BOOTSTRAP_SECRET, "");
    assert.equal(compact.LEMMACOMPUTER_OPENAI_API_KEY, "retired-provider-secret");
    assert.equal(compact.OPERATOR_TOOL_SETTING, "keep-this-setting");
    assert.deepEqual(projectServiceEnvironment(compact), before);
    const resolved = readEnvironmentFile(source, { resolved: true });
    for (const [key, value] of Object.entries(values)) assert.equal(resolved[key], value, key);
    assert.equal((await stat(source)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), [".env"]);
    assert.equal(run("update-env", source, "--check").status, 0);
    const repeated = run("update-env", source, "--write");
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(await readFile(source, "utf8"), cleaned);
    assert.deepEqual(await readdir(root), [".env"]);
    assert.doesNotMatch(updated.stdout + updated.stderr + repeated.stdout + repeated.stderr, /retired-provider-secret|literal\$secret/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh initialization generates one compact file and refuses to replace its secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-init-"));
  const source = join(root, ".env");
  try {
    const initialized = run("initialize-env", source, "--profile=worktree");
    assert.equal(initialized.status, 0, initialized.stderr);
    const contents = await readFile(source, "utf8");
    const values = readEnvironmentFile(source);
    assert.match(values.LEMMACOMPUTER_INSTALLATION_ID, /^[a-f0-9]{10}$/);
    for (const item of environmentContract.filter((item: { generated?: boolean }) => item.generated)) {
      assert.equal(Object.hasOwn(values, item.key), true, item.key);
      assert.notEqual(values[item.key], item.default, item.key);
    }
    for (const key of derivedKeys) assert.equal(Object.hasOwn(values, key), false, key);
    for (const key of integrationPlaceholderKeys) assert.equal(values[key], "", key);
    assert.equal(values.LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT, "capture");
    assert.equal(values.LEMMACOMPUTER_INVITATION_DELIVERY_MODE, "copy-link");
    const resolved = readEnvironmentFile(source, { resolved: true });
    assert.equal(resolved.LEMMACOMPUTER_POSTMARK_MESSAGE_STREAM, "outbound");
    assert.equal(resolved.LEMMACOMPUTER_MICROSOFT_AUTH_TENANT_ID, "common");
    assert.ok(Object.keys(values).length < environmentContract.length / 2);
    validateDeploymentEnvironment(values, { strict: true });
    assert.deepEqual(await readdir(root), [".env"]);
    assert.equal((await stat(source)).mode & 0o777, 0o600);
    assert.notEqual(run("initialize-env", source, "--profile=worktree").status, 0);
    assert.equal(await readFile(source, "utf8"), contents);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("environment updates restore blank integration fields and preserve configured credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-integrations-"));
  const source = join(root, ".env");
  try {
    const existing: Record<string, string> = { ...initial };
    for (const key of integrationPlaceholderKeys) delete existing[key];
    delete existing.LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT;
    delete existing.LEMMACOMPUTER_INVITATION_DELIVERY_MODE;
    await writeFile(source, serializeEnvironment(existing), { mode: 0o600 });
    const before = projectServiceEnvironment(existing);
    const restored = run("update-env", source, "--write");
    assert.equal(restored.status, 0, restored.stderr);
    const placeholders = readEnvironmentFile(source);
    for (const key of integrationPlaceholderKeys) assert.equal(placeholders[key], "", key);
    assert.equal(placeholders.LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT, "capture");
    assert.equal(placeholders.LEMMACOMPUTER_INVITATION_DELIVERY_MODE, "copy-link");
    for (const key of derivedKeys) assert.equal(Object.hasOwn(placeholders, key), false, key);
    assert.deepEqual(projectServiceEnvironment(placeholders), before);

    const credentials = {
      ...Object.fromEntries(integrationPlaceholderKeys.map((key) => [key, `synthetic-${key.toLowerCase()}`])),
      LEMMACOMPUTER_POSTMARK_FROM: "Fixture <auth@example.com>",
      LEMMACOMPUTER_AUTH_EMAIL_TRANSPORT: "postmark",
      LEMMACOMPUTER_INVITATION_DELIVERY_MODE: "email",
      LEMMACOMPUTER_CUSTOMER_SSO_TRUSTED_IDP_ORIGINS: "https://idp.example.com",
    };
    const configured = { ...placeholders, ...credentials };
    await writeFile(source, serializeEnvironment(configured), { mode: 0o600 });
    const configuredServices = projectServiceEnvironment(configured);
    const updated = run("update-env", source, "--write");
    assert.equal(updated.status, 0, updated.stderr);
    const preserved = readEnvironmentFile(source);
    for (const [key, value] of Object.entries(credentials)) assert.equal(preserved[key], value, key);
    for (const key of derivedKeys) assert.equal(Object.hasOwn(preserved, key), false, key);
    assert.deepEqual(projectServiceEnvironment(preserved), configuredServices);
    assert.doesNotMatch(updated.stdout + updated.stderr, /synthetic-/);
    assert.deepEqual(await readdir(root), [".env"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("saved installation identity keeps the same defaults when its directory and branch change", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-move-"));
  const original = join(root, "original");
  const renamed = join(root, "renamed");
  try {
    await mkdir(original);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: original, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "--quiet");
    git("symbolic-ref", "HEAD", "refs/heads/original-branch");
    const source = join(original, ".env");
    await writeEnvironmentFile(source, initial);
    const before = readEnvironmentFile(source, { resolved: true });
    git("symbolic-ref", "HEAD", "refs/heads/renamed-branch");
    await rename(original, renamed);
    const moved = join(renamed, ".env");
    assert.deepEqual(readEnvironmentFile(moved, { resolved: true }), before);
    const update = run("update-env", moved, "--write");
    assert.equal(update.status, 0, update.stderr);
    assert.deepEqual(readEnvironmentFile(moved, { resolved: true }), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worktree bootstrap adopts the existing identity and compacts a legacy environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-worktree-init-"));
  const branch = "mike/legacy-env-test";
  const source = join(root, ".env");
  try {
    for (const file of [
      "scripts/development/worktree-init.mjs",
      "scripts/development/worktree-names.mjs",
      "scripts/development/compose-down.mjs",
      "scripts/development/dev-doctor-lib.mjs",
      "scripts/setup/environment-files.mjs",
      "scripts/setup/deployment-config.mjs",
      "packages/deployment-profile/src/index.mjs",
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await copyFile(file, join(root, file));
    }
    await mkdir(join(root, "node_modules"));
    for (const file of containerMountedFilePaths) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "fixture\n");
    }
    const git = spawnSync("git", ["init", "--quiet", `--initial-branch=${branch}`], { cwd: root, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    const id = worktreeId({ root, branch });
    const values: Record<string, string> = {
      ...initial,
      ...Object.fromEntries(worktreeEnvironmentOverrides({
        id,
        slug: `lemmacomputer-${id}`,
        portOffset: 1000 + (Number.parseInt(id.slice(0, 6), 16) % 20000),
      })),
      LEMMACOMPUTER_CHANNEL_POLL_INTERVAL_MS: "1700",
    };
    delete values.LEMMACOMPUTER_INSTALLATION_ID;
    await writeFile(source, serializeEnvironment(values), { mode: 0o600 });
    const before = projectServiceEnvironment(values);
    const result = spawnSync(process.execPath, ["scripts/development/worktree-init.mjs"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const compact = readEnvironmentFile(source);
    assert.equal(compact.LEMMACOMPUTER_INSTALLATION_ID, id);
    for (const key of derivedKeys) assert.equal(Object.hasOwn(compact, key), false, key);
    assert.deepEqual(projectServiceEnvironment(compact), before);
    const resolved = readEnvironmentFile(source, { resolved: true });
    for (const [key, value] of Object.entries(values)) assert.equal(resolved[key], value, key);
    assert.equal((await stat(source)).mode & 0o777, 0o600);
    await assert.rejects(stat(`${source}.state`), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("custom and legacy resource names and pinned images remain explicit overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-overrides-"));
  try {
    for (const project of ["oc-a1b2c3d4e5", "custom-installation"]) {
      const source = join(root, `${project}.env`);
      const values: Record<string, string> = {
        ...initial,
        LEMMACOMPUTER_COMPOSE_PROJECT_NAME: project,
        LEMMACOMPUTER_CONTROL_NETWORK: `${project}-private`,
        LEMMACOMPUTER_CONTROL_CONTAINER: `${project}-control`,
        LEMMACOMPUTER_APP_VERSION: "reviewed-release",
        ...Object.fromEntries(firstPartyImageVariables.map((key: string) => [key, `registry.example/${key.toLowerCase()}@sha256:${"a".repeat(64)}`])),
      };
      delete values.LEMMACOMPUTER_INSTALLATION_ID;
      await writeFile(source, serializeEnvironment(values));
      const before = projectServiceEnvironment(values);
      const updated = run("update-env", source, "--write");
      assert.equal(updated.status, 0, updated.stderr);
      const compact = readEnvironmentFile(source);
      for (const key of ["LEMMACOMPUTER_COMPOSE_PROJECT_NAME", "LEMMACOMPUTER_CONTROL_NETWORK", "LEMMACOMPUTER_CONTROL_CONTAINER", "LEMMACOMPUTER_APP_VERSION", ...firstPartyImageVariables]) {
        assert.equal(compact[key], values[key], key);
      }
      assert.deepEqual(projectServiceEnvironment(compact), before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("duplicate settings fail without rewriting the environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "lemma-env-duplicates-"));
  const source = join(root, ".env");
  try {
    const contents = renderCompactEnvironment(initial) + "LEMMACOMPUTER_POSTGRES_PASSWORD=conflict\n";
    await writeFile(source, contents, { mode: 0o600 });
    assert.throws(() => readEnvironmentFile(source), /Duplicate variables/);
    assert.notEqual(run("update-env", source, "--write").status, 0);
    assert.equal(await readFile(source, "utf8"), contents);
    assert.deepEqual(await readdir(root), [".env"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
