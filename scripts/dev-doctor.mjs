import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const run = (command, args) => spawnSync(command, args, { encoding: "utf8" });
const failures = [];
const branchResult = run("git", ["branch", "--show-current"]);
const branch = branchResult.stdout.trim();
if (branchResult.status !== 0 || !branch) failures.push("cannot determine the current branch");
if (branch === "main") failures.push("main is demo-only; work from an issue branch/worktree");
if (await access("node_modules").then(() => false).catch(() => true)) failures.push("dependencies are missing; run npm run worktree:init");
const hooks = run("git", ["config", "--get", "core.hooksPath"]).stdout.trim();
if (hooks !== ".githooks") failures.push("local safety hooks are not installed; run npm run worktree:init");
let env = "";
try { env = await readFile(".env", "utf8"); } catch { failures.push(".env is missing; run npm run worktree:init"); }
const value = (key) => env.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim();
for (const key of ["ONECOMPUTER_COMPOSE_PROJECT_NAME", "ONECOMPUTER_CONTROL_NETWORK", "ONECOMPUTER_CONTROL_CONTAINER", "ONECOMPUTER_LITELLM_CONTAINER"]) {
  if (!value(key)?.startsWith("oc-")) failures.push(`${key} is not worktree-isolated`);
}
const context = run("docker", ["context", "show"]);
if (context.status === 0 && context.stdout.trim() === (process.env.ONECOMPUTER_DEMO_DOCKER_CONTEXT ?? "onecomputer-demo")) {
  failures.push("the active Docker context is reserved for the demo deployment");
}
if (failures.length) {
  process.stderr.write(["Development safety check failed:", ...failures.map((item) => `- ${item}`), ""].join("\n"));
  process.exitCode = 1;
} else {
  process.stdout.write(`Development safety check passed for ${branch} (${value("ONECOMPUTER_COMPOSE_PROJECT_NAME")}).\n`);
}
