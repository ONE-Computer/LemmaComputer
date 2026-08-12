import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildWorkspaceBenchmarkSnapshot,
  metricDefinitions,
  summarizeWorkspaceMeasurements,
  validateWorkspaceBenchmarkEvent,
} from "../scripts/workspace-benchmark-lib.mjs";

const execute = promisify(execFile);

test("workspace benchmark summaries never turn missing observations into zeroes", () => {
  const events = [12, 18, 14, 21, 15].map((value, index) => ({
    schemaVersion: 1,
    runId: `run-${index + 1}`,
    metric: "input_to_paint_ms",
    unit: "ms",
    value,
    source: "browser-frame",
  }));
  const summary = summarizeWorkspaceMeasurements(events);

  assert.deepEqual(summary.input_to_paint_ms, {
    status: "measured",
    unit: "ms",
    source: ["browser-frame"],
    sampleCount: 5,
    min: 12,
    p50: 15,
    p95: 21,
    max: 21,
  });
  assert.deepEqual(summary.first_interactive_frame_ms, {
    status: "unavailable",
    unit: "ms",
    reason: "no_validated_runtime_measurement",
  });
  assert.equal(Object.keys(summary).length, metricDefinitions.length);
});

test("workspace benchmark events bind every value to its expected unit and evidence source", () => {
  assert.deepEqual(validateWorkspaceBenchmarkEvent({
    schemaVersion: 1,
    runId: "run-1",
    metric: "persistent_home_bytes",
    unit: "bytes",
    value: 4_096,
    source: "filesystem-stat",
  }), {
    schemaVersion: 1,
    runId: "run-1",
    metric: "persistent_home_bytes",
    unit: "bytes",
    value: 4_096,
    source: "filesystem-stat",
  });
  assert.throws(
    () => validateWorkspaceBenchmarkEvent({
      schemaVersion: 1,
      runId: "run-1",
      metric: "persistent_home_bytes",
      unit: "ms",
      value: 4_096,
      source: "filesystem-stat",
    }),
    /persistent_home_bytes expects bytes/,
  );
  assert.throws(
    () => validateWorkspaceBenchmarkEvent({
      schemaVersion: 1,
      runId: "run-1",
      metric: "input_to_paint_ms",
      unit: "ms",
      value: -1,
      source: "browser-frame",
    }),
    /finite non-negative number/,
  );
});

test("workspace benchmark snapshots retain route, allocation, image and host evidence", () => {
  const snapshot = buildWorkspaceBenchmarkSnapshot({
    benchmarkId: "baseline-local-lan",
    recordedAt: "2026-08-12T05:00:00.000Z",
    route: {
      id: "local-lan",
      kind: "local-lan",
      deploymentProfile: "customer-managed",
      clientLocation: "same-lan",
      clientBrowser: "Chromium 150",
      networkCondition: "unshaped-lan",
      transport: "signed-ingress-websocket-tcp-relay",
    },
    workspace: {
      profile: "claude-desktop-standard-v1",
      agents: ["claude-desktop"],
      applications: ["firefox"],
      cpus: 2,
      memoryGiB: 4,
      persistentHome: "warm",
    },
    environment: {
      gitSha: "a".repeat(40),
      platform: "linux",
      architecture: "x64",
      logicalCpuCount: 8,
      hostMemoryBytes: 16_000_000_000,
    },
    image: {
      reference: "lemmacomputer/workspace:test",
      status: "present",
      id: `sha256:${"b".repeat(64)}`,
      inspectSizeBytes: 4_997_900_506,
    },
    events: [{
      schemaVersion: 1,
      runId: "run-1",
      metric: "image_content_bytes",
      unit: "bytes",
      value: 4_997_900_506,
      source: "docker-image-inspect",
    }],
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.route.deploymentProfile, "customer-managed");
  assert.equal(snapshot.route.clientBrowser, "Chromium 150");
  assert.equal(snapshot.route.transport, "signed-ingress-websocket-tcp-relay");
  assert.equal(snapshot.workspace.persistentHome, "warm");
  assert.equal(snapshot.image.inspectSizeBytes, 4_997_900_506);
  assert.equal(snapshot.measurements.image_content_bytes.status, "measured");
  assert.equal(snapshot.measurements.desktop_ready_ms.status, "unavailable");
});

test("benchmark CLI can emit a deterministic metadata-only baseline without touching Docker", async () => {
  const { stdout } = await execute("node", [
    "scripts/benchmark-workspace.mjs",
    "--benchmark-id", "metadata-only",
    "--recorded-at", "2026-08-12T05:00:00.000Z",
    "--route-id", "local-host",
    "--route-kind", "local-host",
    "--deployment-profile", "worktree",
    "--client-location", "same-host",
    "--client-browser", "Chromium 150",
    "--network-condition", "unshaped-loopback",
    "--profile", "claude-desktop-standard-v1",
    "--agents", "claude-desktop",
    "--applications", "firefox",
    "--cpus", "2",
    "--memory-gib", "4",
    "--persistent-home", "warm",
    "--image", "lemmacomputer/workspace:test",
    "--skip-image-inspect",
  ]);
  const snapshot = JSON.parse(stdout);
  assert.equal(snapshot.benchmarkId, "metadata-only");
  assert.equal(snapshot.image.status, "not_inspected");
  assert.equal(snapshot.measurements.image_content_bytes.status, "unavailable");
  assert.equal(snapshot.measurements.input_to_paint_ms.status, "unavailable");

  const cli = await readFile("scripts/benchmark-workspace.mjs", "utf8");
  assert.doesNotMatch(cli, /docker\s+(?:run|create|start|stop|restart|rm|rmi|pull)|compose\s+(?:up|down|build)/);
});
