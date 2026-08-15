import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { IdentityContext, OwnedJson } from "@lemmacomputer/contracts";
import { PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.OPENVTC_PUSH_TEST_DATABASE_URL;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("governed OpenVTC evidence survives workspace deletion", {
  skip: !connectionString,
}, async () => {
  const store = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  const identity: IdentityContext = {
    tenantId: `governed-retention-${randomUUID()}`,
    subjectId: "retention-owner",
    audience: "lemmacomputer-control",
  };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000);
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  const approverId = randomUUID();
  const taskId = randomUUID();
  const approverDid = "did:key:zRetentionApprover";
  const verificationMethod = `${approverDid}#zRetentionApprover`;
  const challenge = `retention-${randomUUID()}`;
  const payloadDigest = "b".repeat(64);
  const requestDocument: OwnedJson = {
    id: `urn:uuid:${randomUUID()}`,
    type: "https://trusttasks.org/spec/task-consent/request/0.1",
    issuer: "did:key:zRetentionExecutor",
    recipient: approverDid,
    payload: { workspaceId, payloadDigest },
    proof: { proofValue: "signed-request-proof" },
  };
  const decisionDocument: OwnedJson = {
    id: `urn:uuid:${randomUUID()}`,
    type: "https://trusttasks.org/spec/task-consent/decision/0.1",
    issuer: approverDid,
    recipient: "did:key:zRetentionExecutor",
    payload: { challenge, payloadDigest, decision: "approve" },
    proof: { proofValue: "signed-decision-proof" },
  };

  try {
    await store.migrate();
    await pool.query(
      `INSERT INTO workspaces (id,tenant_id,subject_id,grant_id,state,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'ready',$5,$5)`,
      [workspaceId, identity.tenantId, identity.subjectId, `retention-${randomUUID()}`, now],
    );
    const operation = await store.createGovernedOperation({
      id: operationId,
      identity,
      workspaceId,
      agentId: "agent-retention",
      capabilityId: "m365-write-protected",
      serverName: "lemmacomputer_ms365",
      toolName: "delete-calendar-event",
      schemaId: "lemmacomputer.m365.delete-calendar-event.v1",
      arguments: { eventId: "retained-event" },
      operationDigest: "a".repeat(64),
      nonce: randomUUID(),
      safeSummary: "Delete retained calendar event",
      resourceName: "Retained event",
      resourceLocation: "Microsoft Outlook",
      correlationId: "governed-retention-test",
      idempotencyKey: randomUUID(),
      createdAt: now,
      expiresAt,
    });
    assert.ok(operation);

    await store.enrollOpenVtcApprover({
      id: approverId,
      identity,
      approverDid,
      verificationMethod,
      displayName: "Retention approver",
      transportTokenHash: sha256(randomUUID()),
      enrolledAt: now,
    });
    const task = await store.createOpenVtcConsentTask({
      id: taskId,
      outboxId: randomUUID(),
      identity,
      operationId,
      approverId,
      executorDid: "did:key:zRetentionExecutor",
      challenge,
      taskType: "https://lemmacomputer.dev/spec/microsoft365/delete-calendar-event/0.1",
      payloadDigest,
      requestDocument,
      requestHash: sha256(JSON.stringify(requestDocument)),
      requestProofHash: "c".repeat(64),
      createdAt: now,
      expiresAt,
    });
    assert.ok(task);

    const approved = await store.recordOpenVtcDecision({
      identity,
      taskId,
      approvalId: randomUUID(),
      approverId,
      signerDid: approverDid,
      verificationMethod,
      challenge,
      payloadDigest,
      decision: "approve",
      decisionDocument,
      decisionHash: "d".repeat(64),
      proofHash: "e".repeat(64),
      issuedAt: now,
      decidedAt: new Date(now.getTime() + 1_000),
      correlationId: "governed-retention-approved",
    });
    assert.equal(approved?.state, "approved");

    const leaseId = randomUUID();
    const claimed = await store.claimExecution(
      identity,
      operationId,
      leaseId,
      new Date(now.getTime() + 5 * 60_000),
      "governed-retention-executing",
    );
    assert.equal(claimed?.state, "executing");
    const completed = await store.completeExecution(identity, operationId, leaseId, {
      id: randomUUID(),
      upstreamReference: "outlook:event:retained-event",
      resultSummary: "Deleted retained calendar event",
      resultHash: "f".repeat(64),
      executedAt: new Date(now.getTime() + 2_000),
    }, "governed-retention-succeeded");
    assert.equal(completed?.state, "succeeded");

    assert.equal(await store.remove(identity, workspaceId), true);
    assert.equal(await store.getOwned(identity, workspaceId), null);

    const retainedOperation = await store.getOwnedOperation(identity, operationId);
    assert.equal(retainedOperation?.workspaceId, null);
    assert.equal(retainedOperation?.state, "succeeded");
    assert.equal(retainedOperation?.approval?.channel, "openvtc-task-consent");
    assert.equal(retainedOperation?.receipt?.upstreamReference, "outlook:event:retained-event");

    const retainedTask = await store.getOpenVtcConsentTask(identity, operationId);
    assert.deepEqual(retainedTask?.requestDocument, requestDocument);
    assert.equal(retainedTask?.requestProofHash, "c".repeat(64));
    assert.deepEqual(retainedTask?.decisionDocument, decisionDocument);
    assert.equal(retainedTask?.decisionHash, "d".repeat(64));
    assert.equal(retainedTask?.proofHash, "e".repeat(64));
  } finally {
    await pool.end();
    await store.close();
  }
});
