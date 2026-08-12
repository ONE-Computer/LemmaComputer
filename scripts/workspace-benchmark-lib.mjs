export const workspaceBenchmarkSchemaVersion = 1;

export const metricDefinitions = Object.freeze([
  { id: "image_pull_ms", unit: "ms", description: "Registry pull from request to locally available immutable image." },
  { id: "container_creation_ms", unit: "ms", description: "Docker or Kasm container creation, excluding image pull." },
  { id: "profile_initialization_ms", unit: "ms", description: "Persistent-home ownership and Kasm profile initialization." },
  { id: "desktop_ready_ms", unit: "ms", description: "Container start until the workspace health contract reports ready." },
  { id: "first_interactive_frame_ms", unit: "ms", description: "Workspace ready until the browser paints the first interactive desktop frame." },
  { id: "input_to_paint_ms", unit: "ms", description: "Synthetic pointer or key input until its deterministic visual response is painted." },
  { id: "rendered_fps", unit: "frames_per_second", description: "Changed desktop frames painted by the browser during the sample window." },
  { id: "server_cpu_percent", unit: "percent", description: "Workspace-side CPU observed during the benchmark interval." },
  { id: "client_cpu_percent", unit: "percent", description: "Browser-client CPU observed during the benchmark interval." },
  { id: "server_memory_bytes", unit: "bytes", description: "Workspace-side resident memory observed during the benchmark interval." },
  { id: "client_memory_bytes", unit: "bytes", description: "Browser-client resident memory observed during the benchmark interval." },
  { id: "bandwidth_bytes_per_second", unit: "bytes_per_second", description: "Workspace stream bytes divided by the measured sample interval." },
  { id: "persistent_home_bytes", unit: "bytes", description: "Allocated bytes in the persistent workspace home before startup." },
  { id: "persistent_home_inodes", unit: "count", description: "File-system entries in the persistent workspace home before startup." },
  { id: "image_content_bytes", unit: "bytes", description: "Exact Size field from Docker image inspection; not registry transfer size." },
]);

const metricById = new Map(metricDefinitions.map((definition) => [definition.id, definition]));
const evidenceSources = new Set([
  "docker-events",
  "entrypoint-stage",
  "browser-frame",
  "docker-stats",
  "browser-process",
  "network-counter",
  "docker-image-inspect",
  "filesystem-stat",
  "kasm-api",
  "manual-observation",
]);

const object = (value) => value && typeof value === "object" && !Array.isArray(value);

export function validateWorkspaceBenchmarkEvent(value) {
  if (!object(value)) throw new Error("workspace benchmark event must be an object");
  if (value.schemaVersion !== workspaceBenchmarkSchemaVersion) {
    throw new Error(`workspace benchmark event schemaVersion must be ${workspaceBenchmarkSchemaVersion}`);
  }
  if (typeof value.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId)) {
    throw new Error("workspace benchmark event runId is invalid");
  }
  const definition = typeof value.metric === "string" ? metricById.get(value.metric) : undefined;
  if (!definition) throw new Error(`unknown workspace benchmark metric: ${String(value.metric)}`);
  if (value.unit !== definition.unit) throw new Error(`${definition.id} expects ${definition.unit}`);
  if (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0) {
    throw new Error("workspace benchmark event value must be a finite non-negative number");
  }
  if (typeof value.source !== "string" || !evidenceSources.has(value.source)) {
    throw new Error(`unsupported workspace benchmark evidence source: ${String(value.source)}`);
  }
  return {
    schemaVersion: workspaceBenchmarkSchemaVersion,
    runId: value.runId,
    metric: definition.id,
    unit: definition.unit,
    value: value.value,
    source: value.source,
  };
}

const percentile = (sorted, fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];

export function summarizeWorkspaceMeasurements(rawEvents) {
  if (!Array.isArray(rawEvents)) throw new Error("workspace benchmark events must be an array");
  const events = rawEvents.map(validateWorkspaceBenchmarkEvent);
  return Object.fromEntries(metricDefinitions.map((definition) => {
    const selected = events.filter((event) => event.metric === definition.id);
    if (!selected.length) {
      return [definition.id, {
        status: "unavailable",
        unit: definition.unit,
        reason: "no_validated_runtime_measurement",
      }];
    }
    const values = selected.map((event) => event.value).sort((left, right) => left - right);
    return [definition.id, {
      status: "measured",
      unit: definition.unit,
      source: [...new Set(selected.map((event) => event.source))].sort(),
      sampleCount: values.length,
      min: values[0],
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: values.at(-1),
    }];
  }));
}

const requiredText = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};

const positiveNumber = (value, name) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
};

export function buildWorkspaceBenchmarkSnapshot(input) {
  if (!object(input)) throw new Error("workspace benchmark snapshot input must be an object");
  const recordedAt = requiredText(input.recordedAt, "recordedAt");
  if (!Number.isFinite(Date.parse(recordedAt))) throw new Error("recordedAt must be an ISO timestamp");
  if (!object(input.route) || !object(input.workspace) || !object(input.environment) || !object(input.image)) {
    throw new Error("route, workspace, environment, and image metadata are required");
  }
  const routeKinds = new Set(["local-host", "local-lan", "hosted-kasm"]);
  if (!routeKinds.has(input.route.kind)) throw new Error("route kind is invalid");
  const deploymentProfiles = new Set(["customer-managed", "hosted", "worktree"]);
  if (!deploymentProfiles.has(input.route.deploymentProfile)) throw new Error("deployment profile is invalid");
  const persistentHomeStates = new Set(["cold-empty", "warm", "representative"]);
  if (!persistentHomeStates.has(input.workspace.persistentHome)) throw new Error("persistent-home state is invalid");
  if (!Array.isArray(input.workspace.agents) || !input.workspace.agents.length) throw new Error("workspace agents are required");
  if (!Array.isArray(input.workspace.applications) || !input.workspace.applications.length) throw new Error("workspace applications are required");

  return {
    schemaVersion: workspaceBenchmarkSchemaVersion,
    benchmarkId: requiredText(input.benchmarkId, "benchmarkId"),
    recordedAt: new Date(recordedAt).toISOString(),
    route: {
      id: requiredText(input.route.id, "route.id"),
      kind: input.route.kind,
      deploymentProfile: input.route.deploymentProfile,
      clientLocation: requiredText(input.route.clientLocation, "route.clientLocation"),
      clientBrowser: requiredText(input.route.clientBrowser, "route.clientBrowser"),
      networkCondition: requiredText(input.route.networkCondition, "route.networkCondition"),
      transport: requiredText(input.route.transport, "route.transport"),
    },
    workspace: {
      profile: requiredText(input.workspace.profile, "workspace.profile"),
      agents: input.workspace.agents.map((item) => requiredText(item, "workspace agent")),
      applications: input.workspace.applications.map((item) => requiredText(item, "workspace application")),
      cpus: positiveNumber(input.workspace.cpus, "workspace.cpus"),
      memoryGiB: positiveNumber(input.workspace.memoryGiB, "workspace.memoryGiB"),
      persistentHome: input.workspace.persistentHome,
    },
    environment: { ...input.environment },
    image: { ...input.image },
    metricDefinitions,
    measurements: summarizeWorkspaceMeasurements(input.events ?? []),
  };
}
