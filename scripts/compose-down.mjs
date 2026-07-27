import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const runtimeContainerFilters = [
  "label=com.onecomputer.sandbox.provider=kasm-local",
  "label=com.onecomputer.sandbox.relay=kasm-local",
  "label=com.onecomputer.egress-proxy=v2",
];

const text = (value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");

export function runComposeDown({
  run = spawnSync,
  args = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const runtimeContainers = new Set();
  for (const filter of runtimeContainerFilters) {
    const result = run("docker", ["ps", "-a", "--filter", filter, "--format", "{{.Names}}"], {
      encoding: "utf8",
    });
    if (result.error) {
      stderr.write(`Unable to inspect Docker runtime containers: ${result.error.message}\n`);
      return 1;
    }
    if (result.status !== 0) {
      stderr.write(text(result.stderr));
      return result.status ?? 1;
    }
    for (const name of text(result.stdout).split(/\r?\n/).filter(Boolean)) runtimeContainers.add(name);
  }

  if (runtimeContainers.size) {
    stderr.write([
      `Refusing to stop Compose while ${runtimeContainers.size} managed workspace runtime container${runtimeContainers.size === 1 ? "" : "s"} still ${runtimeContainers.size === 1 ? "exists" : "exist"}:`,
      ...[...runtimeContainers].sort().map((name) => `  - ${name}`),
      "Stop every active workspace through ONEComputer, then rerun npm run compose:down.",
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
      ? "ONEComputer Compose services stopped; Compose-managed volumes were removed.\n"
      : "ONEComputer Compose services stopped; persistent volumes were retained.\n");
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runComposeDown();
}
