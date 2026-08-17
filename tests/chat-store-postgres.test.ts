import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresChatStore, PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";
import type { IdentityContext } from "@lemmacomputer/contracts";

const connectionString = process.env.CHAT_STORE_TEST_DATABASE_URL;

test("ChatStore owns unified history, forks without vendor sessions, and enforces tenant placement", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString });
  const workspaces = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const chats = PostgresChatStore.fromConnectionString(connectionString!);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const identity: IdentityContext = { tenantId: `chat-${suffix}`, subjectId: `owner-${suffix}`, audience: "lemmacomputer-control" };
  const outsider: IdentityContext = { tenantId: `other-${suffix}`, subjectId: `outsider-${suffix}`, audience: "lemmacomputer-control" };
  try {
    for (const owner of [identity, outsider]) {
      await pool.query("INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Chat tenant')", [owner.tenantId, `external-${owner.tenantId}`]);
      await pool.query("INSERT INTO organizations(id,display_name) VALUES($1,'Chat tenant')", [owner.tenantId]);
      await pool.query("INSERT INTO users(id,tenant_id,email,display_name) VALUES($1,$2,$3,'Chat owner')", [owner.subjectId, owner.tenantId, `${owner.tenantId}@example.test`]);
    }
    const workspace = await workspaces.createOrGet(identity, `grant-${suffix}`, randomUUID());
    await workspaces.update(workspace.id, { state: "ready", providerId: `sandbox-${suffix}` });
    const readyWorkspace = (await workspaces.getOwned(identity, workspace.id))!;
    const conversation = await chats.createConversation({
      identity, workspaceId: workspace.id, defaultAgentCatalogId: "claude-cli", title: "Durable report",
      requestedServiceClass: "balanced", reasoningEffort: "medium",
    });
    await chats.upsertMessage(identity, conversation.id, {
      id: "user-1", role: "user",
      metadata: { agentCatalogId: "claude-cli", state: "completed", createdAt: new Date().toISOString(), source: "web" },
      parts: [{ type: "text", text: "Create the report" }],
    });
    await chats.upsertMessage(identity, conversation.id, {
      id: "assistant-1", role: "assistant",
      metadata: { agentCatalogId: "claude-cli", turnId: "turn-1", state: "completed", createdAt: new Date().toISOString() },
      parts: [{ type: "text", text: "Done", state: "done" }, { type: "data-terminal", id: "terminal-1", data: { turnId: "turn-1", state: "completed" } }],
    });
    await chats.setVendorSession(identity, conversation.id, "claude-cli", "vendor-session-secret");
    const fork = await chats.forkConversation({
      identity, conversationId: conversation.id, fromMessageId: "assistant-1",
      targetWorkspaceId: workspace.id,
      defaultAgentCatalogId: "codex-cli", requestedServiceClass: "balanced", reasoningEffort: "high",
    });
    assert.equal(fork.parentConversationId, conversation.id);
    assert.deepEqual((await chats.listMessages(identity, fork.id)).map((message) => message.id), ["user-1", "assistant-1"]);
    assert.equal(await chats.getVendorSession(identity, fork.id, "codex-cli"), null);
    assert.equal((await chats.listConversations(identity, workspace.id, { limit: 20 })).conversations.length, 2);
    assert.equal(await chats.getConversation(outsider, conversation.id), null);

    assert.deepEqual(await chats.verifyIngestionPlacement({
      identity, workspaceId: workspace.id, workspaceNodeId: readyWorkspace.workspaceNodeId,
      accessGeneration: readyWorkspace.accessGeneration, requireNodePlacement: false,
    }), { workspaceNodeId: readyWorkspace.workspaceNodeId ?? null, accessGeneration: readyWorkspace.accessGeneration });
    await assert.rejects(() => chats.verifyIngestionPlacement({
      identity, workspaceId: workspace.id, workspaceNodeId: readyWorkspace.workspaceNodeId,
      accessGeneration: readyWorkspace.accessGeneration + 1, requireNodePlacement: false,
    }), { code: "ARTIFACT_INGESTION_REJECTED" });
    await assert.rejects(() => chats.verifyIngestionPlacement({
      identity, workspaceId: workspace.id, workspaceNodeId: "caller-forged-node",
      accessGeneration: readyWorkspace.accessGeneration, requireNodePlacement: false,
    }), { code: "ARTIFACT_INGESTION_REJECTED" });
    await assert.rejects(() => chats.verifyIngestionPlacement({
      identity, workspaceId: workspace.id, workspaceNodeId: null,
      accessGeneration: readyWorkspace.accessGeneration, requireNodePlacement: true,
    }), { code: "ARTIFACT_INGESTION_REJECTED" });

    const opaque = randomUUID().replaceAll("-", "");
    const uploadId = `upload-${opaque}`;
    const artifactId = `artifact-${opaque}`;
    const revisionId = `revision-${opaque}`;
    const stagingLocator = `tenants/${identity.tenantId}/staging/${uploadId}/source`;
    const finalStorageLocator = `tenants/${identity.tenantId}/artifacts/${artifactId}/revisions/${revisionId}/source`;
    await chats.createArtifactStaging({
      id: uploadId, tenantId: identity.tenantId, workspaceId: workspace.id,
      conversationId: conversation.id, ownerSubjectId: identity.subjectId, direction: "output",
      originalFilename: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      expectedByteLength: 12, expectedSha256: "a".repeat(64),
      workspaceNodeId: readyWorkspace.workspaceNodeId ?? null, accessGeneration: readyWorkspace.accessGeneration,
      storageBackend: "s3", stagingLocator, artifactId: null, revisionId: null,
      finalStorageLocator: null, expiresAt: new Date(Date.now() + 60_000),
    });
    await chats.prepareArtifactFinalization({ identity, uploadId, artifactId, revisionId, finalStorageLocator });
    const saved = await chats.commitArtifact({
      identity, uploadId, artifactId, revisionId, finalStorageLocator, messageId: "assistant-1",
    });
    assert.equal(saved.revision.storageLocator, finalStorageLocator);
    assert.equal(saved.artifact.currentRevisionId, revisionId);
    assert.equal((await chats.getArtifact(identity, artifactId, revisionId))?.artifact.id, artifactId);
    assert.equal(await chats.getArtifact(outsider, artifactId, revisionId), null);
    assert.deepEqual((await pool.query(
      "SELECT state,artifact_id,revision_id,final_storage_locator FROM artifact_staging_uploads WHERE id=$1",
      [uploadId],
    )).rows[0], {
      state: "committed", artifact_id: artifactId, revision_id: revisionId,
      final_storage_locator: finalStorageLocator,
    });

    const rollbackOpaque = randomUUID().replaceAll("-", "");
    const rollbackUploadId = `upload-${rollbackOpaque}`;
    const rollbackArtifactId = `artifact-${rollbackOpaque}`;
    const rollbackRevisionId = `revision-${rollbackOpaque}`;
    const rollbackStagingLocator = `tenants/${identity.tenantId}/staging/${rollbackUploadId}/source`;
    const rollbackFinalLocator = `tenants/${identity.tenantId}/artifacts/${rollbackArtifactId}/revisions/${rollbackRevisionId}/source`;
    await chats.createArtifactStaging({
      id: rollbackUploadId, tenantId: identity.tenantId, workspaceId: workspace.id,
      conversationId: conversation.id, ownerSubjectId: identity.subjectId, direction: "output",
      originalFilename: "rollback.pdf", mediaType: "application/pdf", expectedByteLength: 8,
      expectedSha256: "b".repeat(64), workspaceNodeId: readyWorkspace.workspaceNodeId ?? null,
      accessGeneration: readyWorkspace.accessGeneration, storageBackend: "s3",
      stagingLocator: rollbackStagingLocator, artifactId: null, revisionId: null,
      finalStorageLocator: null, expiresAt: new Date(Date.now() + 60_000),
    });
    await chats.prepareArtifactFinalization({
      identity, uploadId: rollbackUploadId, artifactId: rollbackArtifactId,
      revisionId: rollbackRevisionId, finalStorageLocator: rollbackFinalLocator,
    });
    await assert.rejects(() => chats.commitArtifact({
      identity, uploadId: rollbackUploadId, artifactId: rollbackArtifactId,
      revisionId: rollbackRevisionId, finalStorageLocator: rollbackFinalLocator,
      messageId: "missing-message",
    }));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM artifacts WHERE id=$1", [rollbackArtifactId])).rows[0].count, 0);
    assert.equal((await pool.query("SELECT state FROM artifact_staging_uploads WHERE id=$1", [rollbackUploadId])).rows[0].state, "finalizing");

    assert.deepEqual(await workspaces.getDeletionImpact(identity, workspace.id), {
      conversations: 2,
      artifacts: 1,
      protectedConversations: 0,
      protectedArtifacts: 0,
    });
    assert.equal(await workspaces.tombstone(identity, workspace.id, "preserve"), true);
    assert.equal(await workspaces.getOwned(identity, workspace.id), null);
    assert.deepEqual((await pool.query(
      "SELECT deletion_content_disposition,state FROM workspaces WHERE id=$1",
      [workspace.id],
    )).rows[0], { deletion_content_disposition: "preserve", state: "stopped" });
    assert.deepEqual((await pool.query(
      "SELECT state FROM chat_conversations WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[conversation.id, fork.id]],
    )).rows.map((row) => row.state), ["active", "active"]);
    assert.equal((await pool.query("SELECT state FROM artifacts WHERE id=$1", [artifactId])).rows[0].state, "available");
    const archivedConversations = await chats.listOwnedConversations(identity, { limit: 20 });
    assert.equal(archivedConversations.conversations.length, 2);
    assert.ok(archivedConversations.conversations.every((item) => item.workspaceDeletedAt instanceof Date));
    const archivedArtifacts = await chats.listOwnedArtifacts(identity, { limit: 20 });
    assert.equal(archivedArtifacts.artifacts.length, 1);
    assert.equal(archivedArtifacts.artifacts[0].artifact.id, artifactId);
    assert.ok(archivedArtifacts.artifacts[0].workspaceDeletedAt instanceof Date);

    const recreated = await workspaces.createOrGet(identity, `grant-${suffix}`, randomUUID());
    assert.equal(recreated.id, workspace.id, "recreating the same logical workspace revives its durable history");
    assert.equal(recreated.deletedAt, null);
    assert.equal((await chats.listConversations(identity, workspace.id, { limit: 20 })).conversations.length, 2);
    const targetWorkspace = await workspaces.createOrGet(identity, `target-${suffix}`, randomUUID());
    const continued = await chats.forkConversation({
      identity,
      conversationId: conversation.id,
      fromMessageId: "assistant-1",
      targetWorkspaceId: targetWorkspace.id,
      defaultAgentCatalogId: "hermes-claw",
      requestedServiceClass: "balanced",
    });
    assert.equal(continued.workspaceId, targetWorkspace.id);
    assert.equal(continued.parentConversationId, conversation.id);
    assert.deepEqual((await chats.listMessages(identity, continued.id)).map((message) => message.id), ["user-1", "assistant-1"]);

    await pool.query(
      "UPDATE chat_conversations SET retention_class='legal_hold' WHERE id=$1",
      [conversation.id],
    );
    assert.deepEqual(await workspaces.getDeletionImpact(identity, workspace.id), {
      conversations: 2,
      artifacts: 1,
      protectedConversations: 1,
      protectedArtifacts: 1,
    });
    assert.equal(await workspaces.tombstone(identity, workspace.id, "delete"), true);
    assert.equal(await workspaces.getOwned(identity, workspace.id), null);
    assert.equal((await pool.query("SELECT state FROM chat_conversations WHERE id=$1", [conversation.id])).rows[0].state, "active");
    assert.equal((await pool.query("SELECT state FROM chat_conversations WHERE id=$1", [fork.id])).rows[0].state, "staged_delete");
    assert.equal((await pool.query("SELECT state FROM artifacts WHERE id=$1", [artifactId])).rows[0].state, "available");
  } finally {
    await Promise.all([pool.end(), workspaces.close(), chats.close()]);
  }
});
