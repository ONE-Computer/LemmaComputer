import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  LemmaComputerError,
  chatAgentCatalogIdSchema,
  chatReasoningEffortSchema,
  chatRequestedServiceClassSchema,
  chatUiMessageSchema,
  type ChatAgentCatalogId,
  type ChatReasoningEffort,
  type ChatRequestedServiceClass,
  type ChatUiMessage,
  type IdentityContext,
} from "@lemmacomputer/contracts";

export type ChatRetentionClass = "saved" | "temporary" | "legal_hold" | "export" | "staged_delete" | "purged";
export type ArtifactDirection = "input" | "output";
export type ArtifactStorageBackend = "filesystem" | "s3";

export type ChatConversationRecord = {
  id: string;
  tenantId: string;
  workspaceId: string;
  ownerSubjectId: string;
  defaultAgentCatalogId: ChatAgentCatalogId;
  title: string | null;
  requestedServiceClass: ChatRequestedServiceClass;
  reasoningEffort?: ChatReasoningEffort;
  parentConversationId: string | null;
  forkedFromMessageId: string | null;
  retentionClass: ChatRetentionClass;
  state: "active" | "staged_delete" | "purged";
  createdAt: Date;
  updatedAt: Date;
};

export type ChatConversationPage = {
  conversations: ChatConversationRecord[];
  nextCursor: string | null;
};

export type ChatConversationLibraryRecord = ChatConversationRecord & {
  workspaceGrantId: string;
  workspaceDeletedAt: Date | null;
};

export type ChatConversationLibraryPage = {
  conversations: ChatConversationLibraryRecord[];
  nextCursor: string | null;
};

export type ChatRunRecord = {
  id: string;
  tenantId: string;
  conversationId: string;
  turnId: string;
  effectiveAgentCatalogId: ChatAgentCatalogId;
  status: "streaming" | "needs_input" | "completed" | "cancelled" | "failed";
};

export type ArtifactStagingRecord = {
  id: string;
  tenantId: string;
  workspaceId: string;
  conversationId: string;
  ownerSubjectId: string;
  direction: ArtifactDirection;
  originalFilename: string;
  mediaType: string;
  expectedByteLength: number;
  expectedSha256: string;
  workspaceNodeId: string | null;
  accessGeneration: number;
  storageBackend: ArtifactStorageBackend;
  stagingLocator: string;
  artifactId: string | null;
  revisionId: string | null;
  finalStorageLocator: string | null;
  state: "staged" | "finalizing" | "committed" | "abandoned" | "failed";
  expiresAt: Date;
};

export type ArtifactRecord = {
  id: string;
  tenantId: string;
  workspaceId: string;
  conversationId: string;
  creatorSubjectId: string;
  direction: ArtifactDirection;
  originalFilename: string;
  displayName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  state: "available" | "staged_delete" | "purged" | "failed";
  retentionClass: ChatRetentionClass;
  currentRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ArtifactRevisionRecord = {
  id: string;
  tenantId: string;
  artifactId: string;
  revisionNumber: number;
  baseRevisionId: string | null;
  mediaType: string;
  byteLength: number;
  sha256: string;
  storageBackend: ArtifactStorageBackend;
  storageLocator: string;
  createdBySubjectId: string;
  createdAt: Date;
};

export type AuthorizedArtifactRevision = {
  artifact: ArtifactRecord;
  revision: ArtifactRevisionRecord;
};

export type ArtifactLibraryRecord = AuthorizedArtifactRevision & {
  conversationTitle: string | null;
  conversationAgentCatalogId: ChatAgentCatalogId;
  workspaceGrantId: string;
  workspaceDeletedAt: Date | null;
};

export type ArtifactLibraryPage = {
  artifacts: ArtifactLibraryRecord[];
  nextCursor: string | null;
};

export type WorkspaceIngestionPlacement = {
  workspaceNodeId: string | null;
  accessGeneration: number;
};

const conversation = (row: Record<string, unknown>): ChatConversationRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  workspaceId: String(row.workspace_id),
  ownerSubjectId: String(row.owner_subject_id),
  defaultAgentCatalogId: chatAgentCatalogIdSchema.parse(row.default_agent_catalog_id),
  title: row.title == null ? null : String(row.title),
  requestedServiceClass: chatRequestedServiceClassSchema.parse(row.requested_service_class),
  ...(row.reasoning_effort == null ? {} : { reasoningEffort: chatReasoningEffortSchema.parse(row.reasoning_effort) }),
  parentConversationId: row.parent_conversation_id == null ? null : String(row.parent_conversation_id),
  forkedFromMessageId: row.forked_from_message_id == null ? null : String(row.forked_from_message_id),
  retentionClass: String(row.retention_class) as ChatRetentionClass,
  state: String(row.state) as ChatConversationRecord["state"],
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const staging = (row: Record<string, unknown>): ArtifactStagingRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  workspaceId: String(row.workspace_id),
  conversationId: String(row.conversation_id),
  ownerSubjectId: String(row.owner_subject_id),
  direction: String(row.direction) as ArtifactDirection,
  originalFilename: String(row.original_filename),
  mediaType: String(row.media_type),
  expectedByteLength: Number(row.expected_byte_length),
  expectedSha256: String(row.expected_sha256),
  workspaceNodeId: row.workspace_node_id == null ? null : String(row.workspace_node_id),
  accessGeneration: Number(row.access_generation),
  storageBackend: String(row.storage_backend) as ArtifactStorageBackend,
  stagingLocator: String(row.staging_locator),
  artifactId: row.artifact_id == null ? null : String(row.artifact_id),
  revisionId: row.revision_id == null ? null : String(row.revision_id),
  finalStorageLocator: row.final_storage_locator == null ? null : String(row.final_storage_locator),
  state: String(row.state) as ArtifactStagingRecord["state"],
  expiresAt: new Date(String(row.expires_at)),
});

const artifact = (row: Record<string, unknown>): ArtifactRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  workspaceId: String(row.workspace_id),
  conversationId: String(row.conversation_id),
  creatorSubjectId: String(row.creator_subject_id),
  direction: String(row.direction) as ArtifactDirection,
  originalFilename: String(row.original_filename),
  displayName: String(row.display_name),
  mediaType: String(row.media_type),
  byteLength: Number(row.byte_length),
  sha256: String(row.sha256),
  state: String(row.state) as ArtifactRecord["state"],
  retentionClass: String(row.retention_class) as ChatRetentionClass,
  currentRevisionId: row.current_revision_id == null ? null : String(row.current_revision_id),
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const revision = (row: Record<string, unknown>): ArtifactRevisionRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  artifactId: String(row.artifact_id),
  revisionNumber: Number(row.revision_number),
  baseRevisionId: row.base_revision_id == null ? null : String(row.base_revision_id),
  mediaType: String(row.media_type),
  byteLength: Number(row.byte_length),
  sha256: String(row.sha256),
  storageBackend: String(row.storage_backend) as ArtifactStorageBackend,
  storageLocator: String(row.storage_locator),
  createdBySubjectId: String(row.created_by_subject_id),
  createdAt: new Date(String(row.created_at)),
});

const notFound = () => new LemmaComputerError("CHAT_CONVERSATION_NOT_FOUND", "Conversation not found", 404);
const ingestionRejected = () => new LemmaComputerError(
  "ARTIFACT_INGESTION_REJECTED",
  "Artifact ingestion is not authorized for this workspace generation",
  403,
);

export interface ChatStore {
  createConversation(input: {
    identity: IdentityContext;
    workspaceId: string;
    defaultAgentCatalogId: ChatAgentCatalogId;
    title?: string;
    requestedServiceClass: ChatRequestedServiceClass;
    reasoningEffort?: ChatReasoningEffort;
  }): Promise<ChatConversationRecord>;
  listConversations(identity: IdentityContext, workspaceId: string, input: {
    limit: number;
    cursor?: string;
    agentCatalogId?: ChatAgentCatalogId;
  }): Promise<ChatConversationPage>;
  listOwnedConversations(identity: IdentityContext, input: {
    limit: number;
    cursor?: string;
  }): Promise<ChatConversationLibraryPage>;
  getConversation(identity: IdentityContext, conversationId: string): Promise<ChatConversationRecord | null>;
  listMessages(identity: IdentityContext, conversationId: string): Promise<ChatUiMessage[]>;
  upsertMessage(identity: IdentityContext, conversationId: string, message: ChatUiMessage): Promise<void>;
  beginRun(input: {
    identity: IdentityContext;
    conversationId: string;
    turnId: string;
    effectiveAgentCatalogId: ChatAgentCatalogId;
    requestedServiceClass: ChatRequestedServiceClass;
    reasoningEffort?: ChatReasoningEffort;
    policyVersionId: string;
    policyVersion: number;
    policyHash: string;
    workspaceId: string;
    workspaceNodeId?: string | null;
    accessGeneration: number;
    agentInstanceId?: string;
    assistantMessageId?: string;
  }): Promise<ChatRunRecord>;
  finishRun(identity: IdentityContext, conversationId: string, turnId: string, input: {
    status: ChatRunRecord["status"];
    assistantMessageId?: string;
    failureCode?: string;
    completedAt: Date;
  }): Promise<void>;
  getVendorSession(identity: IdentityContext, conversationId: string, catalogId: ChatAgentCatalogId): Promise<string | null>;
  setVendorSession(identity: IdentityContext, conversationId: string, catalogId: ChatAgentCatalogId, vendorSessionId: string): Promise<void>;
  verifyIngestionPlacement(input: {
    identity: IdentityContext;
    workspaceId: string;
    workspaceNodeId?: string | null;
    accessGeneration: number;
    requireNodePlacement: boolean;
  }): Promise<WorkspaceIngestionPlacement>;
  createArtifactStaging(input: Omit<ArtifactStagingRecord, "state">): Promise<ArtifactStagingRecord>;
  prepareArtifactFinalization(input: {
    identity: IdentityContext;
    uploadId: string;
    artifactId: string;
    revisionId: string;
    finalStorageLocator: string;
  }): Promise<void>;
  commitArtifact(input: {
    identity: IdentityContext;
    uploadId: string;
    artifactId: string;
    revisionId: string;
    finalStorageLocator: string;
    messageId?: string;
  }): Promise<AuthorizedArtifactRevision>;
  failArtifactStaging(identity: IdentityContext, uploadId: string): Promise<void>;
  bindArtifact(input: {
    identity: IdentityContext;
    conversationId: string;
    messageId: string;
    artifactId: string;
    revisionId: string;
    direction: ArtifactDirection;
  }): Promise<void>;
  getArtifact(identity: IdentityContext, artifactId: string, revisionId?: string): Promise<AuthorizedArtifactRevision | null>;
  listOwnedArtifacts(identity: IdentityContext, input: {
    limit: number;
    cursor?: string;
    query?: string;
  }): Promise<ArtifactLibraryPage>;
  listExpiredStaging(now: Date, limit: number): Promise<ArtifactStagingRecord[]>;
  abandonStaging(tenantId: string, uploadId: string): Promise<boolean>;
  forkConversation(input: {
    identity: IdentityContext;
    conversationId: string;
    fromMessageId: string;
    targetWorkspaceId: string;
    defaultAgentCatalogId: ChatAgentCatalogId;
    requestedServiceClass: ChatRequestedServiceClass;
    reasoningEffort?: ChatReasoningEffort;
  }): Promise<ChatConversationRecord>;
  close(): Promise<void>;
}

export class PostgresChatStore implements ChatStore {
  constructor(private readonly pool: pg.Pool, private readonly now: () => Date = () => new Date()) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresChatStore(new pg.Pool({ connectionString, max: 8 }));
  }

  async close() { await this.pool.end(); }

  async createConversation(input: Parameters<ChatStore["createConversation"]>[0]) {
    const id = randomUUID();
    const now = this.now();
    const result = await this.pool.query(
      `INSERT INTO chat_conversations (
         id,tenant_id,workspace_id,owner_subject_id,default_agent_catalog_id,title,
         requested_service_class,reasoning_effort,created_at,updated_at
       )
       SELECT $1,$2,workspace.id,$3,$4,$5,$6,$7,$8,$8
       FROM workspaces workspace
       WHERE workspace.id=$9 AND workspace.tenant_id=$2 AND workspace.subject_id=$3
         AND workspace.deleted_at IS NULL
       RETURNING *`,
      [id, input.identity.tenantId, input.identity.subjectId, input.defaultAgentCatalogId,
        input.title ?? null, input.requestedServiceClass, input.reasoningEffort ?? null, now, input.workspaceId],
    );
    if (!result.rowCount) throw notFound();
    return conversation(result.rows[0]);
  }

  async listConversations(identity: IdentityContext, workspaceId: string, input: {
    limit: number;
    cursor?: string;
    agentCatalogId?: ChatAgentCatalogId;
  }) {
    let before: { updatedAt: Date; id: string } | undefined;
    if (input.cursor) {
      const cursor = await this.pool.query(
        `SELECT updated_at,id FROM chat_conversations
         WHERE tenant_id=$1 AND owner_subject_id=$2 AND workspace_id=$3 AND id=$4 AND state='active'`,
        [identity.tenantId, identity.subjectId, workspaceId, input.cursor],
      );
      if (!cursor.rowCount) throw new LemmaComputerError("CHAT_CURSOR_INVALID", "Conversation cursor not found", 400);
      before = { updatedAt: new Date(String(cursor.rows[0].updated_at)), id: String(cursor.rows[0].id) };
    }
    const result = await this.pool.query(
      `SELECT * FROM chat_conversations
       WHERE tenant_id=$1 AND owner_subject_id=$2 AND workspace_id=$3 AND state='active'
         AND ($4::text IS NULL OR default_agent_catalog_id=$4)
         AND ($5::timestamptz IS NULL OR (updated_at,id)<($5,$6::uuid))
       ORDER BY updated_at DESC,id DESC LIMIT $7`,
      [identity.tenantId, identity.subjectId, workspaceId, input.agentCatalogId ?? null,
        before?.updatedAt ?? null, before?.id ?? null, input.limit + 1],
    );
    const values = result.rows.map(conversation);
    const hasMore = values.length > input.limit;
    if (hasMore) values.pop();
    return { conversations: values, nextCursor: hasMore ? values.at(-1)!.id : null };
  }

  async listOwnedConversations(identity: IdentityContext, input: { limit: number; cursor?: string }) {
    let before: { updatedAt: Date; id: string } | undefined;
    if (input.cursor) {
      const cursor = await this.pool.query(
        `SELECT updated_at,id FROM chat_conversations
         WHERE tenant_id=$1 AND owner_subject_id=$2 AND id=$3 AND state='active'`,
        [identity.tenantId, identity.subjectId, input.cursor],
      );
      if (!cursor.rowCount) throw new LemmaComputerError("CHAT_CURSOR_INVALID", "Conversation cursor not found", 400);
      before = { updatedAt: new Date(String(cursor.rows[0].updated_at)), id: String(cursor.rows[0].id) };
    }
    const result = await this.pool.query(
      `SELECT conversation.*,workspace.grant_id AS workspace_grant_id,
         workspace.deleted_at AS workspace_deleted_at
       FROM chat_conversations conversation
       JOIN workspaces workspace
         ON workspace.tenant_id=conversation.tenant_id AND workspace.id=conversation.workspace_id
       WHERE conversation.tenant_id=$1 AND conversation.owner_subject_id=$2
         AND conversation.state='active'
         AND ($3::timestamptz IS NULL OR (conversation.updated_at,conversation.id)<($3,$4::uuid))
       ORDER BY conversation.updated_at DESC,conversation.id DESC LIMIT $5`,
      [identity.tenantId, identity.subjectId, before?.updatedAt ?? null, before?.id ?? null, input.limit + 1],
    );
    const values = result.rows.map((row) => ({
      ...conversation(row),
      workspaceGrantId: String(row.workspace_grant_id),
      workspaceDeletedAt: row.workspace_deleted_at == null ? null : new Date(String(row.workspace_deleted_at)),
    }));
    const hasMore = values.length > input.limit;
    if (hasMore) values.pop();
    return { conversations: values, nextCursor: hasMore ? values.at(-1)!.id : null };
  }

  async getConversation(identity: IdentityContext, conversationId: string) {
    const result = await this.pool.query(
      `SELECT * FROM chat_conversations
       WHERE tenant_id=$1 AND owner_subject_id=$2 AND id=$3 AND state='active'`,
      [identity.tenantId, identity.subjectId, conversationId],
    );
    return result.rowCount ? conversation(result.rows[0]) : null;
  }

  async listMessages(identity: IdentityContext, conversationId: string) {
    const result = await this.pool.query(
      `SELECT message.* FROM chat_messages message
       JOIN chat_conversations conversation
         ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
       WHERE message.tenant_id=$1 AND message.conversation_id=$2
         AND conversation.owner_subject_id=$3 AND conversation.state='active'
       ORDER BY message.ordinal`,
      [identity.tenantId, conversationId, identity.subjectId],
    );
    return result.rows.map((row) => chatUiMessageSchema.parse({
      id: row.id,
      role: row.role,
      metadata: {
        agentCatalogId: row.agent_catalog_id,
        ...(row.turn_id == null ? {} : { turnId: row.turn_id }),
        state: row.state,
        createdAt: new Date(String(row.created_at)).toISOString(),
        ...(row.source == null ? {} : { source: row.source }),
      },
      parts: row.parts,
    }));
  }

  async upsertMessage(identity: IdentityContext, conversationId: string, raw: ChatUiMessage) {
    const message = chatUiMessageSchema.parse(raw);
    if (message.parts.some((part) => part.type === "file")) {
      throw new LemmaComputerError("CHAT_INLINE_ATTACHMENT_FORBIDDEN", "Inline attachment data is not a durable chat record", 500);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query(
        `SELECT id FROM chat_conversations
         WHERE tenant_id=$1 AND owner_subject_id=$2 AND id=$3 AND state='active' FOR UPDATE`,
        [identity.tenantId, identity.subjectId, conversationId],
      );
      if (!owned.rowCount) throw notFound();
      const prior = await client.query(
        `SELECT ordinal FROM chat_messages WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3`,
        [identity.tenantId, conversationId, message.id],
      );
      const ordinal = prior.rowCount
        ? Number(prior.rows[0].ordinal)
        : Number((await client.query(
            `SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM chat_messages WHERE tenant_id=$1 AND conversation_id=$2`,
            [identity.tenantId, conversationId],
          )).rows[0].ordinal);
      await client.query(
        `INSERT INTO chat_messages (
           tenant_id,conversation_id,id,ordinal,role,agent_catalog_id,turn_id,state,parts,source,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
         ON CONFLICT (tenant_id,conversation_id,id) DO UPDATE SET
           role=EXCLUDED.role,agent_catalog_id=EXCLUDED.agent_catalog_id,turn_id=EXCLUDED.turn_id,
           state=EXCLUDED.state,parts=EXCLUDED.parts,source=EXCLUDED.source,updated_at=EXCLUDED.updated_at`,
        [identity.tenantId, conversationId, message.id, ordinal, message.role,
          message.metadata.agentCatalogId, message.metadata.turnId ?? null, message.metadata.state,
          JSON.stringify(message.parts), message.metadata.source ?? null, message.metadata.createdAt, this.now()],
      );
      await client.query("UPDATE chat_conversations SET updated_at=$3 WHERE tenant_id=$1 AND id=$2", [identity.tenantId, conversationId, this.now()]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async beginRun(input: Parameters<ChatStore["beginRun"]>[0]) {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO chat_agent_runs (
         id,tenant_id,conversation_id,assistant_message_id,turn_id,effective_agent_catalog_id,
         requested_service_class,reasoning_effort,policy_version_id,policy_version,policy_hash,
         workspace_id,workspace_node_id,access_generation,agent_instance_id,status,started_at
       )
       SELECT $1,$2,conversation.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'streaming',$15
       FROM chat_conversations conversation
       WHERE conversation.tenant_id=$2 AND conversation.id=$16 AND conversation.owner_subject_id=$17
         AND conversation.workspace_id=$11 AND conversation.state='active'
       ON CONFLICT (tenant_id,conversation_id,turn_id) DO UPDATE SET
         assistant_message_id=COALESCE(EXCLUDED.assistant_message_id,chat_agent_runs.assistant_message_id)
       RETURNING *`,
      [id, input.identity.tenantId, input.assistantMessageId ?? null, input.turnId,
        input.effectiveAgentCatalogId, input.requestedServiceClass, input.reasoningEffort ?? null,
        input.policyVersionId, input.policyVersion, input.policyHash, input.workspaceId,
        input.workspaceNodeId ?? null, input.accessGeneration, input.agentInstanceId ?? null,
        this.now(), input.conversationId, input.identity.subjectId],
    );
    if (!result.rowCount) throw notFound();
    const row = result.rows[0];
    return {
      id: String(row.id), tenantId: String(row.tenant_id), conversationId: String(row.conversation_id),
      turnId: String(row.turn_id), effectiveAgentCatalogId: chatAgentCatalogIdSchema.parse(row.effective_agent_catalog_id),
      status: String(row.status) as ChatRunRecord["status"],
    };
  }

  async finishRun(identity: IdentityContext, conversationId: string, turnId: string, input: Parameters<ChatStore["finishRun"]>[3]) {
    const result = await this.pool.query(
      `UPDATE chat_agent_runs run SET
         status=$5,assistant_message_id=COALESCE($6,assistant_message_id),failure_code=$7,completed_at=$8
       FROM chat_conversations conversation
       WHERE run.tenant_id=$1 AND run.conversation_id=$2 AND run.turn_id=$3
         AND conversation.tenant_id=run.tenant_id AND conversation.id=run.conversation_id
         AND conversation.owner_subject_id=$4
       RETURNING run.id`,
      [identity.tenantId, conversationId, turnId, identity.subjectId, input.status,
        input.assistantMessageId ?? null, input.failureCode ?? null, input.completedAt],
    );
    if (!result.rowCount) throw notFound();
  }

  async getVendorSession(identity: IdentityContext, conversationId: string, catalogId: ChatAgentCatalogId) {
    const result = await this.pool.query(
      `SELECT binding.vendor_session_id FROM chat_vendor_session_bindings binding
       JOIN chat_conversations conversation
         ON conversation.tenant_id=binding.tenant_id AND conversation.id=binding.conversation_id
       WHERE binding.tenant_id=$1 AND binding.conversation_id=$2 AND binding.agent_catalog_id=$3
         AND conversation.owner_subject_id=$4 AND conversation.state='active'`,
      [identity.tenantId, conversationId, catalogId, identity.subjectId],
    );
    return result.rowCount ? String(result.rows[0].vendor_session_id) : null;
  }

  async setVendorSession(identity: IdentityContext, conversationId: string, catalogId: ChatAgentCatalogId, vendorSessionId: string) {
    const result = await this.pool.query(
      `INSERT INTO chat_vendor_session_bindings (tenant_id,conversation_id,agent_catalog_id,vendor_session_id,updated_at)
       SELECT conversation.tenant_id,conversation.id,$3,$4,$5
       FROM chat_conversations conversation
       WHERE conversation.tenant_id=$1 AND conversation.id=$2 AND conversation.owner_subject_id=$6 AND conversation.state='active'
       ON CONFLICT (tenant_id,conversation_id,agent_catalog_id) DO UPDATE SET
         vendor_session_id=EXCLUDED.vendor_session_id,updated_at=EXCLUDED.updated_at
       RETURNING conversation_id`,
      [identity.tenantId, conversationId, catalogId, vendorSessionId, this.now(), identity.subjectId],
    );
    if (!result.rowCount) throw notFound();
  }

  async verifyIngestionPlacement(input: Parameters<ChatStore["verifyIngestionPlacement"]>[0]) {
    const result = await this.pool.query(
      `SELECT workspace.workspace_node_id,workspace.access_generation
       FROM workspaces workspace
       WHERE workspace.tenant_id=$1 AND workspace.subject_id=$2 AND workspace.id=$3
         AND workspace.access_generation=$4 AND workspace.state IN ('provisioning','ready','open','restarting')`,
      [input.identity.tenantId, input.identity.subjectId, input.workspaceId, input.accessGeneration],
    );
    if (!result.rowCount) throw ingestionRejected();
    const workspaceNodeId = result.rows[0].workspace_node_id == null ? null : String(result.rows[0].workspace_node_id);
    if (
      (input.requireNodePlacement && (!workspaceNodeId || !input.workspaceNodeId))
      || (input.workspaceNodeId !== undefined && input.workspaceNodeId !== workspaceNodeId)
    ) throw ingestionRejected();
    return { workspaceNodeId, accessGeneration: Number(result.rows[0].access_generation) };
  }

  async createArtifactStaging(input: Omit<ArtifactStagingRecord, "state">) {
    const result = await this.pool.query(
      `INSERT INTO artifact_staging_uploads (
         id,tenant_id,workspace_id,conversation_id,owner_subject_id,direction,original_filename,
         media_type,expected_byte_length,expected_sha256,workspace_node_id,access_generation,
         storage_backend,staging_locator,artifact_id,revision_id,final_storage_locator,state,expires_at,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,NULL,NULL,'staged',$15,$16,$16)
       RETURNING *`,
      [input.id, input.tenantId, input.workspaceId, input.conversationId, input.ownerSubjectId,
        input.direction, input.originalFilename, input.mediaType, input.expectedByteLength,
        input.expectedSha256, input.workspaceNodeId, input.accessGeneration, input.storageBackend,
        input.stagingLocator, input.expiresAt, this.now()],
    );
    return staging(result.rows[0]);
  }

  async prepareArtifactFinalization(input: Parameters<ChatStore["prepareArtifactFinalization"]>[0]) {
    const result = await this.pool.query(
      `UPDATE artifact_staging_uploads SET
         state='finalizing',artifact_id=$4,revision_id=$5,final_storage_locator=$6,updated_at=$7
       WHERE tenant_id=$1 AND owner_subject_id=$2 AND id=$3 AND state='staged' AND expires_at>=$7
       RETURNING id`,
      [input.identity.tenantId, input.identity.subjectId, input.uploadId, input.artifactId,
        input.revisionId, input.finalStorageLocator, this.now()],
    );
    if (!result.rowCount) {
      throw new LemmaComputerError("ARTIFACT_STAGING_NOT_FOUND", "Artifact upload is no longer available", 409);
    }
  }

  async commitArtifact(input: Parameters<ChatStore["commitArtifact"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      const staged = await client.query(
        `SELECT upload.* FROM artifact_staging_uploads upload
         JOIN chat_conversations conversation
           ON conversation.tenant_id=upload.tenant_id AND conversation.id=upload.conversation_id
         WHERE upload.tenant_id=$1 AND upload.id=$2 AND upload.owner_subject_id=$3
           AND upload.state='finalizing' AND upload.expires_at>=$4
           AND upload.artifact_id=$5 AND upload.revision_id=$6 AND upload.final_storage_locator=$7
           AND conversation.state='active' FOR UPDATE OF upload`,
        [input.identity.tenantId, input.uploadId, input.identity.subjectId, this.now(),
          input.artifactId, input.revisionId, input.finalStorageLocator],
      );
      if (!staged.rowCount) throw new LemmaComputerError("ARTIFACT_STAGING_NOT_FOUND", "Artifact upload is no longer available", 409);
      const upload = staging(staged.rows[0]);
      await client.query(
        `INSERT INTO artifacts (
           id,tenant_id,workspace_id,conversation_id,creator_subject_id,direction,original_filename,
           display_name,media_type,byte_length,sha256,state,retention_class,current_revision_id,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,'available','saved',$11,$12,$12)`,
        [input.artifactId, upload.tenantId, upload.workspaceId, upload.conversationId,
          upload.ownerSubjectId, upload.direction, upload.originalFilename, upload.mediaType,
          upload.expectedByteLength, upload.expectedSha256, input.revisionId, this.now()],
      );
      await client.query(
        `INSERT INTO artifact_revisions (
           id,tenant_id,artifact_id,revision_number,base_revision_id,media_type,byte_length,sha256,
           storage_backend,storage_locator,created_by_subject_id,created_at
         ) VALUES ($1,$2,$3,1,NULL,$4,$5,$6,$7,$8,$9,$10)`,
        [input.revisionId, upload.tenantId, input.artifactId, upload.mediaType,
          upload.expectedByteLength, upload.expectedSha256, upload.storageBackend,
          input.finalStorageLocator, upload.ownerSubjectId, this.now()],
      );
      if (input.messageId) {
        await client.query(
          `INSERT INTO chat_message_artifacts (
             tenant_id,conversation_id,message_id,artifact_id,revision_id,direction,created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [upload.tenantId, upload.conversationId, input.messageId, input.artifactId,
            input.revisionId, upload.direction, this.now()],
        );
      }
      await client.query(
        "UPDATE artifact_staging_uploads SET state='committed',updated_at=$3 WHERE tenant_id=$1 AND id=$2",
        [upload.tenantId, upload.id, this.now()],
      );
      await client.query("COMMIT");
      return (await this.getArtifact(input.identity, input.artifactId, input.revisionId))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failArtifactStaging(identity: IdentityContext, uploadId: string) {
    await this.pool.query(
      `UPDATE artifact_staging_uploads SET state='failed',updated_at=$3
       WHERE tenant_id=$1 AND owner_subject_id=$2 AND id=$4 AND state IN ('staged','finalizing')`,
      [identity.tenantId, identity.subjectId, this.now(), uploadId],
    );
  }

  async bindArtifact(input: Parameters<ChatStore["bindArtifact"]>[0]) {
    const result = await this.pool.query(
      `INSERT INTO chat_message_artifacts (
         tenant_id,conversation_id,message_id,artifact_id,revision_id,direction,created_at
       )
       SELECT $1,$2,$3,$4,$5,$6,$7
       FROM chat_conversations conversation
       JOIN artifacts artifact ON artifact.tenant_id=conversation.tenant_id AND artifact.id=$4
       JOIN artifact_revisions revision ON revision.tenant_id=artifact.tenant_id AND revision.id=$5 AND revision.artifact_id=artifact.id
       WHERE conversation.tenant_id=$1 AND conversation.id=$2 AND conversation.owner_subject_id=$8
         AND artifact.conversation_id=conversation.id AND artifact.state='available'
       ON CONFLICT DO NOTHING RETURNING artifact_id`,
      [input.identity.tenantId, input.conversationId, input.messageId, input.artifactId,
        input.revisionId, input.direction, this.now(), input.identity.subjectId],
    );
    if (!result.rowCount) {
      const existing = await this.pool.query(
        `SELECT 1 FROM chat_message_artifacts WHERE tenant_id=$1 AND conversation_id=$2
         AND message_id=$3 AND artifact_id=$4 AND revision_id=$5`,
        [input.identity.tenantId, input.conversationId, input.messageId, input.artifactId, input.revisionId],
      );
      if (!existing.rowCount) throw new LemmaComputerError("ARTIFACT_BINDING_REJECTED", "Artifact reference is not authorized", 403);
    }
  }

  async getArtifact(identity: IdentityContext, artifactId: string, revisionId?: string) {
    const result = await this.pool.query(
      `SELECT artifact.*,revision.id AS revision_id,revision.artifact_id AS revision_artifact_id,
              revision.revision_number,revision.base_revision_id,revision.media_type AS revision_media_type,
              revision.byte_length AS revision_byte_length,revision.sha256 AS revision_sha256,
              revision.storage_backend,revision.storage_locator,revision.created_by_subject_id,
              revision.created_at AS revision_created_at
       FROM artifacts artifact
       JOIN chat_conversations conversation
         ON conversation.tenant_id=artifact.tenant_id AND conversation.id=artifact.conversation_id
       JOIN artifact_revisions revision
         ON revision.tenant_id=artifact.tenant_id AND revision.artifact_id=artifact.id
        AND revision.id=COALESCE($4,artifact.current_revision_id)
       WHERE artifact.tenant_id=$1 AND artifact.id=$2 AND conversation.owner_subject_id=$3
         AND artifact.state='available' AND conversation.state='active'`,
      [identity.tenantId, artifactId, identity.subjectId, revisionId ?? null],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      artifact: artifact(row),
      revision: revision({
        id: row.revision_id,
        tenant_id: row.tenant_id,
        artifact_id: row.revision_artifact_id,
        revision_number: row.revision_number,
        base_revision_id: row.base_revision_id,
        media_type: row.revision_media_type,
        byte_length: row.revision_byte_length,
        sha256: row.revision_sha256,
        storage_backend: row.storage_backend,
        storage_locator: row.storage_locator,
        created_by_subject_id: row.created_by_subject_id,
        created_at: row.revision_created_at,
      }),
    };
  }

  async listOwnedArtifacts(identity: IdentityContext, input: { limit: number; cursor?: string; query?: string }) {
    const query = input.query?.trim() || null;
    let before: { updatedAt: Date; id: string } | undefined;
    if (input.cursor) {
      const cursor = await this.pool.query(
        `SELECT updated_at,id FROM artifacts
         WHERE tenant_id=$1 AND creator_subject_id=$2 AND id=$3 AND state='available'
           AND ($4::text IS NULL OR position(lower($4) in lower(display_name))>0)`,
        [identity.tenantId, identity.subjectId, input.cursor, query],
      );
      if (!cursor.rowCount) throw new LemmaComputerError("ARTIFACT_CURSOR_INVALID", "Artifact cursor not found", 400);
      before = { updatedAt: new Date(String(cursor.rows[0].updated_at)), id: String(cursor.rows[0].id) };
    }
    const result = await this.pool.query(
      `SELECT artifact.*,revision.id AS revision_id,revision.artifact_id AS revision_artifact_id,
         revision.revision_number,revision.base_revision_id,revision.media_type AS revision_media_type,
         revision.byte_length AS revision_byte_length,revision.sha256 AS revision_sha256,
         revision.storage_backend,revision.storage_locator,revision.created_by_subject_id,
         revision.created_at AS revision_created_at,conversation.title AS conversation_title,
         conversation.default_agent_catalog_id AS conversation_agent_catalog_id,
         workspace.grant_id AS workspace_grant_id,workspace.deleted_at AS workspace_deleted_at
       FROM artifacts artifact
       JOIN artifact_revisions revision
         ON revision.tenant_id=artifact.tenant_id AND revision.id=artifact.current_revision_id
       JOIN chat_conversations conversation
         ON conversation.tenant_id=artifact.tenant_id AND conversation.id=artifact.conversation_id
       JOIN workspaces workspace
         ON workspace.tenant_id=artifact.tenant_id AND workspace.id=artifact.workspace_id
       WHERE artifact.tenant_id=$1 AND artifact.creator_subject_id=$2 AND artifact.state='available'
         AND conversation.state='active'
         AND ($3::timestamptz IS NULL OR (artifact.updated_at,artifact.id)<($3,$4))
         AND ($5::text IS NULL OR position(lower($5) in lower(artifact.display_name))>0)
       ORDER BY artifact.updated_at DESC,artifact.id DESC LIMIT $6`,
      [identity.tenantId, identity.subjectId, before?.updatedAt ?? null, before?.id ?? null, query, input.limit + 1],
    );
    const values = result.rows.map((row) => ({
      artifact: artifact(row),
      revision: revision({
        id: row.revision_id,
        tenant_id: row.tenant_id,
        artifact_id: row.revision_artifact_id,
        revision_number: row.revision_number,
        base_revision_id: row.base_revision_id,
        media_type: row.revision_media_type,
        byte_length: row.revision_byte_length,
        sha256: row.revision_sha256,
        storage_backend: row.storage_backend,
        storage_locator: row.storage_locator,
        created_by_subject_id: row.created_by_subject_id,
        created_at: row.revision_created_at,
      }),
      conversationTitle: row.conversation_title == null ? null : String(row.conversation_title),
      conversationAgentCatalogId: chatAgentCatalogIdSchema.parse(row.conversation_agent_catalog_id),
      workspaceGrantId: String(row.workspace_grant_id),
      workspaceDeletedAt: row.workspace_deleted_at == null ? null : new Date(String(row.workspace_deleted_at)),
    }));
    const hasMore = values.length > input.limit;
    if (hasMore) values.pop();
    return { artifacts: values, nextCursor: hasMore ? values.at(-1)!.artifact.id : null };
  }

  async listExpiredStaging(now: Date, limit: number) {
    const result = await this.pool.query(
      `SELECT * FROM artifact_staging_uploads
       WHERE expires_at<$1 AND state IN ('staged','finalizing','failed')
       ORDER BY expires_at,id LIMIT $2`,
      [now, limit],
    );
    return result.rows.map(staging);
  }

  async abandonStaging(tenantId: string, uploadId: string) {
    const result = await this.pool.query(
      `UPDATE artifact_staging_uploads SET state='abandoned',updated_at=$3
       WHERE tenant_id=$1 AND id=$2 AND state IN ('staged','finalizing','failed') RETURNING id`,
      [tenantId, uploadId, this.now()],
    );
    return Boolean(result.rowCount);
  }

  async forkConversation(input: Parameters<ChatStore["forkConversation"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const source = await client.query(
        `SELECT conversation.*,message.ordinal AS fork_ordinal,target.id AS target_workspace_id
         FROM chat_conversations conversation
         JOIN chat_messages message ON message.tenant_id=conversation.tenant_id
           AND message.conversation_id=conversation.id AND message.id=$4
         JOIN workspaces target ON target.tenant_id=conversation.tenant_id
           AND target.id=$5 AND target.subject_id=conversation.owner_subject_id AND target.deleted_at IS NULL
         WHERE conversation.tenant_id=$1 AND conversation.id=$2 AND conversation.owner_subject_id=$3
           AND conversation.state='active' FOR SHARE OF conversation,message`,
        [input.identity.tenantId, input.conversationId, input.identity.subjectId, input.fromMessageId, input.targetWorkspaceId],
      );
      if (!source.rowCount) throw notFound();
      const id = randomUUID();
      const now = this.now();
      const inserted = await client.query(
        `INSERT INTO chat_conversations (
           id,tenant_id,workspace_id,owner_subject_id,default_agent_catalog_id,title,
           requested_service_class,reasoning_effort,parent_conversation_id,forked_from_message_id,
           retention_class,state,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'saved','active',$11,$11) RETURNING *`,
        [id, input.identity.tenantId, source.rows[0].target_workspace_id, input.identity.subjectId,
          input.defaultAgentCatalogId, source.rows[0].title, input.requestedServiceClass,
          input.reasoningEffort ?? null, input.conversationId, input.fromMessageId, now],
      );
      await client.query(
        `INSERT INTO chat_messages (
           tenant_id,conversation_id,id,ordinal,role,agent_catalog_id,turn_id,state,parts,source,created_at,updated_at
         ) SELECT tenant_id,$1,id,ordinal,role,agent_catalog_id,turn_id,state,parts,source,created_at,$2
           FROM chat_messages WHERE tenant_id=$3 AND conversation_id=$4 AND ordinal<=$5`,
        [id, now, input.identity.tenantId, input.conversationId, source.rows[0].fork_ordinal],
      );
      await client.query(
        `INSERT INTO chat_message_artifacts (
           tenant_id,conversation_id,message_id,artifact_id,revision_id,direction,created_at
         ) SELECT binding.tenant_id,$1,binding.message_id,binding.artifact_id,binding.revision_id,binding.direction,$2
           FROM chat_message_artifacts binding
           JOIN chat_messages message ON message.tenant_id=binding.tenant_id
             AND message.conversation_id=binding.conversation_id AND message.id=binding.message_id
          WHERE binding.tenant_id=$3 AND binding.conversation_id=$4 AND message.ordinal<=$5`,
        [id, now, input.identity.tenantId, input.conversationId, source.rows[0].fork_ordinal],
      );
      await client.query("COMMIT");
      return conversation(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
