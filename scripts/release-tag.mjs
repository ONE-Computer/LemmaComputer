import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { releaseAttestationSchemaVersion, requiredReleaseGates } from "./release-gates.mjs";

const push = process.argv.includes("--push");
const requestedTag = process.argv.find((argument) => argument.startsWith("--tag="))?.slice(6);
if (requestedTag && (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(requestedTag) || requestedTag.includes(".."))) {
  throw new Error("Custom release tags must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens");
}

const capture = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout.trim();
};
const succeeds = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status === 0;

const root = capture("git", ["rev-parse", "--show-toplevel"]);
process.chdir(root);
if (capture("git", ["status", "--porcelain"])) throw new Error("Release tagging requires a clean worktree");

const sha = capture("git", ["rev-parse", "HEAD"]);
const branch = capture("git", ["branch", "--show-current"]);
if (branch !== "main" && !branch.startsWith("release/")) {
  throw new Error("Release tagging must run on main or a release/* branch");
}

const attestation = JSON.parse(await readFile(`.artifacts/release-verification/${sha}.json`, "utf8"));
const requiredFirstPartyImages = ["control-runtime", "openvtc-consent", "ms365-mcp", "workspace"];
if (
  attestation.schemaVersion !== releaseAttestationSchemaVersion
  || attestation.sha !== sha
  || attestation.branch !== branch
  || !Array.isArray(attestation.gates)
  || requiredReleaseGates.some((gate) => !attestation.gates.includes(gate))
  || !Array.isArray(attestation.images)
  || attestation.images.length !== requiredFirstPartyImages.length
  || requiredFirstPartyImages.some((name) => {
    const image = attestation.images.find((candidate) => candidate?.name === name);
    return !image
      || !/^sha256:[a-f0-9]{64}$/.test(image.builtDigest)
      || typeof image.reference !== "string"
      || !Array.isArray(image.repositoryDigests)
      || image.repositoryDigests.some((digest) => !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(digest));
  })
) {
  throw new Error("Release verification attestation does not match the current commit and branch");
}
const ageMs = Date.now() - Date.parse(attestation.verifiedAt);
if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) {
  throw new Error("Release verification is older than 24 hours; rerun npm run verify:release");
}

const migrationFiles = (await readdir("packages/workspace-store/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const currentMigrations = [];
for (const file of migrationFiles) {
  currentMigrations.push({
    file,
    sha256: createHash("sha256")
      .update(await readFile(`packages/workspace-store/migrations/${file}`))
      .digest("hex"),
  });
}
if (JSON.stringify(currentMigrations) !== JSON.stringify(attestation.migrations)) {
  throw new Error("Migration manifest differs from the verified release");
}

capture("git", ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
const remoteSha = capture("git", ["rev-parse", `origin/${branch}`]);
if (remoteSha !== sha) {
  throw new Error(`Current commit must already be pushed to origin/${branch} before release tagging`);
}

const tag = requestedTag
  ?? `demo-${attestation.verifiedAt.slice(0, 10).replaceAll("-", "")}-${sha.slice(0, 12)}`;
if (succeeds("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`])
  || succeeds("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`])) {
  throw new Error(`Release tag ${tag} already exists; create a new tag instead of moving it`);
}

if (!push) {
  process.stdout.write(`Verified ${sha} on ${branch} is eligible for immutable tag ${tag}. Rerun with --push to create it.\n`);
  process.exit(0);
}

capture("git", ["tag", "-a", tag, sha, "-m", `LemmaComputer release ${tag}`]);
try {
  capture("git", ["push", "origin", `refs/tags/${tag}`]);
} catch (error) {
  spawnSync("git", ["tag", "-d", tag], { stdio: "ignore" });
  throw error;
}
process.stdout.write(`Created and pushed immutable release tag ${tag} for ${sha}.\n`);
