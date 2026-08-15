import { access, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { worktreeEnvironmentOverrides } from "./deployment-config.mjs";
import { runtimeContainerFilters } from "./compose-down.mjs";
import { containerMountedFilePaths } from "./dev-doctor-lib.mjs";
import {
  applyWorktreeEnvironmentOverrides,
  legacyWorktreeSlug,
  worktreeId,
  worktreeSlug,
} from "./worktree-names.mjs";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
};
const exists = (path) => access(path).then(() => true).catch(() => false);
const root = run("git", ["rev-parse", "--show-toplevel"]);
process.chdir(root);
const branch = run("git", ["branch", "--show-current"]);
if (!branch || branch === "main") throw new Error("Worktree bootstrap is forbidden on main; create an issue branch/worktree first");
const id = worktreeId({ root, branch });
const slug = worktreeSlug(id);
const legacySlug = legacyWorktreeSlug(id);
const portOffset = 1000 + (Number.parseInt(id.slice(0, 6), 16) % 20000);

const localModules = resolve(root, "node_modules");
if (!await exists(localModules)) {
  const install = spawnSync("npm", ["ci"], { stdio: "inherit" });
  if (install.status !== 0) throw new Error("npm ci failed");
}

const existingEnvironment = await exists(".env");
if (!existingEnvironment) run(process.execPath, ["scripts/initialize-env.mjs"]);
const envPath = resolve(root, ".env");
const current = await readFile(envPath, "utf8");
const currentProject = current.match(/^LEMMACOMPUTER_COMPOSE_PROJECT_NAME=(.+)$/m)?.[1]?.trim();
const migrateLegacyNamespace = process.argv.includes("--migrate-legacy-namespace");
if (currentProject === legacySlug && !migrateLegacyNamespace) {
  throw new Error([
    `This worktree still owns the legacy Docker namespace ${legacySlug}.`,
    "Changing its Compose project name while services are running would disconnect its databases and workspace storage.",
    "Follow docs/guides/development-workflow.md#rename-a-stateful-oc-worktree, then rerun:",
    "  npm run worktree:init -- --migrate-legacy-namespace",
  ].join("\n"));
}
if (migrateLegacyNamespace) {
  if (currentProject !== legacySlug) {
    throw new Error(`--migrate-legacy-namespace requires LEMMACOMPUTER_COMPOSE_PROJECT_NAME=${legacySlug}; found ${currentProject || "no project name"}`);
  }
  if (await exists(".runtime-remote-workspace-node")) {
    throw new Error("Remote workspace-node qualification is active; stop every workspace and run npm run qualify:remote-workspace-node -- down first");
  }
  const composeContainers = [legacySlug, `${legacySlug}-remote-node`].flatMap((project) => run("docker", [
    "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}",
  ]).split(/\r?\n/).filter(Boolean));
  if (composeContainers.length) {
    throw new Error(`Legacy Compose containers still exist:\n${composeContainers.join("\n")}\nRun npm run compose:down before migrating the namespace.`);
  }
  const networkPrefix = current.match(/^LEMMACOMPUTER_KASM_LOCAL_NETWORK_PREFIX=(.+)$/m)?.[1]?.trim();
  const runtimeContainers = new Set();
  for (const filter of runtimeContainerFilters) {
    for (const name of run("docker", ["ps", "-a", "--filter", filter, "--format", "{{.Names}}"]).split(/\r?\n/).filter(Boolean)) {
      const labels = JSON.parse(run("docker", ["inspect", "--format", "{{json .Config.Labels}}", name]));
      if (String(labels["com.lemmacomputer.workspace-network"] ?? "").startsWith(`${networkPrefix}-`)) runtimeContainers.add(name);
    }
  }
  if (runtimeContainers.size) {
    throw new Error(`Managed workspace runtime containers still exist:\n${[...runtimeContainers].sort().join("\n")}\nStop every workspace before migrating the namespace.`);
  }
}
if (existingEnvironment && currentProject !== slug && currentProject !== legacySlug) {
  throw new Error([
    `.env belongs to Docker project ${currentProject || "<missing>"}, not this worktree's ${slug} namespace.`,
    "Do not copy or repurpose another checkout's environment. Remove only a known-disposable .env, or follow the stateful handover workflow.",
  ].join("\n"));
}
const overrides = worktreeEnvironmentOverrides({ slug, id, portOffset });
const previousOverrides = migrateLegacyNamespace
  ? worktreeEnvironmentOverrides({ slug: legacySlug, id, portOffset })
  : currentProject === slug ? overrides : undefined;
const updated = applyWorktreeEnvironmentOverrides(current, overrides, { previousOverrides });
await writeFile(envPath, updated, { mode: 0o600 });
const publicWebUrl = updated.match(/^LEMMACOMPUTER_PUBLIC_WEB_URL=(.+)$/m)?.[1]?.trim();

for (const mountedFile of containerMountedFilePaths) await chmod(mountedFile, 0o644);
await rm(".artifacts/release-verification", { recursive: true, force: true });
process.stdout.write([
  `Worktree ${branch} is isolated as ${slug}.`,
  `Web: ${publicWebUrl || `http://localhost:${4174 + portOffset}`}`,
  migrateLegacyNamespace
    ? "Legacy isolation names were rewritten; database and workspace contents were not moved. Restore the coordinated recovery set before starting the full stack."
    : existingEnvironment
      ? "Existing worktree environment and custom values were preserved."
      : "Fresh worktree secrets are in .env; provider and Entra placeholders still need local values for full sign-in tests.",
  "Run npm run dev:doctor before starting work.",
  "",
].join("\n"));
