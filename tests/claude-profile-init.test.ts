import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const initializer = join(process.cwd(), "docker/workspace/lemmacomputer-claude-profile-init.sh");
const uid = process.getuid!() === 0 ? 1000 : process.getuid!();
const gid = process.getgid!() === 0 ? 1000 : process.getgid!();
const initialize = (profile: string) => spawnSync("bash", [initializer, profile, String(uid), String(gid)], { encoding: "utf8" });

test("Claude profile creates both writable cache parents and preserves cache-hit state", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "lemmacomputer-claude-init-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  for (const existingCache of [false, true]) {
    const profile = join(fixture, existingCache ? "existing" : "fresh");
    const cache = join(profile, "claude-code");
    const version = join(cache, "pinned-version");
    const sentinel = join(version, "claude");
    if (existingCache) {
      // Reproduces root-created intermediate parents when this test runs as root.
      await mkdir(version, { recursive: true });
      await writeFile(sentinel, "cached engine\n");
      await chmod(sentinel, 0o750);
    }
    const before = existingCache ? await lstat(sentinel, { bigint: true }) : null;
    const result = initialize(profile);
    assert.equal(result.status, 0, result.stderr);
    for (const directory of [profile, cache]) {
      const stat = await lstat(directory);
      assert.equal(stat.uid, uid);
      assert.equal(stat.gid, gid);
      assert.ok(stat.mode & 0o200, "workspace user must be able to write its app profile");
    }
    const normalized = await lstat(profile, { bigint: true });
    assert.equal(initialize(profile).status, 0);
    assert.equal((await lstat(profile, { bigint: true })).ctimeNs, normalized.ctimeNs);
    if (before) {
      assert.deepEqual(await lstat(sentinel, { bigint: true }), before, "cached engine must not be traversed or rewritten");
      assert.equal(await readFile(sentinel, "utf8"), "cached engine\n");
    }
  }
});

test("Claude profile rejects symlinked profile and cache parents", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "lemmacomputer-claude-init-link-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const target = join(fixture, "employee-data");
  await mkdir(target);
  const before = await lstat(target, { bigint: true });
  const profile = join(fixture, "profile");
  await symlink(target, profile);
  assert.equal(initialize(profile).status, 78);
  await rm(profile);
  await mkdir(profile);
  await symlink(target, join(profile, "claude-code"));
  assert.equal(initialize(profile).status, 78);
  assert.deepEqual(await lstat(target, { bigint: true }), before);
});
