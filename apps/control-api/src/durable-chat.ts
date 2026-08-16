import { createHash, randomUUID } from "node:crypto";
import { artifactRevisionLocator, type ArtifactStore } from "@lemmacomputer/artifact-store";
import {
  LemmaComputerError,
  chatUiMessageSchema,
  type AgentChatEvent,
  type ChatUiMessage,
  type IdentityContext,
} from "@lemmacomputer/contracts";
import type {
  ArtifactDirection,
  AuthorizedArtifactRevision,
  ChatConversationRecord,
  ChatStore,
} from "@lemmacomputer/workspace-store";
import type { AgentChatAccess, AgentChatClient } from "./agent-chat.js";

const opaqueId = (prefix: "upload" | "artifact" | "revision") => `${prefix}-${randomUUID().replaceAll("-", "")}`;

const decodeInlineFile = (part: Extract<ChatUiMessage["parts"][number], { type: "file" }>) => {
  const prefix = `data:${part.mediaType};base64,`;
  if (!part.url.startsWith(prefix)) throw new LemmaComputerError("CHAT_ATTACHMENT_INVALID", "Attachment data is invalid", 400);
  const encoded = part.url.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new LemmaComputerError("CHAT_ATTACHMENT_INVALID", "Attachment data is invalid", 400);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new LemmaComputerError("CHAT_ATTACHMENT_INVALID", "Attachment data is invalid", 400);
  }
  return bytes;
};

export class DurableChatService {
  constructor(
    private readonly chats: ChatStore,
    private readonly artifacts: ArtifactStore,
    private readonly options: { requireNodePlacement: boolean; stagingTtlMs?: number },
  ) {}

  private async ingestBytes(input: {
    identity: IdentityContext;
    conversation: ChatConversationRecord;
    access: Pick<AgentChatAccess, "workspaceNodeId" | "accessGeneration">;
    direction: ArtifactDirection;
    filename: string;
    mediaType: string;
    bytes: Buffer;
    declaredSha256?: string;
  }): Promise<AuthorizedArtifactRevision> {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    if (input.declaredSha256 && input.declaredSha256 !== sha256) {
      throw new LemmaComputerError("CHAT_ARTIFACT_MISMATCH", "The generated file changed before it could be saved", 409);
    }
    const placement = await this.chats.verifyIngestionPlacement({
      identity: input.identity,
      workspaceId: input.conversation.workspaceId,
      workspaceNodeId: input.access.workspaceNodeId,
      accessGeneration: input.access.accessGeneration,
      requireNodePlacement: this.options.requireNodePlacement,
    });
    const uploadId = opaqueId("upload");
    const artifactId = opaqueId("artifact");
    const revisionId = opaqueId("revision");
    let stagingLocator: string | undefined;
    let finalLocator: string | undefined;
    try {
      stagingLocator = await this.artifacts.stage({
        tenantId: input.identity.tenantId,
        uploadId,
        mediaType: input.mediaType,
        bytes: input.bytes,
        sha256,
      });
      await this.chats.createArtifactStaging({
        id: uploadId,
        tenantId: input.identity.tenantId,
        workspaceId: input.conversation.workspaceId,
        conversationId: input.conversation.id,
        ownerSubjectId: input.identity.subjectId,
        direction: input.direction,
        originalFilename: input.filename,
        mediaType: input.mediaType,
        expectedByteLength: input.bytes.length,
        expectedSha256: sha256,
        workspaceNodeId: placement.workspaceNodeId,
        accessGeneration: placement.accessGeneration,
        storageBackend: this.artifacts.backend,
        stagingLocator,
        artifactId: null,
        revisionId: null,
        finalStorageLocator: null,
        expiresAt: new Date(Date.now() + (this.options.stagingTtlMs ?? 15 * 60_000)),
      });
      const intendedFinalLocator = artifactRevisionLocator(input.identity.tenantId, artifactId, revisionId);
      await this.chats.prepareArtifactFinalization({
        identity: input.identity,
        uploadId,
        artifactId,
        revisionId,
        finalStorageLocator: intendedFinalLocator,
      });
      finalLocator = await this.artifacts.finalize({
        tenantId: input.identity.tenantId,
        uploadId,
        artifactId,
        revisionId,
        stagingLocator,
        mediaType: input.mediaType,
        byteLength: input.bytes.length,
        sha256,
      });
      if (finalLocator !== intendedFinalLocator) throw new Error("ArtifactStore returned an unexpected final locator");
      return await this.chats.commitArtifact({
        identity: input.identity,
        uploadId,
        artifactId,
        revisionId,
        finalStorageLocator: finalLocator,
      });
    } catch (error) {
      await this.chats.failArtifactStaging(input.identity, uploadId).catch(() => undefined);
      if (finalLocator) await this.artifacts.delete(finalLocator).catch(() => undefined);
      else if (stagingLocator) await this.artifacts.deleteStaging(stagingLocator).catch(() => undefined);
      throw error;
    }
  }

  async persistUserMessage(input: {
    identity: IdentityContext;
    conversation: ChatConversationRecord;
    access: Pick<AgentChatAccess, "workspaceNodeId" | "accessGeneration">;
    message: ChatUiMessage;
  }) {
    const runtimeMessage = chatUiMessageSchema.parse(input.message);
    const canonicalParts: ChatUiMessage["parts"] = [];
    const bindings: AuthorizedArtifactRevision[] = [];
    for (const part of runtimeMessage.parts) {
      if (part.type !== "file") {
        canonicalParts.push(part);
        continue;
      }
      const saved = await this.ingestBytes({
        identity: input.identity,
        conversation: input.conversation,
        access: input.access,
        direction: "input",
        filename: part.filename,
        mediaType: part.mediaType,
        bytes: decodeInlineFile(part),
      });
      bindings.push(saved);
      canonicalParts.push({
        type: "data-file-reference",
        id: saved.artifact.id,
        data: {
          mediaType: part.mediaType,
          filename: part.filename,
          storage: "control",
          revisionId: saved.revision.id,
        },
      });
    }
    const canonicalMessage = chatUiMessageSchema.parse({ ...runtimeMessage, parts: canonicalParts });
    await this.chats.upsertMessage(input.identity, input.conversation.id, canonicalMessage);
    await Promise.all(bindings.map((saved) => this.chats.bindArtifact({
      identity: input.identity,
      conversationId: input.conversation.id,
      messageId: canonicalMessage.id,
      artifactId: saved.artifact.id,
      revisionId: saved.revision.id,
      direction: "input",
    })));
    return { canonicalMessage, runtimeMessage };
  }

  async persistGeneratedArtifact(input: {
    identity: IdentityContext;
    conversation: ChatConversationRecord;
    access: AgentChatAccess;
    client: AgentChatClient;
    event: Extract<AgentChatEvent, { type: "artifact" }>;
  }) {
    const bytes = await input.client.downloadArtifact(input.access, input.event.artifactId);
    if (bytes.length !== input.event.byteLength) {
      throw new LemmaComputerError("CHAT_ARTIFACT_MISMATCH", "The generated file changed before it could be saved", 409);
    }
    const saved = await this.ingestBytes({
      identity: input.identity,
      conversation: input.conversation,
      access: input.access,
      direction: "output",
      filename: input.event.filename,
      mediaType: input.event.mediaType,
      bytes,
      declaredSha256: input.event.sha256,
    });
    return {
      ...input.event,
      artifactId: saved.artifact.id,
      revisionId: saved.revision.id,
      byteLength: saved.revision.byteLength,
      sha256: saved.revision.sha256,
    } satisfies AgentChatEvent;
  }

  async bindMessageArtifacts(identity: IdentityContext, conversationId: string, message: ChatUiMessage) {
    await Promise.all(message.parts.flatMap((part) => part.type === "data-file-reference" ? [this.chats.bindArtifact({
      identity,
      conversationId,
      messageId: message.id,
      artifactId: part.id,
      revisionId: part.data.revisionId,
      direction: message.role === "user" ? "input" : "output",
    })] : []));
  }

  async readArtifact(identity: IdentityContext, artifactId: string, revisionId?: string) {
    const saved = await this.chats.getArtifact(identity, artifactId, revisionId);
    if (!saved) throw new LemmaComputerError("CHAT_ARTIFACT_NOT_FOUND", "Artifact not found", 404);
    const bytes = await this.artifacts.read({
      locator: saved.revision.storageLocator,
      byteLength: saved.revision.byteLength,
      sha256: saved.revision.sha256,
    });
    return { ...saved, bytes };
  }

  async cleanupExpiredStaging(limit = 100) {
    const expired = await this.chats.listExpiredStaging(new Date(), limit);
    for (const upload of expired) {
      try {
        if (upload.finalStorageLocator) await this.artifacts.delete(upload.finalStorageLocator);
        await this.artifacts.deleteStaging(upload.stagingLocator);
        await this.chats.abandonStaging(upload.tenantId, upload.id);
      } catch {
        // Keep the row retryable. Storage deletion must succeed before Control
        // records cleanup complete, otherwise a transient outage could leak bytes.
      }
    }
    return expired.length;
  }
}
