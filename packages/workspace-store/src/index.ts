import { randomUUID } from "node:crypto";
import pg from "pg";
import { activityEventSchema } from "@onecomputer/contracts";
import type { ActivityEventDraft, ActivityEventV1, AgentCatalogId, ChatAgentCatalogId, ChatArtifact, GovernedOperationState, IdentityContext, OwnedJson, PolicyVerificationKey, SandboxApplicationId, SandboxModelAlias, SandboxProfileId, WorkspaceState } from "@onecomputer/contracts";
import { assertWorkspaceSchemaCompatible, runWorkspaceMigrations } from "./migrations.js";
export * from "./identity-policy.js";
export * from "./connector-registry.js";
export * from "./migrations.js";
export * from "./provider-settings.js";
export * from "./pinned-rate-catalogue.js";
export * from "./schedules.js";
export * from "./sites.js";
export * from "./spend-observability.js";
export * from "./teams.js";
export * from "./usage-ledger.js";
export * from "./budgets.js";
export * from "./routing.js";

export type WorkspaceRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  grantId: string;
  state: WorkspaceState;
  providerId: string | null;
  failureCode: string | null;
  operationToken: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SandboxSettingsRecord = {
  tenantId: string;
  subjectId: string;
  grantId: string;
  profileId: SandboxProfileId;
  applicationIds: SandboxApplicationId[];
  modelAlias: SandboxModelAlias;
  agentIds: AgentCatalogId[];
  updatedAt: Date;
};

export type ChannelConnectionRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  adapter: "telegram";
  credentialId: string;
  credentialCiphertext: string;
  credentialKeyVersion: number;
  tokenVersion: number;
  allowedUserIds: string[];
  defaultAgentId: ChatAgentCatalogId;
  allowAgentSwitch: boolean;
  botUsername: string | null;
  state: "active";
  telegramUpdateOffset: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ChannelCredentialRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  kind: "telegram_bot_token";
  credentialCiphertext: string;
  credentialKeyVersion: number;
  version: number;
  fingerprint: string;
  displayName: string;
  botUsername: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ChannelPendingResponse = {
  connectionId: string;
  updateId: string;
  senderId: string;
  chatId: string;
  text: string;
  offset: number;
  agentCatalogId: ChatAgentCatalogId | null;
  artifacts: ChatArtifact[];
  artifactOffset: number;
  finalState: "delivered" | "failed";
  finalFailureCode: string | null;
};

export interface ChannelStore {
  listOwnedChannelCredentials(identity: IdentityContext): Promise<Array<ChannelCredentialRecord & { workspaceId: string | null; connectionId: string | null }>>;
  getOwnedChannelCredential(identity: IdentityContext, credentialId: string): Promise<ChannelCredentialRecord | null>;
  saveChannelCredential(identity: IdentityContext, input: Omit<ChannelCredentialRecord, "tenantId" | "subjectId" | "createdAt" | "updatedAt">): Promise<ChannelCredentialRecord>;
  deleteChannelCredential(identity: IdentityContext, credentialId: string): Promise<boolean>;
  getOwnedChannelConnection(identity: IdentityContext, adapter: "telegram", workspaceId: string): Promise<ChannelConnectionRecord | null>;
  saveChannelConnection(identity: IdentityContext, input: {
    id: string;
    workspaceId: string;
    adapter: "telegram";
    credentialId: string;
    allowedUserIds: string[];
    defaultAgentId: ChatAgentCatalogId;
    allowAgentSwitch: boolean;
    telegramUpdateOffset: string;
  }): Promise<ChannelConnectionRecord>;
  deleteChannelConnection(identity: IdentityContext, adapter: "telegram", workspaceId: string): Promise<boolean>;
  listActiveChannelConnections(adapter: "telegram"): Promise<ChannelConnectionRecord[]>;
  reserveChannelUpdate(connectionId: string, updateId: string, senderId: string): Promise<boolean>;
  claimChannelUpdate(connectionId: string, updateId: string, senderId: string): Promise<boolean>;
  finishChannelUpdate(connectionId: string, updateId: string, state: "delivered" | "rejected" | "failed", failureCode?: string): Promise<void>;
  stageChannelResponse(
    connectionId: string,
    updateId: string,
    chatId: string,
    text: string,
    agentCatalogId: ChatAgentCatalogId,
    artifacts: ChatArtifact[],
    finalState: "delivered" | "failed",
    finalFailureCode?: string,
  ): Promise<void>;
  listPendingChannelResponses(connectionId: string): Promise<ChannelPendingResponse[]>;
  advanceChannelResponseDelivery(connectionId: string, updateId: string, offset: number): Promise<void>;
  advanceChannelArtifactDelivery(connectionId: string, updateId: string, offset: number): Promise<void>;
  advanceTelegramUpdateOffset(connectionId: string, offset: string): Promise<void>;
  getChannelSenderAgent(connectionId: string, senderId: string): Promise<ChatAgentCatalogId | null>;
  setChannelSenderAgent(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId): Promise<void>;
  getChannelSession(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId): Promise<string | null>;
  saveChannelSession(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId, sessionId: string): Promise<void>;
  clearChannelSession(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId): Promise<void>;
}

export type GovernedOperationRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  agentId: string | null;
  policyVersionId: string | null;
  policyHash: string | null;
  capabilityId: string;
  serverName: string;
  toolName: string;
  schemaId: string;
  arguments: OwnedJson;
  operationDigest: string;
  nonce: string;
  state: GovernedOperationState;
  policyDecision: "approval_required" | "deny";
  safeSummary: string;
  resourceName: string;
  resourceLocation: string;
  correlationId: string;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  dispatchStartedAt: Date | null;
  failureCode: string | null;
  failureSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  approval: null | { decision: "approve" | "deny"; channel: "local-fixture" | "openvtc-task-consent"; decidedAt: Date };
  receipt: null | { status: "succeeded"; upstreamReference: string; resultSummary: string; executedAt: Date };
};

export type CreateGovernedOperationRecord = Omit<GovernedOperationRecord,
  "tenantId" | "subjectId" | "agentId" | "policyVersionId" | "policyHash" | "state" | "policyDecision" | "leaseId" | "leaseExpiresAt" | "dispatchStartedAt" | "failureCode" | "failureSummary" | "createdAt" | "updatedAt" | "approval" | "receipt"
> & {
  identity: IdentityContext;
  agentId?: string;
  policyVersionId?: string;
  policyHash?: string;
  idempotencyKey: string;
  replaceTerminal?: boolean;
  createdAt: Date;
};

export type ApprovalRecordInput = {
  identity: IdentityContext;
  operationId: string;
  approvalId: string;
  decision: "approve" | "deny";
  channel: "local-fixture" | "openvtc-task-consent";
  issuer: string;
  keyId: string;
  operationDigest: string;
  nonce: string;
  proofHash: string;
  issuedAt: Date;
  expiresAt: Date;
  decidedAt: Date;
  correlationId: string;
};

export type OpenVtcApproverRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  approverDid: string;
  verificationMethod: string;
  displayName: string;
  status: "active" | "revoked";
  enrolledAt: Date;
  revokedAt: Date | null;
};

export type OpenVtcConsentTaskRecord = {
  id: string;
  operationId: string;
  tenantId: string;
  subjectId: string;
  approverId: string;
  executorDid: string;
  challenge: string;
  taskType: string;
  payloadDigest: string;
  requestDocument: OwnedJson;
  requestHash: string;
  requestProofHash: string;
  state: "queued" | "delivered" | "approved" | "denied" | "expired" | "failed";
  createdAt: Date;
  expiresAt: Date;
  deliveredAt: Date | null;
  decidedAt: Date | null;
  decisionDocument: OwnedJson | null;
  decisionHash: string | null;
  proofHash: string | null;
};

export type OpenVtcEnrollmentChallengeRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  executorDid: string;
  challenge: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type OpenVtcCompanionSubscriptionRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  approverId: string;
  installationId: string;
  protocolVersion: "onecomputer-companion-push-0.1";
  browserFamily: "chrome" | "edge" | "firefox" | "safari" | "other";
  platform: "windows" | "macos" | "linux" | "android" | "ios" | "other";
  endpointHash: string;
  subscriptionCiphertext: string;
  status: "active" | "invalid" | "revoked";
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
  lastSuccessfulDeliveryAt: Date | null;
  lastFailureCode: string | null;
};

export type CreateOpenVtcConsentTaskInput = Omit<OpenVtcConsentTaskRecord,
  "tenantId" | "subjectId" | "state" | "deliveredAt" | "decidedAt" | "decisionDocument" | "decisionHash" | "proofHash"
> & { identity: IdentityContext; outboxId: string; replaceApprover?: boolean };

export type RecordOpenVtcDecisionInput = {
  identity: IdentityContext;
  taskId: string;
  approvalId: string;
  approverId: string;
  signerDid: string;
  verificationMethod: string;
  challenge: string;
  payloadDigest: string;
  decision: "approve" | "deny";
  decisionDocument: OwnedJson;
  decisionHash: string;
  proofHash: string;
  issuedAt: Date;
  decidedAt: Date;
  correlationId: string;
};

export interface OpenVtcApprovalStore {
  createOpenVtcEnrollmentChallenge(input: Omit<OpenVtcEnrollmentChallengeRecord, "tenantId" | "subjectId" | "consumedAt"> & { identity: IdentityContext }): Promise<OpenVtcEnrollmentChallengeRecord>;
  getOpenVtcEnrollmentChallenge(identity: IdentityContext, challengeId: string): Promise<OpenVtcEnrollmentChallengeRecord | null>;
  consumeOpenVtcEnrollmentChallenge(identity: IdentityContext, challengeId: string, challenge: string, consumedAt: Date): Promise<boolean>;
  enrollOpenVtcApprover(input: {
    id: string;
    identity: IdentityContext;
    approverDid: string;
    verificationMethod: string;
    displayName: string;
    transportTokenHash: string;
    enrolledAt: Date;
  }): Promise<OpenVtcApproverRecord>;
  getActiveOpenVtcApprover(identity: IdentityContext): Promise<OpenVtcApproverRecord | null>;
  listActiveOpenVtcApprovers(identity: IdentityContext): Promise<OpenVtcApproverRecord[]>;
  getActiveOpenVtcApproverByDid(identity: IdentityContext, approverDid: string): Promise<OpenVtcApproverRecord | null>;
  getOpenVtcApproverByTransportTokenHash(tokenHash: string): Promise<OpenVtcApproverRecord | null>;
  revokeOpenVtcApprover(identity: IdentityContext, approverId: string, revokedAt: Date): Promise<boolean>;
  createOpenVtcConsentTask(input: CreateOpenVtcConsentTaskInput): Promise<OpenVtcConsentTaskRecord | null>;
  getOpenVtcConsentTask(identity: IdentityContext, operationId: string): Promise<OpenVtcConsentTaskRecord | null>;
  getOpenVtcConsentTaskForApprover(identity: IdentityContext, operationId: string, approverId: string): Promise<OpenVtcConsentTaskRecord | null>;
  getOpenVtcConsentTaskByPayloadDigest(approverId: string, payloadDigest: string): Promise<OpenVtcConsentTaskRecord | null>;
  deliverNextOpenVtcConsentTask(approverId: string, deliveredAt: Date): Promise<OpenVtcConsentTaskRecord | null>;
  recordOpenVtcDecision(input: RecordOpenVtcDecisionInput): Promise<GovernedOperationRecord | null>;
  upsertOpenVtcCompanionSubscription(input: Omit<OpenVtcCompanionSubscriptionRecord,
    "tenantId" | "subjectId" | "status" | "createdAt" | "updatedAt" | "revokedAt" | "lastSuccessfulDeliveryAt" | "lastFailureCode"
  > & { identity: IdentityContext; savedAt: Date }): Promise<OpenVtcCompanionSubscriptionRecord>;
  listOpenVtcCompanionSubscriptions(identity: IdentityContext): Promise<OpenVtcCompanionSubscriptionRecord[]>;
  getOpenVtcCompanionSubscriptionForApprover(approverId: string): Promise<OpenVtcCompanionSubscriptionRecord | null>;
  revokeOpenVtcCompanionSubscription(identity: IdentityContext, subscriptionId: string, revokedAt: Date): Promise<boolean>;
  enqueueOpenVtcCompanionPushDelivery(input: {
    id: string;
    taskId: string;
    subscriptionId: string;
    queuedAt: Date;
  }): Promise<boolean>;
  claimOpenVtcCompanionPushDelivery(input: {
    taskId: string;
    subscriptionId: string;
    claimedAt: Date;
  }): Promise<boolean>;
  listDueOpenVtcCompanionPushDeliveries(now: Date, limit: number): Promise<Array<{
    taskId: string;
    subscriptionId: string;
    subscriptionCiphertext: string;
  }>>;
  recordOpenVtcCompanionPushDelivery(input: {
    taskId: string;
    subscriptionId: string;
    delivered: boolean;
    terminal: boolean;
    failureCode?: string;
    attemptedAt: Date;
  }): Promise<void>;
}

export interface GovernanceStore {
  createGovernedOperation(input: CreateGovernedOperationRecord): Promise<GovernedOperationRecord | null>;
  getOwnedOperation(identity: IdentityContext, operationId: string): Promise<GovernedOperationRecord | null>;
  getRecentOperation(identity: IdentityContext): Promise<GovernedOperationRecord | null>;
  recordApproval(input: ApprovalRecordInput): Promise<GovernedOperationRecord | null>;
  claimExecution(identity: IdentityContext, operationId: string, leaseId: string, leaseExpiresAt: Date, correlationId: string): Promise<GovernedOperationRecord | null>;
  claimToolDispatch(identity: IdentityContext, input: {
    operationId: string;
    operationDigest: string;
    leaseId: string;
    workspaceId: string;
    agentId: string;
    serverName: string;
    toolName: string;
    arguments: OwnedJson;
    dispatchedAt: Date;
    correlationId: string;
  }): Promise<boolean>;
  completeExecution(identity: IdentityContext, operationId: string, leaseId: string, receipt: { id: string; upstreamReference: string; resultSummary: string; resultHash: string; executedAt: Date }, correlationId: string): Promise<GovernedOperationRecord | null>;
  failExecution(identity: IdentityContext, operationId: string, leaseId: string, failureCode: string, correlationId: string, failureSummary?: string): Promise<GovernedOperationRecord | null>;
  recoverOperation(identity: IdentityContext, operationId: string, now: Date, correlationId: string): Promise<GovernedOperationRecord | null>;
  listOwnedOperations?(identity: IdentityContext, limit: number): Promise<GovernedOperationRecord[]>;
  listOwnedOperationsPage?(identity: IdentityContext, input: {
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<GovernedOperationRecord[]>;
  getOperationEvents?(identity: IdentityContext, operationId: string): Promise<Array<{
    eventType: string;
    correlationId: string;
    safeDetail: OwnedJson;
    createdAt: Date;
  }>>;
}

export type ActivityEventScope = {
  workspaceId: string;
  agentCatalogId: ChatAgentCatalogId;
  sessionId: string;
  turnId: string;
};

export type AppendActivityEventInput = ActivityEventScope & {
  identity: IdentityContext;
  dedupeKey: string;
  occurredAt: Date;
  draft: ActivityEventDraft;
};

export interface ActivityStore {
  appendActivityEvent(input: AppendActivityEventInput): Promise<ActivityEventV1 | null>;
  replayActivityEvents(
    identity: IdentityContext,
    scope: ActivityEventScope,
    afterSequence: number,
    limit: number,
  ): Promise<{ found: boolean; events: ActivityEventV1[]; terminalSequence: number | null }>;
}

export interface WorkspaceStore {
  getCurrent(identity: IdentityContext, grantId: string): Promise<WorkspaceRecord | null>;
  listCurrent(identity: IdentityContext): Promise<WorkspaceRecord[]>;
  getOwned(identity: IdentityContext, workspaceId: string): Promise<WorkspaceRecord | null>;
  createOrGet(identity: IdentityContext, grantId: string, idempotencyKey: string): Promise<WorkspaceRecord>;
  claim(workspaceId: string, allowed: WorkspaceState[], next: WorkspaceState): Promise<WorkspaceRecord | null>;
  finish(workspaceId: string, operationToken: string, patch: Partial<Pick<WorkspaceRecord, "state" | "providerId" | "failureCode">>): Promise<WorkspaceRecord>;
  update(workspaceId: string, patch: Partial<Pick<WorkspaceRecord, "state" | "providerId" | "failureCode">>): Promise<WorkspaceRecord>;
  remove(identity: IdentityContext, workspaceId: string): Promise<boolean>;
  getSandboxSettings?(identity: IdentityContext, grantId: string): Promise<SandboxSettingsRecord | null>;
  saveSandboxSettings?(identity: IdentityContext, input: { grantId: string; profileId: SandboxProfileId; applicationIds: SandboxApplicationId[]; modelAlias: SandboxModelAlias; agentIds: AgentCatalogId[] }): Promise<SandboxSettingsRecord>;
  registerPolicyVerificationKeys?(keys: PolicyVerificationKey[]): Promise<void>;
}

const mapRow = (row: Record<string, unknown>): WorkspaceRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  grantId: String(row.grant_id),
  state: row.state as WorkspaceState,
  providerId: row.provider_id ? String(row.provider_id) : null,
  failureCode: row.failure_code ? String(row.failure_code) : null,
  operationToken: row.operation_token ? String(row.operation_token) : null,
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const mapSandboxSettingsRow = (row: Record<string, unknown>): SandboxSettingsRecord => ({
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  grantId: String(row.grant_id),
  profileId: String(row.profile_id) as SandboxProfileId,
  applicationIds: (Array.isArray(row.application_ids) ? row.application_ids : ["firefox"]) as SandboxApplicationId[],
  modelAlias: String(row.model_alias) as SandboxModelAlias,
  agentIds: (Array.isArray(row.agent_ids) ? row.agent_ids : ["claude-desktop", "hermes-claw"]) as AgentCatalogId[],
  updatedAt: new Date(String(row.updated_at)),
});

const mapChannelConnectionRow = (row: Record<string, unknown>): ChannelConnectionRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  workspaceId: String(row.workspace_id),
  adapter: "telegram",
  credentialId: String(row.credential_id),
  credentialCiphertext: String(row.credential_ciphertext),
  credentialKeyVersion: Number(row.credential_key_version),
  tokenVersion: Number(row.credential_version),
  allowedUserIds: (Array.isArray(row.allowed_user_ids) ? row.allowed_user_ids : [])
    .filter((value): value is string => typeof value === "string"),
  defaultAgentId: String(row.default_agent_id) as ChatAgentCatalogId,
  allowAgentSwitch: Boolean(row.allow_agent_switch),
  botUsername: row.bot_username ? String(row.bot_username) : null,
  state: "active",
  telegramUpdateOffset: String(row.telegram_update_offset),
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const mapChannelCredentialRow = (row: Record<string, unknown>): ChannelCredentialRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  kind: "telegram_bot_token",
  credentialCiphertext: String(row.credential_ciphertext),
  credentialKeyVersion: Number(row.credential_key_version),
  version: Number(row.version),
  fingerprint: String(row.fingerprint),
  displayName: String(row.display_name),
  botUsername: row.bot_username ? String(row.bot_username) : null,
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const channelConnectionSelect = `
  SELECT c.*,v.credential_ciphertext,v.credential_key_version,v.version AS credential_version,
    v.bot_username
  FROM channel_connections c
  JOIN channel_credentials v ON v.id=c.credential_id`;

const operationSelect = `
  SELECT o.*,
    a.decision AS approval_decision, a.channel AS approval_channel, a.decided_at AS approval_decided_at,
    r.status AS receipt_status, r.upstream_reference, r.result_summary, r.executed_at
  FROM governed_operations o
  LEFT JOIN governed_approvals a ON a.operation_id=o.id
  LEFT JOIN governed_receipts r ON r.operation_id=o.id`;

const activityEventSelect = `
  SELECT event_id,turn_id,sequence,occurred_at,kind,state,provenance,visibility,payload
  FROM activity_events`;

const mapActivityEventRow = (row: Record<string, unknown>): ActivityEventV1 => activityEventSchema.parse({
  version: 1,
  eventId: String(row.event_id),
  turnId: String(row.turn_id),
  sequence: Number(row.sequence),
  timestamp: new Date(String(row.occurred_at)).toISOString(),
  kind: String(row.kind),
  state: String(row.state),
  provenance: String(row.provenance),
  visibility: String(row.visibility),
  payload: row.payload,
});

const mapOperationRow = (row: Record<string, unknown>): GovernedOperationRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  workspaceId: String(row.workspace_id),
  agentId: row.agent_id ? String(row.agent_id) : null,
  policyVersionId: row.policy_version_id ? String(row.policy_version_id) : null,
  policyHash: row.policy_hash ? String(row.policy_hash) : null,
  capabilityId: String(row.capability_id),
  serverName: String(row.server_name),
  toolName: String(row.tool_name),
  schemaId: String(row.schema_id),
  arguments: row.arguments_json as OwnedJson,
  operationDigest: String(row.operation_digest),
  nonce: String(row.nonce),
  state: row.state as GovernedOperationState,
  policyDecision: row.policy_decision as "approval_required" | "deny",
  safeSummary: String(row.safe_summary),
  resourceName: String(row.resource_name),
  resourceLocation: String(row.resource_location),
  correlationId: String(row.correlation_id),
  leaseId: row.lease_id ? String(row.lease_id) : null,
  leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)) : null,
  dispatchStartedAt: row.dispatch_started_at ? new Date(String(row.dispatch_started_at)) : null,
  failureCode: row.failure_code ? String(row.failure_code) : null,
  failureSummary: row.failure_summary ? String(row.failure_summary) : null,
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
  expiresAt: new Date(String(row.expires_at)),
  approval: row.approval_decision ? {
    decision: row.approval_decision as "approve" | "deny",
    channel: row.approval_channel as "local-fixture" | "openvtc-task-consent",
    decidedAt: new Date(String(row.approval_decided_at)),
  } : null,
  receipt: row.receipt_status ? {
    status: "succeeded",
    upstreamReference: String(row.upstream_reference),
    resultSummary: String(row.result_summary),
    executedAt: new Date(String(row.executed_at)),
  } : null,
});

const mapOpenVtcApproverRow = (row: Record<string, unknown>): OpenVtcApproverRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  approverDid: String(row.approver_did),
  verificationMethod: String(row.verification_method),
  displayName: String(row.display_name),
  status: row.status as "active" | "revoked",
  enrolledAt: new Date(String(row.enrolled_at)),
  revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
});

const mapOpenVtcConsentTaskRow = (row: Record<string, unknown>): OpenVtcConsentTaskRecord => ({
  id: String(row.id),
  operationId: String(row.operation_id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  approverId: String(row.approver_id),
  executorDid: String(row.executor_did),
  challenge: String(row.challenge),
  taskType: String(row.task_type),
  payloadDigest: String(row.payload_digest),
  requestDocument: row.request_document as OwnedJson,
  requestHash: String(row.request_hash),
  requestProofHash: String(row.request_proof_hash),
  state: row.state as OpenVtcConsentTaskRecord["state"],
  createdAt: new Date(String(row.created_at)),
  expiresAt: new Date(String(row.expires_at)),
  deliveredAt: row.delivered_at ? new Date(String(row.delivered_at)) : null,
  decidedAt: row.decided_at ? new Date(String(row.decided_at)) : null,
  decisionDocument: row.decision_document ? row.decision_document as OwnedJson : null,
  decisionHash: row.decision_hash ? String(row.decision_hash) : null,
  proofHash: row.proof_hash ? String(row.proof_hash) : null,
});

const mapOpenVtcEnrollmentChallengeRow = (row: Record<string, unknown>): OpenVtcEnrollmentChallengeRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  executorDid: String(row.executor_did),
  challenge: String(row.challenge),
  createdAt: new Date(String(row.created_at)),
  expiresAt: new Date(String(row.expires_at)),
  consumedAt: row.consumed_at ? new Date(String(row.consumed_at)) : null,
});

const mapOpenVtcCompanionSubscriptionRow = (row: Record<string, unknown>): OpenVtcCompanionSubscriptionRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  approverId: String(row.approver_id),
  installationId: String(row.installation_id),
  protocolVersion: "onecomputer-companion-push-0.1",
  browserFamily: row.browser_family as OpenVtcCompanionSubscriptionRecord["browserFamily"],
  platform: row.platform as OpenVtcCompanionSubscriptionRecord["platform"],
  endpointHash: String(row.endpoint_hash),
  subscriptionCiphertext: String(row.subscription_ciphertext),
  status: row.status as OpenVtcCompanionSubscriptionRecord["status"],
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
  revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
  lastSuccessfulDeliveryAt: row.last_successful_delivery_at ? new Date(String(row.last_successful_delivery_at)) : null,
  lastFailureCode: row.last_failure_code ? String(row.last_failure_code) : null,
});

export class PostgresWorkspaceStore implements WorkspaceStore, GovernanceStore, OpenVtcApprovalStore, ChannelStore, ActivityStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresWorkspaceStore(new pg.Pool({ connectionString, max: 10 }));
  }

  async migrate() { return runWorkspaceMigrations(this.pool); }

  async assertSchemaCompatible() { return assertWorkspaceSchemaCompatible(this.pool); }

  async close() { await this.pool.end(); }

  async appendActivityEvent(input: AppendActivityEventInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const scopeKey = [
        input.identity.tenantId,
        input.identity.subjectId,
        input.workspaceId,
        input.agentCatalogId,
        input.sessionId,
        input.turnId,
      ].join(":");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`activity:${scopeKey}`]);
      const workspace = await client.query(
        "SELECT id FROM workspaces WHERE id=$1 AND tenant_id=$2 AND subject_id=$3",
        [input.workspaceId, input.identity.tenantId, input.identity.subjectId],
      );
      if (!workspace.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      const values = [
        input.identity.tenantId,
        input.identity.subjectId,
        input.workspaceId,
        input.agentCatalogId,
        input.sessionId,
        input.turnId,
      ];
      const existing = await client.query(
        `${activityEventSelect}
         WHERE tenant_id=$1 AND subject_id=$2 AND workspace_id=$3 AND agent_catalog_id=$4
           AND session_id=$5 AND turn_id=$6 AND dedupe_key=$7`,
        [...values, input.dedupeKey],
      );
      if (existing.rowCount) {
        await client.query("COMMIT");
        return mapActivityEventRow(existing.rows[0]);
      }
      const next = await client.query<{ sequence: number }>(
        `SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM activity_events
         WHERE tenant_id=$1 AND subject_id=$2 AND workspace_id=$3 AND agent_catalog_id=$4
           AND session_id=$5 AND turn_id=$6`,
        values,
      );
      if (input.draft.turnId !== input.turnId) throw new Error("Activity event turn scope does not match its draft");
      const { turnId: _draftTurnId, ...draft } = input.draft;
      const event = activityEventSchema.parse({
        version: 1,
        eventId: randomUUID(),
        turnId: input.turnId,
        sequence: Number(next.rows[0]?.sequence ?? 0),
        timestamp: input.occurredAt.toISOString(),
        ...draft,
      });
      await client.query(
        `INSERT INTO activity_events (
           event_id,tenant_id,subject_id,workspace_id,agent_catalog_id,session_id,turn_id,
           sequence,dedupe_key,occurred_at,kind,state,provenance,visibility,payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [
          event.eventId,
          ...values,
          event.sequence,
          input.dedupeKey,
          event.timestamp,
          event.kind,
          event.state,
          event.provenance,
          event.visibility,
          JSON.stringify(event.payload),
        ],
      );
      await client.query("COMMIT");
      return event;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async replayActivityEvents(
    identity: IdentityContext,
    scope: ActivityEventScope,
    afterSequence: number,
    limit: number,
  ) {
    const values = [
      identity.tenantId,
      identity.subjectId,
      scope.workspaceId,
      scope.agentCatalogId,
      scope.sessionId,
      scope.turnId,
    ];
    const summary = await this.pool.query<{ count: string; terminal_sequence: number | null }>(
      `SELECT COUNT(*)::text AS count,
         MIN(sequence) FILTER (WHERE kind='terminal') AS terminal_sequence
       FROM activity_events
       WHERE tenant_id=$1 AND subject_id=$2 AND workspace_id=$3 AND agent_catalog_id=$4
         AND session_id=$5 AND turn_id=$6`,
      values,
    );
    if (Number(summary.rows[0]?.count ?? 0) === 0) return { found: false, events: [], terminalSequence: null };
    const result = await this.pool.query(
      `${activityEventSelect}
       WHERE tenant_id=$1 AND subject_id=$2 AND workspace_id=$3 AND agent_catalog_id=$4
         AND session_id=$5 AND turn_id=$6 AND sequence>$7
       ORDER BY sequence ASC LIMIT $8`,
      [...values, afterSequence, Math.min(500, Math.max(1, limit))],
    );
    return {
      found: true,
      events: result.rows.map(mapActivityEventRow),
      terminalSequence: summary.rows[0]?.terminal_sequence === null
        ? null
        : Number(summary.rows[0]?.terminal_sequence),
    };
  }

  async registerPolicyVerificationKeys(keys: PolicyVerificationKey[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const key of keys) {
        await client.query(
          `INSERT INTO policy_signing_keys (
             key_id,algorithm,public_key_spki_base64,status,activated_at,expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (key_id) DO UPDATE SET
             algorithm=EXCLUDED.algorithm,
             public_key_spki_base64=EXCLUDED.public_key_spki_base64,
             status=EXCLUDED.status,
             activated_at=EXCLUDED.activated_at,
             expires_at=EXCLUDED.expires_at,
             updated_at=now()`,
          [key.keyId, key.algorithm, key.publicKeySpkiBase64, key.status, key.activatedAt, key.expiresAt],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCurrent(identity: IdentityContext, grantId: string) {
    const result = await this.pool.query(
      "SELECT * FROM workspaces WHERE tenant_id=$1 AND subject_id=$2 AND grant_id=$3",
      [identity.tenantId, identity.subjectId, grantId],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async listCurrent(identity: IdentityContext) {
    const result = await this.pool.query(
      "SELECT * FROM workspaces WHERE tenant_id=$1 AND subject_id=$2 ORDER BY updated_at DESC, created_at DESC",
      [identity.tenantId, identity.subjectId],
    );
    return result.rows.map(mapRow);
  }

  async getOwned(identity: IdentityContext, workspaceId: string) {
    const result = await this.pool.query(
      "SELECT * FROM workspaces WHERE id=$1 AND tenant_id=$2 AND subject_id=$3",
      [workspaceId, identity.tenantId, identity.subjectId],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async createOrGet(identity: IdentityContext, grantId: string, idempotencyKey: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${identity.tenantId}:${identity.subjectId}:${grantId}`]);
      const existing = await client.query(
        "SELECT * FROM workspaces WHERE tenant_id=$1 AND subject_id=$2 AND grant_id=$3 FOR UPDATE",
        [identity.tenantId, identity.subjectId, grantId],
      );
      let record: WorkspaceRecord;
      if (existing.rowCount) {
        record = mapRow(existing.rows[0]);
      } else {
        const id = randomUUID();
        const now = new Date();
        const inserted = await client.query(
          "INSERT INTO workspaces (id,tenant_id,subject_id,grant_id,state,created_at,updated_at) VALUES ($1,$2,$3,$4,'not_created',$5,$5) RETURNING *",
          [id, identity.tenantId, identity.subjectId, grantId, now],
        );
        record = mapRow(inserted.rows[0]);
      }
      await client.query(
        "INSERT INTO workspace_idempotency (tenant_id,subject_id,operation,idempotency_key,workspace_id) VALUES ($1,$2,'create',$3,$4) ON CONFLICT DO NOTHING",
        [identity.tenantId, identity.subjectId, idempotencyKey, record.id],
      );
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(workspaceId: string, allowed: WorkspaceState[], next: WorkspaceState) {
    const token = randomUUID();
    const result = await this.pool.query(
      "UPDATE workspaces SET state=$2, operation_token=$3, failure_code=NULL, updated_at=now() WHERE id=$1 AND state=ANY($4::text[]) RETURNING *",
      [workspaceId, next, token, allowed],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async finish(workspaceId: string, operationToken: string, patch: Partial<Pick<WorkspaceRecord, "state" | "providerId" | "failureCode">>) {
    const result = await this.pool.query(
      "UPDATE workspaces SET state=COALESCE($3,state), provider_id=CASE WHEN $5 THEN $4 ELSE provider_id END, failure_code=$6, operation_token=NULL, updated_at=now() WHERE id=$1 AND operation_token=$2 RETURNING *",
      [workspaceId, operationToken, patch.state ?? null, patch.providerId ?? null, Object.hasOwn(patch, "providerId"), patch.failureCode ?? null],
    );
    if (!result.rowCount) throw new Error("Workspace operation ownership was lost");
    return mapRow(result.rows[0]);
  }

  async update(workspaceId: string, patch: Partial<Pick<WorkspaceRecord, "state" | "providerId" | "failureCode">>) {
    const result = await this.pool.query(
      "UPDATE workspaces SET state=COALESCE($2,state), provider_id=CASE WHEN $4 THEN $3 ELSE provider_id END, failure_code=$5, updated_at=now() WHERE id=$1 RETURNING *",
      [workspaceId, patch.state ?? null, patch.providerId ?? null, Object.hasOwn(patch, "providerId"), patch.failureCode ?? null],
    );
    if (!result.rowCount) throw new Error("Workspace not found");
    return mapRow(result.rows[0]);
  }

  async getSandboxSettings(identity: IdentityContext, grantId: string) {
    const result = await this.pool.query(
      "SELECT * FROM sandbox_settings WHERE tenant_id=$1 AND subject_id=$2 AND grant_id=$3",
      [identity.tenantId, identity.subjectId, grantId],
    );
    return result.rowCount ? mapSandboxSettingsRow(result.rows[0]) : null;
  }

  async saveSandboxSettings(identity: IdentityContext, input: { grantId: string; profileId: SandboxProfileId; applicationIds: SandboxApplicationId[]; modelAlias: SandboxModelAlias; agentIds: AgentCatalogId[] }) {
    const result = await this.pool.query(
      `INSERT INTO sandbox_settings (tenant_id,subject_id,grant_id,profile_id,application_ids,model_alias,agent_ids,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,now())
       ON CONFLICT (tenant_id,subject_id,grant_id) DO UPDATE
       SET profile_id=EXCLUDED.profile_id,application_ids=EXCLUDED.application_ids,model_alias=EXCLUDED.model_alias,agent_ids=EXCLUDED.agent_ids,updated_at=now()
       RETURNING *`,
      [identity.tenantId, identity.subjectId, input.grantId, input.profileId, JSON.stringify(input.applicationIds), input.modelAlias, JSON.stringify(input.agentIds)],
    );
    return mapSandboxSettingsRow(result.rows[0]);
  }

  async listOwnedChannelCredentials(identity: IdentityContext) {
    const result = await this.pool.query(
      `SELECT v.*,c.workspace_id,c.id AS connection_id
       FROM channel_credentials v
       LEFT JOIN channel_connections c ON c.credential_id=v.id AND c.state='active'
       WHERE v.tenant_id=$1 AND v.subject_id=$2
       ORDER BY v.updated_at DESC,v.id`,
      [identity.tenantId, identity.subjectId],
    );
    return result.rows.map((row) => ({
      ...mapChannelCredentialRow(row),
      workspaceId: row.workspace_id ? String(row.workspace_id) : null,
      connectionId: row.connection_id ? String(row.connection_id) : null,
    }));
  }

  async getOwnedChannelCredential(identity: IdentityContext, credentialId: string) {
    const result = await this.pool.query(
      "SELECT * FROM channel_credentials WHERE id=$1 AND tenant_id=$2 AND subject_id=$3",
      [credentialId, identity.tenantId, identity.subjectId],
    );
    return result.rowCount ? mapChannelCredentialRow(result.rows[0]) : null;
  }

  async saveChannelCredential(identity: IdentityContext, input: Omit<ChannelCredentialRecord, "tenantId" | "subjectId" | "createdAt" | "updatedAt">) {
    const result = await this.pool.query(
      `INSERT INTO channel_credentials (
         id,tenant_id,subject_id,kind,credential_ciphertext,credential_key_version,version,
         fingerprint,display_name,bot_username,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
       ON CONFLICT (id) DO UPDATE SET
         credential_ciphertext=EXCLUDED.credential_ciphertext,
         credential_key_version=EXCLUDED.credential_key_version,
         version=EXCLUDED.version,
         fingerprint=EXCLUDED.fingerprint,
         display_name=EXCLUDED.display_name,
         bot_username=EXCLUDED.bot_username,
         updated_at=now()
       WHERE channel_credentials.tenant_id=EXCLUDED.tenant_id
         AND channel_credentials.subject_id=EXCLUDED.subject_id
         AND channel_credentials.kind=EXCLUDED.kind
       RETURNING *`,
      [input.id, identity.tenantId, identity.subjectId, input.kind, input.credentialCiphertext,
        input.credentialKeyVersion, input.version, input.fingerprint, input.displayName, input.botUsername],
    );
    if (!result.rowCount) throw new Error("Credential is missing or belongs to another user");
    return mapChannelCredentialRow(result.rows[0]);
  }

  async deleteChannelCredential(identity: IdentityContext, credentialId: string) {
    const result = await this.pool.query(
      "DELETE FROM channel_credentials WHERE id=$1 AND tenant_id=$2 AND subject_id=$3",
      [credentialId, identity.tenantId, identity.subjectId],
    );
    return Boolean(result.rowCount);
  }

  async getOwnedChannelConnection(identity: IdentityContext, adapter: "telegram", workspaceId: string) {
    const result = await this.pool.query(
      `${channelConnectionSelect}
       WHERE c.tenant_id=$1 AND c.subject_id=$2 AND c.adapter=$3 AND c.workspace_id=$4 AND c.state='active'`,
      [identity.tenantId, identity.subjectId, adapter, workspaceId],
    );
    return result.rowCount ? mapChannelConnectionRow(result.rows[0]) : null;
  }

  async saveChannelConnection(identity: IdentityContext, input: {
    id: string;
    workspaceId: string;
    adapter: "telegram";
    credentialId: string;
    allowedUserIds: string[];
    defaultAgentId: ChatAgentCatalogId;
    allowAgentSwitch: boolean;
    telegramUpdateOffset: string;
  }) {
    const result = await this.pool.query(
      `INSERT INTO channel_connections (
         id,tenant_id,subject_id,workspace_id,adapter,credential_id,
         allowed_user_ids,default_agent_id,allow_agent_switch,telegram_update_offset,state,created_at,updated_at
       )
       SELECT $1,$2,$3,w.id,$5,v.id,$7::jsonb,$8,$9,$10::bigint,'active',now(),now()
       FROM workspaces w
       JOIN channel_credentials v ON v.id=$6 AND v.tenant_id=$2 AND v.subject_id=$3
       WHERE w.id=$4 AND w.tenant_id=$2 AND w.subject_id=$3
       ON CONFLICT (workspace_id,adapter) DO UPDATE SET
         credential_id=EXCLUDED.credential_id,
         allowed_user_ids=EXCLUDED.allowed_user_ids,
         default_agent_id=EXCLUDED.default_agent_id,
         allow_agent_switch=EXCLUDED.allow_agent_switch,
         telegram_update_offset=EXCLUDED.telegram_update_offset,
         state='active',
         updated_at=now()
       RETURNING id`,
      [input.id, identity.tenantId, identity.subjectId, input.workspaceId, input.adapter,
        input.credentialId, JSON.stringify(input.allowedUserIds), input.defaultAgentId,
        input.allowAgentSwitch, input.telegramUpdateOffset],
    );
    if (!result.rowCount) throw new Error("Channel workspace is missing or belongs to another user");
    const saved = await this.pool.query(`${channelConnectionSelect} WHERE c.id=$1`, [result.rows[0].id]);
    return mapChannelConnectionRow(saved.rows[0]);
  }

  async deleteChannelConnection(identity: IdentityContext, adapter: "telegram", workspaceId: string) {
    const result = await this.pool.query(
      "DELETE FROM channel_connections WHERE tenant_id=$1 AND subject_id=$2 AND adapter=$3 AND workspace_id=$4",
      [identity.tenantId, identity.subjectId, adapter, workspaceId],
    );
    return Boolean(result.rowCount);
  }

  async listActiveChannelConnections(adapter: "telegram") {
    const result = await this.pool.query(
      `${channelConnectionSelect} WHERE c.adapter=$1 AND c.state='active' ORDER BY c.updated_at,c.id`,
      [adapter],
    );
    return result.rows.map(mapChannelConnectionRow);
  }

  async reserveChannelUpdate(connectionId: string, updateId: string, senderId: string) {
    const result = await this.pool.query(
      `INSERT INTO channel_updates (connection_id,update_id,sender_id,state)
       VALUES ($1,$2::bigint,$3,'reserved') ON CONFLICT DO NOTHING RETURNING update_id`,
      [connectionId, updateId, senderId],
    );
    return Boolean(result.rowCount);
  }

  async claimChannelUpdate(connectionId: string, updateId: string, senderId: string) {
    const result = await this.pool.query(
      `UPDATE channel_updates SET state='dispatched',updated_at=now()
       WHERE connection_id=$1 AND update_id=$2::bigint AND sender_id=$3 AND state='reserved'
       RETURNING update_id`,
      [connectionId, updateId, senderId],
    );
    return Boolean(result.rowCount);
  }

  async finishChannelUpdate(connectionId: string, updateId: string, state: "delivered" | "rejected" | "failed", failureCode?: string) {
    await this.pool.query(
      `UPDATE channel_updates SET state=$3,failure_code=$4,updated_at=now()
       WHERE connection_id=$1 AND update_id=$2::bigint AND state IN ('reserved','dispatched')`,
      [connectionId, updateId, state, failureCode ?? null],
    );
  }

  async stageChannelResponse(
    connectionId: string,
    updateId: string,
    chatId: string,
    text: string,
    agentCatalogId: ChatAgentCatalogId,
    artifacts: ChatArtifact[],
    finalState: "delivered" | "failed",
    finalFailureCode?: string,
  ) {
    await this.pool.query(
      `UPDATE channel_updates
       SET state='dispatched',response_chat_id=$3,response_text=$4,response_offset=0,
           response_agent_catalog_id=$5,response_artifacts=$6::jsonb,response_artifact_offset=0,
           final_state=$7,final_failure_code=$8,failure_code=NULL,updated_at=now()
       WHERE connection_id=$1 AND update_id=$2::bigint AND state IN ('reserved','dispatched')`,
      [connectionId, updateId, chatId, text, agentCatalogId, JSON.stringify(artifacts), finalState, finalFailureCode ?? null],
    );
  }

  async listPendingChannelResponses(connectionId: string) {
    const result = await this.pool.query(
      `SELECT connection_id,update_id,sender_id,response_chat_id,response_text,response_offset,
              response_agent_catalog_id,response_artifacts,response_artifact_offset,final_state,final_failure_code
       FROM channel_updates
       WHERE connection_id=$1 AND state='dispatched' AND response_text IS NOT NULL
       ORDER BY created_at,update_id`,
      [connectionId],
    );
    return result.rows.map((row): ChannelPendingResponse => ({
      connectionId: String(row.connection_id),
      updateId: String(row.update_id),
      senderId: String(row.sender_id),
      chatId: String(row.response_chat_id),
      text: String(row.response_text),
      offset: Number(row.response_offset),
      agentCatalogId: row.response_agent_catalog_id as ChatAgentCatalogId | null,
      artifacts: Array.isArray(row.response_artifacts) ? row.response_artifacts as ChatArtifact[] : [],
      artifactOffset: Number(row.response_artifact_offset),
      finalState: row.final_state as "delivered" | "failed",
      finalFailureCode: row.final_failure_code ? String(row.final_failure_code) : null,
    }));
  }

  async advanceChannelResponseDelivery(connectionId: string, updateId: string, offset: number) {
    await this.pool.query(
      `UPDATE channel_updates
       SET response_offset=$3,
           state=CASE WHEN $3 >= char_length(response_text)
                           AND response_artifact_offset >= jsonb_array_length(response_artifacts)
                      THEN final_state ELSE state END,
           failure_code=CASE WHEN $3 >= char_length(response_text)
                                  AND response_artifact_offset >= jsonb_array_length(response_artifacts)
                             THEN final_failure_code ELSE failure_code END,
           updated_at=now()
       WHERE connection_id=$1 AND update_id=$2::bigint
         AND state='dispatched' AND response_text IS NOT NULL
         AND response_offset <= $3`,
      [connectionId, updateId, offset],
    );
  }

  async advanceChannelArtifactDelivery(connectionId: string, updateId: string, offset: number) {
    await this.pool.query(
      `UPDATE channel_updates
       SET response_artifact_offset=$3,
           state=CASE WHEN $3 >= jsonb_array_length(response_artifacts)
                           AND response_offset >= char_length(response_text)
                      THEN final_state ELSE state END,
           failure_code=CASE WHEN $3 >= jsonb_array_length(response_artifacts)
                                  AND response_offset >= char_length(response_text)
                             THEN final_failure_code ELSE failure_code END,
           updated_at=now()
       WHERE connection_id=$1 AND update_id=$2::bigint
         AND state='dispatched' AND response_text IS NOT NULL
         AND response_artifact_offset <= $3
         AND $3 <= jsonb_array_length(response_artifacts)`,
      [connectionId, updateId, offset],
    );
  }

  async advanceTelegramUpdateOffset(connectionId: string, offset: string) {
    await this.pool.query(
      `UPDATE channel_connections
       SET telegram_update_offset=GREATEST(telegram_update_offset,$2::bigint),updated_at=updated_at
       WHERE id=$1`,
      [connectionId, offset],
    );
  }

  async getChannelSenderAgent(connectionId: string, senderId: string) {
    const result = await this.pool.query(
      "SELECT agent_catalog_id FROM channel_sender_routes WHERE connection_id=$1 AND sender_id=$2",
      [connectionId, senderId],
    );
    return result.rowCount ? String(result.rows[0].agent_catalog_id) as ChatAgentCatalogId : null;
  }

  async setChannelSenderAgent(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId) {
    await this.pool.query(
      `INSERT INTO channel_sender_routes (connection_id,sender_id,agent_catalog_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (connection_id,sender_id) DO UPDATE
       SET agent_catalog_id=EXCLUDED.agent_catalog_id,updated_at=now()`,
      [connectionId, senderId, agentCatalogId],
    );
  }

  async getChannelSession(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId) {
    const result = await this.pool.query(
      `SELECT session_id FROM channel_sessions
       WHERE connection_id=$1 AND sender_id=$2 AND agent_catalog_id=$3`,
      [connectionId, senderId, agentCatalogId],
    );
    return result.rowCount ? String(result.rows[0].session_id) : null;
  }

  async saveChannelSession(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId, sessionId: string) {
    await this.pool.query(
      `INSERT INTO channel_sessions (connection_id,sender_id,agent_catalog_id,session_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (connection_id,sender_id,agent_catalog_id) DO UPDATE
       SET session_id=EXCLUDED.session_id,updated_at=now()`,
      [connectionId, senderId, agentCatalogId, sessionId],
    );
  }

  async clearChannelSession(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId) {
    await this.pool.query(
      `DELETE FROM channel_sessions
       WHERE connection_id=$1 AND sender_id=$2 AND agent_catalog_id=$3`,
      [connectionId, senderId, agentCatalogId],
    );
  }

  async createGovernedOperation(input: CreateGovernedOperationRecord) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`governed:${input.identity.tenantId}:${input.identity.subjectId}:${input.idempotencyKey}`]);
      const existing = await client.query(
        "SELECT id,state FROM governed_operations WHERE tenant_id=$1 AND subject_id=$2 AND idempotency_key=$3",
        [input.identity.tenantId, input.identity.subjectId, input.idempotencyKey],
      );
      if (existing.rowCount) {
        const existingId = String(existing.rows[0].id);
        if (input.replaceTerminal && ["denied", "failed", "expired"].includes(String(existing.rows[0].state))) {
          await client.query(
            "UPDATE governed_operations SET idempotency_key=idempotency_key || ':terminal:' || id::text WHERE id=$1",
            [existingId],
          );
        } else {
          await client.query("COMMIT");
          return this.getOwnedOperation(input.identity, existingId);
        }
      }
      const workspace = await client.query(
        "SELECT id FROM workspaces WHERE id=$1 AND tenant_id=$2 AND subject_id=$3",
        [input.workspaceId, input.identity.tenantId, input.identity.subjectId],
      );
      if (!workspace.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `INSERT INTO governed_operations (
          id,tenant_id,subject_id,workspace_id,agent_id,policy_version_id,policy_hash,capability_id,server_name,tool_name,schema_id,arguments_json,
          operation_digest,nonce,state,policy_decision,safe_summary,resource_name,resource_location,
          idempotency_key,correlation_id,created_at,updated_at,expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,'approval_required','approval_required',$15,$16,$17,$18,$19,$20,$20,$21)`,
        [
          input.id, input.identity.tenantId, input.identity.subjectId, input.workspaceId, input.agentId ?? null,
          input.policyVersionId ?? null, input.policyHash ?? null, input.capabilityId,
          input.serverName, input.toolName, input.schemaId, JSON.stringify(input.arguments), input.operationDigest,
          input.nonce, input.safeSummary, input.resourceName, input.resourceLocation, input.idempotencyKey,
          input.correlationId, input.createdAt, input.expiresAt,
        ],
      );
      await client.query(
        "INSERT INTO governed_operation_events (operation_id,tenant_id,event_type,correlation_id,safe_detail) VALUES ($1,$2,'approval_required',$3,$4::jsonb)",
        [input.id, input.identity.tenantId, input.correlationId, JSON.stringify({
          capabilityId: input.capabilityId,
          toolName: input.toolName,
          agentId: input.agentId ?? null,
          policyVersionId: input.policyVersionId ?? null,
          policyHash: input.policyHash ?? null,
        })],
      );
      await client.query("COMMIT");
      return this.getOwnedOperation(input.identity, input.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getOwnedOperation(identity: IdentityContext, operationId: string) {
    const result = await this.pool.query(
      `${operationSelect} WHERE o.id=$1 AND o.tenant_id=$2 AND o.subject_id=$3`,
      [operationId, identity.tenantId, identity.subjectId],
    );
    return result.rowCount ? mapOperationRow(result.rows[0]) : null;
  }

  async getRecentOperation(identity: IdentityContext) {
    const result = await this.pool.query(
      `${operationSelect} WHERE o.tenant_id=$1 AND o.subject_id=$2 ORDER BY o.created_at DESC LIMIT 1`,
      [identity.tenantId, identity.subjectId],
    );
    return result.rowCount ? mapOperationRow(result.rows[0]) : null;
  }

  async listOwnedOperations(identity: IdentityContext, limit: number) {
    const result = await this.pool.query(
      `${operationSelect} WHERE o.tenant_id=$1 AND o.subject_id=$2 ORDER BY o.created_at DESC,o.id DESC LIMIT $3`,
      [identity.tenantId, identity.subjectId, limit],
    );
    return result.rows.map(mapOperationRow);
  }

  async listOwnedOperationsPage(identity: IdentityContext, input: {
    limit: number;
    before?: { createdAt: Date; id: string };
  }) {
    const result = await this.pool.query(
      `${operationSelect}
       WHERE o.tenant_id=$1 AND o.subject_id=$2
         AND ($3::timestamptz IS NULL
           OR o.created_at<$3::timestamptz
           OR (o.created_at=$3::timestamptz AND o.id<$4::uuid))
       ORDER BY o.created_at DESC,o.id DESC LIMIT $5`,
      [identity.tenantId, identity.subjectId, input.before?.createdAt ?? null, input.before?.id ?? null, input.limit],
    );
    return result.rows.map(mapOperationRow);
  }

  async getOperationEvents(identity: IdentityContext, operationId: string) {
    const result = await this.pool.query(
      `SELECT e.event_type,e.correlation_id,e.safe_detail,e.created_at
       FROM governed_operation_events e JOIN governed_operations o ON o.id=e.operation_id
       WHERE e.operation_id=$1 AND o.tenant_id=$2 AND o.subject_id=$3 ORDER BY e.created_at ASC,e.id ASC`,
      [operationId, identity.tenantId, identity.subjectId],
    );
    return result.rows.map((row) => ({
      eventType: String(row.event_type),
      correlationId: String(row.correlation_id),
      safeDetail: row.safe_detail as OwnedJson,
      createdAt: new Date(String(row.created_at)),
    }));
  }

  async recordApproval(input: ApprovalRecordInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        `SELECT id FROM governed_operations
         WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 AND state='approval_required'
           AND operation_digest=$4 AND nonce=$5 AND expires_at>$6
         FOR UPDATE`,
        [input.operationId, input.identity.tenantId, input.identity.subjectId, input.operationDigest, input.nonce, input.decidedAt],
      );
      if (!claimed.rowCount) {
        await client.query("COMMIT");
        return this.getOwnedOperation(input.identity, input.operationId);
      }
      await client.query(
        `INSERT INTO governed_approvals (
          id,operation_id,decision,channel,issuer,key_id,operation_digest,nonce,proof_hash,issued_at,expires_at,decided_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [input.approvalId, input.operationId, input.decision, input.channel, input.issuer, input.keyId, input.operationDigest, input.nonce, input.proofHash, input.issuedAt, input.expiresAt, input.decidedAt],
      );
      await client.query(
        "UPDATE governed_operations SET state=$2, updated_at=$3 WHERE id=$1",
        [input.operationId, input.decision === "approve" ? "approved" : "denied", input.decidedAt],
      );
      await client.query(
        "INSERT INTO governed_operation_events (operation_id,tenant_id,event_type,correlation_id,safe_detail) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [input.operationId, input.identity.tenantId, input.decision === "approve" ? "approved" : "denied", input.correlationId, JSON.stringify({ channel: input.channel })],
      );
      await client.query("COMMIT");
      return this.getOwnedOperation(input.identity, input.operationId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimExecution(identity: IdentityContext, operationId: string, leaseId: string, leaseExpiresAt: Date, correlationId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE governed_operations SET state='executing',lease_id=$4,lease_expires_at=$5,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 AND state='approved' AND expires_at>now()
         RETURNING id`,
        [operationId, identity.tenantId, identity.subjectId, leaseId, leaseExpiresAt],
      );
      if (result.rowCount) await client.query(
        "INSERT INTO governed_operation_events (operation_id,tenant_id,event_type,correlation_id) VALUES ($1,$2,'executing',$3)",
        [operationId, identity.tenantId, correlationId],
      );
      await client.query("COMMIT");
      return this.getOwnedOperation(identity, operationId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimToolDispatch(identity: IdentityContext, input: {
    operationId: string; operationDigest: string; leaseId: string; workspaceId: string; agentId: string; serverName: string;
    toolName: string; arguments: OwnedJson; dispatchedAt: Date; correlationId: string;
  }) {
    const result = await this.pool.query(
      `UPDATE governed_operations SET dispatch_started_at=$11,updated_at=$11
       WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 AND workspace_id=$4 AND state='executing'
         AND agent_id=$5 AND operation_digest=$6 AND lease_id=$7 AND lease_expires_at>$11
         AND server_name=$8 AND tool_name=$9 AND arguments_json=$10::jsonb
         AND dispatch_started_at IS NULL RETURNING id`,
      [input.operationId, identity.tenantId, identity.subjectId, input.workspaceId, input.agentId, input.operationDigest,
        input.leaseId, input.serverName, input.toolName, JSON.stringify(input.arguments), input.dispatchedAt],
    );
    if (result.rowCount) await this.pool.query(
      "INSERT INTO governed_operation_events (operation_id,tenant_id,event_type,correlation_id) VALUES ($1,$2,'dispatch_started',$3)",
      [input.operationId, identity.tenantId, input.correlationId],
    );
    return Boolean(result.rowCount);
  }

  async completeExecution(identity: IdentityContext, operationId: string, leaseId: string, receipt: { id: string; upstreamReference: string; resultSummary: string; resultHash: string; executedAt: Date }, correlationId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ownedLease = await client.query(
        "SELECT id FROM governed_operations WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 AND state='executing' AND lease_id=$4 FOR UPDATE",
        [operationId, identity.tenantId, identity.subjectId, leaseId],
      );
      if (!ownedLease.rowCount) {
        await client.query("COMMIT");
        return this.getOwnedOperation(identity, operationId);
      }
      await client.query(
        "INSERT INTO governed_receipts (id,operation_id,lease_id,status,upstream_reference,result_summary,result_hash,executed_at) VALUES ($1,$2,$3,'succeeded',$4,$5,$6,$7)",
        [receipt.id, operationId, leaseId, receipt.upstreamReference, receipt.resultSummary, receipt.resultHash, receipt.executedAt],
      );
      await client.query("UPDATE governed_operations SET state='succeeded',updated_at=$2 WHERE id=$1", [operationId, receipt.executedAt]);
      await client.query(
        "INSERT INTO governed_operation_events (operation_id,tenant_id,event_type,correlation_id) VALUES ($1,$2,'succeeded',$3)",
        [operationId, identity.tenantId, correlationId],
      );
      await client.query("COMMIT");
      return this.getOwnedOperation(identity, operationId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failExecution(identity: IdentityContext, operationId: string, leaseId: string, failureCode: string, correlationId: string, failureSummary?: string) {
    const result = await this.pool.query(
      `UPDATE governed_operations SET state='failed',failure_code=$5,failure_summary=$6,updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 AND state='executing' AND lease_id=$4 RETURNING id`,
      [operationId, identity.tenantId, identity.subjectId, leaseId, failureCode, failureSummary?.slice(0, 240) ?? null],
    );
    if (result.rowCount) await this.pool.query(
      "INSERT INTO governed_operation_events (operation_id,tenant_id,event_type,correlation_id,safe_detail) VALUES ($1,$2,'failed',$3,$4::jsonb)",
      [operationId, identity.tenantId, correlationId, JSON.stringify({ failureCode, failureSummary: failureSummary?.slice(0, 240) ?? null })],
    );
    return this.getOwnedOperation(identity, operationId);
  }

  async recoverOperation(identity: IdentityContext, operationId: string, now: Date, correlationId: string) {
    const result = await this.pool.query(
      `UPDATE governed_operations
       SET state=CASE WHEN state='executing' THEN 'failed' ELSE 'expired' END,
           failure_code=CASE WHEN state='executing' THEN 'EXECUTION_LEASE_EXPIRED' ELSE failure_code END,
           updated_at=$4
       WHERE id=$1 AND tenant_id=$2 AND subject_id=$3
         AND ((state IN ('approval_required','approved') AND expires_at<=$4)
           OR (state='executing' AND lease_expires_at<=$4))
       RETURNING state`,
      [operationId, identity.tenantId, identity.subjectId, now],
    );
    if (result.rowCount) await this.pool.query(
      "INSERT INTO governed_operation_events (operation_id,tenant_id,event_type,correlation_id) VALUES ($1,$2,$3,$4)",
      [operationId, identity.tenantId, result.rows[0].state === "expired" ? "expired" : "lease_expired", correlationId],
    );
    return this.getOwnedOperation(identity, operationId);
  }

  async createOpenVtcEnrollmentChallenge(input: Omit<OpenVtcEnrollmentChallengeRecord, "tenantId" | "subjectId" | "consumedAt"> & { identity: IdentityContext }) {
    const result = await this.pool.query(
      `INSERT INTO openvtc_enrollment_challenges (id,tenant_id,subject_id,executor_did,challenge,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.id, input.identity.tenantId, input.identity.subjectId, input.executorDid, input.challenge, input.createdAt, input.expiresAt],
    );
    return mapOpenVtcEnrollmentChallengeRow(result.rows[0]);
  }

  async getOpenVtcEnrollmentChallenge(identity: IdentityContext, challengeId: string) {
    const result = await this.pool.query(
      "SELECT * FROM openvtc_enrollment_challenges WHERE id=$1 AND tenant_id=$2 AND subject_id=$3",
      [challengeId, identity.tenantId, identity.subjectId],
    );
    return result.rowCount ? mapOpenVtcEnrollmentChallengeRow(result.rows[0]) : null;
  }

  async consumeOpenVtcEnrollmentChallenge(identity: IdentityContext, challengeId: string, challenge: string, consumedAt: Date) {
    const result = await this.pool.query(
      `UPDATE openvtc_enrollment_challenges SET consumed_at=$5
       WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 AND challenge=$4 AND consumed_at IS NULL AND expires_at>$5`,
      [challengeId, identity.tenantId, identity.subjectId, challenge, consumedAt],
    );
    return Boolean(result.rowCount);
  }

  async enrollOpenVtcApprover(input: {
    id: string; identity: IdentityContext; approverDid: string; verificationMethod: string; displayName: string;
    transportTokenHash: string; enrolledAt: Date;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO openvtc_approvers (
          id,tenant_id,subject_id,approver_did,verification_method,display_name,transport_token_hash,status,enrolled_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)
        ON CONFLICT (tenant_id,subject_id,approver_did) DO UPDATE SET
          verification_method=EXCLUDED.verification_method,display_name=EXCLUDED.display_name,
          transport_token_hash=EXCLUDED.transport_token_hash,status='active',enrolled_at=EXCLUDED.enrolled_at,revoked_at=NULL
        RETURNING *`,
        [input.id, input.identity.tenantId, input.identity.subjectId, input.approverDid, input.verificationMethod,
          input.displayName, input.transportTokenHash, input.enrolledAt],
      );
      await client.query("COMMIT");
      return mapOpenVtcApproverRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getActiveOpenVtcApprover(identity: IdentityContext) {
    const result = await this.pool.query(
      "SELECT * FROM openvtc_approvers WHERE tenant_id=$1 AND subject_id=$2 AND status='active' ORDER BY enrolled_at DESC,id DESC LIMIT 1",
      [identity.tenantId, identity.subjectId],
    );
    return result.rowCount ? mapOpenVtcApproverRow(result.rows[0]) : null;
  }

  async listActiveOpenVtcApprovers(identity: IdentityContext) {
    const result = await this.pool.query(
      "SELECT * FROM openvtc_approvers WHERE tenant_id=$1 AND subject_id=$2 AND status='active' ORDER BY enrolled_at DESC,id DESC",
      [identity.tenantId, identity.subjectId],
    );
    return result.rows.map(mapOpenVtcApproverRow);
  }

  async getActiveOpenVtcApproverByDid(identity: IdentityContext, approverDid: string) {
    const result = await this.pool.query(
      "SELECT * FROM openvtc_approvers WHERE tenant_id=$1 AND subject_id=$2 AND approver_did=$3 AND status='active'",
      [identity.tenantId, identity.subjectId, approverDid],
    );
    return result.rowCount ? mapOpenVtcApproverRow(result.rows[0]) : null;
  }

  async getOpenVtcApproverByTransportTokenHash(tokenHash: string) {
    const result = await this.pool.query(
      "SELECT * FROM openvtc_approvers WHERE transport_token_hash=$1 AND status='active'",
      [tokenHash],
    );
    return result.rowCount ? mapOpenVtcApproverRow(result.rows[0]) : null;
  }

  async revokeOpenVtcApprover(identity: IdentityContext, approverId: string, revokedAt: Date) {
    const result = await this.pool.query(
      `UPDATE openvtc_approvers SET status='revoked',revoked_at=$4
       WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 AND status='active'`,
      [approverId, identity.tenantId, identity.subjectId, revokedAt],
    );
    return Boolean(result.rowCount);
  }

  async createOpenVtcConsentTask(input: CreateOpenVtcConsentTaskInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const operation = await client.query(
        `SELECT id,state,expires_at FROM governed_operations
         WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 FOR UPDATE`,
        [input.operationId, input.identity.tenantId, input.identity.subjectId],
      );
      const existing = await client.query(
        "SELECT * FROM openvtc_consent_tasks WHERE operation_id=$1 AND tenant_id=$2 AND subject_id=$3 AND approver_id=$4",
        [input.operationId, input.identity.tenantId, input.identity.subjectId, input.approverId],
      );
      const operationRow = operation.rows[0] as Record<string, unknown> | undefined;
      const approver = await client.query(
        `SELECT id FROM openvtc_approvers WHERE id=$1 AND tenant_id=$2 AND subject_id=$3
         AND status='active' FOR UPDATE`,
        [input.approverId, input.identity.tenantId, input.identity.subjectId],
      );
      if (!operationRow || operationRow.state !== "approval_required" || new Date(String(operationRow.expires_at)) <= input.createdAt || !approver.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      if (existing.rowCount) {
        const existingRow = existing.rows[0] as Record<string, unknown>;
        await client.query("COMMIT");
        return mapOpenVtcConsentTaskRow(existingRow);
      }
      const inserted = await client.query(
        `INSERT INTO openvtc_consent_tasks (
          id,operation_id,tenant_id,subject_id,approver_id,executor_did,challenge,task_type,payload_digest,
          request_document,request_hash,request_proof_hash,state,created_at,expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,'queued',$13,$14) RETURNING *`,
        [input.id, input.operationId, input.identity.tenantId, input.identity.subjectId, input.approverId,
          input.executorDid, input.challenge, input.taskType, input.payloadDigest, JSON.stringify(input.requestDocument),
          input.requestHash, input.requestProofHash, input.createdAt, input.expiresAt],
      );
      await client.query(
        `INSERT INTO openvtc_delivery_outbox (
          id,task_id,transport,state,available_at,created_at,updated_at
        ) VALUES ($1,$2,'https-poll-0.1','queued',$3,$3,$3)`,
        [input.outboxId, input.id, input.createdAt],
      );
      await client.query(
        `INSERT INTO governed_operation_events (operation_id,tenant_id,event_type,correlation_id,safe_detail)
         VALUES ($1,$2,'approval_delivery_queued','openvtc-task-create',$3::jsonb)`,
        [input.operationId, input.identity.tenantId, JSON.stringify({ channel: "openvtc-task-consent", taskId: input.id })],
      );
      await client.query("COMMIT");
      return mapOpenVtcConsentTaskRow(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getOpenVtcConsentTask(identity: IdentityContext, operationId: string) {
    const result = await this.pool.query(
      "SELECT * FROM openvtc_consent_tasks WHERE operation_id=$1 AND tenant_id=$2 AND subject_id=$3 ORDER BY created_at DESC LIMIT 1",
      [operationId, identity.tenantId, identity.subjectId],
    );
    return result.rowCount ? mapOpenVtcConsentTaskRow(result.rows[0]) : null;
  }

  async getOpenVtcConsentTaskForApprover(identity: IdentityContext, operationId: string, approverId: string) {
    const result = await this.pool.query(
      "SELECT * FROM openvtc_consent_tasks WHERE operation_id=$1 AND tenant_id=$2 AND subject_id=$3 AND approver_id=$4",
      [operationId, identity.tenantId, identity.subjectId, approverId],
    );
    return result.rowCount ? mapOpenVtcConsentTaskRow(result.rows[0]) : null;
  }

  async getOpenVtcConsentTaskByPayloadDigest(approverId: string, payloadDigest: string) {
    const result = await this.pool.query(
      "SELECT * FROM openvtc_consent_tasks WHERE approver_id=$1 AND payload_digest=$2",
      [approverId, payloadDigest],
    );
    return result.rowCount ? mapOpenVtcConsentTaskRow(result.rows[0]) : null;
  }

  async deliverNextOpenVtcConsentTask(approverId: string, deliveredAt: Date) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE openvtc_consent_tasks SET state='expired'
         WHERE approver_id=$1 AND state IN ('queued','delivered') AND expires_at<=$2`,
        [approverId, deliveredAt],
      );
      const result = await client.query(
        `SELECT t.*,o.id AS outbox_id,o.attempt_count
         FROM openvtc_consent_tasks t
         JOIN openvtc_delivery_outbox o ON o.task_id=t.id
         JOIN openvtc_approvers a ON a.id=t.approver_id AND a.status='active'
         WHERE t.approver_id=$1 AND t.state IN ('queued','delivered') AND t.expires_at>$2
         ORDER BY t.created_at LIMIT 1 FOR UPDATE OF t,o`,
        [approverId, deliveredAt],
      );
      if (!result.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      const row = result.rows[0] as Record<string, unknown>;
      const attempt = Number(row.attempt_count) + 1;
      await client.query(
        "UPDATE openvtc_consent_tasks SET state='delivered',delivered_at=COALESCE(delivered_at,$2) WHERE id=$1",
        [row.id, deliveredAt],
      );
      await client.query(
        `UPDATE openvtc_delivery_outbox SET state='delivered',attempt_count=$2,delivered_at=COALESCE(delivered_at,$3),
         updated_at=$3,lease_id=NULL,lease_expires_at=NULL WHERE id=$1`,
        [row.outbox_id, attempt, deliveredAt],
      );
      await client.query(
        `INSERT INTO openvtc_delivery_attempts (outbox_id,attempt,outcome,attempted_at)
         VALUES ($1,$2,'delivered',$3)`,
        [row.outbox_id, attempt, deliveredAt],
      );
      await client.query("COMMIT");
      return mapOpenVtcConsentTaskRow({ ...row, state: "delivered", delivered_at: row.delivered_at ?? deliveredAt });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertOpenVtcCompanionSubscription(input: Omit<OpenVtcCompanionSubscriptionRecord,
    "tenantId" | "subjectId" | "status" | "createdAt" | "updatedAt" | "revokedAt" | "lastSuccessfulDeliveryAt" | "lastFailureCode"
  > & { identity: IdentityContext; savedAt: Date }) {
    const result = await this.pool.query(
      `INSERT INTO openvtc_companion_subscriptions (
        id,tenant_id,subject_id,approver_id,installation_id,protocol_version,browser_family,platform,
        endpoint_hash,subscription_ciphertext,status,created_at,updated_at
      )
      SELECT $1,$2,$3,a.id,$4,$5,$6,$7,$8,$9,'active',$10,$10
      FROM openvtc_approvers a
      WHERE a.id=$11 AND a.tenant_id=$2 AND a.subject_id=$3 AND a.status='active'
      ON CONFLICT (approver_id) DO UPDATE SET
        installation_id=EXCLUDED.installation_id,protocol_version=EXCLUDED.protocol_version,
        browser_family=EXCLUDED.browser_family,platform=EXCLUDED.platform,endpoint_hash=EXCLUDED.endpoint_hash,
        subscription_ciphertext=EXCLUDED.subscription_ciphertext,status='active',updated_at=EXCLUDED.updated_at,
        revoked_at=NULL,last_failure_code=NULL
      RETURNING *`,
      [input.id, input.identity.tenantId, input.identity.subjectId, input.installationId, input.protocolVersion,
        input.browserFamily, input.platform, input.endpointHash, input.subscriptionCiphertext, input.savedAt, input.approverId],
    );
    if (!result.rowCount) throw new Error("The companion approver is missing, revoked, or belongs to another user");
    return mapOpenVtcCompanionSubscriptionRow(result.rows[0]);
  }

  async listOpenVtcCompanionSubscriptions(identity: IdentityContext) {
    const result = await this.pool.query(
      `SELECT * FROM openvtc_companion_subscriptions
       WHERE tenant_id=$1 AND subject_id=$2
       ORDER BY created_at DESC,id DESC`,
      [identity.tenantId, identity.subjectId],
    );
    return result.rows.map(mapOpenVtcCompanionSubscriptionRow);
  }

  async getOpenVtcCompanionSubscriptionForApprover(approverId: string) {
    const result = await this.pool.query(
      "SELECT * FROM openvtc_companion_subscriptions WHERE approver_id=$1 AND status='active'",
      [approverId],
    );
    return result.rowCount ? mapOpenVtcCompanionSubscriptionRow(result.rows[0]) : null;
  }

  async revokeOpenVtcCompanionSubscription(identity: IdentityContext, subscriptionId: string, revokedAt: Date) {
    const result = await this.pool.query(
      `UPDATE openvtc_companion_subscriptions SET status='revoked',revoked_at=$4,updated_at=$4
       WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 AND status<>'revoked'`,
      [subscriptionId, identity.tenantId, identity.subjectId, revokedAt],
    );
    return Boolean(result.rowCount);
  }

  async enqueueOpenVtcCompanionPushDelivery(input: { id: string; taskId: string; subscriptionId: string; queuedAt: Date }) {
    const result = await this.pool.query(
      `INSERT INTO openvtc_companion_push_deliveries (
        id,task_id,subscription_id,state,attempt_count,available_at,created_at,updated_at
      ) VALUES ($1,$2,$3,'queued',0,$4,$4,$4)
      ON CONFLICT (task_id,subscription_id) DO NOTHING
      RETURNING id`,
      [input.id, input.taskId, input.subscriptionId, input.queuedAt],
    );
    return Boolean(result.rowCount);
  }

  async claimOpenVtcCompanionPushDelivery(input: { taskId: string; subscriptionId: string; claimedAt: Date }) {
    const result = await this.pool.query(
      `UPDATE openvtc_companion_push_deliveries SET
        state='queued',attempt_count=attempt_count+1,updated_at=$3
       WHERE task_id=$1 AND subscription_id=$2
         AND (
           (state='retry' AND available_at<=$3)
           OR (state='queued' AND attempt_count=0 AND available_at<=$3)
           OR (state='queued' AND attempt_count>0 AND updated_at<=$3::timestamptz - interval '30 seconds')
         )
      RETURNING id`,
      [input.taskId, input.subscriptionId, input.claimedAt],
    );
    return Boolean(result.rowCount);
  }

  async listDueOpenVtcCompanionPushDeliveries(now: Date, limit: number) {
    const result = await this.pool.query(
      `SELECT d.task_id,d.subscription_id,s.subscription_ciphertext
       FROM openvtc_companion_push_deliveries d
       JOIN openvtc_companion_subscriptions s ON s.id=d.subscription_id AND s.status='active'
       JOIN openvtc_consent_tasks t ON t.id=d.task_id AND t.state IN ('queued','delivered')
       JOIN governed_operations o ON o.id=t.operation_id AND o.state='approval_required' AND o.expires_at>$1
       WHERE (d.state='retry' AND d.available_at<=$1)
          OR (d.state='queued' AND d.attempt_count=0 AND d.available_at<=$1)
          OR (d.state='queued' AND d.attempt_count>0 AND d.updated_at<=$1::timestamptz - interval '30 seconds')
       ORDER BY d.available_at,d.created_at
       LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => ({
      taskId: String(row.task_id),
      subscriptionId: String(row.subscription_id),
      subscriptionCiphertext: String(row.subscription_ciphertext),
    }));
  }

  async recordOpenVtcCompanionPushDelivery(input: {
    taskId: string;
    subscriptionId: string;
    delivered: boolean;
    terminal: boolean;
    failureCode?: string;
    attemptedAt: Date;
  }) {
    const state = input.delivered ? "delivered" : input.terminal ? "failed" : "retry";
    await this.pool.query(
      `UPDATE openvtc_companion_push_deliveries SET
        state=$3,delivered_at=CASE WHEN $3='delivered' THEN $4 ELSE delivered_at END,
        last_failure_code=$5,updated_at=$4,
        available_at=CASE WHEN $3='retry'
          THEN $4::timestamptz + (LEAST(60,power(2,attempt_count)) * interval '1 second')
          ELSE available_at END
       WHERE task_id=$1 AND subscription_id=$2`,
      [input.taskId, input.subscriptionId, state, input.attemptedAt, input.failureCode ?? null],
    );
    await this.pool.query(
      `UPDATE openvtc_companion_subscriptions SET
        status=CASE WHEN $3 AND NOT $2 THEN 'invalid' ELSE status END,
        last_successful_delivery_at=CASE WHEN $2 THEN $4 ELSE last_successful_delivery_at END,
        last_failure_code=CASE WHEN $2 THEN NULL ELSE $5 END,
        updated_at=$4
       WHERE id=$1`,
      [input.subscriptionId, input.delivered, input.terminal, input.attemptedAt, input.failureCode ?? null],
    );
  }

  async recordOpenVtcDecision(input: RecordOpenVtcDecisionInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        `SELECT t.operation_id,t.expires_at,t.state AS task_state,a.approver_did,a.verification_method,a.status,
           o.operation_digest,o.nonce,o.state
         FROM openvtc_consent_tasks t
         JOIN openvtc_approvers a ON a.id=t.approver_id
         JOIN governed_operations o ON o.id=t.operation_id
         WHERE t.id=$1 AND t.tenant_id=$2 AND t.subject_id=$3 AND t.approver_id=$4
           AND t.challenge=$5 AND t.payload_digest=$6
         FOR UPDATE OF t,a,o`,
        [input.taskId, input.identity.tenantId, input.identity.subjectId, input.approverId, input.challenge, input.payloadDigest],
      );
      if (!claimed.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      const row = claimed.rows[0] as Record<string, unknown>;
      const valid = row.status === "active" && row.approver_did === input.signerDid
        && row.verification_method === input.verificationMethod && row.state === "approval_required"
        && (row.task_state === "queued" || row.task_state === "delivered")
        && new Date(String(row.expires_at)) > input.decidedAt;
      if (!valid) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `INSERT INTO governed_approvals (
          id,operation_id,decision,channel,issuer,key_id,operation_digest,nonce,proof_hash,issued_at,expires_at,decided_at
        ) VALUES ($1,$2,$3,'openvtc-task-consent',$4,$5,$6,$7,$8,$9,$10,$11)`,
        [input.approvalId, row.operation_id, input.decision, input.signerDid, input.verificationMethod,
          row.operation_digest, row.nonce, input.proofHash, input.issuedAt, row.expires_at, input.decidedAt],
      );
      await client.query(
        `UPDATE openvtc_consent_tasks SET state=$2,decided_at=$3,decision_document=$4::jsonb,decision_hash=$5,proof_hash=$6
         WHERE id=$1`,
        [input.taskId, input.decision === "approve" ? "approved" : "denied", input.decidedAt,
          JSON.stringify(input.decisionDocument), input.decisionHash, input.proofHash],
      );
      await client.query(
        `UPDATE openvtc_consent_tasks SET state='failed'
         WHERE operation_id=$1 AND id<>$2 AND state IN ('queued','delivered')`,
        [row.operation_id, input.taskId],
      );
      await client.query(
        "UPDATE governed_operations SET state=$2,updated_at=$3 WHERE id=$1",
        [row.operation_id, input.decision === "approve" ? "approved" : "denied", input.decidedAt],
      );
      await client.query(
        `INSERT INTO governed_operation_events (operation_id,tenant_id,event_type,correlation_id,safe_detail)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [row.operation_id, input.identity.tenantId, input.decision === "approve" ? "approved" : "denied",
          input.correlationId, JSON.stringify({ channel: "openvtc-task-consent", decisionHash: input.decisionHash })],
      );
      await client.query("COMMIT");
      return this.getOwnedOperation(input.identity, String(row.operation_id));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async remove(identity: IdentityContext, workspaceId: string) {
    const result = await this.pool.query(
      "DELETE FROM workspaces WHERE id=$1 AND tenant_id=$2 AND subject_id=$3",
      [workspaceId, identity.tenantId, identity.subjectId],
    );
    return Boolean(result.rowCount);
  }
}

export class MemoryWorkspaceStore implements WorkspaceStore, GovernanceStore, OpenVtcApprovalStore, ChannelStore, ActivityStore {
  private records = new Map<string, WorkspaceRecord>();
  private channelConnections = new Map<string, ChannelConnectionRecord>();
  private channelCredentials = new Map<string, ChannelCredentialRecord>();
  private channelUpdates = new Map<string, {
    senderId: string;
    state: "reserved" | "dispatched" | "delivered" | "rejected" | "failed";
    response?: Omit<ChannelPendingResponse, "connectionId" | "updateId" | "senderId">;
  }>();
  private channelRoutes = new Map<string, ChatAgentCatalogId>();
  private channelSessions = new Map<string, string>();
  private operations = new Map<string, GovernedOperationRecord>();
  private operationKeys = new Map<string, string>();
  private openVtcApprovers = new Map<string, { record: OpenVtcApproverRecord; transportTokenHash: string }>();
  private openVtcTasks = new Map<string, OpenVtcConsentTaskRecord>();
  private openVtcTaskByOperationApprover = new Map<string, string>();
  private openVtcDeliveryAttempts = new Map<string, number>();
  private openVtcEnrollmentChallenges = new Map<string, OpenVtcEnrollmentChallengeRecord>();
  private openVtcCompanionSubscriptions = new Map<string, OpenVtcCompanionSubscriptionRecord>();
  private openVtcCompanionPushDeliveries = new Map<string, {
    taskId: string;
    subscriptionId: string;
    state: "queued" | "delivered" | "retry" | "failed";
    attemptCount: number;
    availableAt: Date;
  }>();
  private activityEvents: Array<{
    tenantId: string;
    subjectId: string;
    workspaceId: string;
    agentCatalogId: ChatAgentCatalogId;
    sessionId: string;
    turnId: string;
    dedupeKey: string;
    event: ActivityEventV1;
  }> = [];

  async appendActivityEvent(input: AppendActivityEventInput) {
    if (!await this.getOwned(input.identity, input.workspaceId)) return null;
    const matchesScope = (record: typeof this.activityEvents[number]) => (
      record.tenantId === input.identity.tenantId
      && record.subjectId === input.identity.subjectId
      && record.workspaceId === input.workspaceId
      && record.agentCatalogId === input.agentCatalogId
      && record.sessionId === input.sessionId
      && record.turnId === input.turnId
    );
    const existing = this.activityEvents.find((record) => matchesScope(record) && record.dedupeKey === input.dedupeKey);
    if (existing) return existing.event;
    const scoped = this.activityEvents.filter(matchesScope);
    const sequence = scoped.length ? Math.max(...scoped.map((record) => record.event.sequence)) + 1 : 0;
    if (input.draft.turnId !== input.turnId) throw new Error("Activity event turn scope does not match its draft");
    const { turnId: _draftTurnId, ...draft } = input.draft;
    const event = activityEventSchema.parse({
      version: 1,
      eventId: randomUUID(),
      turnId: input.turnId,
      sequence,
      timestamp: input.occurredAt.toISOString(),
      ...draft,
    });
    this.activityEvents.push({
      tenantId: input.identity.tenantId,
      subjectId: input.identity.subjectId,
      workspaceId: input.workspaceId,
      agentCatalogId: input.agentCatalogId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      dedupeKey: input.dedupeKey,
      event,
    });
    return event;
  }

  async replayActivityEvents(
    identity: IdentityContext,
    scope: ActivityEventScope,
    afterSequence: number,
    limit: number,
  ) {
    const scoped = this.activityEvents.filter((record) => (
      record.tenantId === identity.tenantId
      && record.subjectId === identity.subjectId
      && record.workspaceId === scope.workspaceId
      && record.agentCatalogId === scope.agentCatalogId
      && record.sessionId === scope.sessionId
      && record.turnId === scope.turnId
    ));
    return {
      found: scoped.length > 0,
      events: scoped
        .map((record) => record.event)
        .filter((event) => event.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, Math.min(500, Math.max(1, limit))),
      terminalSequence: scoped.find((record) => record.event.kind === "terminal")?.event.sequence ?? null,
    };
  }

  async getCurrent(identity: IdentityContext, grantId: string) {
    return [...this.records.values()].find((item) => item.tenantId === identity.tenantId && item.subjectId === identity.subjectId && item.grantId === grantId) ?? null;
  }
  async listCurrent(identity: IdentityContext) {
    return [...this.records.values()]
      .filter((item) => item.tenantId === identity.tenantId && item.subjectId === identity.subjectId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }
  async getOwned(identity: IdentityContext, workspaceId: string) {
    const item = this.records.get(workspaceId);
    return item?.tenantId === identity.tenantId && item.subjectId === identity.subjectId ? item : null;
  }
  async createOrGet(identity: IdentityContext, grantId: string, _key: string) {
    const existing = [...this.records.values()].find((item) => item.tenantId === identity.tenantId && item.subjectId === identity.subjectId && item.grantId === grantId);
    if (existing) return existing;
    const now = new Date();
    const record: WorkspaceRecord = { id: randomUUID(), ...identity, grantId, state: "not_created", providerId: null, failureCode: null, operationToken: null, createdAt: now, updatedAt: now };
    this.records.set(record.id, record);
    return record;
  }
  async claim(workspaceId: string, allowed: WorkspaceState[], next: WorkspaceState) {
    const record = this.records.get(workspaceId);
    if (!record || !allowed.includes(record.state)) return null;
    const claimed = { ...record, state: next, operationToken: randomUUID(), updatedAt: new Date() };
    this.records.set(workspaceId, claimed);
    return claimed;
  }
  async finish(workspaceId: string, token: string, patch: Partial<Pick<WorkspaceRecord, "state" | "providerId" | "failureCode">>) {
    const record = this.records.get(workspaceId);
    if (!record || record.operationToken !== token) throw new Error("Workspace operation ownership was lost");
    return this.save(record, { ...patch, operationToken: null });
  }
  async update(workspaceId: string, patch: Partial<Pick<WorkspaceRecord, "state" | "providerId" | "failureCode">>) {
    const record = this.records.get(workspaceId);
    if (!record) throw new Error("Workspace not found");
    return this.save(record, patch);
  }
  async remove(identity: IdentityContext, workspaceId: string) {
    if (!await this.getOwned(identity, workspaceId)) return false;
    for (const [operationId, operation] of this.operations) {
      if (operation.workspaceId === workspaceId) this.operations.delete(operationId);
    }
    this.activityEvents = this.activityEvents.filter((event) => event.workspaceId !== workspaceId);
    return this.records.delete(workspaceId);
  }

  async listOwnedChannelCredentials(identity: IdentityContext) {
    return [...this.channelCredentials.values()]
      .filter((record) => record.tenantId === identity.tenantId && record.subjectId === identity.subjectId)
      .map((record) => {
        const connection = [...this.channelConnections.values()].find((item) => item.credentialId === record.id);
        return { ...record, workspaceId: connection?.workspaceId ?? null, connectionId: connection?.id ?? null };
      });
  }

  async getOwnedChannelCredential(identity: IdentityContext, credentialId: string) {
    const record = this.channelCredentials.get(credentialId);
    return record?.tenantId === identity.tenantId && record.subjectId === identity.subjectId ? record : null;
  }

  async saveChannelCredential(identity: IdentityContext, input: Omit<ChannelCredentialRecord, "tenantId" | "subjectId" | "createdAt" | "updatedAt">) {
    const prior = this.channelCredentials.get(input.id);
    if (prior && (prior.tenantId !== identity.tenantId || prior.subjectId !== identity.subjectId || prior.kind !== input.kind)) {
      throw new Error("Credential is missing or belongs to another user");
    }
    const duplicate = [...this.channelCredentials.values()].find((record) => record.id !== input.id && record.fingerprint === input.fingerprint);
    if (duplicate) throw new Error("Credential is already stored");
    const now = new Date();
    const record: ChannelCredentialRecord = {
      ...input,
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    this.channelCredentials.set(input.id, record);
    for (const [key, connection] of this.channelConnections) {
      if (connection.credentialId === record.id) {
        this.channelConnections.set(key, {
          ...connection,
          credentialCiphertext: record.credentialCiphertext,
          credentialKeyVersion: record.credentialKeyVersion,
          tokenVersion: record.version,
          botUsername: record.botUsername,
        });
      }
    }
    return record;
  }

  async deleteChannelCredential(identity: IdentityContext, credentialId: string) {
    const record = await this.getOwnedChannelCredential(identity, credentialId);
    if (!record) return false;
    this.channelCredentials.delete(credentialId);
    for (const [key, connection] of this.channelConnections) {
      if (connection.credentialId === credentialId) {
        this.channelConnections.delete(key);
        for (const update of this.channelUpdates.keys()) if (update.startsWith(`${connection.id}:`)) this.channelUpdates.delete(update);
        for (const route of this.channelRoutes.keys()) if (route.startsWith(`${connection.id}:`)) this.channelRoutes.delete(route);
        for (const session of this.channelSessions.keys()) if (session.startsWith(`${connection.id}:`)) this.channelSessions.delete(session);
      }
    }
    return true;
  }

  async getOwnedChannelConnection(identity: IdentityContext, adapter: "telegram", workspaceId: string) {
    return this.channelConnections.get(`${identity.tenantId}:${identity.subjectId}:${workspaceId}:${adapter}`) ?? null;
  }

  async saveChannelConnection(identity: IdentityContext, input: {
    id: string;
    workspaceId: string;
    adapter: "telegram";
    credentialId: string;
    allowedUserIds: string[];
    defaultAgentId: ChatAgentCatalogId;
    allowAgentSwitch: boolean;
    telegramUpdateOffset: string;
  }) {
    const workspace = await this.getOwned(identity, input.workspaceId);
    if (!workspace) throw new Error("Channel workspace is missing or belongs to another user");
    const credential = await this.getOwnedChannelCredential(identity, input.credentialId);
    if (!credential) throw new Error("Channel credential is missing or belongs to another user");
    const inUse = [...this.channelConnections.values()].find((record) => (
      record.credentialId === credential.id && record.workspaceId !== input.workspaceId
    ));
    if (inUse) throw new Error("Channel credential is already attached");
    const key = `${identity.tenantId}:${identity.subjectId}:${input.workspaceId}:${input.adapter}`;
    const prior = this.channelConnections.get(key);
    const now = new Date();
    const record: ChannelConnectionRecord = {
      ...input,
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      credentialCiphertext: credential.credentialCiphertext,
      credentialKeyVersion: credential.credentialKeyVersion,
      tokenVersion: credential.version,
      botUsername: credential.botUsername,
      state: "active",
      telegramUpdateOffset: input.telegramUpdateOffset,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    this.channelConnections.set(key, record);
    return record;
  }

  async deleteChannelConnection(identity: IdentityContext, adapter: "telegram", workspaceId: string) {
    const key = `${identity.tenantId}:${identity.subjectId}:${workspaceId}:${adapter}`;
    const record = this.channelConnections.get(key);
    if (!record) return false;
    this.channelConnections.delete(key);
    for (const update of this.channelUpdates.keys()) if (update.startsWith(`${record.id}:`)) this.channelUpdates.delete(update);
    for (const route of this.channelRoutes.keys()) if (route.startsWith(`${record.id}:`)) this.channelRoutes.delete(route);
    for (const session of this.channelSessions.keys()) if (session.startsWith(`${record.id}:`)) this.channelSessions.delete(session);
    return true;
  }

  async listActiveChannelConnections(adapter: "telegram") {
    return [...this.channelConnections.values()].filter((record) => record.adapter === adapter);
  }

  async reserveChannelUpdate(connectionId: string, updateId: string, _senderId: string) {
    const key = `${connectionId}:${updateId}`;
    if (this.channelUpdates.has(key)) return false;
    this.channelUpdates.set(key, { senderId: _senderId, state: "reserved" });
    return true;
  }

  async claimChannelUpdate(connectionId: string, updateId: string, senderId: string) {
    const key = `${connectionId}:${updateId}`;
    const update = this.channelUpdates.get(key);
    if (!update || update.senderId !== senderId || update.state !== "reserved") return false;
    this.channelUpdates.set(key, { ...update, state: "dispatched" });
    return true;
  }

  async finishChannelUpdate(connectionId: string, updateId: string, state: "delivered" | "rejected" | "failed", _failureCode?: string) {
    const key = `${connectionId}:${updateId}`;
    const update = this.channelUpdates.get(key);
    if (update && ["reserved", "dispatched"].includes(update.state)) this.channelUpdates.set(key, { ...update, state });
  }

  async stageChannelResponse(
    connectionId: string,
    updateId: string,
    chatId: string,
    text: string,
    agentCatalogId: ChatAgentCatalogId,
    artifacts: ChatArtifact[],
    finalState: "delivered" | "failed",
    finalFailureCode?: string,
  ) {
    const key = `${connectionId}:${updateId}`;
    const update = this.channelUpdates.get(key);
    if (!update || !["reserved", "dispatched"].includes(update.state)) return;
    this.channelUpdates.set(key, {
      ...update,
      state: "dispatched",
      response: {
        chatId,
        text,
        offset: 0,
        agentCatalogId,
        artifacts,
        artifactOffset: 0,
        finalState,
        finalFailureCode: finalFailureCode ?? null,
      },
    });
  }

  async listPendingChannelResponses(connectionId: string) {
    return [...this.channelUpdates.entries()].flatMap(([key, update]) => {
      if (!key.startsWith(`${connectionId}:`) || update.state !== "dispatched" || !update.response) return [];
      return [{
        connectionId,
        updateId: key.slice(connectionId.length + 1),
        senderId: update.senderId,
        ...update.response,
      }];
    });
  }

  async advanceChannelResponseDelivery(connectionId: string, updateId: string, offset: number) {
    const key = `${connectionId}:${updateId}`;
    const update = this.channelUpdates.get(key);
    if (update?.state !== "dispatched" || !update.response || offset < update.response.offset) return;
    const complete = offset >= [...update.response.text].length
      && update.response.artifactOffset >= update.response.artifacts.length;
    this.channelUpdates.set(key, {
      ...update,
      state: complete ? update.response.finalState : update.state,
      response: { ...update.response, offset },
    });
  }

  async advanceChannelArtifactDelivery(connectionId: string, updateId: string, offset: number) {
    const key = `${connectionId}:${updateId}`;
    const update = this.channelUpdates.get(key);
    if (update?.state !== "dispatched" || !update.response
      || offset < update.response.artifactOffset || offset > update.response.artifacts.length) return;
    const complete = offset >= update.response.artifacts.length
      && update.response.offset >= [...update.response.text].length;
    this.channelUpdates.set(key, {
      ...update,
      state: complete ? update.response.finalState : update.state,
      response: { ...update.response, artifactOffset: offset },
    });
  }

  async advanceTelegramUpdateOffset(connectionId: string, offset: string) {
    for (const [key, record] of this.channelConnections) {
      if (record.id === connectionId && BigInt(offset) > BigInt(record.telegramUpdateOffset)) {
        this.channelConnections.set(key, { ...record, telegramUpdateOffset: offset });
      }
    }
  }

  async getChannelSenderAgent(connectionId: string, senderId: string) {
    return this.channelRoutes.get(`${connectionId}:${senderId}`) ?? null;
  }

  async setChannelSenderAgent(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId) {
    this.channelRoutes.set(`${connectionId}:${senderId}`, agentCatalogId);
  }

  async getChannelSession(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId) {
    return this.channelSessions.get(`${connectionId}:${senderId}:${agentCatalogId}`) ?? null;
  }

  async saveChannelSession(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId, sessionId: string) {
    this.channelSessions.set(`${connectionId}:${senderId}:${agentCatalogId}`, sessionId);
  }

  async clearChannelSession(connectionId: string, senderId: string, agentCatalogId: ChatAgentCatalogId) {
    this.channelSessions.delete(`${connectionId}:${senderId}:${agentCatalogId}`);
  }

  async createGovernedOperation(input: CreateGovernedOperationRecord) {
    if (!await this.getOwned(input.identity, input.workspaceId)) return null;
    const key = `${input.identity.tenantId}:${input.identity.subjectId}:${input.idempotencyKey}`;
    const existingId = this.operationKeys.get(key);
    if (existingId) {
      const existing = this.operations.get(existingId) ?? null;
      if (!input.replaceTerminal || !existing || !["denied", "failed", "expired"].includes(existing.state)) return existing;
      this.operationKeys.delete(key);
      this.operationKeys.set(`${key}:terminal:${existingId}`, existingId);
    }
    const record: GovernedOperationRecord = {
      id: input.id,
      tenantId: input.identity.tenantId,
      subjectId: input.identity.subjectId,
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? null,
      policyVersionId: input.policyVersionId ?? null,
      policyHash: input.policyHash ?? null,
      capabilityId: input.capabilityId,
      serverName: input.serverName,
      toolName: input.toolName,
      schemaId: input.schemaId,
      arguments: input.arguments,
      operationDigest: input.operationDigest,
      nonce: input.nonce,
      state: "approval_required",
      policyDecision: "approval_required",
      safeSummary: input.safeSummary,
      resourceName: input.resourceName,
      resourceLocation: input.resourceLocation,
      correlationId: input.correlationId,
      leaseId: null,
      leaseExpiresAt: null,
      dispatchStartedAt: null,
      failureCode: null,
      failureSummary: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      expiresAt: input.expiresAt,
      approval: null,
      receipt: null,
    };
    this.operations.set(record.id, record);
    this.operationKeys.set(key, record.id);
    return record;
  }

  async getOwnedOperation(identity: IdentityContext, operationId: string) {
    const record = this.operations.get(operationId);
    return record?.tenantId === identity.tenantId && record.subjectId === identity.subjectId ? record : null;
  }

  async getRecentOperation(identity: IdentityContext) {
    return [...this.operations.values()]
      .filter((item) => item.tenantId === identity.tenantId && item.subjectId === identity.subjectId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))[0] ?? null;
  }

  async listOwnedOperations(identity: IdentityContext, limit: number) {
    return this.listOwnedOperationsPage(identity, { limit });
  }

  async listOwnedOperationsPage(identity: IdentityContext, input: {
    limit: number;
    before?: { createdAt: Date; id: string };
  }) {
    return [...this.operations.values()]
      .filter((item) => item.tenantId === identity.tenantId && item.subjectId === identity.subjectId)
      .filter((item) => !input.before
        || item.createdAt.getTime() < input.before.createdAt.getTime()
        || (item.createdAt.getTime() === input.before.createdAt.getTime() && item.id < input.before.id))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
      .slice(0, input.limit);
  }

  async recordApproval(input: ApprovalRecordInput) {
    const record = this.operations.get(input.operationId);
    if (!record || record.tenantId !== input.identity.tenantId || record.subjectId !== input.identity.subjectId) return null;
    if (record.state !== "approval_required") return record;
    if (record.operationDigest !== input.operationDigest || record.nonce !== input.nonce || record.expiresAt <= input.decidedAt) return record;
    const next: GovernedOperationRecord = {
      ...record,
      state: input.decision === "approve" ? "approved" : "denied",
      updatedAt: input.decidedAt,
      approval: { decision: input.decision, channel: input.channel, decidedAt: input.decidedAt },
    };
    this.operations.set(record.id, next);
    return next;
  }

  async claimExecution(identity: IdentityContext, operationId: string, leaseId: string, leaseExpiresAt: Date, _correlationId: string) {
    const record = this.operations.get(operationId);
    if (!record || record.tenantId !== identity.tenantId || record.subjectId !== identity.subjectId) return null;
    if (record.state !== "approved" || record.expiresAt <= new Date()) return record;
    const next: GovernedOperationRecord = { ...record, state: "executing", leaseId, leaseExpiresAt, updatedAt: new Date() };
    this.operations.set(record.id, next);
    return next;
  }

  async claimToolDispatch(identity: IdentityContext, input: {
    operationId: string; operationDigest: string; leaseId: string; workspaceId: string; agentId: string; serverName: string;
    toolName: string; arguments: OwnedJson; dispatchedAt: Date; correlationId: string;
  }) {
    const record = this.operations.get(input.operationId);
    if (!record || record.tenantId !== identity.tenantId || record.subjectId !== identity.subjectId) return false;
    const matches = record.state === "executing"
      && record.workspaceId === input.workspaceId
      && record.agentId === input.agentId
      && record.operationDigest === input.operationDigest
      && record.leaseId === input.leaseId
      && record.leaseExpiresAt !== null
      && record.leaseExpiresAt > input.dispatchedAt
      && record.serverName === input.serverName
      && record.toolName === input.toolName
      && JSON.stringify(record.arguments) === JSON.stringify(input.arguments)
      && record.dispatchStartedAt === null;
    if (!matches) return false;
    this.operations.set(record.id, { ...record, dispatchStartedAt: input.dispatchedAt, updatedAt: input.dispatchedAt });
    return true;
  }

  async completeExecution(identity: IdentityContext, operationId: string, leaseId: string, receipt: { id: string; upstreamReference: string; resultSummary: string; resultHash: string; executedAt: Date }, _correlationId: string) {
    const record = this.operations.get(operationId);
    if (!record || record.tenantId !== identity.tenantId || record.subjectId !== identity.subjectId) return null;
    if (record.state !== "executing" || record.leaseId !== leaseId) return record;
    const next: GovernedOperationRecord = {
      ...record,
      state: "succeeded",
      updatedAt: receipt.executedAt,
      receipt: { status: "succeeded", upstreamReference: receipt.upstreamReference, resultSummary: receipt.resultSummary, executedAt: receipt.executedAt },
    };
    this.operations.set(record.id, next);
    return next;
  }

  async failExecution(identity: IdentityContext, operationId: string, leaseId: string, failureCode: string, _correlationId: string, failureSummary?: string) {
    const record = this.operations.get(operationId);
    if (!record || record.tenantId !== identity.tenantId || record.subjectId !== identity.subjectId) return null;
    if (record.state !== "executing" || record.leaseId !== leaseId) return record;
    const next: GovernedOperationRecord = {
      ...record,
      state: "failed",
      failureCode,
      failureSummary: failureSummary?.slice(0, 240) ?? null,
      updatedAt: new Date(),
    };
    this.operations.set(record.id, next);
    return next;
  }

  async recoverOperation(identity: IdentityContext, operationId: string, now: Date, _correlationId: string) {
    const record = this.operations.get(operationId);
    if (!record || record.tenantId !== identity.tenantId || record.subjectId !== identity.subjectId) return null;
    const operationExpired = ["approval_required", "approved"].includes(record.state) && record.expiresAt <= now;
    const leaseExpired = record.state === "executing" && record.leaseExpiresAt !== null && record.leaseExpiresAt <= now;
    if (!operationExpired && !leaseExpired) return record;
    const next: GovernedOperationRecord = {
      ...record,
      state: leaseExpired ? "failed" : "expired",
      failureCode: leaseExpired ? "EXECUTION_LEASE_EXPIRED" : record.failureCode,
      updatedAt: now,
    };
    this.operations.set(record.id, next);
    return next;
  }

  async createOpenVtcEnrollmentChallenge(input: Omit<OpenVtcEnrollmentChallengeRecord, "tenantId" | "subjectId" | "consumedAt"> & { identity: IdentityContext }) {
    const record: OpenVtcEnrollmentChallengeRecord = {
      id: input.id,
      tenantId: input.identity.tenantId,
      subjectId: input.identity.subjectId,
      executorDid: input.executorDid,
      challenge: input.challenge,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
    };
    this.openVtcEnrollmentChallenges.set(record.id, record);
    return record;
  }

  async getOpenVtcEnrollmentChallenge(identity: IdentityContext, challengeId: string) {
    const record = this.openVtcEnrollmentChallenges.get(challengeId);
    return record?.tenantId === identity.tenantId && record.subjectId === identity.subjectId ? record : null;
  }

  async consumeOpenVtcEnrollmentChallenge(identity: IdentityContext, challengeId: string, challenge: string, consumedAt: Date) {
    const record = this.openVtcEnrollmentChallenges.get(challengeId);
    if (!record || record.tenantId !== identity.tenantId || record.subjectId !== identity.subjectId
      || record.challenge !== challenge || record.consumedAt !== null || record.expiresAt <= consumedAt) return false;
    this.openVtcEnrollmentChallenges.set(record.id, { ...record, consumedAt });
    return true;
  }

  async enrollOpenVtcApprover(input: {
    id: string; identity: IdentityContext; approverDid: string; verificationMethod: string; displayName: string;
    transportTokenHash: string; enrolledAt: Date;
  }) {
    const prior = [...this.openVtcApprovers.values()].find((stored) => stored.record.tenantId === input.identity.tenantId
      && stored.record.subjectId === input.identity.subjectId && stored.record.approverDid === input.approverDid);
    const record: OpenVtcApproverRecord = {
      id: prior?.record.id ?? input.id,
      tenantId: input.identity.tenantId,
      subjectId: input.identity.subjectId,
      approverDid: input.approverDid,
      verificationMethod: input.verificationMethod,
      displayName: input.displayName,
      status: "active",
      enrolledAt: input.enrolledAt,
      revokedAt: null,
    };
    this.openVtcApprovers.set(record.id, { record, transportTokenHash: input.transportTokenHash });
    return record;
  }

  async getActiveOpenVtcApprover(identity: IdentityContext) {
    return [...this.openVtcApprovers.values()].map((stored) => stored.record)
      .filter((record) => record.tenantId === identity.tenantId && record.subjectId === identity.subjectId && record.status === "active")
      .sort((left, right) => right.enrolledAt.getTime() - left.enrolledAt.getTime())[0] ?? null;
  }

  async listActiveOpenVtcApprovers(identity: IdentityContext) {
    return [...this.openVtcApprovers.values()].map((stored) => stored.record)
      .filter((record) => record.tenantId === identity.tenantId && record.subjectId === identity.subjectId && record.status === "active")
      .sort((left, right) => right.enrolledAt.getTime() - left.enrolledAt.getTime());
  }

  async getActiveOpenVtcApproverByDid(identity: IdentityContext, approverDid: string) {
    return [...this.openVtcApprovers.values()].map((stored) => stored.record)
      .find((record) => record.tenantId === identity.tenantId && record.subjectId === identity.subjectId
        && record.approverDid === approverDid && record.status === "active") ?? null;
  }

  async getOpenVtcApproverByTransportTokenHash(tokenHash: string) {
    const stored = [...this.openVtcApprovers.values()].find((candidate) => candidate.transportTokenHash === tokenHash && candidate.record.status === "active");
    return stored?.record ?? null;
  }

  async revokeOpenVtcApprover(identity: IdentityContext, approverId: string, revokedAt: Date) {
    const stored = this.openVtcApprovers.get(approverId);
    if (!stored || stored.record.tenantId !== identity.tenantId || stored.record.subjectId !== identity.subjectId || stored.record.status !== "active") return false;
    this.openVtcApprovers.set(approverId, { ...stored, record: { ...stored.record, status: "revoked", revokedAt } });
    return true;
  }

  async createOpenVtcConsentTask(input: CreateOpenVtcConsentTaskInput) {
    const operationApproverKey = `${input.operationId}:${input.approverId}`;
    const existingId = this.openVtcTaskByOperationApprover.get(operationApproverKey);
    const existing = existingId ? this.openVtcTasks.get(existingId) ?? null : null;
    if (existing) return existing;
    const operation = await this.getOwnedOperation(input.identity, input.operationId);
    const racedExistingId = this.openVtcTaskByOperationApprover.get(operationApproverKey);
    const racedExisting = racedExistingId ? this.openVtcTasks.get(racedExistingId) ?? null : null;
    if (racedExisting) return racedExisting;
    const approver = this.openVtcApprovers.get(input.approverId)?.record;
    if (!operation || operation.state !== "approval_required" || operation.expiresAt <= input.createdAt
      || !approver || approver.status !== "active" || approver.tenantId !== input.identity.tenantId || approver.subjectId !== input.identity.subjectId) return null;
    const task: OpenVtcConsentTaskRecord = {
      id: input.id,
      operationId: input.operationId,
      tenantId: input.identity.tenantId,
      subjectId: input.identity.subjectId,
      approverId: input.approverId,
      executorDid: input.executorDid,
      challenge: input.challenge,
      taskType: input.taskType,
      payloadDigest: input.payloadDigest,
      requestDocument: input.requestDocument,
      requestHash: input.requestHash,
      requestProofHash: input.requestProofHash,
      state: "queued",
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      deliveredAt: null,
      decidedAt: null,
      decisionDocument: null,
      decisionHash: null,
      proofHash: null,
    };
    this.openVtcTasks.set(task.id, task);
    this.openVtcTaskByOperationApprover.set(operationApproverKey, task.id);
    this.openVtcDeliveryAttempts.set(task.id, 0);
    return task;
  }

  async getOpenVtcConsentTask(identity: IdentityContext, operationId: string) {
    return [...this.openVtcTasks.values()]
      .filter((task) => task.operationId === operationId && task.tenantId === identity.tenantId && task.subjectId === identity.subjectId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  async getOpenVtcConsentTaskForApprover(identity: IdentityContext, operationId: string, approverId: string) {
    const taskId = this.openVtcTaskByOperationApprover.get(`${operationId}:${approverId}`);
    const task = taskId ? this.openVtcTasks.get(taskId) : null;
    return task?.tenantId === identity.tenantId && task.subjectId === identity.subjectId ? task : null;
  }

  async getOpenVtcConsentTaskByPayloadDigest(approverId: string, payloadDigest: string) {
    return [...this.openVtcTasks.values()].find((task) => task.approverId === approverId && task.payloadDigest === payloadDigest) ?? null;
  }

  async deliverNextOpenVtcConsentTask(approverId: string, deliveredAt: Date) {
    const approver = this.openVtcApprovers.get(approverId)?.record;
    if (!approver || approver.status !== "active") return null;
    const candidates = [...this.openVtcTasks.values()]
      .filter((task) => task.approverId === approverId && ["queued", "delivered"].includes(task.state))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    for (const task of candidates) {
      if (task.expiresAt <= deliveredAt) {
        this.openVtcTasks.set(task.id, { ...task, state: "expired" });
        continue;
      }
      const delivered: OpenVtcConsentTaskRecord = { ...task, state: "delivered", deliveredAt: task.deliveredAt ?? deliveredAt };
      this.openVtcTasks.set(task.id, delivered);
      this.openVtcDeliveryAttempts.set(task.id, (this.openVtcDeliveryAttempts.get(task.id) ?? 0) + 1);
      return delivered;
    }
    return null;
  }

  async upsertOpenVtcCompanionSubscription(input: Omit<OpenVtcCompanionSubscriptionRecord,
    "tenantId" | "subjectId" | "status" | "createdAt" | "updatedAt" | "revokedAt" | "lastSuccessfulDeliveryAt" | "lastFailureCode"
  > & { identity: IdentityContext; savedAt: Date }) {
    const approver = this.openVtcApprovers.get(input.approverId)?.record;
    if (!approver || approver.status !== "active" || approver.tenantId !== input.identity.tenantId || approver.subjectId !== input.identity.subjectId) {
      throw new Error("The companion approver is missing, revoked, or belongs to another user");
    }
    const prior = [...this.openVtcCompanionSubscriptions.values()].find((item) => item.approverId === input.approverId);
    const record: OpenVtcCompanionSubscriptionRecord = {
      id: prior?.id ?? input.id,
      tenantId: input.identity.tenantId,
      subjectId: input.identity.subjectId,
      approverId: input.approverId,
      installationId: input.installationId,
      protocolVersion: input.protocolVersion,
      browserFamily: input.browserFamily,
      platform: input.platform,
      endpointHash: input.endpointHash,
      subscriptionCiphertext: input.subscriptionCiphertext,
      status: "active",
      createdAt: prior?.createdAt ?? input.savedAt,
      updatedAt: input.savedAt,
      revokedAt: null,
      lastSuccessfulDeliveryAt: prior?.lastSuccessfulDeliveryAt ?? null,
      lastFailureCode: null,
    };
    this.openVtcCompanionSubscriptions.set(record.id, record);
    return record;
  }

  async listOpenVtcCompanionSubscriptions(identity: IdentityContext) {
    return [...this.openVtcCompanionSubscriptions.values()]
      .filter((item) => item.tenantId === identity.tenantId && item.subjectId === identity.subjectId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async getOpenVtcCompanionSubscriptionForApprover(approverId: string) {
    return [...this.openVtcCompanionSubscriptions.values()]
      .find((item) => item.approverId === approverId && item.status === "active") ?? null;
  }

  async revokeOpenVtcCompanionSubscription(identity: IdentityContext, subscriptionId: string, revokedAt: Date) {
    const record = this.openVtcCompanionSubscriptions.get(subscriptionId);
    if (!record || record.tenantId !== identity.tenantId || record.subjectId !== identity.subjectId || record.status === "revoked") return false;
    this.openVtcCompanionSubscriptions.set(record.id, { ...record, status: "revoked", revokedAt, updatedAt: revokedAt });
    return true;
  }

  async enqueueOpenVtcCompanionPushDelivery(input: { id: string; taskId: string; subscriptionId: string; queuedAt: Date }) {
    const key = `${input.taskId}:${input.subscriptionId}`;
    if (this.openVtcCompanionPushDeliveries.has(key)) return false;
    this.openVtcCompanionPushDeliveries.set(key, {
      taskId: input.taskId,
      subscriptionId: input.subscriptionId,
      state: "queued",
      attemptCount: 0,
      availableAt: input.queuedAt,
    });
    return true;
  }

  async claimOpenVtcCompanionPushDelivery(input: { taskId: string; subscriptionId: string; claimedAt: Date }) {
    const key = `${input.taskId}:${input.subscriptionId}`;
    const prior = this.openVtcCompanionPushDeliveries.get(key);
    if (!prior || !(
      prior.state === "retry" && prior.availableAt <= input.claimedAt
      || prior.state === "queued" && prior.attemptCount === 0 && prior.availableAt <= input.claimedAt
      || prior.state === "queued" && prior.attemptCount > 0
        && prior.availableAt <= new Date(input.claimedAt.getTime() - 30_000)
    )) return false;
    this.openVtcCompanionPushDeliveries.set(key, {
      taskId: input.taskId,
      subscriptionId: input.subscriptionId,
      state: "queued",
      attemptCount: prior.attemptCount + 1,
      availableAt: input.claimedAt,
    });
    return true;
  }

  async listDueOpenVtcCompanionPushDeliveries(now: Date, limit: number) {
    return [...this.openVtcCompanionPushDeliveries.values()]
      .filter((delivery) => delivery.state === "retry" && delivery.availableAt <= now
        || delivery.state === "queued" && delivery.attemptCount === 0 && delivery.availableAt <= now
        || delivery.state === "queued" && delivery.attemptCount > 0
          && delivery.availableAt <= new Date(now.getTime() - 30_000))
      .slice(0, limit)
      .flatMap((delivery) => {
        const subscription = this.openVtcCompanionSubscriptions.get(delivery.subscriptionId);
        const task = this.openVtcTasks.get(delivery.taskId);
        const operation = task ? this.operations.get(task.operationId) : null;
        return subscription?.status === "active" && task && ["queued", "delivered"].includes(task.state)
          && operation?.state === "approval_required" && operation.expiresAt > now
          ? [{ taskId: delivery.taskId, subscriptionId: delivery.subscriptionId, subscriptionCiphertext: subscription.subscriptionCiphertext }]
          : [];
      });
  }

  async recordOpenVtcCompanionPushDelivery(input: {
    taskId: string;
    subscriptionId: string;
    delivered: boolean;
    terminal: boolean;
    failureCode?: string;
    attemptedAt: Date;
  }) {
    const key = `${input.taskId}:${input.subscriptionId}`;
    const delivery = this.openVtcCompanionPushDeliveries.get(key);
    if (!delivery) return;
    this.openVtcCompanionPushDeliveries.set(key, {
      ...delivery,
      state: input.delivered ? "delivered" : input.terminal ? "failed" : "retry",
      availableAt: input.delivered || input.terminal
        ? delivery.availableAt
        : new Date(input.attemptedAt.getTime() + Math.min(60, 2 ** delivery.attemptCount) * 1_000),
    });
    const subscription = this.openVtcCompanionSubscriptions.get(input.subscriptionId);
    if (!subscription) return;
    this.openVtcCompanionSubscriptions.set(subscription.id, {
      ...subscription,
      status: input.terminal && !input.delivered ? "invalid" : subscription.status,
      updatedAt: input.attemptedAt,
      lastSuccessfulDeliveryAt: input.delivered ? input.attemptedAt : subscription.lastSuccessfulDeliveryAt,
      lastFailureCode: input.delivered ? null : input.failureCode ?? "WEB_PUSH_FAILED",
    });
  }

  async recordOpenVtcDecision(input: RecordOpenVtcDecisionInput) {
    const task = this.openVtcTasks.get(input.taskId);
    const approver = this.openVtcApprovers.get(input.approverId)?.record;
    const operation = task ? this.operations.get(task.operationId) : null;
    if (!task || !approver || !operation || task.tenantId !== input.identity.tenantId || task.subjectId !== input.identity.subjectId
      || task.approverId !== input.approverId || task.challenge !== input.challenge || task.payloadDigest !== input.payloadDigest
      || approver.status !== "active" || approver.approverDid !== input.signerDid || approver.verificationMethod !== input.verificationMethod
      || operation.state !== "approval_required" || !["queued", "delivered"].includes(task.state)
      || task.expiresAt <= input.decidedAt) return null;
    const nextTask: OpenVtcConsentTaskRecord = {
      ...task,
      state: input.decision === "approve" ? "approved" : "denied",
      decidedAt: input.decidedAt,
      decisionDocument: input.decisionDocument,
      decisionHash: input.decisionHash,
      proofHash: input.proofHash,
    };
    const nextOperation: GovernedOperationRecord = {
      ...operation,
      state: input.decision === "approve" ? "approved" : "denied",
      updatedAt: input.decidedAt,
      approval: { decision: input.decision, channel: "openvtc-task-consent", decidedAt: input.decidedAt },
    };
    this.openVtcTasks.set(task.id, nextTask);
    for (const [taskId, candidate] of this.openVtcTasks) {
      if (candidate.operationId === operation.id && taskId !== task.id && ["queued", "delivered"].includes(candidate.state)) {
        this.openVtcTasks.set(taskId, { ...candidate, state: "failed" });
      }
    }
    this.operations.set(operation.id, nextOperation);
    return nextOperation;
  }
  private save(record: WorkspaceRecord, patch: Partial<WorkspaceRecord>) {
    const next = { ...record, ...patch, updatedAt: new Date() };
    this.records.set(record.id, next);
    return next;
  }
}
