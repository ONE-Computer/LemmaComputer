import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import { WorkspaceRecoveryWorker } from "../apps/control-api/src/workspace-recovery.js";
import type { RuntimePolicy } from "@lemmacomputer/contracts";
const policy = {} as RuntimePolicy; // The worker transports policy; WorkspaceService tests validate provisioning.

test("recovery scans tenants without sessions, denies removed or mismatched owners, and continues after dependency failure", async () => {
  const store = new MemoryWorkspaceStore();
  const records = [];
  for (let index = 0; index < 24; index++) {
    const identity = { tenantId: `tenant-${index}`, subjectId: `owner-${index}`, audience: "lemmacomputer-control" as const };
    const record = await store.createOrGet(identity, "personal", `recovery-${index}`);
    records.push(await store.update(record.id, { state: "ready", providerId: record.id }));
  }
  const calls: string[] = [];
  const worker = new WorkspaceRecoveryWorker(store, { recover: async (record) => { calls.push(record.id); } }, async (record) => {
    if (record.subjectId === "owner-0") return null; // disabled or missing policy
    if (record.subjectId === "owner-1") throw new Error("policy dependency unavailable");
    const identity = { ...record, audience: "lemmacomputer-control" as const };
    if (record.subjectId === "owner-2") identity.tenantId = "foreign";
    return { identity, policy };
  }, () => undefined);
  await worker.runOnce();
  assert.ok(calls.length <= 20);
  await worker.runOnce();
  assert.equal(new Set(calls).size, 21, "later tenants cannot starve behind the first page");
  worker.stop();
  await worker.runOnce();
  assert.equal(calls.length, 21);
});
