import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { IdentityContext } from "@onecomputer/contracts";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import { createControlServer, ONEVIBE_EPHEMERAL_TTL_MS } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";
import { OneVibeCaptureAuthority } from "../apps/control-api/src/onevibe-vcr.js";

const proxyToken = "onevibe-api-proxy-token-at-least-24-characters";
const identity: IdentityContext = { tenantId: "acme", subjectId: "alex-morgan", audience: "onecomputer-control" };
const headers = {
  "x-onecomputer-proxy-token": proxyToken,
  "x-onecomputer-test-tenant-id": identity.tenantId,
  "x-onecomputer-test-user-id": identity.subjectId,
};
const captureSecret = "onevibe-capture-test-secret-at-least-32-characters";
const onePixelPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";

test("ONEVibe API creates an owned PPTX and only its workspace owner can download it", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", randomUUID());
  await store.update(workspace.id, { state: "ready" });
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    oneVibeCaptureSecret: captureSecret,
  });
  try {
    const taskCreated = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/onevibe/tasks`,
      headers,
    });
    assert.equal(taskCreated.statusCode, 201);
    const task = taskCreated.json().task as { id: string };

    const captureToken = new OneVibeCaptureAuthority(captureSecret).issue(identity, {
      workspaceId: workspace.id,
      taskId: task.id,
      sourceApplication: "browser",
      maximumBytes: 16_384,
    });
    const captured = await app.inject({
      method: "POST",
      url: `/internal/v1/onevibe/tasks/${task.id}/frames`,
      headers: { "x-onecomputer-onevibe-capture-token": captureToken },
      payload: { sourceApplication: "browser", imageBase64: onePixelPngBase64 },
    });
    assert.equal(captured.statusCode, 201);
    const vcr = await app.inject({ method: "GET", url: `/v1/workspaces/${workspace.id}/onevibe/tasks/${task.id}/vcr`, headers });
    assert.equal(vcr.statusCode, 200);
    const frameUrl = (vcr.json().frames as Array<{ frameUrl: string; sourceApplication: string }>)[0]?.frameUrl;
    assert.equal((vcr.json().frames as Array<{ sourceApplication: string }>)[0]?.sourceApplication, "browser");
    assert.ok(frameUrl);
    const frame = await app.inject({ method: "GET", url: frameUrl!, headers });
    assert.equal(frame.statusCode, 200);
    assert.equal(frame.headers["content-type"], "image/png");
    assert.deepEqual(frame.rawPayload.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/onevibe/tasks/${task.id}/presentations`,
      headers,
      payload: { title: "Q3 executive update", body: "ONEVibe created this governed, editable PowerPoint artifact." },
    });
    assert.equal(created.statusCode, 201);
    const artifact = created.json().artifact as { id: string; downloadUrl: string; sha256: string; sizeBytes: number };
    assert.match(artifact.id, /^[0-9a-f-]{36}$/);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(artifact.sizeBytes > 10_000);

    const events = await app.inject({ method: "GET", url: `/v1/workspaces/${workspace.id}/onevibe/tasks/${task.id}/events`, headers });
    assert.equal(events.statusCode, 200);
    assert.deepEqual((events.json().events as Array<{ kind: string; sequence: number }>).map(({ kind, sequence }) => ({ kind, sequence })), [
      { kind: "system", sequence: 1 }, { kind: "workspace-frame", sequence: 2 }, { kind: "artifact", sequence: 3 },
    ]);

    const download = await app.inject({ method: "GET", url: artifact.downloadUrl, headers });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    assert.equal(download.rawPayload.subarray(0, 2).toString("utf8"), "PK");

    const siblingTask = await store.createOneVibeTask(identity, workspace.id);
    assert.ok(siblingTask);
    const crossTaskDownload = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspace.id}/onevibe/tasks/${siblingTask.id}/presentations/${artifact.id}`,
      headers,
    });
    assert.equal(crossTaskDownload.statusCode, 404);

    const denied = await app.inject({
      method: "GET",
      url: artifact.downloadUrl,
      headers: { ...headers, "x-onecomputer-test-user-id": "another-employee" },
    });
    assert.equal(denied.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("ONEVibe can bootstrap a task-scoped ephemeral sandbox without a durable workspace", async () => {
  const store = new MemoryWorkspaceStore();
  const controller = {
    async create(input) { return { providerId: `ephemeral-${input.workspaceId}`, state: "ready", failureCode: null }; },
    async status(providerId) { return { providerId, state: "ready", failureCode: null }; },
    async open() { return { launchUrl: "https://vcr.example", expiresAt: new Date().toISOString() }; },
    async destroy() {},
    async purgeWorkspace() {},
  } as ControllerClient;
  const app = createControlServer(store, controller, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    oneVibeCaptureSecret: captureSecret,
  });
  try {
    const created = await app.inject({ method: "POST", url: "/v1/onevibe/tasks", headers: { ...headers, "idempotency-key": "ephemeral-cowork-test-0001" } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().workspace.ephemeral, true);
    assert.match(created.json().workspace.grantId, /^cowork-ephemeral-/);
    const taskId = created.json().task.id as string;
    const workspaceId = created.json().workspace.id as string;
    const taskRecord = await store.getOwnedOneVibeTask(identity, workspaceId, taskId);
    assert.ok(taskRecord);
    taskRecord.createdAt = new Date(Date.now() - ONEVIBE_EPHEMERAL_TTL_MS - 1);

    const expiredPresentation = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/onevibe/tasks/${taskId}/presentations`,
      headers,
      payload: { title: "Expired task", body: "This must not execute after the task deadline." },
    });
    assert.equal(expiredPresentation.statusCode, 410);
    assert.equal(expiredPresentation.json().error.code, "ONEVIBE_TASK_EXPIRED");

    const captureToken = new OneVibeCaptureAuthority(captureSecret).issue(identity, {
      workspaceId,
      taskId,
      sourceApplication: "browser",
      maximumBytes: 16_384,
    });
    const expiredCapture = await app.inject({
      method: "POST",
      url: `/internal/v1/onevibe/tasks/${taskId}/frames`,
      headers: { "x-onecomputer-onevibe-capture-token": captureToken },
      payload: { sourceApplication: "browser", imageBase64: onePixelPngBase64 },
    });
    assert.equal(expiredCapture.statusCode, 410);
    assert.equal(expiredCapture.json().error.code, "ONEVIBE_TASK_EXPIRED");

    const events = await app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/onevibe/tasks/${taskId}/events`, headers });
    assert.equal(events.statusCode, 200);
    assert.equal(events.json().events[0].kind, "system");
    const listed = await app.inject({ method: "GET", url: "/v1/workspaces", headers });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().workspaces.some((workspace: { id: string }) => workspace.id === workspaceId), false);
  } finally {
    await app.close();
  }
});
