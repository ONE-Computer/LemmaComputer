import { createHash } from "node:crypto";
import { open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sha = process.argv.find((argument) => argument.startsWith("--sha="))?.slice(6);
const push = process.argv.includes("--push");
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("Usage: npm run release:promote -- --sha=<40-char-sha> [--push]");
const capture = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout.trim();
};
const root = capture("git", ["rev-parse", "--show-toplevel"]);
process.chdir(root);
if (capture("git", ["status", "--porcelain"])) throw new Error("Promotion requires a clean worktree");
capture("git", ["cat-file", "-e", `${sha}^{commit}`]);
const attestation = JSON.parse(await readFile(`.artifacts/release-verification/${sha}.json`, "utf8"));
if (attestation.sha !== sha) throw new Error("Verification attestation SHA mismatch");
const ageMs = Date.now() - Date.parse(attestation.verifiedAt);
if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) throw new Error("Verification attestation is older than 24 hours; rerun verify:release");
const migrationFiles = (await readdir("packages/workspace-store/migrations")).filter((name) => name.endsWith(".sql")).sort();
const currentMigrations = [];
for (const file of migrationFiles) currentMigrations.push({
  file,
  sha256: createHash("sha256").update(await readFile(`packages/workspace-store/migrations/${file}`)).digest("hex"),
});
if (JSON.stringify(currentMigrations) !== JSON.stringify(attestation.migrations)) throw new Error("Migration manifest differs from the verified attestation");
if (!push) {
  process.stdout.write(`Verified ${sha} is eligible for promotion. Rerun with --push to atomically update main and an immutable demo tag.\n`);
  process.exit(0);
}
capture("git", ["fetch", "origin", "main"]);
const remoteMain = capture("git", ["rev-parse", "origin/main"]);
if (remoteMain !== attestation.originMain) throw new Error("origin/main changed after verification; rebase and rerun verify:release");
const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", remoteMain, sha]);
if (ancestor.status !== 0) throw new Error("Verified SHA is not a fast-forward of origin/main");
const commonDirRaw = capture("git", ["rev-parse", "--git-common-dir"]);
const commonDir = resolve(root, commonDirRaw);
const lockPath = resolve(dirname(commonDir), `${commonDir.split("/").at(-1)}-onecomputer-release.lock`);
let lock;
try {
  lock = await open(lockPath, "wx", 0o600);
  const tag = `demo-${attestation.verifiedAt.slice(0, 10).replaceAll("-", "")}-${sha.slice(0, 12)}`;
  capture("git", ["push", "--atomic", "origin", `${sha}:refs/heads/main`, `${sha}:refs/tags/${tag}`], {
    env: { ...process.env, ONECOMPUTER_RELEASE_PROMOTION: "1" },
  });
  process.stdout.write(`Promoted ${sha} to main and immutable tag ${tag}.\n`);
} finally {
  await lock?.close();
  await rm(lockPath, { force: true });
}
