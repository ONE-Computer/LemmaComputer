import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { governedOperationDigest, type GovernedOperationEnvelope, type IdentityContext } from "@lemmacomputer/contracts";
import { MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";

const alex: IdentityContext = { tenantId: "acme", subjectId: "alex-morgan", audience: "lemmacomputer-control" };
const outsider: IdentityContext = { tenantId: "other", subjectId: "alex-morgan", audience: "lemmacomputer-control" };

const setup = async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(alex, "personal", randomUUID());
  const now = new Date();
  const envelope: GovernedOperationEnvelope = {
    version: "1",
    ...alex,
    workspaceId: workspace.id,
    capabilityId: "files.delete",
    serverName: "lemmacomputer_fixture",
    toolName: "delete_file",
    schemaId: "lemmacomputer.fixture.delete_file.v1",
    arguments: { path: "/Finance/2026/Q3-draft.docx" },
    nonce: randomUUID(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  return { store, workspace, now, envelope };
};

test("governed operations are idempotent and tenant scoped", async () => {
  const { store, workspace, now, envelope } = await setup();
  const input = {
    id: randomUUID(),
    identity: alex,
    workspaceId: workspace.id,
    capabilityId: envelope.capabilityId,
    serverName: envelope.serverName,
    toolName: envelope.toolName,
    schemaId: envelope.schemaId,
    arguments: envelope.arguments,
    operationDigest: governedOperationDigest(envelope),
    nonce: envelope.nonce,
    safeSummary: "Delete Q3-draft.docx",
    resourceName: "Q3-draft.docx",
    resourceLocation: "OneDrive / Finance / 2026",
    correlationId: "request-1",
    idempotencyKey: "operation-request-1",
    createdAt: now,
    expiresAt: new Date(envelope.expiresAt),
  };
  const created = await store.createGovernedOperation(input);
  const replay = await store.createGovernedOperation({ ...input, id: randomUUID() });
  assert.equal(created?.id, replay?.id);
  assert.equal((await store.getOwnedOperation(outsider, created!.id)), null);
  assert.equal((await store.getRecentOperation(outsider)), null);
});

test("an operation cannot be created against another tenant's workspace", async () => {
  const { store, workspace, now, envelope } = await setup();
  const created = await store.createGovernedOperation({
    id: randomUUID(),
    identity: outsider,
    workspaceId: workspace.id,
    capabilityId: envelope.capabilityId,
    serverName: envelope.serverName,
    toolName: envelope.toolName,
    schemaId: envelope.schemaId,
    arguments: envelope.arguments,
    operationDigest: governedOperationDigest({ ...envelope, tenantId: outsider.tenantId }),
    nonce: envelope.nonce,
    safeSummary: "Delete Q3-draft.docx",
    resourceName: "Q3-draft.docx",
    resourceLocation: "OneDrive / Finance / 2026",
    correlationId: "request-2",
    idempotencyKey: "operation-request-2",
    createdAt: now,
    expiresAt: new Date(envelope.expiresAt),
  });
  assert.equal(created, null);
});

test("access revocation cancels only the target user's pending governed operations", async () => {
  const { store, workspace, now, envelope } = await setup();
  const operation = await store.createGovernedOperation({
    id: randomUUID(), identity: alex, workspaceId: workspace.id,
    capabilityId: envelope.capabilityId, serverName: envelope.serverName, toolName: envelope.toolName,
    schemaId: envelope.schemaId, arguments: envelope.arguments, operationDigest: governedOperationDigest(envelope),
    nonce: envelope.nonce, safeSummary: "Delete Q3-draft.docx", resourceName: "Q3-draft.docx",
    resourceLocation: "OneDrive / Finance / 2026", correlationId: "request-revoke",
    idempotencyKey: "operation-request-revoke", createdAt: now, expiresAt: new Date(envelope.expiresAt),
  });
  assert.ok(operation);
  assert.equal(await store.cancelPendingGovernedOperations(outsider, now, "admin-revoke-other"), 0);
  assert.equal(await store.cancelPendingGovernedOperations(alex, now, "admin-revoke"), 1);
  const canceled = await store.getOwnedOperation(alex, operation.id);
  assert.equal(canceled?.state, "failed");
  assert.equal(canceled?.failureCode, "MEMBERSHIP_ACCESS_REVOKED");
  assert.equal(await store.cancelPendingGovernedOperations(alex, now, "admin-revoke-replay"), 0);
});
