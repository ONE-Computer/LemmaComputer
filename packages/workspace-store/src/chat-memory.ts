import { randomUUID } from "node:crypto";
import { LemmaComputerError, chatUiMessageSchema, type IdentityContext } from "@lemmacomputer/contracts";
import type {
  ArtifactRecord,
  ArtifactRevisionRecord,
  ArtifactStagingRecord,
  AuthorizedArtifactRevision,
  ChatConversationRecord,
  ChatRunRecord,
  ChatStore,
  WorkspaceIngestionPlacement,
} from "./chat.js";

const key = (tenantId: string, id: string) => `${tenantId}:${id}`;
const owns = (identity: IdentityContext, conversation: ChatConversationRecord | undefined) => Boolean(
  conversation && conversation.tenantId === identity.tenantId && conversation.ownerSubjectId === identity.subjectId,
);

export class MemoryChatStore implements ChatStore {
  private readonly conversations = new Map<string, ChatConversationRecord>();
  private readonly messages = new Map<string, Map<string, ReturnType<typeof chatUiMessageSchema.parse>>>();
  private readonly vendorSessions = new Map<string, string>();
  private readonly staging = new Map<string, ArtifactStagingRecord>();
  private readonly artifacts = new Map<string, AuthorizedArtifactRevision>();
  private readonly runs = new Map<string, ChatRunRecord>();

  constructor(private readonly placement: (identity: IdentityContext, workspaceId: string) => WorkspaceIngestionPlacement = () => ({
    workspaceNodeId: null,
    accessGeneration: 1,
  })) {}

  async close() {}

  async createConversation(input: Parameters<ChatStore["createConversation"]>[0]) {
    const now = new Date();
    const value: ChatConversationRecord = {
      id: randomUUID(), tenantId: input.identity.tenantId, workspaceId: input.workspaceId,
      ownerSubjectId: input.identity.subjectId, defaultAgentCatalogId: input.defaultAgentCatalogId,
      title: input.title ?? null, requestedServiceClass: input.requestedServiceClass,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      parentConversationId: null, forkedFromMessageId: null, retentionClass: "saved", state: "active",
      createdAt: now, updatedAt: now,
    };
    this.conversations.set(key(value.tenantId, value.id), value);
    this.messages.set(key(value.tenantId, value.id), new Map());
    return structuredClone(value);
  }

  async listConversations(identity: IdentityContext, workspaceId: string, input: Parameters<ChatStore["listConversations"]>[2]) {
    const values = [...this.conversations.values()]
      .filter((item) => owns(identity, item) && item.workspaceId === workspaceId && item.state === "active"
        && (!input.agentCatalogId || item.defaultAgentCatalogId === input.agentCatalogId))
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    const start = input.cursor ? Math.max(0, values.findIndex((item) => item.id === input.cursor) + 1) : 0;
    const page = values.slice(start, start + input.limit);
    return { conversations: structuredClone(page), nextCursor: values.length > start + input.limit ? page.at(-1)!.id : null };
  }

  async getConversation(identity: IdentityContext, conversationId: string) {
    const value = this.conversations.get(key(identity.tenantId, conversationId));
    return owns(identity, value) && value?.state === "active" ? structuredClone(value) : null;
  }

  async listMessages(identity: IdentityContext, conversationId: string) {
    if (!await this.getConversation(identity, conversationId)) return [];
    return [...(this.messages.get(key(identity.tenantId, conversationId))?.values() ?? [])].map((item) => structuredClone(item));
  }

  async upsertMessage(identity: IdentityContext, conversationId: string, raw: Parameters<ChatStore["upsertMessage"]>[2]) {
    const conversation = await this.getConversation(identity, conversationId);
    if (!conversation) throw new LemmaComputerError("CHAT_CONVERSATION_NOT_FOUND", "Conversation not found", 404);
    const message = chatUiMessageSchema.parse(raw);
    if (message.parts.some((part) => part.type === "file")) throw new Error("Inline attachment data is not durable");
    this.messages.get(key(identity.tenantId, conversationId))!.set(message.id, structuredClone(message));
    this.conversations.set(key(identity.tenantId, conversationId), { ...conversation, updatedAt: new Date() });
  }

  async beginRun(input: Parameters<ChatStore["beginRun"]>[0]) {
    if (!await this.getConversation(input.identity, input.conversationId)) throw new Error("Conversation not found");
    const value: ChatRunRecord = { id: randomUUID(), tenantId: input.identity.tenantId, conversationId: input.conversationId,
      turnId: input.turnId, effectiveAgentCatalogId: input.effectiveAgentCatalogId, status: "streaming" };
    this.runs.set(key(input.identity.tenantId, `${input.conversationId}:${input.turnId}`), value);
    return value;
  }

  async finishRun(identity: IdentityContext, conversationId: string, turnId: string, input: Parameters<ChatStore["finishRun"]>[3]) {
    const runKey = key(identity.tenantId, `${conversationId}:${turnId}`);
    const run = this.runs.get(runKey);
    if (run) this.runs.set(runKey, { ...run, status: input.status });
  }

  async getVendorSession(identity: IdentityContext, conversationId: string, catalogId: Parameters<ChatStore["getVendorSession"]>[2]) {
    return this.vendorSessions.get(key(identity.tenantId, `${conversationId}:${catalogId}`)) ?? null;
  }
  async setVendorSession(identity: IdentityContext, conversationId: string, catalogId: Parameters<ChatStore["setVendorSession"]>[2], value: string) {
    this.vendorSessions.set(key(identity.tenantId, `${conversationId}:${catalogId}`), value);
  }

  async verifyIngestionPlacement(input: Parameters<ChatStore["verifyIngestionPlacement"]>[0]) {
    const expected = this.placement(input.identity, input.workspaceId);
    if (expected.accessGeneration !== input.accessGeneration
      || (input.requireNodePlacement && (!input.workspaceNodeId || input.workspaceNodeId !== expected.workspaceNodeId))) {
      throw new LemmaComputerError("ARTIFACT_INGESTION_REJECTED", "Artifact ingestion is not authorized", 403);
    }
    return expected;
  }

  async createArtifactStaging(input: Omit<ArtifactStagingRecord, "state">) {
    const value = { ...input, state: "staged" as const };
    this.staging.set(key(input.tenantId, input.id), value);
    return value;
  }

  async prepareArtifactFinalization(input: Parameters<ChatStore["prepareArtifactFinalization"]>[0]) {
    const value = this.staging.get(key(input.identity.tenantId, input.uploadId));
    if (!value || value.ownerSubjectId !== input.identity.subjectId || value.state !== "staged") {
      throw new Error("Staging upload not found");
    }
    this.staging.set(key(input.identity.tenantId, input.uploadId), {
      ...value,
      artifactId: input.artifactId,
      revisionId: input.revisionId,
      finalStorageLocator: input.finalStorageLocator,
      state: "finalizing",
    });
  }

  async commitArtifact(input: Parameters<ChatStore["commitArtifact"]>[0]) {
    const upload = this.staging.get(key(input.identity.tenantId, input.uploadId));
    if (!upload || upload.ownerSubjectId !== input.identity.subjectId || upload.state !== "finalizing"
      || upload.artifactId !== input.artifactId || upload.revisionId !== input.revisionId
      || upload.finalStorageLocator !== input.finalStorageLocator) throw new Error("Staging upload not found");
    const now = new Date();
    const artifact: ArtifactRecord = {
      id: input.artifactId, tenantId: upload.tenantId, workspaceId: upload.workspaceId,
      conversationId: upload.conversationId, creatorSubjectId: upload.ownerSubjectId, direction: upload.direction,
      originalFilename: upload.originalFilename, displayName: upload.originalFilename, mediaType: upload.mediaType,
      byteLength: upload.expectedByteLength, sha256: upload.expectedSha256, state: "available", retentionClass: "saved",
      currentRevisionId: input.revisionId, createdAt: now, updatedAt: now,
    };
    const revision: ArtifactRevisionRecord = {
      id: input.revisionId, tenantId: upload.tenantId, artifactId: input.artifactId, revisionNumber: 1,
      baseRevisionId: null, mediaType: upload.mediaType, byteLength: upload.expectedByteLength,
      sha256: upload.expectedSha256, storageBackend: upload.storageBackend, storageLocator: input.finalStorageLocator,
      createdBySubjectId: upload.ownerSubjectId, createdAt: now,
    };
    const saved = { artifact, revision };
    this.artifacts.set(key(upload.tenantId, input.artifactId), saved);
    this.staging.set(key(upload.tenantId, upload.id), { ...upload, state: "committed" });
    return structuredClone(saved);
  }

  async failArtifactStaging(identity: IdentityContext, uploadId: string) {
    const value = this.staging.get(key(identity.tenantId, uploadId));
    if (value) this.staging.set(key(identity.tenantId, uploadId), { ...value, state: "failed" });
  }
  async bindArtifact() {}
  async getArtifact(identity: IdentityContext, artifactId: string, revisionId?: string) {
    const saved = this.artifacts.get(key(identity.tenantId, artifactId));
    return saved && saved.artifact.creatorSubjectId === identity.subjectId
      && (!revisionId || saved.revision.id === revisionId) ? structuredClone(saved) : null;
  }
  async listExpiredStaging(now: Date, limit: number) {
    return [...this.staging.values()].filter((item) => ["staged", "finalizing", "failed"].includes(item.state)
      && item.expiresAt <= now).slice(0, limit);
  }
  async abandonStaging(tenantId: string, uploadId: string) {
    const value = this.staging.get(key(tenantId, uploadId));
    if (!value) return false;
    this.staging.set(key(tenantId, uploadId), { ...value, state: "abandoned" });
    return true;
  }

  async forkConversation(input: Parameters<ChatStore["forkConversation"]>[0]) {
    const source = await this.getConversation(input.identity, input.conversationId);
    if (!source) throw new Error("Conversation not found");
    const created = await this.createConversation({
      identity: input.identity, workspaceId: source.workspaceId, defaultAgentCatalogId: input.defaultAgentCatalogId,
      title: source.title ?? undefined, requestedServiceClass: input.requestedServiceClass, reasoningEffort: input.reasoningEffort,
    });
    const sourceMessages = await this.listMessages(input.identity, source.id);
    const stop = sourceMessages.findIndex((message) => message.id === input.fromMessageId);
    if (stop < 0) throw new Error("Fork message not found");
    for (const message of sourceMessages.slice(0, stop + 1)) await this.upsertMessage(input.identity, created.id, message);
    const fork = { ...created, parentConversationId: source.id, forkedFromMessageId: input.fromMessageId };
    this.conversations.set(key(fork.tenantId, fork.id), fork);
    return fork;
  }
}
