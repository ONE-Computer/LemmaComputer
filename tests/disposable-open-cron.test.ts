import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the workspace image pins cron and installs the persistent scheduling helpers", async () => {
  const dockerfile = await source("docker/Dockerfile.workspace");
  assert.match(dockerfile, /cron=3\.0pl1-137ubuntu3/);
  assert.match(dockerfile, /dpkg-query[\s\S]+cron[\s\S]+3\.0pl1-137ubuntu3/);
  assert.match(dockerfile, /onecomputer-crontab/);
  assert.match(dockerfile, /onecomputer-cron-run/);
  assert.match(dockerfile, /SCHEDULING\.md/);
});

test("cron is confined to disposable-open workspaces and restored from persistent home", async () => {
  const entrypoint = await source("docker/workspace/onecomputer-workspace-entrypoint.sh");
  assert.match(entrypoint, /ONECOMPUTER_EXECUTION_MODE" == "disposable-open"/);
  assert.match(entrypoint, /canonical_crontab="\/home\/kasm-user\/\.onecomputer\/crontab"/);
  assert.match(entrypoint, /\/usr\/bin\/crontab -u kasm-user "\$canonical_crontab"/);
  assert.match(entrypoint, /\/usr\/sbin\/cron -f -L 0/);
  assert.match(entrypoint, /kill -0 "\$cron_supervisor_pid"/);
  assert.match(entrypoint, /install -o 1000 -g 1000 -m 0600 \/dev\/null \/run\/onecomputer\/cron-events\.log/);
  assert.match(entrypoint, /\/usr\/bin\/crontab -u kasm-user -r/);
});

test("the cron helper persists updates and the runner bounds time, overlap, and logs", async () => {
  const [crontab, runner, guidance] = await Promise.all([
    source("docker/workspace/onecomputer-crontab"),
    source("docker/workspace/onecomputer-cron-run"),
    source("docker/workspace/SCHEDULING.md"),
  ]);
  assert.match(crontab, /canonical_file="\$\{canonical_dir\}\/crontab"/);
  assert.match(crontab, /size <= 65536/);
  assert.match(crontab, /grep -qP '\[\\x00-/);
  assert.match(crontab, /"\$runtime_crontab" "\$normalized"/);
  assert.match(crontab, /mv -f "\$normalized" "\$canonical_file"/);
  assert.match(runner, /flock -n 9/);
  assert.match(runner, /timeout --signal=TERM --kill-after=15s/);
  assert.match(runner, /5242880/);
  assert.doesNotMatch(runner, /"command":|"\$\*"/);
  assert.match(guidance, /absolute paths/i);
  assert.match(guidance, /Stop pauses all jobs/);
  assert.match(guidance, /Delete permanently removes/);
});
