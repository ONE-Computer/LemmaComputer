import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Sandbox as E2bSandbox, Volume as E2bVolume, type SandboxInfo } from "e2b";

/**
 * Live-only acceptance gate for the E2B Cowork vertical slice.
 *
 * This intentionally refuses to run unless explicitly enabled and requires a
 * real authenticated Control session plus controller/E2B credentials. It
 * never starts a fixture server and never treats a deterministic fixture
 * marker as evidence of a model call.
 */

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live E2B qualification`);
  return value;
};

if (process.env.ONECOMPUTER_E2B_LIVE !== "1") {
  throw new Error("Refusing live E2B qualification: set ONECOMPUTER_E2B_LIVE=1 explicitly");
}
if (process.env.ONECOMPUTER_UI_FIXTURE === "1") {
  throw new Error("Refusing live E2B qualification while ONECOMPUTER_UI_FIXTURE=1");
}

const controlUrl = required("ONECOMPUTER_CONTROL_URL").replace(/\/$/, "");
const proxyToken = required("ONECOMPUTER_PROXY_TOKEN");
const sessionCookie = required("ONECOMPUTER_SESSION_COOKIE");
const controllerUrl = required("ONECOMPUTER_CONTROLLER_URL").replace(/\/$/, "");
const controllerToken = required("ONECOMPUTER_CONTROLLER_INTERNAL_TOKEN");
const e2bApiKey = required("E2B_API_KEY");
const expectedTemplateId = required("E2B_TEMPLATE_ID");
const agentCatalogId = process.env.ONECOMPUTER_E2B_AGENT?.trim() || "opencode-cli";
const timeoutMs = Number(process.env.ONECOMPUTER_E2B_LIVE_TIMEOUT_MS ?? 600_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 1_800_000) {
  throw new Error("ONECOMPUTER_E2B_LIVE_TIMEOUT_MS must be between 30000 and 1800000");
}

const commonHeaders = {
  "x-onecomputer-proxy-token": proxyToken,
  cookie: sessionCookie,
};
const controllerHeaders = { "x-controller-token": controllerToken };
const jsonHeaders = { ...commonHeaders, "content-type": "application/json" };
const artifactRoot = resolve(process.env.ONECOMPUTER_E2B_LIVE_ARTIFACT_DIR ?? ".artifacts/e2b-live");

type JsonRecord = Record<string, unknown>;
type TaskRun = {
  taskId: string;
  workspaceId: string;
  sandboxId: string;
  templateId: string;
  streamHashes: string[];
  frameHashes: string[];
  artifactHashes: string[];
  activitySequences: number[];
  sseReplayHash: string;
};

async function responseBody(response: Response) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.url}: ${body.slice(0, 500)}`);
  }
  return body;
}

async function controlJson(path: string, init: RequestInit = {}) {
  const response = await fetch(`${controlUrl}${path}`, {
    ...init,
    headers: { ...commonHeaders, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await responseBody(response);
  return body ? JSON.parse(body) as JsonRecord : {};
}

async function controllerRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${controllerUrl}${path}`, {
    ...init,
    headers: { ...controllerHeaders, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return responseBody(response);
}

async function responseBytes(response: Response) {
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function listE2bSandboxes(workspaceId: string) {
  const paginator = E2bSandbox.list({
    apiKey: e2bApiKey,
    query: { metadata: { "onecomputer.workspaceId": workspaceId } },
    limit: 100,
  });
  const sandboxes: SandboxInfo[] = [];
  while (paginator.hasNext) sandboxes.push(...await paginator.nextItems({ apiKey: e2bApiKey }));
  return sandboxes;
}

async function waitForSandbox(workspaceId: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sandboxes = await listE2bSandboxes(workspaceId);
    if (sandboxes.length === 1) {
      const sandbox = sandboxes[0]!;
      assert.equal(sandbox.templateId, expectedTemplateId, "live sandbox must use the pinned template");
      assert.equal(sandbox.allowInternetAccess, true, "E2B internet policy must be explicitly inspected");
      assert.ok(sandbox.network?.allowOut?.length, "E2B allowOut must contain governed routes");
      return sandbox;
    }
    if (sandboxes.length > 1) throw new Error(`Expected one E2B sandbox for ${workspaceId}, found ${sandboxes.length}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Timed out waiting for the E2B sandbox for ${workspaceId}`);
}

async function waitForProviderCleanup(workspaceId: string) {
  const volumeName = `oc-${workspaceId.replaceAll("-", "")}`;
  const deadline = Date.now() + Math.min(timeoutMs, 120_000);
  while (Date.now() < deadline) {
    const sandboxes = await listE2bSandboxes(workspaceId);
    const volumes = await E2bVolume.list({ apiKey: e2bApiKey });
    if (!sandboxes.length && !volumes.some((volume) => volume.name === volumeName)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`E2B provider cleanup was not observable for ${workspaceId}`);
}

function chatMessage(agent: string, text: string) {
  return {
    id: randomUUID(),
    role: "user",
    metadata: { agentCatalogId: agent, state: "completed", createdAt: new Date().toISOString(), source: "web" },
    parts: [{ type: "text", text, state: "done" }],
  };
}

function extractTurnId(stream: string) {
  const match = /turnId(?:\\?":|:)\\?"([A-Za-z0-9_-]{8,})/.exec(stream)
    ?? /turnId["']\s*:\s*["']([^"']{8,})/.exec(stream);
  if (!match?.[1]) throw new Error("Control UI stream did not expose a turn id");
  return match[1];
}

async function runTurn(workspaceId: string, taskId: string, sessionId: string, marker: string) {
  const response = await fetch(
    `${controlUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(agentCatalogId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      headers: { ...jsonHeaders, "x-onecomputer-onevibe-task-id": taskId, "idempotency-key": randomUUID() },
      body: JSON.stringify({ message: chatMessage(agentCatalogId, `Respond with exactly ${marker} and no tool calls.`) }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const stream = await responseBody(response);
  if (stream.includes("fixture") || stream.includes("UI_FIXTURE")) throw new Error("Fixture output detected in live ACP stream");
  if (!stream.includes(marker)) throw new Error(`Live ACP response marker missing: ${marker}`);
  const turnId = extractTurnId(stream);
  const activity = await controlJson(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(agentCatalogId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/activity?after=-1&limit=500`,
  );
  const events = Array.isArray(activity.events) ? activity.events as Array<JsonRecord> : [];
  assert.ok(events.length >= 3, "real ACP activity must include lifecycle and text events");
  assert.equal(events[0]?.type, "turn-start");
  assert.equal((events[0]?.runtime as JsonRecord | undefined)?.transport, "acp");
  assert.ok(events.some((event) => event.type === "text-delta" && typeof event.delta === "string" && event.delta.length > 0));
  assert.equal(events.at(-1)?.type, "turn-finish");
  assert.equal(events.at(-1)?.state, "completed");
  return {
    turnId,
    streamHash: createHash("sha256").update(stream).digest("hex"),
    activitySequences: events.map((event) => Number(event.sequence)),
  };
}

async function runTask(label: string): Promise<TaskRun> {
  const created = await controlJson("/v1/onevibe/tasks", {
    method: "POST",
    headers: { ...jsonHeaders, "idempotency-key": randomUUID() },
  });
  const task = created.task as JsonRecord;
  const workspace = created.workspace as JsonRecord;
  const taskId = String(task.id);
  const workspaceId = String(workspace.id);
  allocatedWorkspaces.add(workspaceId);
  const sandbox = await waitForSandbox(workspaceId);
  const agentList = await controlJson(`/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents`);
  const agent = (Array.isArray(agentList.agents) ? agentList.agents as Array<JsonRecord> : [])
    .find((candidate) => candidate.catalogId === agentCatalogId);
  assert.equal(agent?.state, "ready", `selected ${agentCatalogId} must be ready in the E2B sandbox`);

  const sessionResponse = await controlJson(`/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(agentCatalogId)}/sessions`, {
    method: "POST",
    headers: { ...jsonHeaders, "idempotency-key": randomUUID() },
    body: JSON.stringify({ title: `E2B live qualification ${label}` }),
  });
  const sessionId = String(sessionResponse.id);
  const first = await runTurn(workspaceId, taskId, sessionId, `E2B_REAL_ACP_OK_${label}_1`);
  const replayResponse = await fetch(
    `${controlUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(agentCatalogId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(first.turnId)}/activity/stream?after=0`,
    { headers: { ...commonHeaders, "last-event-id": "0" }, signal: AbortSignal.timeout(timeoutMs) },
  );
  const sseReplay = await responseBody(replayResponse);
  assert.match(replayResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(sseReplay, /event: activity/);
  assert.match(sseReplay, /id: \d+/);
  if (sseReplay.includes("fixture") || sseReplay.includes("UI_FIXTURE")) throw new Error("Fixture output detected in live activity replay");
  const second = await runTurn(workspaceId, taskId, sessionId, `E2B_REAL_ACP_OK_${label}_2`);

  const port = agentCatalogId === "codex-cli" ? 8644 : 8645;
  const connected = await E2bSandbox.connect(sandbox.sandboxId, { apiKey: e2bApiKey, timeoutMs });
  const health = await fetch(`https://${connected.getHost(port)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  assert.ok([401, 403, 404].includes(health.status), "provider ACP endpoint must reject an unauthenticated request");

  const capture = await controlJson(`/v1/workspaces/${encodeURIComponent(workspaceId)}/onevibe/tasks/${encodeURIComponent(taskId)}/capture`, {
    method: "POST",
    headers: { ...jsonHeaders, "idempotency-key": randomUUID() },
    body: JSON.stringify({ sourceApplication: "browser" }),
  });
  const frame = capture.frame as JsonRecord;
  const frameUrl = String(frame.frameUrl);
  const frameResponse = await fetch(`${controlUrl}${frameUrl}`, { headers: commonHeaders, signal: AbortSignal.timeout(timeoutMs) });
  const frameBytes = await responseBytes(frameResponse);
  assert.deepEqual(frameBytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const presentation = await controlJson(`/v1/workspaces/${encodeURIComponent(workspaceId)}/onevibe/tasks/${encodeURIComponent(taskId)}/presentations`, {
    method: "POST",
    headers: { ...jsonHeaders, "idempotency-key": randomUUID() },
    body: JSON.stringify({ title: `E2B live ${label}`, body: "A real ACP-routed Cowork qualification artifact." }),
  });
  const artifact = presentation.artifact as JsonRecord;
  const artifactResponse = await fetch(`${controlUrl}${String(artifact.downloadUrl)}`, { headers: commonHeaders, signal: AbortSignal.timeout(timeoutMs) });
  const artifactBytes = await responseBytes(artifactResponse);
  assert.deepEqual(artifactBytes.subarray(0, 2).toString("utf8"), "PK");
  return {
    taskId,
    workspaceId,
    sandboxId: sandbox.sandboxId,
    templateId: sandbox.templateId,
    streamHashes: [first.streamHash, second.streamHash],
    frameHashes: [String(frame.imageSha256), createHash("sha256").update(frameBytes).digest("hex")],
    artifactHashes: [String(artifact.sha256), createHash("sha256").update(artifactBytes).digest("hex")],
    activitySequences: [...first.activitySequences, ...second.activitySequences],
    sseReplayHash: createHash("sha256").update(sseReplay).digest("hex"),
  };
}

const runs: TaskRun[] = [];
const allocatedWorkspaces = new Set<string>();
let cleanupFailed = false;
try {
  runs.push(await runTask("one"));
  runs.push(await runTask("two"));
  assert.notEqual(runs[0]!.sandboxId, runs[1]!.sandboxId, "separate Cowork conversations must use separate E2B sandboxes");
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await writeFile(resolve(artifactRoot, `qualification-${Date.now()}.json`), JSON.stringify({
    qualifiedAt: new Date().toISOString(),
    agentCatalogId,
    runs,
  }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ qualified: true, agentCatalogId, runs }));
} finally {
  for (const workspaceId of [...allocatedWorkspaces].reverse()) {
    try {
      await controlJson(`/v1/workspaces/${encodeURIComponent(workspaceId)}/stop`, {
        method: "POST",
        headers: { ...jsonHeaders, "idempotency-key": randomUUID() },
      });
    } catch (error) {
      cleanupFailed = true;
      console.error(`Cowork stop failed for ${workspaceId}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    try {
      await controllerRequest(`/internal/v1/workspaces/${encodeURIComponent(workspaceId)}/storage`, { method: "DELETE" });
      await waitForProviderCleanup(workspaceId);
    } catch (error) {
      cleanupFailed = true;
      console.error(`Cowork volume purge failed for ${workspaceId}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  if (cleanupFailed) throw new Error("Live E2B qualification cleanup did not complete");
}
