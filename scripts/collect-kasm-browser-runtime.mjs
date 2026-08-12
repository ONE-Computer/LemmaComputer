#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

const usage = `usage: node scripts/collect-kasm-browser-runtime.mjs [options]

Collects browser-side Kasm measurements from an already-ready workspace. It
does not create, stop, restart, resize, or remove a workspace.

Required:
  --launch-url-file FILE   0600 file containing a short-lived signed launch URL
  --output FILE            JSONL measurement output (created with mode 0600)
  --run-id ID              Stable prefix for the recorded sample IDs

Optional:
  --samples NUMBER         Fresh browser contexts to measure (default: 1)
  --timeout-ms NUMBER      Per-sample first-frame timeout (default: 15000)
  --activity-ms NUMBER     Changed-frame sample window (default: 3000)
  --headed true|false      Show Chromium (default: false)
  --server-container NAME  Record Docker CPU and memory for this workspace
`;

const metric = Object.freeze({
  firstFrame: ["first_interactive_frame_ms", "ms", "browser-frame"],
  inputPaint: ["input_to_paint_ms", "ms", "browser-frame"],
  fps: ["rendered_fps", "frames_per_second", "browser-frame"],
  bandwidth: ["bandwidth_bytes_per_second", "bytes_per_second", "network-counter"],
  serverCpu: ["server_cpu_percent", "percent", "docker-stats"],
  serverMemory: ["server_memory_bytes", "bytes", "docker-stats"],
  clientCpu: ["client_cpu_percent", "percent", "browser-process"],
  clientMemory: ["client_memory_bytes", "bytes", "browser-process"],
});

export function parseKasmCollectorArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${name ?? ""}`);
    values.set(name.slice(2), value);
  }
  const required = (name) => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const positiveInteger = (name, fallback) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
    return value;
  };
  const headed = values.get("headed") ?? "false";
  if (headed !== "true" && headed !== "false") throw new Error("--headed must be true or false");
  const runId = required("run-id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(runId)) throw new Error("--run-id is invalid");
  return {
    launchUrlFile: required("launch-url-file"),
    output: required("output"),
    runId,
    samples: positiveInteger("samples", 1),
    timeoutMs: positiveInteger("timeout-ms", 15_000),
    activityMs: positiveInteger("activity-ms", 3_000),
    headed: headed === "true",
    serverContainer: values.get("server-container")?.trim() || undefined,
  };
}

export function workspaceBenchmarkEvent(runId, definition, value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("measurement must be finite and non-negative");
  return {
    schemaVersion: 1,
    runId,
    metric: definition[0],
    unit: definition[1],
    value: Math.round(value * 1_000) / 1_000,
    source: definition[2],
  };
}

const byteUnits = Object.freeze({
  B: 1,
  kB: 1_000,
  MB: 1_000 ** 2,
  GB: 1_000 ** 3,
  KiB: 1_024,
  MiB: 1_024 ** 2,
  GiB: 1_024 ** 3,
});

export function parseDockerStats(value) {
  const cpu = Number(String(value.CPUPerc ?? "").replace(/%$/, ""));
  const memory = String(value.MemUsage ?? "").split("/")[0]?.trim().match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);
  const multiplier = memory ? byteUnits[memory[2]] : undefined;
  if (!Number.isFinite(cpu) || cpu < 0 || !memory || !multiplier) throw new Error("Docker returned invalid CPU or memory statistics");
  return { cpuPercent: cpu, memoryBytes: Number(memory[1]) * multiplier };
}

export function webSocketPayloadBytes(response) {
  const payload = typeof response?.payloadData === "string" ? response.payloadData : "";
  return response?.opcode === 2
    ? Buffer.from(payload, "base64").byteLength
    : Buffer.byteLength(payload, "utf8");
}

const dockerStats = async (container) => {
  const { stdout } = await execute("docker", ["stats", "--no-stream", "--format", "{{json .}}", container], { timeout: 10_000 });
  return parseDockerStats(JSON.parse(stdout.trim()));
};

const browserProcesses = async (browserCdp) => {
  const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
  const residentBytes = await Promise.all(processInfo.map(async (process) => {
    try {
      const status = await readFile(`/proc/${process.id}/status`, "utf8");
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      return match ? Number(match[1]) * 1_024 : 0;
    } catch {
      return 0;
    }
  }));
  return {
    cpuSeconds: processInfo.reduce((sum, process) => sum + process.cpuTime, 0),
    residentBytes: residentBytes.reduce((sum, value) => sum + value, 0),
  };
};

const canvasProbe = () => {
  const candidates = [...document.querySelectorAll("canvas")]
    .filter((canvas) => canvas.width >= 640 && canvas.height >= 480 && canvas.getBoundingClientRect().width > 0);
  const canvas = candidates.sort((left, right) => right.width * right.height - left.width * left.height)[0];
  if (!canvas) return null;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const width = Math.min(96, canvas.width);
  const height = Math.min(60, canvas.height);
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
  if (!scratchContext) return null;
  scratchContext.drawImage(canvas, 0, 0, width, height);
  const pixels = scratchContext.getImageData(0, 0, width, height).data;
  let opaque = 0;
  let checksum = 2166136261;
  const buckets = new Set();
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const alpha = pixels[index + 3];
    if (alpha > 0) opaque += 1;
    buckets.add(`${red >> 4}:${green >> 4}:${blue >> 4}:${alpha >> 6}`);
    checksum ^= red;
    checksum = Math.imul(checksum, 16777619);
    checksum ^= green;
    checksum = Math.imul(checksum, 16777619);
    checksum ^= blue;
    checksum = Math.imul(checksum, 16777619);
  }
  return {
    checksum: checksum >>> 0,
    colorBuckets: buckets.size,
    opaqueRatio: opaque / (pixels.length / 4),
  };
};

const waitForChangedFrame = async (page, previousChecksum, timeoutMs) => {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const probe = await page.evaluate(canvasProbe);
    if (probe && probe.checksum !== previousChecksum) return performance.now() - startedAt;
    await page.waitForTimeout(10);
  }
  throw new Error(`desktop did not paint an input response within ${timeoutMs}ms`);
};

const waitForInteractiveFrame = async (page, timeoutMs) => {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const probe = await page.evaluate(canvasProbe);
    if (probe && probe.opaqueRatio > 0.9 && probe.colorBuckets >= 4) return;
    await page.waitForTimeout(10);
  }
  throw new Error(`desktop did not paint an interactive frame within ${timeoutMs}ms`);
};

const runSample = async (browser, launchUrl, options, sampleNumber) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const browserCdp = await browser.newBrowserCDPSession();
  const clientBefore = await browserProcesses(browserCdp);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  let receivedBytes = 0;
  cdp.on("Network.dataReceived", (event) => { receivedBytes += event.dataLength; });
  cdp.on("Network.webSocketFrameReceived", (event) => { receivedBytes += webSocketPayloadBytes(event.response); });
  const sampleStartedAt = performance.now();
  await page.goto(launchUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
  await waitForInteractiveFrame(page, options.timeoutMs);
  const firstFrameMs = performance.now() - sampleStartedAt;

  const beforeInput = await page.evaluate(canvasProbe);
  if (!beforeInput) throw new Error("interactive desktop canvas disappeared");
  await page.mouse.click(48, 18);
  const inputPaintMs = await waitForChangedFrame(page, beforeInput.checksum, Math.min(options.timeoutMs, 5_000));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  const frameStartedAt = performance.now();
  let changes = 0;
  let previous = (await page.evaluate(canvasProbe))?.checksum;
  let open = false;
  while (performance.now() - frameStartedAt < options.activityMs) {
    if (open) await page.keyboard.press("Escape");
    else await page.mouse.click(48, 18);
    open = !open;
    const intervalStartedAt = performance.now();
    while (performance.now() - intervalStartedAt < 250) {
      const current = (await page.evaluate(canvasProbe))?.checksum;
      if (current !== undefined && current !== previous) {
        changes += 1;
        previous = current;
      }
      await page.waitForTimeout(10);
    }
  }
  if (open) await page.keyboard.press("Escape");
  const activitySeconds = (performance.now() - frameStartedAt) / 1_000;
  const elapsedSeconds = (performance.now() - sampleStartedAt) / 1_000;
  const clientAfter = await browserProcesses(browserCdp);
  const server = options.serverContainer ? await dockerStats(options.serverContainer) : undefined;
  const runId = `${options.runId}-${String(sampleNumber).padStart(2, "0")}`;
  await context.close();
  await browserCdp.detach();
  return [
    workspaceBenchmarkEvent(runId, metric.firstFrame, firstFrameMs),
    workspaceBenchmarkEvent(runId, metric.inputPaint, inputPaintMs),
    workspaceBenchmarkEvent(runId, metric.fps, changes / activitySeconds),
    workspaceBenchmarkEvent(runId, metric.bandwidth, receivedBytes / elapsedSeconds),
    workspaceBenchmarkEvent(runId, metric.clientCpu, Math.max(0, clientAfter.cpuSeconds - clientBefore.cpuSeconds) / elapsedSeconds * 100),
    workspaceBenchmarkEvent(runId, metric.clientMemory, clientAfter.residentBytes),
    ...(server ? [
      workspaceBenchmarkEvent(runId, metric.serverCpu, server.cpuPercent),
      workspaceBenchmarkEvent(runId, metric.serverMemory, server.memoryBytes),
    ] : []),
  ];
};

const secureLaunchUrl = async (file) => {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error("--launch-url-file must be a regular file");
  if ((metadata.mode & 0o077) !== 0) throw new Error("--launch-url-file must not be readable or writable by group or other users");
  const value = (await readFile(file, "utf8")).trim();
  const url = new URL(value);
  if (!url.searchParams.has("oc_workspace_access")) throw new Error("launch URL is missing its signed workspace access token");
  return value;
};

export async function collectKasmBrowserRuntime(options) {
  const launchUrl = await secureLaunchUrl(options.launchUrlFile);
  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const events = [];
    for (let sample = 1; sample <= options.samples; sample += 1) {
      events.push(...await runSample(browser, launchUrl, options, sample));
    }
    await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await writeFile(options.output, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
    await chmod(options.output, 0o600);
    return events;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseKasmCollectorArguments(process.argv.slice(2));
    const events = await collectKasmBrowserRuntime(options);
    process.stdout.write(`Recorded ${events.length} measurements across ${options.samples} sample(s) in ${options.output}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    process.exitCode = 1;
  }
}
