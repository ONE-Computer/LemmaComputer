import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const initializer = join(root, "docker/workspace/lemmacomputer-workspace-home-init.sh");

test("workspace home initialization changes only the volume root", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lemmacomputer-workspace-home-"));
  const home = join(fixture, "home");
  const unrelated = join(home, "employee-data", "archive");
  const sentinel = join(unrelated, "do-not-touch.txt");
  try {
    await mkdir(unrelated, { recursive: true });
    await writeFile(sentinel, "employee-owned content\n", "utf8");
    await chmod(sentinel, 0o640);
    const fixedTime = new Date("2024-01-02T03:04:05.000Z");
    await utimes(sentinel, fixedTime, fixedTime);
    for (let index = 0; index < 256; index += 1) {
      await writeFile(join(unrelated, `unrelated-${index}.txt`), `${index}\n`, "utf8");
    }

    const before = await lstat(sentinel, { bigint: true });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    assert.equal(typeof uid, "number");
    assert.equal(typeof gid, "number");
    const workspaceUid = uid === 0 ? 1000 : uid;
    const workspaceGid = gid === 0 ? 1000 : gid;
    const result = spawnSync("bash", [initializer, home, String(workspaceUid), String(workspaceGid)], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const homeAfterFirstAttach = await lstat(home, { bigint: true });
    assert.equal(homeAfterFirstAttach.uid, BigInt(workspaceUid));
    assert.equal(homeAfterFirstAttach.gid, BigInt(workspaceGid));
    const restart = spawnSync("bash", [initializer, home, String(workspaceUid), String(workspaceGid)], {
      encoding: "utf8",
    });
    assert.equal(restart.status, 0, restart.stderr);
    const homeAfterRestart = await lstat(home, { bigint: true });
    assert.equal(homeAfterRestart.ctimeNs, homeAfterFirstAttach.ctimeNs, "normalized roots must not be rewritten");
    const after = await lstat(sentinel, { bigint: true });
    assert.equal(await readFile(sentinel, "utf8"), "employee-owned content\n");
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode, before.mode);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("workspace home initialization rejects symbolic-link mount points", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lemmacomputer-workspace-home-link-"));
  try {
    const target = join(fixture, "target");
    const link = join(fixture, "home");
    await mkdir(target);
    await symlink(target, link);
    const result = spawnSync("bash", [initializer, link, "1000", "1000"], { encoding: "utf8" });
    assert.equal(result.status, 78);
    assert.match(result.stderr, /workspace home must be a directory, not a symbolic link/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("workspace startup ownership remains bounded and readiness remains holistic", async () => {
  const [dockerfile, entrypoint, homeInitializer, adapter] = await Promise.all([
    readFile(join(root, "docker/Dockerfile.workspace"), "utf8"),
    readFile(join(root, "docker/workspace/lemmacomputer-workspace-entrypoint.sh"), "utf8"),
    readFile(initializer, "utf8"),
    readFile(join(root, "packages/kasm-adapter/src/index.ts"), "utf8"),
  ]);

  assert.match(dockerfile, /COPY --chmod=0755 docker\/workspace\/lemmacomputer-workspace-home-init\.sh/);
  assert.match(dockerfile, /chown -R 1000:1000 \/home\/kasm-default-profile/);
  assert.match(adapter, /Target: "\/home\/kasm-user",[\s\S]+VolumeOptions: \{ NoCopy: true \}/);
  assert.doesNotMatch(homeInitializer, /chown\s+-R|find\s+[^\n]+workspace_home/);
  assert.doesNotMatch(entrypoint, /chown\s+-R\s+1000:1000\s+\/home\/kasm-user/);
  assert.doesNotMatch(entrypoint, /chown\s+-R\s+1000:1000\s+"\$hermes_home"/);
  assert.doesNotMatch(entrypoint, /find\s+"\$hermes_home"/);

  const volumeRootInitialization = entrypoint.indexOf("lemmacomputer-workspace-home-init /home/kasm-user 1000 1000");
  const profileInitialization = entrypoint.indexOf("/dockerstartup/kasm_default_profile.sh /bin/true");
  const managedConfiguration = entrypoint.indexOf("startup_phase_begin managed-configuration");
  const agentBrokers = entrypoint.indexOf("startup_phase_begin agent-brokers");
  const selectedAgentRuntimes = entrypoint.indexOf("startup_phase_begin selected-agent-runtimes");
  const scheduling = entrypoint.indexOf("startup_phase_begin scheduling");
  const readyMarker = entrypoint.indexOf("touch /run/lemmacomputer/workspace-ready");
  for (const boundary of [
    volumeRootInitialization,
    profileInitialization,
    managedConfiguration,
    agentBrokers,
    selectedAgentRuntimes,
    scheduling,
    readyMarker,
  ]) assert.ok(boundary >= 0);
  assert.ok(volumeRootInitialization < profileInitialization);
  assert.ok(profileInitialization < managedConfiguration);
  assert.ok(managedConfiguration < agentBrokers);
  assert.ok(agentBrokers < selectedAgentRuntimes);
  assert.ok(selectedAgentRuntimes < scheduling);
  assert.ok(scheduling < readyMarker, "selected agents and scheduling must finish before Ready");
});
