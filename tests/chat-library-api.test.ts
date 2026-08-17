import assert from "node:assert/strict";
import test from "node:test";
import { MemoryArtifactStore } from "@lemmacomputer/artifact-store";
import type { IdentityContext } from "@lemmacomputer/contracts";
import { MemoryChatStore, MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "chat-library-proxy-token-at-least-24-characters";
const owner: IdentityContext = {
  tenantId: "tenant-chat-library",
  subjectId: "owner-chat-library",
  audience: "lemmacomputer-control",
};
const outsider: IdentityContext = {
  ...owner,
  subjectId: "outsider-chat-library",
};

const headers = (identity: IdentityContext) => ({
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": identity.tenantId,
  "x-lemmacomputer-test-user-id": identity.subjectId,
});

test("the account chat library exposes owned transcripts without leaking them to another subject", async () => {
  const chats = new MemoryChatStore();
  const conversation = await chats.createConversation({
    identity: owner,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    defaultAgentCatalogId: "hermes-claw",
    title: "Retained handover",
    requestedServiceClass: "balanced",
  });
  await chats.upsertMessage(owner, conversation.id, {
    id: "message-retained-user",
    role: "user",
    metadata: {
      agentCatalogId: "hermes-claw",
      state: "completed",
      createdAt: "2026-08-17T00:00:00.000Z",
    },
    parts: [{ type: "text", text: "Keep this handover." }],
  });
  const artifactId = "artifact-11111111111111111111111111111111";
  const revisionId = "revision-11111111111111111111111111111111";
  await chats.createArtifactStaging({
    id: "upload-11111111111111111111111111111111",
    tenantId: owner.tenantId,
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    ownerSubjectId: owner.subjectId,
    direction: "output",
    originalFilename: "handover-notes.md",
    mediaType: "text/markdown",
    expectedByteLength: 42,
    expectedSha256: "a".repeat(64),
    workspaceNodeId: null,
    accessGeneration: 1,
    storageBackend: "filesystem",
    stagingLocator: "staging/handover-notes.md",
    artifactId: null,
    revisionId: null,
    finalStorageLocator: null,
    expiresAt: new Date("2026-08-17T00:10:00.000Z"),
  });
  await chats.prepareArtifactFinalization({
    identity: owner,
    uploadId: "upload-11111111111111111111111111111111",
    artifactId,
    revisionId,
    finalStorageLocator: "artifacts/handover-notes.md",
  });
  await chats.commitArtifact({
    identity: owner,
    uploadId: "upload-11111111111111111111111111111111",
    artifactId,
    revisionId,
    finalStorageLocator: "artifacts/handover-notes.md",
    messageId: "message-retained-user",
  });

  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    {},
    {
      testIdentityMode: true,
      chatStore: chats,
      artifactStore: new MemoryArtifactStore(),
    },
  );

  try {
    const library = await app.inject({ method: "GET", url: "/v1/chat/sessions", headers: headers(owner) });
    assert.equal(library.statusCode, 200, library.body);
    assert.deepEqual(library.json().sessions.map((session: { id: string; workspaceId: string }) => ({
      id: session.id,
      workspaceId: session.workspaceId,
    })), [{ id: conversation.id, workspaceId: conversation.workspaceId }]);

    const transcript = await app.inject({
      method: "GET",
      url: `/v1/chat/sessions/${conversation.id}/messages`,
      headers: headers(owner),
    });
    assert.equal(transcript.statusCode, 200, transcript.body);
    assert.equal(transcript.json().messages[0].parts[0].text, "Keep this handover.");

    const artifacts = await app.inject({
      method: "GET",
      url: "/v1/chat/artifacts?query=HANDOVER",
      headers: headers(owner),
    });
    assert.equal(artifacts.statusCode, 200, artifacts.body);
    assert.deepEqual(artifacts.json().artifacts.map((artifact: { id: string; displayName: string }) => ({
      id: artifact.id,
      displayName: artifact.displayName,
    })), [{ id: artifactId, displayName: "handover-notes.md" }]);

    const outsiderLibrary = await app.inject({ method: "GET", url: "/v1/chat/sessions", headers: headers(outsider) });
    assert.equal(outsiderLibrary.statusCode, 200, outsiderLibrary.body);
    assert.deepEqual(outsiderLibrary.json().sessions, []);

    const outsiderArtifacts = await app.inject({ method: "GET", url: "/v1/chat/artifacts", headers: headers(outsider) });
    assert.equal(outsiderArtifacts.statusCode, 200, outsiderArtifacts.body);
    assert.deepEqual(outsiderArtifacts.json().artifacts, []);

    const outsiderTranscript = await app.inject({
      method: "GET",
      url: `/v1/chat/sessions/${conversation.id}/messages`,
      headers: headers(outsider),
    });
    assert.equal(outsiderTranscript.statusCode, 404, outsiderTranscript.body);
  } finally {
    await app.close();
  }
});
