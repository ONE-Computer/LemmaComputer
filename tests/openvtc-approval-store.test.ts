import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { IdentityContext, OwnedJson } from "@onecomputer/contracts";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";

const identity: IdentityContext = { tenantId: "tenant-openvtc", subjectId: "owner-openvtc", audience: "onecomputer-control" };
const NOW = new Date("2026-07-21T02:00:00.000Z");

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const setupOperation = async (store: MemoryWorkspaceStore) => {
  const workspace = await store.createOrGet(identity, "grant-openvtc", randomUUID());
  const operation = await store.createGovernedOperation({
    id: randomUUID(),
    identity,
    workspaceId: workspace.id,
    agentId: "agent-openvtc",
    capabilityId: "onedrive-delete-protected",
    serverName: "onecomputer_ms365",
    toolName: "delete-onedrive-file",
    schemaId: "onecomputer.m365.delete-onedrive-file.v1",
    arguments: { driveId: "drive", driveItemId: "item", "If-Match": "etag", confirm: true, excludeResponse: true },
    operationDigest: "a".repeat(64),
    nonce: randomUUID(),
    safeSummary: "Delete OneDrive item item",
    resourceName: "item",
    resourceLocation: "OneDrive drive drive",
    correlationId: "openvtc-test",
    idempotencyKey: randomUUID(),
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
  });
  assert.ok(operation);
  return operation;
};

const enroll = (store: MemoryWorkspaceStore, did: string, token: string, at = NOW) => store.enrollOpenVtcApprover({
  id: randomUUID(),
  identity,
  approverDid: did,
  verificationMethod: `${did}#${did.slice("did:key:".length)}`,
  displayName: "Mike's browser",
  transportTokenHash: sha256(token),
  enrolledAt: at,
});

const createTask = async (
  store: MemoryWorkspaceStore,
  operationId: string,
  approverId: string,
  expiresAt = new Date(NOW.getTime() + 10 * 60 * 1000),
) => {
  const requestDocument: OwnedJson = {
    id: `urn:uuid:${randomUUID()}`,
    type: "https://trusttasks.org/spec/task-consent/request/0.1",
    issuer: "did:key:zExecutor",
    recipient: "did:key:zApprover",
    payload: { payloadDigest: "b".repeat(64) },
  };
  return store.createOpenVtcConsentTask({
    id: randomUUID(),
    outboxId: randomUUID(),
    identity,
    operationId,
    approverId,
    executorDid: "did:key:zExecutor",
    challenge: "challenge-with-at-least-128-bits",
    taskType: "https://onecomputer.dev/spec/microsoft365/delete-onedrive-file/0.1",
    payloadDigest: "b".repeat(64),
    requestDocument,
    requestHash: sha256(JSON.stringify(requestDocument)),
    requestProofHash: "c".repeat(64),
    createdAt: NOW,
    expiresAt,
  });
};

test("OpenVTC enrollment keeps independently hashed transport tokens for multiple active approvers", async () => {
  const store = new MemoryWorkspaceStore();
  const first = await enroll(store, "did:key:zFirstApprover", "first-secret-token");

  assert.equal(await store.getOpenVtcApproverByTransportTokenHash(sha256("first-secret-token")), first);
  assert.equal(await store.getOpenVtcApproverByTransportTokenHash("first-secret-token"), null);

  const second = await enroll(store, "did:key:zSecondApprover", "second-secret-token", new Date(NOW.getTime() + 1_000));
  assert.equal((await store.getActiveOpenVtcApprover(identity))?.id, second.id);
  assert.equal(await store.getOpenVtcApproverByTransportTokenHash(sha256("first-secret-token")), first);
  assert.deepEqual((await store.listActiveOpenVtcApprovers(identity)).map((item) => item.id), [second.id, first.id]);
});

test("OpenVTC enrollment challenges are owner-bound, expiring, and single use", async () => {
  const store = new MemoryWorkspaceStore();
  const challenge = await store.createOpenVtcEnrollmentChallenge({
    id: randomUUID(),
    identity,
    executorDid: "did:key:zExecutor",
    challenge: "single-use-enrollment-challenge",
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const consumedAt = new Date(NOW.getTime() + 1_000);
  assert.equal((await store.getOpenVtcEnrollmentChallenge(identity, challenge.id))?.challenge, challenge.challenge);
  assert.equal(await store.getOpenVtcEnrollmentChallenge({ ...identity, subjectId: "other-user" }, challenge.id), null);
  assert.equal(await store.consumeOpenVtcEnrollmentChallenge(identity, challenge.id, challenge.challenge, consumedAt), true);
  assert.equal(await store.consumeOpenVtcEnrollmentChallenge(identity, challenge.id, challenge.challenge, consumedAt), false);
  assert.equal(await store.consumeOpenVtcEnrollmentChallenge({ ...identity, subjectId: "other-user" }, challenge.id, challenge.challenge, consumedAt), false);
});

test("OpenVTC task creation is operation-bound and idempotent", async () => {
  const store = new MemoryWorkspaceStore();
  const operation = await setupOperation(store);
  const approver = await enroll(store, "did:key:zTaskApprover", "task-secret-token");
  const task = await createTask(store, operation.id, approver.id);
  assert.ok(task);
  assert.equal(task.operationId, operation.id);
  assert.equal(task.state, "queued");

  const duplicate = await createTask(store, operation.id, approver.id);
  assert.equal(duplicate?.id, task.id);
  assert.equal(await createTask(store, randomUUID(), approver.id), null);
});

test("OpenVTC HTTPS inbox redelivers a live signed task and fails closed after revocation", async () => {
  const store = new MemoryWorkspaceStore();
  const operation = await setupOperation(store);
  const approver = await enroll(store, "did:key:zInboxApprover", "inbox-secret-token");
  const task = await createTask(store, operation.id, approver.id);
  assert.ok(task);

  const first = await store.deliverNextOpenVtcConsentTask(approver.id, new Date(NOW.getTime() + 1_000));
  const replay = await store.deliverNextOpenVtcConsentTask(approver.id, new Date(NOW.getTime() + 2_000));
  assert.equal(first?.state, "delivered");
  assert.equal(replay?.id, first?.id);
  assert.deepEqual(replay?.requestDocument, task.requestDocument);

  assert.equal(await store.revokeOpenVtcApprover(identity, approver.id, new Date(NOW.getTime() + 3_000)), true);
  assert.equal(await store.deliverNextOpenVtcConsentTask(approver.id, new Date(NOW.getTime() + 4_000)), null);
});

test("OpenVTC inbox never delivers an expired task", async () => {
  const store = new MemoryWorkspaceStore();
  const operation = await setupOperation(store);
  const approver = await enroll(store, "did:key:zExpiredApprover", "expired-secret-token");
  await createTask(store, operation.id, approver.id, new Date(NOW.getTime() + 100));
  assert.equal(await store.deliverNextOpenVtcConsentTask(approver.id, new Date(NOW.getTime() + 100)), null);
});

test("a verified OpenVTC decision atomically records evidence and operation approval", async () => {
  const store = new MemoryWorkspaceStore();
  const operation = await setupOperation(store);
  const approverDid = "did:key:zDecisionApprover";
  const approver = await enroll(store, approverDid, "decision-secret-token");
  const task = await createTask(store, operation.id, approver.id);
  assert.ok(task);
  const decisionDocument: OwnedJson = {
    id: `urn:uuid:${randomUUID()}`,
    type: "https://trusttasks.org/spec/task-consent/decision/0.1",
    issuer: approverDid,
    recipient: task.executorDid,
    payload: { challenge: task.challenge, payloadDigest: task.payloadDigest, decision: "approve" },
    proof: { proofValue: "redacted-test-proof" },
  };
  const decidedAt = new Date(NOW.getTime() + 2_000);
  const recorded = await store.recordOpenVtcDecision({
    identity,
    taskId: task.id,
    approvalId: randomUUID(),
    approverId: approver.id,
    signerDid: approverDid,
    verificationMethod: approver.verificationMethod,
    challenge: task.challenge,
    payloadDigest: task.payloadDigest,
    decision: "approve",
    decisionDocument,
    decisionHash: "c".repeat(64),
    proofHash: "d".repeat(64),
    issuedAt: new Date(NOW.getTime() + 1_000),
    decidedAt,
    correlationId: "decision-test",
  });

  assert.equal(recorded?.state, "approved");
  assert.equal(recorded?.approval?.channel, "openvtc-task-consent");
  const storedTask = await store.getOpenVtcConsentTask(identity, operation.id);
  assert.equal(storedTask?.state, "approved");
  assert.equal(storedTask?.decisionHash, "c".repeat(64));
  assert.deepEqual(storedTask?.decisionDocument, decisionDocument);
});
