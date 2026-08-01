import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { IdentityContext } from "@onecomputer/contracts";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "onevibe-api-proxy-token-at-least-24-characters";
const identity: IdentityContext = { tenantId: "acme", subjectId: "alex-morgan", audience: "onecomputer-control" };
const headers = {
  "x-onecomputer-proxy-token": proxyToken,
  "x-onecomputer-test-tenant-id": identity.tenantId,
  "x-onecomputer-test-user-id": identity.subjectId,
};

test("ONEVibe API creates an owned PPTX and only its workspace owner can download it", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", randomUUID());
  await store.update(workspace.id, { state: "ready" });
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, { testIdentityMode: true });
  try {
    const taskCreated = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/onevibe/tasks`,
      headers,
    });
    assert.equal(taskCreated.statusCode, 201);
    const task = taskCreated.json().task as { id: string };

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
      { kind: "system", sequence: 1 }, { kind: "artifact", sequence: 2 },
    ]);

    const download = await app.inject({ method: "GET", url: artifact.downloadUrl, headers });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    assert.equal(download.rawPayload.subarray(0, 2).toString("utf8"), "PK");

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
