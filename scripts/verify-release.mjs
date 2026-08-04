import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { releaseAttestationSchemaVersion, requiredReleaseGates } from "./release-gates.mjs";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
};
const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
};
if (capture("git", ["status", "--porcelain"])) throw new Error("Release verification requires a clean committed worktree");
const sha = capture("git", ["rev-parse", "HEAD"]);
const branch = capture("git", ["branch", "--show-current"]);
if (branch !== "main" && !branch.startsWith("release/")) {
  throw new Error("Release verification must run on main or a release/* branch");
}
const env = await readFile(".env", "utf8");
const envValue = (name) => env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
const composeProject = envValue("LEMMACOMPUTER_COMPOSE_PROJECT_NAME");
const workspaceImage = envValue("LEMMACOMPUTER_WORKSPACE_IMAGE");
const workspaceNetworkPrefix = envValue("LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX");
if (
  !composeProject
  || composeProject === "lemmacomputer"
  || !workspaceImage
  || workspaceImage === "lemmacomputer/workspace:dev"
  || !workspaceNetworkPrefix
  || workspaceNetworkPrefix === "lemmacomputer-workspace"
) {
  throw new Error("Release verification requires an isolated worktree initialized with npm run worktree:init");
}
// compose.yaml consumes ignored per-service files. Render and validate them
// immediately before any release command can invoke Docker Compose.
run(process.execPath, ["scripts/render-service-env.mjs"]);
run("npm", ["run", "qualify:providers"]);
run("npm", ["run", "qualify:mcp-egress"]);
run("npm", ["run", "qualify:oauth"]);
run(process.execPath, ["scripts/verify-quick.mjs"]);
run(process.execPath, ["scripts/verify-db.mjs"]);
let composeAttempted = false;
try {
  run("docker", ["compose", "--profile", "build", "build", "workspace-image"]);
  run("docker", ["image", "inspect", workspaceImage]);
  composeAttempted = true;
  run("docker", ["compose", "up", "-d", "--build", "--wait", "--wait-timeout", "300"]);
  const webUrl = env.match(/^LEMMACOMPUTER_PUBLIC_WEB_URL=(.+)$/m)?.[1]?.trim();
  if (!webUrl) throw new Error("LEMMACOMPUTER_PUBLIC_WEB_URL is missing");
  run("curl", ["--fail", "--silent", "--show-error", `${webUrl}/__lemmacomputer/healthz`]);
  const qualifier = `${process.cwd()}/scripts/qualify-workspace-startup.mts`;
  run("docker", [
    "compose", "run", "--rm", "--no-deps",
    "-v", `${qualifier}:/app/scripts/qualify-workspace-startup.mts:ro`,
    "control-api", "./node_modules/.bin/tsx", "/app/scripts/qualify-workspace-startup.mts",
  ]);
} finally {
  if (composeAttempted) run(process.execPath, ["scripts/compose-down.mjs", "--volumes"]);
}
if (capture("git", ["rev-parse", "HEAD"]) !== sha || capture("git", ["status", "--porcelain"])) {
  throw new Error("Worktree changed during release verification");
}
const migrationFiles = (await readdir("packages/workspace-store/migrations")).filter((name) => name.endsWith(".sql")).sort();
const migrations = [];
for (const file of migrationFiles) {
  const contents = await readFile(`packages/workspace-store/migrations/${file}`);
  migrations.push({ file, sha256: createHash("sha256").update(contents).digest("hex") });
}
const attestation = {
  schemaVersion: releaseAttestationSchemaVersion,
  sha,
  branch,
  verifiedAt: new Date().toISOString(),
  gates: requiredReleaseGates,
  migrations,
};
await mkdir(".artifacts/release-verification", { recursive: true });
await writeFile(`.artifacts/release-verification/${sha}.json`, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Release verification passed for ${sha}.\n`);
