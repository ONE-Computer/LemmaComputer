import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const runtimeContainerFilters = [
  "label=com.onecomputer.sandbox.provider=kasm-local",
  "label=com.onecomputer.sandbox.relay=kasm-local",
  "label=com.onecomputer.egress-proxy=v2",
];

const text = (value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
const localEnvironment = () => {
  try {
    const contents = readFileSync(".env", "utf8");
    const value = (key) => contents.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim();
    return { projectName: value("ONECOMPUTER_COMPOSE_PROJECT_NAME"), networkPrefix: value("ONECOMPUTER_KASM_LOCAL_NETWORK_PREFIX") };
  } catch {
    return {};
  }
};

export function runComposeDown({
  run = spawnSync,
  args = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  projectName = localEnvironment().projectName ?? "onecomputer",
  networkPrefix = localEnvironment().networkPrefix ?? "onecomputer-workspace",
} = {}) {
  const runtimeContainers = new Set();
  const workspaceIds = new Set();
  const sandboxNames = new Set();
  const scoped = projectName !== "onecomputer";
  for (const [filterIndex, filter] of runtimeContainerFilters.entries()) {
    const result = run("docker", ["ps", "-a", "--filter", filter, "--format", "{{.Names}}"], { encoding: "utf8" });
    if (result.error) {
      stderr.write(`Unable to inspect Docker runtime containers: ${result.error.message}\n`);
      return 1;
    }
    if (result.status !== 0) {
      stderr.write(text(result.stderr));
      return result.status ?? 1;
    }
    for (const name of text(result.stdout).split(/\r?\n/).filter(Boolean)) {
      if (!scoped) {
        runtimeContainers.add(name);
        continue;
      }
      const inspection = run("docker", ["inspect", "--format", "{{json .Config.Labels}}", name], { encoding: "utf8" });
      if (inspection.error || inspection.status !== 0) {
        stderr.write(text(inspection.stderr) || `Unable to inspect runtime container ${name}\n`);
        return inspection.status ?? 1;
      }
      let labels;
      try { labels = JSON.parse(text(inspection.stdout)); } catch {
        stderr.write(`Runtime container ${name} returned invalid labels\n`);
        return 1;
      }
      const belongs = filterIndex === 0
        ? String(labels["com.onecomputer.workspace-network"] ?? "").startsWith(`${networkPrefix}-`)
        : filterIndex === 1
          ? sandboxNames.has(String(labels["com.onecomputer.sandbox-id"] ?? ""))
          : workspaceIds.has(String(labels["com.onecomputer.workspace-id"] ?? ""));
      if (belongs) {
        runtimeContainers.add(name);
        if (filterIndex === 0) {
          sandboxNames.add(name);
          workspaceIds.add(String(labels["com.onecomputer.workspace-id"] ?? ""));
        }
      }
    }
  }

  if (runtimeContainers.size) {
    stderr.write([
      `Refusing to stop Compose while ${runtimeContainers.size} managed workspace runtime container${runtimeContainers.size === 1 ? "" : "s"} still ${runtimeContainers.size === 1 ? "exists" : "exist"}:`,
      ...[...runtimeContainers].sort().map((name) => `  - ${name}`),
      "Stop every active workspace through LemmaComputer, then rerun npm run compose:down.",
      "This guard preserves Control state, runtime grants, and workspace storage consistency.",
      "",
    ].join("\n"));
    return 1;
  }

  const result = run("docker", ["compose", "down", ...args], { stdio: "inherit" });
  if (result.error) {
    stderr.write(`Unable to run Docker Compose: ${result.error.message}\n`);
    return 1;
  }
  if (result.status === 0) {
    stdout.write(args.includes("--volumes")
      ? "LemmaComputer Compose services stopped; Compose-managed volumes were removed.\n"
      : "LemmaComputer Compose services stopped; persistent volumes were retained.\n");
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runComposeDown();
