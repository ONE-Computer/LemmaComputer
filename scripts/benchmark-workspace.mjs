#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWorkspaceBenchmarkSnapshot } from "./workspace-benchmark-lib.mjs";

const usage = `usage: npm run benchmark:workspace -- [options]

Creates a metadata and measurement summary without creating, starting, stopping,
pulling, or removing a workspace or image. Runtime measurements must be supplied
as validated JSONL with --events; absent observations remain unavailable.

Required:
  --route-id ID
  --route-kind local-host|local-lan|hosted-kasm
  --deployment-profile customer-managed|hosted|worktree
  --client-location LABEL
  --client-browser NAME_AND_VERSION
  --network-condition LABEL
  --profile PROFILE
  --agents CSV
  --applications CSV
  --cpus NUMBER
  --memory-gib NUMBER
  --persistent-home cold-empty|warm|representative
  --image REFERENCE

Optional:
  --benchmark-id ID
  --recorded-at ISO_TIMESTAMP
  --transport LABEL
  --events FILE.jsonl
  --output FILE.json
  --skip-image-inspect
`;

const parseArguments = (argv) => {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true, values, flags };
    if (argument === "--skip-image-inspect") {
      flags.add(argument.slice(2));
      continue;
    }
    if (!argument.startsWith("--") || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`invalid argument: ${argument}`);
    }
    values.set(argument.slice(2), argv[index + 1]);
    index += 1;
  }
  return { help: false, values, flags };
};

const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const required = (values, name) => {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const csv = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);

const loadEvents = async (file) => {
  if (!file) return [];
  return (await readFile(file, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`invalid JSONL event at line ${index + 1}`); }
    });
};

const inspectImage = (reference, skip) => {
  if (skip) return { reference, status: "not_inspected", reason: "explicitly_skipped" };
  const raw = capture("docker", ["image", "inspect", reference, "--format", "{{json .}}"]);
  if (!raw) return { reference, status: "unavailable", reason: "docker_image_inspect_failed" };
  try {
    const image = JSON.parse(raw);
    if (typeof image.Id !== "string" || typeof image.Size !== "number") throw new Error("invalid image metadata");
    return { reference, status: "present", id: image.Id, inspectSizeBytes: image.Size };
  } catch {
    return { reference, status: "unavailable", reason: "docker_image_inspect_invalid" };
  }
};

export async function runWorkspaceBenchmarkCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) return { help: true };
  const { values, flags } = parsed;
  const recordedAt = values.get("recorded-at") ?? new Date().toISOString();
  const routeId = required(values, "route-id");
  const image = inspectImage(required(values, "image"), flags.has("skip-image-inspect"));
  const events = await loadEvents(values.get("events"));
  if (image.status === "present") {
    events.push({
      schemaVersion: 1,
      runId: "image-inspection",
      metric: "image_content_bytes",
      unit: "bytes",
      value: image.inspectSizeBytes,
      source: "docker-image-inspect",
    });
  }
  const cpus = Number(required(values, "cpus"));
  const memoryGiB = Number(required(values, "memory-gib"));
  const cpuModels = [...new Set(os.cpus().map((cpu) => cpu.model).filter(Boolean))];
  const snapshot = buildWorkspaceBenchmarkSnapshot({
    benchmarkId: values.get("benchmark-id") ?? `${routeId}-${recordedAt.replace(/[^0-9]/g, "").slice(0, 14)}`,
    recordedAt,
    route: {
      id: routeId,
      kind: required(values, "route-kind"),
      deploymentProfile: required(values, "deployment-profile"),
      clientLocation: required(values, "client-location"),
      clientBrowser: required(values, "client-browser"),
      networkCondition: required(values, "network-condition"),
      transport: values.get("transport") ?? "signed-ingress-websocket-tcp-relay",
    },
    workspace: {
      profile: required(values, "profile"),
      agents: csv(required(values, "agents")),
      applications: csv(required(values, "applications")),
      cpus,
      memoryGiB,
      persistentHome: required(values, "persistent-home"),
    },
    environment: {
      gitSha: capture("git", ["rev-parse", "HEAD"]) ?? "unavailable",
      platform: os.platform(),
      architecture: os.arch(),
      logicalCpuCount: os.cpus().length,
      cpuModels,
      hostMemoryBytes: os.totalmem(),
      nodeVersion: process.version,
    },
    image,
    events,
  });
  const document = `${JSON.stringify(snapshot, null, 2)}\n`;
  const output = values.get("output");
  if (output) {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, document, { mode: 0o600 });
  } else {
    process.stdout.write(document);
  }
  return { help: false, snapshot };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runWorkspaceBenchmarkCli().then((result) => {
    if (result.help) process.stdout.write(usage);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    process.exitCode = 1;
  });
}
