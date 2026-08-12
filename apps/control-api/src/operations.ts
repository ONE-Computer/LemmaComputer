import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  LemmaComputerError,
  canonicalJson,
  governedOperationDigest,
  ownedAgentCatalog,
  type GovernedOperationEnvelope,
  type IdentityContext,
  type OperationView,
  type OwnedJson,
} from "@lemmacomputer/contracts";
import type { GovernedToolExecutor } from "@lemmacomputer/litellm-adapter";
import type { GovernanceStore, GovernedOperationRecord, WorkspaceStore } from "@lemmacomputer/workspace-store";
import type { OpenVtcApprovalCoordinator } from "./openvtc.js";

export type FixtureApprovalEnvelope = {
  version: "1";
  issuer: "lemmacomputer-local-fixture";
  keyId: "fixture-hmac-v1";
  tenantId: string;
  subjectId: string;
  audience: "lemmacomputer-control";
  operationId: string;
  operationDigest: string;
  nonce: string;
  decision: "approve" | "deny";
  issuedAt: string;
  expiresAt: string;
};

export class FixtureApprovalAuthority {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error("Fixture approval secret must be at least 32 characters");
  }

  sign(envelope: FixtureApprovalEnvelope) {
    return createHmac("sha256", this.secret).update(canonicalJson(envelope), "utf8").digest("base64url");
  }

  verify(envelope: FixtureApprovalEnvelope, signature: string) {
    const expected = Buffer.from(this.sign(envelope));
    const received = Buffer.from(signature);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}

const actionFor = (record: GovernedOperationRecord) => (
  record.toolName === "delete-onedrive-file" || record.toolName === "delete_file"
    ? "Delete file"
    : record.safeSummary
);

const companionActionFor = (record: GovernedOperationRecord) => ({
  "create-draft-email": "Create email draft",
  "update-mail-message": "Update email",
  "delete-mail-message": "Delete email",
  "move-mail-message": "Move email",
  "send-mail": "Send email",
  "send-draft-message": "Send draft",
  "reply-mail-message": "Reply to email",
  "reply-all-mail-message": "Reply all",
  "forward-mail-message": "Forward email",
  "create-calendar-event": "Create calendar event",
  "update-calendar-event": "Update calendar event",
  "delete-calendar-event": "Delete calendar event",
  "create-onedrive-folder": "Create OneDrive folder",
  "upload-file-content": "Upload file",
  "create-upload-session": "Upload large file",
  "move-rename-onedrive-item": "Move or rename OneDrive item",
  "copy-drive-item": "Copy OneDrive item",
  "send-chat-message": "Send Teams message",
  "reply-to-chat-message": "Reply in Teams chat",
  "send-channel-message": "Post Teams channel message",
  "reply-to-channel-message": "Reply in Teams channel",
}[record.toolName] ?? actionFor(record));

const activityRequester = (record: GovernedOperationRecord) => {
  if (!record.agentId) return "LemmaComputer";
  const agent = ownedAgentCatalog.find((candidate) => (
    record.agentId === candidate.id || record.agentId?.endsWith(`:${candidate.id}`)
  ));
  return agent?.displayName ?? "Workspace agent";
};

type CompanionRequestDetail = {
  label: string;
  value: string;
  format?: "text" | "long-text";
};

type CompanionTarget = {
  label: string;
  name: string;
  context: string;
};

const ownedRecord = (value: OwnedJson | undefined) => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, OwnedJson>
    : undefined
);

const htmlToAuditText = (value: string) => value
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/p\s*>/gi, "\n\n")
  .replace(/<[^>]+>/g, "")
  .replaceAll("&nbsp;", " ")
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", "\"")
  .replaceAll("&#39;", "'")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const emailRecipients = (value: OwnedJson | undefined) => Array.isArray(value)
  ? value.flatMap((item) => {
    const address = ownedRecord(ownedRecord(item)?.emailAddress);
    if (typeof address?.address !== "string") return [];
    return [typeof address.name === "string" ? `${address.name} <${address.address}>` : address.address];
  }).join(", ")
  : "";

const messageContent = (value: OwnedJson | undefined) => {
  const item = ownedRecord(value);
  const content = typeof item?.content === "string" ? item.content : "";
  return item?.contentType === "html" ? htmlToAuditText(content) : content.trim();
};

const auditTarget = (record: GovernedOperationRecord) => {
  const context = ownedRecord(ownedRecord(record.arguments)?.lemmacomputerAudit);
  return typeof context?.target === "string" ? context.target : "";
};

const auditTargetLabel = (record: GovernedOperationRecord) => {
  const context = ownedRecord(ownedRecord(record.arguments)?.lemmacomputerAudit);
  return ({
    recipient: "To",
    chat: "Chat",
    channel: "Channel",
    file: "File",
    folder: "Folder",
    event: "Event",
    message: "Message",
    item: "Item",
    destination: "Destination",
  } as Record<string, string>)[typeof context?.targetType === "string" ? context.targetType : ""] ?? "Target";
};

const companionTarget = (record: GovernedOperationRecord): CompanionTarget => {
  const argumentsValue = ownedRecord(record.arguments);
  if (record.toolName === "send-mail") {
    const message = ownedRecord(ownedRecord(argumentsValue?.body)?.Message);
    const recipients = emailRecipients(message?.toRecipients);
    if (recipients) return { label: "To", name: recipients, context: record.resourceLocation };
  }
  return {
    label: auditTargetLabel(record),
    name: auditTarget(record) || record.resourceName,
    context: record.resourceLocation,
  };
};

const companionRequestDetails = (record: GovernedOperationRecord): CompanionRequestDetail[] => {
  const argumentsValue = ownedRecord(record.arguments);
  if (!argumentsValue) return [];

  if (["send-chat-message", "reply-to-chat-message"].includes(record.toolName)) {
    const body = ownedRecord(ownedRecord(argumentsValue.body)?.body);
    const content = messageContent(body);
    return [
      ...(content ? [{ label: record.toolName.startsWith("reply") ? "Reply" : "Message", value: content, format: "long-text" as const }] : []),
    ];
  }

  if (["send-channel-message", "reply-to-channel-message"].includes(record.toolName)) {
    const body = ownedRecord(ownedRecord(argumentsValue.body)?.body);
    const content = messageContent(body);
    return [
      ...(content ? [{ label: record.toolName.startsWith("reply") ? "Reply" : "Message", value: content, format: "long-text" as const }] : []),
    ];
  }

  if (["send-mail", "create-draft-email", "update-mail-message"].includes(record.toolName)) {
    const supplied = ownedRecord(argumentsValue.body);
    const message = record.toolName === "send-mail" ? ownedRecord(supplied?.Message) : supplied;
    const body = ownedRecord(message?.body);
    const cc = emailRecipients(message?.ccRecipients);
    const bcc = emailRecipients(message?.bccRecipients);
    const content = messageContent(body);
    return [
      ...(cc ? [{ label: "Cc", value: cc }] : []),
      ...(bcc ? [{ label: "Bcc", value: bcc }] : []),
      ...(typeof message?.subject === "string" ? [{ label: "Subject", value: message.subject }] : []),
      ...(content ? [{ label: "Message", value: content, format: "long-text" as const }] : []),
    ];
  }

  if (["reply-mail-message", "reply-all-mail-message"].includes(record.toolName)) {
    const comment = ownedRecord(argumentsValue.body)?.Comment;
    return typeof comment === "string"
      ? [{ label: "Message", value: comment, format: "long-text" }]
      : [];
  }

  if (record.toolName === "forward-mail-message") {
    const body = ownedRecord(argumentsValue.body);
    const recipients = emailRecipients(body?.ToRecipients);
    return [
      ...(recipients ? [{ label: "To", value: recipients }] : []),
      ...(typeof body?.Comment === "string" ? [{ label: "Message", value: body.Comment, format: "long-text" as const }] : []),
    ];
  }

  if (["create-calendar-event", "update-calendar-event"].includes(record.toolName)) {
    const event = ownedRecord(argumentsValue.body);
    const start = ownedRecord(event?.start);
    const end = ownedRecord(event?.end);
    const attendees = Array.isArray(event?.attendees)
      ? emailRecipients(event.attendees)
      : "";
    return [
      ...(typeof event?.subject === "string" ? [{ label: "Event", value: event.subject }] : []),
      ...(typeof start?.dateTime === "string" ? [{ label: "Starts", value: `${start.dateTime}${typeof start.timeZone === "string" ? ` · ${start.timeZone}` : ""}` }] : []),
      ...(typeof end?.dateTime === "string" ? [{ label: "Ends", value: `${end.dateTime}${typeof end.timeZone === "string" ? ` · ${end.timeZone}` : ""}` }] : []),
      ...(attendees ? [{ label: "Attendees", value: attendees }] : []),
    ];
  }

  if (["create-onedrive-folder", "move-rename-onedrive-item", "copy-drive-item"].includes(record.toolName)) {
    const body = ownedRecord(argumentsValue.body);
    return typeof body?.name === "string" ? [{ label: "Name", value: body.name }] : [];
  }

  return [];
};

const toView = (record: GovernedOperationRecord): OperationView => ({
  id: record.id,
  workspaceId: record.workspaceId,
  agentId: record.agentId,
  agentInstanceId: record.agentInstanceId,
  policyVersionId: record.policyVersionId,
  policyHash: record.policyHash,
  serverName: record.serverName,
  toolName: record.toolName,
  state: record.state,
  action: actionFor(record),
  resourceName: record.resourceName,
  resourceLocation: record.resourceLocation,
  safeSummary: record.safeSummary,
  operationDigest: record.operationDigest,
  requestedAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  expiresAt: record.expiresAt.toISOString(),
  requiredApprovalChannel: record.serverName === "lemmacomputer_fixture"
    && record.toolName === "delete_file"
    && record.schemaId === "lemmacomputer.fixture.delete_file.v1"
    ? "local-fixture"
    : "openvtc-task-consent",
  approval: record.approval ? {
    decision: record.approval.decision,
    channel: record.approval.channel,
    decidedAt: record.approval.decidedAt.toISOString(),
  } : null,
  receipt: record.receipt ? {
    status: "succeeded",
    resultSummary: record.receipt.resultSummary,
    executedAt: record.receipt.executedAt.toISOString(),
  } : null,
  failureCode: record.failureCode,
  failureSummary: record.failureSummary,
});

const toCompanionActivity = (record: GovernedOperationRecord, includeRequestDetails = false) => ({
  id: record.id,
  state: record.state,
  request: {
    action: companionActionFor(record),
    summary: record.safeSummary,
    target: companionTarget(record),
    details: includeRequestDetails ? companionRequestDetails(record) : [],
  },
  audit: {
    requestedBy: activityRequester(record),
    requestedAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    decision: record.approval ? {
      value: record.approval.decision,
      decidedAt: record.approval.decidedAt.toISOString(),
    } : null,
    outcome: record.receipt ? {
      status: "succeeded" as const,
      completedAt: record.receipt.executedAt.toISOString(),
    } : record.state === "failed" ? {
      status: "failed" as const,
      completedAt: record.updatedAt.toISOString(),
    } : null,
  },
});

type CompanionActivityCursor = {
  version: 1;
  createdAt: string;
  id: string;
};

const encodeCompanionActivityCursor = (record: GovernedOperationRecord) => Buffer.from(JSON.stringify({
  version: 1,
  createdAt: record.createdAt.toISOString(),
  id: record.id,
} satisfies CompanionActivityCursor)).toString("base64url");

const decodeCompanionActivityCursor = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CompanionActivityCursor>;
    const createdAt = typeof cursor.createdAt === "string" ? new Date(cursor.createdAt) : null;
    if (cursor.version !== 1 || !createdAt || !Number.isFinite(createdAt.getTime())
      || typeof cursor.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.id)) {
      throw new Error("Invalid cursor");
    }
    return { createdAt, id: cursor.id };
  } catch {
    throw new LemmaComputerError("INVALID_ACTIVITY_CURSOR", "The activity page cursor is invalid", 400);
  }
};

const activityEventLabel = (eventType: string) => ({
  approval_required: "Approval requested",
  approved: "Request approved",
  denied: "Request denied",
  executing: "Protected action started",
  dispatch_started: "Action sent to the connected service",
  succeeded: "Action completed",
  failed: "Action could not be completed",
  expired: "Request expired",
}[eventType] ?? "Request updated");

const shortIdentifier = (value: OwnedJson | undefined, fallback: string) => typeof value === "string"
  ? (value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value)
  : fallback;

const microsoft365ArgumentTarget = (toolName: string, argumentsValue: Record<string, OwnedJson>) => {
  const body = ownedRecord(argumentsValue.body);
  if (toolName === "send-mail") {
    return emailRecipients(ownedRecord(body?.Message)?.toRecipients);
  }
  if (toolName === "forward-mail-message") {
    return emailRecipients(body?.ToRecipients);
  }
  if (["create-onedrive-folder", "move-rename-onedrive-item", "copy-drive-item"].includes(toolName)) {
    return typeof body?.name === "string" ? body.name.trim() : "";
  }
  return "";
};

const microsoft365Resource = (toolName: string, argumentsValue: Record<string, OwnedJson>, displayName: string) => {
  const service = toolName.includes("mail") || toolName.includes("draft") ? "Outlook Mail"
    : toolName.includes("calendar") ? "Outlook Calendar"
      : toolName.includes("chat") || toolName.includes("channel") ? "Microsoft Teams"
        : "OneDrive";
  const context = ownedRecord(argumentsValue.lemmacomputerAudit);
  const declaredTarget = typeof context?.target === "string" ? context.target.trim() : "";
  const target = microsoft365ArgumentTarget(toolName, argumentsValue) || declaredTarget;
  if (target) {
    return {
      safeSummary: `${displayName}: ${target}`,
      resourceName: target,
      resourceLocation: service,
    };
  }
  const identifier = shortIdentifier(
    argumentsValue.driveItemId ?? argumentsValue.messageId ?? argumentsValue.eventId ?? argumentsValue.chatMessageId,
    displayName,
  );
  return { safeSummary: displayName, resourceName: identifier, resourceLocation: service };
};

const uploadUrlFrom = (value: unknown): string | null => {
  if (typeof value === "string") {
    try {
      return uploadUrlFrom(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = uploadUrlFrom(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.uploadUrl === "string") return record.uploadUrl;
  for (const item of Object.values(record)) {
    const found = uploadUrlFrom(item);
    if (found) return found;
  }
  return null;
};

export class GovernedOperationService {
  constructor(
    private readonly store: WorkspaceStore & GovernanceStore,
    private readonly executor: GovernedToolExecutor,
    private readonly approvals: FixtureApprovalAuthority,
    private readonly operationTtlMs = 10 * 60 * 1000,
    private readonly openVtc?: OpenVtcApprovalCoordinator,
  ) {}

  private async activeAccessGeneration(identity: IdentityContext, workspaceId: string) {
    const workspace = await this.store.getOwned(identity, workspaceId);
    if (!workspace) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    if (!["ready", "open"].includes(workspace.state)) {
      throw new LemmaComputerError("WORKSPACE_NOT_READY", "The workspace is not ready for governed actions", 409, true);
    }
    return workspace.accessGeneration;
  }

  async createDeleteFile(identity: IdentityContext, workspaceId: string, rawPath: string, idempotencyKey: string, correlationId: string) {
    const workspace = await this.store.getOwned(identity, workspaceId);
    if (!workspace) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    if (!["ready", "open"].includes(workspace.state)) throw new LemmaComputerError("WORKSPACE_NOT_READY", "The workspace is not ready for governed actions", 409, true);

    const segments = rawPath.replaceAll("\\", "/").split("/").filter(Boolean);
    if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
      throw new LemmaComputerError("INVALID_RESOURCE_PATH", "The file path is invalid", 400);
    }
    const path = `/${segments.join("/")}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.operationTtlMs);
    const operationId = randomUUID();
    const nonce = randomUUID();
    const operationEnvelope: GovernedOperationEnvelope = {
      version: "1",
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      workspaceId,
      audience: identity.audience,
      capabilityId: "files.delete",
      serverName: "lemmacomputer_fixture",
      toolName: "delete_file",
      schemaId: "lemmacomputer.fixture.delete_file.v1",
      arguments: { path },
      nonce,
      expiresAt: expiresAt.toISOString(),
    };
    const operationDigest = governedOperationDigest(operationEnvelope);
    const resourceName = segments.at(-1)!;
    const resourceLocation = segments.length > 1 ? `OneDrive / ${segments.slice(0, -1).join(" / ")}` : "OneDrive";
    const record = await this.store.createGovernedOperation({
      id: operationId,
      identity,
      workspaceId,
      capabilityId: operationEnvelope.capabilityId,
      serverName: operationEnvelope.serverName,
      toolName: operationEnvelope.toolName,
      schemaId: operationEnvelope.schemaId,
      arguments: operationEnvelope.arguments,
      operationDigest,
      nonce,
      safeSummary: `Delete ${resourceName}`,
      resourceName,
      resourceLocation,
      correlationId,
      idempotencyKey,
      createdAt: now,
      expiresAt,
    });
    if (!record) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    if (record.operationDigest !== operationDigest) {
      const sameRequest = record.workspaceId === workspaceId
        && record.agentId === null
        && record.policyVersionId === null
        && record.policyHash === null
        && record.capabilityId === operationEnvelope.capabilityId
        && record.serverName === operationEnvelope.serverName
        && record.toolName === operationEnvelope.toolName
        && record.schemaId === operationEnvelope.schemaId
        && canonicalJson(record.arguments) === canonicalJson(operationEnvelope.arguments);
      if (!sameRequest) {
        throw new LemmaComputerError("IDEMPOTENCY_MISMATCH", "The idempotency key was already used for a different operation", 409);
      }
    }
    return toView(record);
  }

  async createMicrosoft365Delete(
    identity: IdentityContext,
    workspaceId: string,
    input: { driveId: string; driveItemId: string; "If-Match": string },
    agentId: string,
    policy: { policyVersionId: string; policyHash: string },
    idempotencyKey: string,
    correlationId: string,
  ) {
    return this.createMicrosoft365Operation(identity, workspaceId, {
      capabilityId: "onedrive-delete-protected",
      serverName: "lemmacomputer_ms365",
      toolName: "delete-onedrive-file",
      schemaId: "lemmacomputer.m365.delete-onedrive-file.v1",
      arguments: {
        "If-Match": input["If-Match"],
        confirm: true,
        driveId: input.driveId,
        driveItemId: input.driveItemId,
        excludeResponse: true,
      },
      displayName: "Delete OneDrive file",
    }, agentId, policy, idempotencyKey, correlationId);
  }

  async createMicrosoft365Operation(
    identity: IdentityContext,
    workspaceId: string,
    input: {
      capabilityId: string;
      serverName: string;
      toolName: string;
      schemaId: string;
      arguments: Record<string, OwnedJson>;
      displayName: string;
      safeSummary?: string;
      resourceName?: string;
      resourceLocation?: string;
    },
    agentId: string,
    policy: { policyVersionId: string; policyHash: string },
    idempotencyKey: string,
    correlationId: string,
    retryTerminal = false,
    agentInstanceId?: string,
  ) {
    const workspace = await this.store.getOwned(identity, workspaceId);
    if (!workspace) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    if (!["ready", "open"].includes(workspace.state)) throw new LemmaComputerError("WORKSPACE_NOT_READY", "The workspace is not ready for governed actions", 409, true);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.operationTtlMs);
    const operationId = randomUUID();
    const nonce = randomUUID();
    const argumentsValue: OwnedJson = input.arguments;
    const operationEnvelope: GovernedOperationEnvelope = {
      version: "1",
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      workspaceId,
      agentId,
      ...(agentInstanceId ? { agentInstanceId } : {}),
      audience: identity.audience,
      capabilityId: input.capabilityId,
      serverName: input.serverName,
      toolName: input.toolName,
      schemaId: input.schemaId,
      arguments: argumentsValue,
      policyVersionId: policy.policyVersionId,
      policyHash: policy.policyHash,
      nonce,
      expiresAt: expiresAt.toISOString(),
    };
    const operationDigest = governedOperationDigest(operationEnvelope);
    const resource = input.resourceLocation ? {
      safeSummary: input.safeSummary ?? input.displayName,
      resourceName: input.resourceName ?? input.displayName,
      resourceLocation: input.resourceLocation,
    } : microsoft365Resource(input.toolName, input.arguments, input.displayName);
    const record = await this.store.createGovernedOperation({
      id: operationId,
      identity,
      workspaceId,
      agentId,
      ...(agentInstanceId ? { agentInstanceId } : {}),
      policyVersionId: policy.policyVersionId,
      policyHash: policy.policyHash,
      capabilityId: operationEnvelope.capabilityId,
      serverName: operationEnvelope.serverName,
      toolName: operationEnvelope.toolName,
      schemaId: operationEnvelope.schemaId,
      arguments: operationEnvelope.arguments,
      operationDigest,
      nonce,
      safeSummary: resource.safeSummary,
      resourceName: resource.resourceName,
      resourceLocation: resource.resourceLocation,
      correlationId,
      idempotencyKey,
      replaceTerminal: retryTerminal,
      createdAt: now,
      expiresAt,
    });
    if (!record) throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    if (record.operationDigest !== operationDigest) {
      const sameRequest = record.workspaceId === workspaceId
        && record.agentId === agentId
        && record.agentInstanceId === (agentInstanceId ?? null)
        && record.policyVersionId === policy.policyVersionId
        && record.policyHash === policy.policyHash
        && record.capabilityId === input.capabilityId
        && record.serverName === input.serverName
        && record.toolName === input.toolName
        && record.schemaId === input.schemaId
        && canonicalJson(record.arguments) === canonicalJson(input.arguments);
      if (!sameRequest) {
        throw new LemmaComputerError("IDEMPOTENCY_MISMATCH", "The idempotency key was already used for a different operation", 409);
      }
    }
    await this.openVtc?.ensureTask(identity, record);
    return toView(record);
  }

  async get(identity: IdentityContext, operationId: string) {
    const record = await this.store.recoverOperation(identity, operationId, new Date(), "operation-read");
    if (!record) throw new LemmaComputerError("OPERATION_NOT_FOUND", "Governed operation not found", 404);
    return toView(record);
  }

  async getForAgent(identity: IdentityContext, operationId: string, binding: { workspaceId: string; agentId: string; agentInstanceId?: string }) {
    const record = await this.store.recoverOperation(identity, operationId, new Date(), "agent-operation-read");
    if (!record || record.workspaceId !== binding.workspaceId || record.agentId !== binding.agentId || record.agentInstanceId !== (binding.agentInstanceId ?? null)) {
      throw new LemmaComputerError("OPERATION_NOT_FOUND", "Governed operation not found", 404);
    }
    return toView(record);
  }

  async recent(identity: IdentityContext) {
    const record = await this.store.getRecentOperation(identity);
    if (!record) return null;
    return toView(await this.store.recoverOperation(identity, record.id, new Date(), "operation-recent") ?? record);
  }

  async history(identity: IdentityContext, limit = 25) {
    const recent = this.store.listOwnedOperations ? null : await this.store.getRecentOperation(identity);
    const records = this.store.listOwnedOperations
      ? await this.store.listOwnedOperations(identity, Math.max(1, Math.min(limit, 50)))
      : recent ? [recent] : [];
    return Promise.all(records.map(async (record) => toView(
      await this.store.recoverOperation(identity, record.id, new Date(), "operation-history") ?? record,
    )));
  }

  async companionActivity(identity: IdentityContext, input: { cursor?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
    const before = decodeCompanionActivityCursor(input.cursor);
    const records = this.store.listOwnedOperationsPage
      ? await this.store.listOwnedOperationsPage(identity, { limit: limit + 1, before })
      : this.store.listOwnedOperations
        ? (await this.store.listOwnedOperations(identity, 50))
          .filter((record) => !before
            || record.createdAt.getTime() < before.createdAt.getTime()
            || (record.createdAt.getTime() === before.createdAt.getTime() && record.id < before.id))
          .slice(0, limit + 1)
        : [];
    const page = records.slice(0, limit);
    const recovered = await Promise.all(page.map(async (record) => (
      await this.store.recoverOperation(identity, record.id, new Date(), "companion-activity") ?? record
    )));
    return {
      activities: recovered.map((record) => toCompanionActivity(record)),
      nextCursor: records.length > limit && page.length
        ? encodeCompanionActivityCursor(page[page.length - 1]!)
        : null,
    };
  }

  async companionActivityDetail(identity: IdentityContext, operationId: string) {
    const operation = await this.requireOwned(identity, operationId);
    const events = this.store.getOperationEvents ? await this.store.getOperationEvents(identity, operationId) : [];
    const inferredTimeline = [
      { label: "Approval requested", createdAt: operation.createdAt.toISOString() },
      ...(operation.approval ? [{
        label: operation.approval.decision === "approve" ? "Request approved" : "Request denied",
        createdAt: operation.approval.decidedAt.toISOString(),
      }] : []),
      ...(operation.receipt ? [{
        label: "Action completed",
        createdAt: operation.receipt.executedAt.toISOString(),
      }] : operation.state === "failed" ? [{
        label: "Action could not be completed",
        createdAt: operation.updatedAt.toISOString(),
      }] : operation.state === "expired" ? [{
        label: "Request expired",
        createdAt: operation.updatedAt.toISOString(),
      }] : []),
    ];
    return {
      activity: toCompanionActivity(operation, true),
      timeline: (events.length ? events.map((event) => ({
        label: activityEventLabel(event.eventType),
        createdAt: event.createdAt.toISOString(),
      })) : inferredTimeline),
    };
  }

  async audit(identity: IdentityContext, operationId: string) {
    const operation = await this.get(identity, operationId);
    const events = this.store.getOperationEvents ? await this.store.getOperationEvents(identity, operationId) : [];
    return {
      operation,
      events: events.map((event) => ({
        eventType: event.eventType,
        correlationId: event.correlationId,
        safeDetail: event.safeDetail,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  async decideWithFixture(identity: IdentityContext, operationId: string, decision: "approve" | "deny", correlationId: string) {
    const operation = await this.requireOwned(identity, operationId);
    this.requireFixtureOperation(operation);
    const now = new Date();
    const proofExpiresAt = new Date(Math.min(operation.expiresAt.getTime(), now.getTime() + 2 * 60 * 1000));
    const envelope: FixtureApprovalEnvelope = {
      version: "1",
      issuer: "lemmacomputer-local-fixture",
      keyId: "fixture-hmac-v1",
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      audience: "lemmacomputer-control",
      operationId,
      operationDigest: operation.operationDigest,
      nonce: operation.nonce,
      decision,
      issuedAt: now.toISOString(),
      expiresAt: proofExpiresAt.toISOString(),
    };
    return this.applyApproval(identity, envelope, this.approvals.sign(envelope), correlationId);
  }

  async applyApproval(identity: IdentityContext, envelope: FixtureApprovalEnvelope, signature: string, correlationId: string) {
    const operation = await this.requireOwned(identity, envelope.operationId);
    this.requireFixtureOperation(operation);
    const now = new Date();
    const issuedAt = new Date(envelope.issuedAt);
    const proofExpiresAt = new Date(envelope.expiresAt);
    const bindingMatches = envelope.version === "1"
      && envelope.issuer === "lemmacomputer-local-fixture"
      && envelope.keyId === "fixture-hmac-v1"
      && envelope.tenantId === identity.tenantId
      && envelope.subjectId === identity.subjectId
      && envelope.audience === identity.audience
      && envelope.operationId === operation.id
      && envelope.operationDigest === operation.operationDigest
      && envelope.nonce === operation.nonce;
    if (!bindingMatches || !this.approvals.verify(envelope, signature)) {
      throw new LemmaComputerError("APPROVAL_PROOF_INVALID", "The approval proof is invalid for this operation", 403);
    }
    if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(proofExpiresAt.getTime()) || issuedAt.getTime() > now.getTime() + 5_000 || proofExpiresAt <= now || operation.expiresAt <= now) {
      throw new LemmaComputerError("APPROVAL_EXPIRED", "The approval proof or operation has expired", 409);
    }
    if (operation.approval && operation.approval.decision !== envelope.decision) {
      throw new LemmaComputerError("APPROVAL_CONFLICT", "This operation already has a different decision", 409);
    }
    if (["denied", "failed", "expired"].includes(operation.state)) return toView(operation);
    if (operation.state === "succeeded") return toView(operation);

    const decidedAt = now;
    const recorded = operation.approval ? operation : await this.store.recordApproval({
      identity,
      operationId: operation.id,
      approvalId: randomUUID(),
      decision: envelope.decision,
      channel: "local-fixture",
      issuer: envelope.issuer,
      keyId: envelope.keyId,
      operationDigest: envelope.operationDigest,
      nonce: envelope.nonce,
      proofHash: createHash("sha256").update(signature).digest("hex"),
      issuedAt,
      expiresAt: proofExpiresAt,
      decidedAt,
      correlationId,
    });
    if (!recorded) throw new LemmaComputerError("OPERATION_NOT_FOUND", "Governed operation not found", 404);
    if (!recorded.approval || recorded.approval.decision !== envelope.decision) {
      throw new LemmaComputerError("APPROVAL_STATE_INVALID", "A verified approval record is required before execution", 409);
    }
    if (envelope.decision === "deny") return toView(recorded);
    return this.execute(identity, recorded.id, correlationId);
  }

  async applyOpenVtcDecision(transportToken: string, document: unknown, correlationId: string) {
    if (!this.openVtc) throw new LemmaComputerError("OPENVTC_NOT_CONFIGURED", "OpenVTC approvals are not configured", 503, true);
    const { identity, operation } = await this.openVtc.submitDecision(transportToken, document, correlationId);
    if (!operation.approval) throw new LemmaComputerError("APPROVAL_STATE_INVALID", "A verified approval record is required before execution", 409);
    if (operation.approval.decision === "deny" || ["denied", "failed", "expired", "succeeded"].includes(operation.state)) return toView(operation);
    if (operation.toolName === "create-upload-session") return toView(operation);
    return this.execute(identity, operation.id, correlationId);
  }

  async beginResumableUpload(
    identity: IdentityContext,
    operationId: string,
    binding: { workspaceId: string; agentId: string; agentInstanceId?: string },
    correlationId: string,
  ) {
    const operation = await this.requireOwned(identity, operationId);
    if (
      operation.workspaceId !== binding.workspaceId
      || operation.agentId !== binding.agentId
      || operation.agentInstanceId !== (binding.agentInstanceId ?? null)
      || operation.toolName !== "create-upload-session"
      || operation.serverName !== "lemmacomputer_ms365"
      || operation.approval?.decision !== "approve"
      || operation.state !== "approved"
    ) {
      throw new LemmaComputerError("UPLOAD_NOT_APPROVED", "The resumable upload is not approved for this workspace agent", 409);
    }
    const leaseId = randomUUID();
    const claimed = await this.store.claimExecution(
      identity,
      operation.id,
      leaseId,
      new Date(Date.now() + 24 * 60 * 60_000),
      correlationId,
    );
    if (!claimed || claimed.leaseId !== leaseId) {
      throw new LemmaComputerError("UPLOAD_ALREADY_STARTED", "The resumable upload has already started", 409);
    }
    try {
      const accessGeneration = await this.activeAccessGeneration(identity, claimed.workspaceId);
      const result = await this.executor.executeGovernedTool({
        tenantId: identity.tenantId,
        subjectId: identity.subjectId,
        workspaceId: claimed.workspaceId,
        accessGeneration,
        operationId: claimed.id,
        operationDigest: claimed.operationDigest,
        leaseId,
        agentId: claimed.agentId ?? undefined,
        serverName: claimed.serverName,
        toolName: claimed.toolName,
        arguments: claimed.arguments,
      });
      const uploadUrlValue = uploadUrlFrom(result.result);
      if (!uploadUrlValue) throw new LemmaComputerError("UPLOAD_SESSION_INVALID", "Microsoft did not return a resumable upload session", 502, true);
      const uploadUrl = new URL(uploadUrlValue);
      if (
        uploadUrl.protocol !== "https:"
        || !(uploadUrl.hostname.endsWith(".up.1drv.com") || uploadUrl.hostname.endsWith(".sharepoint.com"))
      ) {
        throw new LemmaComputerError("UPLOAD_SESSION_INVALID", "Microsoft returned an invalid resumable upload destination", 502);
      }
      return { leaseId, uploadUrl: uploadUrl.toString() };
    } catch (error) {
      await this.store.failExecution(
        identity,
        operation.id,
        leaseId,
        error instanceof LemmaComputerError ? error.code : "UPLOAD_SESSION_FAILED",
        correlationId,
        error instanceof LemmaComputerError ? error.message : "The resumable upload session could not be created",
      );
      throw error;
    }
  }

  async completeResumableUpload(
    identity: IdentityContext,
    operationId: string,
    binding: { workspaceId: string; agentId: string; agentInstanceId?: string },
    leaseId: string,
    correlationId: string,
  ) {
    const operation = await this.requireOwned(identity, operationId);
    if (operation.workspaceId !== binding.workspaceId || operation.agentId !== binding.agentId || operation.agentInstanceId !== (binding.agentInstanceId ?? null) || operation.toolName !== "create-upload-session") {
      throw new LemmaComputerError("OPERATION_NOT_FOUND", "Governed operation not found", 404);
    }
    const file = (operation.arguments as Record<string, OwnedJson>).lemmacomputerFile as Record<string, OwnedJson> | undefined;
    const name = typeof file?.name === "string" ? file.name : "file";
    const completed = await this.store.completeExecution(identity, operation.id, leaseId, {
      id: randomUUID(),
      upstreamReference: `onedrive-upload:${operation.id}`,
      resultSummary: `Uploaded ${name} to OneDrive after signed approval`,
      resultHash: createHash("sha256").update(canonicalJson(file ?? null)).digest("hex"),
      executedAt: new Date(),
    }, correlationId);
    if (!completed) throw new LemmaComputerError("UPLOAD_LEASE_INVALID", "The resumable upload lease is no longer valid", 409);
    return toView(completed);
  }

  async failResumableUpload(
    identity: IdentityContext,
    operationId: string,
    binding: { workspaceId: string; agentId: string; agentInstanceId?: string },
    leaseId: string,
    correlationId: string,
  ) {
    const operation = await this.requireOwned(identity, operationId);
    if (operation.workspaceId !== binding.workspaceId || operation.agentId !== binding.agentId || operation.agentInstanceId !== (binding.agentInstanceId ?? null) || operation.toolName !== "create-upload-session") {
      throw new LemmaComputerError("OPERATION_NOT_FOUND", "Governed operation not found", 404);
    }
    await this.store.failExecution(identity, operation.id, leaseId, "UPLOAD_TRANSFER_FAILED", correlationId, "The approved OneDrive upload did not complete");
    return this.get(identity, operation.id);
  }

  private requireFixtureOperation(operation: GovernedOperationRecord) {
    if (operation.serverName !== "lemmacomputer_fixture" || operation.toolName !== "delete_file"
      || operation.schemaId !== "lemmacomputer.fixture.delete_file.v1") {
      throw new LemmaComputerError(
        "FIXTURE_APPROVAL_NOT_ALLOWED",
        "The local fixture cannot decide this governed operation",
        403,
      );
    }
  }

  private async execute(identity: IdentityContext, operationId: string, correlationId: string) {
    const leaseId = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 30_000);
    const claimed = await this.store.claimExecution(identity, operationId, leaseId, leaseExpiresAt, correlationId);
    if (!claimed) throw new LemmaComputerError("OPERATION_NOT_FOUND", "Governed operation not found", 404);
    if (claimed.leaseId !== leaseId) return this.waitForConcurrentExecution(identity, operationId);
    try {
      const accessGeneration = await this.activeAccessGeneration(identity, claimed.workspaceId);
      const result = await this.executor.executeGovernedTool({
        tenantId: identity.tenantId,
        subjectId: identity.subjectId,
        workspaceId: claimed.workspaceId,
        accessGeneration,
        operationId: claimed.id,
        operationDigest: claimed.operationDigest,
        leaseId,
        agentId: claimed.agentId ?? undefined,
        serverName: claimed.serverName,
        toolName: claimed.toolName,
        arguments: claimed.arguments,
      });
      const completed = await this.store.completeExecution(identity, claimed.id, leaseId, {
        id: randomUUID(),
        upstreamReference: result.upstreamReference,
        resultSummary: result.resultSummary,
        resultHash: createHash("sha256").update(canonicalJson(result.result)).digest("hex"),
        executedAt: new Date(),
      }, correlationId);
      if (!completed) throw new LemmaComputerError("OPERATION_NOT_FOUND", "Governed operation not found", 404);
      return toView(completed);
    } catch (error) {
      await this.store.failExecution(
        identity,
        claimed.id,
        leaseId,
        error instanceof LemmaComputerError ? error.code : "TOOL_EXECUTION_FAILED",
        correlationId,
        error instanceof LemmaComputerError ? error.message : "The governed tool execution failed",
      );
      throw error;
    }
  }

  private async waitForConcurrentExecution(identity: IdentityContext, operationId: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await this.requireOwned(identity, operationId);
      if (current.state !== "executing") return toView(current);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new LemmaComputerError("OPERATION_IN_PROGRESS", "The governed operation is still executing", 409, true);
  }

  private async requireOwned(identity: IdentityContext, operationId: string) {
    const operation = await this.store.recoverOperation(identity, operationId, new Date(), "operation-command");
    if (!operation) throw new LemmaComputerError("OPERATION_NOT_FOUND", "Governed operation not found", 404);
    return operation;
  }
}
