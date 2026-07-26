import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OneComputerError, type IdentityContext, type OwnedJson } from "@onecomputer/contracts";
import type {
  GovernanceStore,
  GovernedOperationRecord,
  OpenVtcApprovalStore,
  OpenVtcApproverRecord,
  OpenVtcCompanionSubscriptionRecord,
  OpenVtcConsentTaskRecord,
  WorkspaceStore,
} from "@onecomputer/workspace-store";
import {
  COMPANION_PUSH_PROTOCOL,
  type CompanionPushProvider,
  type CompanionPushSubscription,
} from "./web-push.js";
import type { OpenVtcConsentClient } from "./openvtc-consent-client.js";

const MICROSOFT365_TASK_TYPE = "https://onecomputer.dev/spec/microsoft365/tool-call/0.1";
const ONECOMPUTER_APPROVER_ENROLLMENT_TYPE = "https://onecomputer.dev/spec/openvtc/approver-enrollment/0.1";
const ENROLLMENT_TTL_MS = 5 * 60 * 1000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// trust-tasks-rs serializes whole-second RFC 3339 instants without a
// fractional component before verifying their Data Integrity proof. Keep the
// challenge representation aligned so a browser signs the same bytes the
// verifier receives.
export const openVtcTimestamp = (value: Date) => value.toISOString().replace(".000Z", "Z");

type ApprovalStore = WorkspaceStore & GovernanceStore & OpenVtcApprovalStore;

const publicApprover = (record: OpenVtcApproverRecord) => ({
  id: record.id,
  approverDid: record.approverDid,
  verificationMethod: record.verificationMethod,
  displayName: record.displayName,
  status: record.status,
  enrolledAt: record.enrolledAt.toISOString(),
});

const publicCompanion = (record: OpenVtcCompanionSubscriptionRecord, approver: OpenVtcApproverRecord | undefined) => ({
  id: record.id,
  approverId: record.approverId,
  approverDid: approver?.approverDid ?? null,
  displayName: approver?.displayName ?? "Companion browser",
  installationId: record.installationId,
  protocolVersion: record.protocolVersion,
  browserFamily: record.browserFamily,
  platform: record.platform,
  status: record.status,
  enrolledAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  revokedAt: record.revokedAt?.toISOString() ?? null,
  lastSuccessfulDeliveryAt: record.lastSuccessfulDeliveryAt?.toISOString() ?? null,
  lastFailureCode: record.lastFailureCode,
});

const taskPayloadFor = (record: GovernedOperationRecord): OwnedJson => ({
  version: "1",
  tenantId: record.tenantId,
  subjectId: record.subjectId,
  workspaceId: record.workspaceId,
  agentId: record.agentId,
  capabilityId: record.capabilityId,
  serverName: record.serverName,
  toolName: record.toolName,
  schemaId: record.schemaId,
  arguments: record.arguments,
  operationDigest: record.operationDigest,
  nonce: record.nonce,
  expiresAt: record.expiresAt.toISOString(),
});

const transportIdentity = (approver: OpenVtcApproverRecord): IdentityContext => ({
  tenantId: approver.tenantId,
  subjectId: approver.subjectId,
  audience: "onecomputer-control",
});

const effectKind = (toolName: string) => toolName.startsWith("delete-") ? "delete"
  : toolName.startsWith("send-") || toolName.startsWith("reply-") || toolName.startsWith("forward-") ? "send"
    : toolName.startsWith("create-") || toolName.startsWith("upload-") || toolName.startsWith("copy-") ? "create"
      : "update";

export class OpenVtcApprovalCoordinator {
  constructor(
    private readonly store: ApprovalStore,
    readonly consent: OpenVtcConsentClient,
    private readonly pushProvider?: CompanionPushProvider,
  ) {}

  async createEnrollmentChallenge(identity: IdentityContext) {
    const createdAt = new Date();
    const record = await this.store.createOpenVtcEnrollmentChallenge({
      id: randomUUID(),
      identity,
      executorDid: this.consent.executorDid,
      challenge: randomBytes(24).toString("base64url"),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + ENROLLMENT_TTL_MS),
    });
    return {
      id: record.id,
      type: ONECOMPUTER_APPROVER_ENROLLMENT_TYPE,
      recipientDid: record.executorDid,
      challenge: record.challenge,
      tenantId: record.tenantId,
      subjectId: record.subjectId,
      issuedAt: openVtcTimestamp(record.createdAt),
      expiresAt: openVtcTimestamp(record.expiresAt),
    };
  }

  async enroll(identity: IdentityContext, challengeId: string, document: unknown) {
    const challenge = await this.store.getOpenVtcEnrollmentChallenge(identity, challengeId);
    const now = new Date();
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) {
      throw new OneComputerError("OPENVTC_ENROLLMENT_CHALLENGE_INVALID", "The enrollment challenge is missing, expired, or already used", 409);
    }
    const proof = await this.consent.verifyEnrollment({
      document,
      expected: {
        recipientDid: challenge.executorDid,
        challenge: challenge.challenge,
        tenantId: identity.tenantId,
        subjectId: identity.subjectId,
      },
      now: now.toISOString(),
    });
    if (!await this.store.consumeOpenVtcEnrollmentChallenge(identity, challenge.id, challenge.challenge, now)) {
      throw new OneComputerError("OPENVTC_ENROLLMENT_CHALLENGE_INVALID", "The enrollment challenge is missing, expired, or already used", 409);
    }
    const payload = isObject(document) && isObject(document.payload) ? document.payload : {};
    const transportToken = `ocvta_${randomBytes(32).toString("base64url")}`;
    const approver = await this.store.enrollOpenVtcApprover({
      id: randomUUID(),
      identity,
      approverDid: proof.signerDid,
      verificationMethod: proof.verificationMethod,
      displayName: proof.displayName,
      transportTokenHash: sha256(transportToken),
      enrolledAt: now,
    });
    const recent = await this.store.getRecentOperation(identity);
    if (recent?.state === "approval_required") await this.ensureTask(identity, recent);
    return { approver: publicApprover(approver), transportToken };
  }

  async status(identity: IdentityContext, approverDid?: string) {
    const approver = approverDid
      ? await this.store.getActiveOpenVtcApproverByDid(identity, approverDid)
      : await this.store.getActiveOpenVtcApprover(identity);
    return { connected: Boolean(approver), approver: approver ? publicApprover(approver) : null, executorDid: this.consent.executorDid };
  }

  async revoke(identity: IdentityContext, approverDid?: string) {
    const approver = approverDid
      ? await this.store.getActiveOpenVtcApproverByDid(identity, approverDid)
      : await this.store.getActiveOpenVtcApprover(identity);
    if (!approver) return false;
    const subscription = await this.store.getOpenVtcCompanionSubscriptionForApprover(approver.id);
    if (subscription) await this.store.revokeOpenVtcCompanionSubscription(identity, subscription.id, new Date());
    return this.store.revokeOpenVtcApprover(identity, approver.id, new Date());
  }

  async ensureTask(identity: IdentityContext, operation: GovernedOperationRecord) {
    const approvers = await this.store.listActiveOpenVtcApprovers(identity);
    if (!approvers.length || operation.state !== "approval_required" || operation.expiresAt <= new Date()) return null;
    const tasks = await Promise.all(approvers.map((approver) => this.ensureTaskForApprover(identity, operation, approver)));
    return tasks.find(Boolean) ?? null;
  }

  private async ensureTaskForApprover(identity: IdentityContext, operation: GovernedOperationRecord, approver: OpenVtcApproverRecord) {
    const existing = await this.store.getOpenVtcConsentTaskForApprover(identity, operation.id, approver.id);
    if (existing) {
      if (["queued", "delivered"].includes(existing.state)) await this.dispatchCompanionPush(existing, approver);
      return existing;
    }
    const createdAt = new Date();
    const challenge = randomBytes(24).toString("base64url");
    const taskPayload = taskPayloadFor(operation);
    const taskId = randomUUID();
    const signed = await this.consent.signRequest({
      id: `urn:uuid:${taskId}`,
      recipientDid: approver.approverDid,
      issuedAt: createdAt.toISOString(),
      expiresAt: operation.expiresAt.toISOString(),
      challenge,
      taskType: MICROSOFT365_TASK_TYPE,
      taskPayload,
      requesterDid: `did:onecomputer:agent:${operation.agentId ?? "workspace-agent"}`,
      approverSet: "onecomputer-workspace-owners",
      minApprovals: 1,
      excludeRequester: true,
      sideEffects: operation.toolName.startsWith("delete-") ? "destructive" : "mutating",
      exposure: { discloses: "none", actsAsSubject: true },
      effects: [{ kind: effectKind(operation.toolName), summary: operation.safeSummary, path: operation.resourceLocation }],
      consequences: [operation.toolName.startsWith("delete-")
        ? "This operation removes the selected Microsoft 365 resource."
        : "This operation changes Microsoft 365 data or communicates as the signed-in user."],
      subject: `urn:onecomputer:operation:${operation.id}`,
      origin: "ONEComputer Control",
      statePin: { resource: operation.resourceName, version: operation.operationDigest },
    });
    const task = await this.store.createOpenVtcConsentTask({
      id: taskId,
      outboxId: randomUUID(),
      identity,
      operationId: operation.id,
      approverId: approver.id,
      executorDid: this.consent.executorDid,
      challenge,
      taskType: MICROSOFT365_TASK_TYPE,
      payloadDigest: signed.payloadDigest,
      requestDocument: signed.document,
      requestHash: signed.documentHash,
      requestProofHash: signed.proofHash,
      createdAt,
      expiresAt: operation.expiresAt,
    });
    if (task) await this.dispatchCompanionPush(task, approver);
    return task;
  }

  async inbox(transportToken: string) {
    const approver = await this.requireTransportApprover(transportToken);
    const task = await this.store.deliverNextOpenVtcConsentTask(approver.id, new Date());
    return task?.requestDocument ?? null;
  }

  async inboxForIdentity(identity: IdentityContext, approverDid?: string) {
    const approver = approverDid
      ? await this.store.getActiveOpenVtcApproverByDid(identity, approverDid)
      : await this.store.getActiveOpenVtcApprover(identity);
    if (!approver) return null;
    const recent = await this.store.getRecentOperation(identity);
    if (recent?.state === "approval_required") await this.ensureTask(identity, recent);
    const task = await this.store.deliverNextOpenVtcConsentTask(approver.id, new Date());
    return task?.requestDocument ?? null;
  }

  companionConfig() {
    return {
      enabled: Boolean(this.pushProvider),
      protocolVersion: COMPANION_PUSH_PROTOCOL,
      serviceWorkerVersion: "onecomputer-companion-sw-0.2",
      vapidPublicKey: this.pushProvider?.publicKey ?? null,
      notificationPayload: { version: "1", event: "approval-pending" },
      support: [
        { browser: "Chrome", platforms: ["Windows", "macOS", "Linux", "Android"], mode: "supported" },
        { browser: "Edge", platforms: ["Windows", "macOS"], mode: "supported" },
        { browser: "Safari", platforms: ["macOS", "iOS installed web app"], mode: "verification-required" },
        { browser: "Firefox", platforms: ["Windows", "macOS", "Linux"], mode: "verification-required" },
      ],
    };
  }

  async companions(identity: IdentityContext) {
    const [approvers, subscriptions] = await Promise.all([
      this.store.listActiveOpenVtcApprovers(identity),
      this.store.listOpenVtcCompanionSubscriptions(identity),
    ]);
    const approverById = new Map(approvers.map((approver) => [approver.id, approver]));
    return { companions: subscriptions.map((subscription) => publicCompanion(subscription, approverById.get(subscription.approverId))) };
  }

  async subscribeCompanion(identity: IdentityContext, input: {
    approverDid: string;
    installationId: string;
    browserFamily: OpenVtcCompanionSubscriptionRecord["browserFamily"];
    platform: OpenVtcCompanionSubscriptionRecord["platform"];
    subscription: CompanionPushSubscription;
  }) {
    if (!this.pushProvider) throw new OneComputerError("WEB_PUSH_NOT_CONFIGURED", "Companion push notifications are not configured", 503, true);
    const approver = await this.store.getActiveOpenVtcApproverByDid(identity, input.approverDid);
    if (!approver) throw new OneComputerError("OPENVTC_APPROVER_NOT_FOUND", "This browser approval key is not enrolled for the signed-in user", 404);
    const protectedSubscription = this.pushProvider.protect(input.subscription);
    const saved = await this.store.upsertOpenVtcCompanionSubscription({
      id: randomUUID(),
      identity,
      approverId: approver.id,
      installationId: input.installationId,
      protocolVersion: COMPANION_PUSH_PROTOCOL,
      browserFamily: input.browserFamily,
      platform: input.platform,
      endpointHash: protectedSubscription.endpointHash,
      subscriptionCiphertext: protectedSubscription.ciphertext,
      savedAt: new Date(),
    });
    const recent = await this.store.getRecentOperation(identity);
    if (recent?.state === "approval_required") await this.ensureTask(identity, recent);
    return publicCompanion(saved, approver);
  }

  async revokeCompanion(identity: IdentityContext, companionId: string) {
    const subscriptions = await this.store.listOpenVtcCompanionSubscriptions(identity);
    const subscription = subscriptions.find((item) => item.id === companionId);
    if (!subscription) return false;
    const revokedAt = new Date();
    await this.store.revokeOpenVtcCompanionSubscription(identity, companionId, revokedAt);
    return this.store.revokeOpenVtcApprover(identity, subscription.approverId, revokedAt);
  }

  async testCompanion(identity: IdentityContext, companionId: string) {
    if (!this.pushProvider) throw new OneComputerError("WEB_PUSH_NOT_CONFIGURED", "Companion push notifications are not configured", 503, true);
    const subscriptions = await this.store.listOpenVtcCompanionSubscriptions(identity);
    const subscription = subscriptions.find((item) => item.id === companionId && item.status === "active");
    if (!subscription) throw new OneComputerError("OPENVTC_COMPANION_NOT_FOUND", "Active companion browser not found", 404);
    const result = await this.pushProvider.sendHint(subscription.subscriptionCiphertext);
    if (!result.delivered) {
      throw new OneComputerError(result.failureCode ?? "WEB_PUSH_PROVIDER_UNAVAILABLE",
        result.terminal ? "This notification subscription is no longer valid; re-enable notifications on this browser." : "The push provider is temporarily unavailable.",
        result.terminal ? 409 : 503,
        !result.terminal);
    }
    return { delivered: true, deliveredAt: new Date().toISOString() };
  }

  async flushCompanionPushQueue(limit = 25) {
    if (!this.pushProvider) return 0;
    const due = await this.store.listDueOpenVtcCompanionPushDeliveries(new Date(), limit);
    let attempted = 0;
    for (const delivery of due) {
      const claimedAt = new Date();
      if (!await this.store.claimOpenVtcCompanionPushDelivery({
        id: randomUUID(),
        taskId: delivery.taskId,
        subscriptionId: delivery.subscriptionId,
        claimedAt,
      })) continue;
      attempted += 1;
      await this.deliverClaimedCompanionPush(delivery.taskId, delivery.subscriptionId, delivery.subscriptionCiphertext);
    }
    return attempted;
  }

  async submitDecision(transportToken: string, document: unknown, correlationId: string) {
    const approver = await this.requireTransportApprover(transportToken);
    const payload = isObject(document) && isObject(document.payload) ? document.payload : null;
    const payloadDigest = payload?.payloadDigest;
    if (typeof payloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(payloadDigest)) {
      throw new OneComputerError("OPENVTC_DECISION_INVALID", "The decision payload digest is invalid", 400);
    }
    const task = await this.store.getOpenVtcConsentTaskByPayloadDigest(approver.id, payloadDigest);
    if (!task) throw new OneComputerError("OPENVTC_TASK_NOT_FOUND", "No live consent task matches this decision", 404);
    const identity = transportIdentity(approver);
    const operation = await this.store.getOwnedOperation(identity, task.operationId);
    if (!operation) throw new OneComputerError("OPERATION_NOT_FOUND", "Governed operation not found", 404);
    await this.assertStoredRequest(task, approver, operation);
    const request = task.requestDocument as Record<string, unknown>;
    const requestPayload = request.payload as Record<string, unknown>;
    const verified = await this.consent.verifyDecision({
      document,
      expected: {
        recipientDid: this.consent.executorDid,
        challenge: task.challenge,
        payloadDigest: task.payloadDigest,
        enrolledApprovers: [{
          signerDid: approver.approverDid,
          verificationMethod: approver.verificationMethod,
        }],
        requestIssuedAt: String(request.issuedAt),
        requestExpiresAt: task.expiresAt.toISOString(),
        requesterDid: String(requestPayload.requester),
        excludeRequester: requestPayload.excludeRequester === true,
      },
      now: new Date().toISOString(),
    });
    if (verified.signerDid !== approver.approverDid
      || verified.verificationMethod !== approver.verificationMethod) {
      throw new OneComputerError("OPENVTC_DECISION_APPROVER_INVALID", "The decision key is not the enrolled approver key", 403);
    }
    if (["approved", "denied"].includes(task.state)) {
      if (task.decisionHash === verified.documentHash) return { identity, operation };
      throw new OneComputerError("APPROVAL_CONFLICT", "This task already has a different signed decision", 409);
    }
    const recorded = await this.store.recordOpenVtcDecision({
      identity,
      taskId: task.id,
      approvalId: randomUUID(),
      approverId: approver.id,
      signerDid: verified.signerDid,
      verificationMethod: verified.verificationMethod,
      challenge: verified.challenge,
      payloadDigest: verified.payloadDigest,
      decision: verified.decision,
      decisionDocument: document as OwnedJson,
      decisionHash: verified.documentHash,
      proofHash: verified.proofHash,
      issuedAt: new Date(verified.issuedAt),
      decidedAt: new Date(),
      correlationId,
    });
    if (!recorded) {
      const decidedTask = await this.store.getOpenVtcConsentTask(identity, task.operationId);
      const decidedOperation = await this.store.getOwnedOperation(identity, task.operationId);
      if (decidedTask?.decisionHash === verified.documentHash && decidedOperation) return { identity, operation: decidedOperation };
      throw new OneComputerError("APPROVAL_STATE_INVALID", "The consent task is no longer live", 409);
    }
    return { identity, operation: recorded };
  }

  private async requireTransportApprover(transportToken: string) {
    if (!/^ocvta_[A-Za-z0-9_-]{43}$/.test(transportToken)) {
      throw new OneComputerError("UNAUTHENTICATED", "Browser agent authentication is required", 401);
    }
    const approver = await this.store.getOpenVtcApproverByTransportTokenHash(sha256(transportToken));
    if (!approver) throw new OneComputerError("UNAUTHENTICATED", "Browser agent authentication is required", 401);
    return approver;
  }

  private async dispatchCompanionPush(task: OpenVtcConsentTaskRecord, approver: OpenVtcApproverRecord) {
    if (!this.pushProvider) return;
    const subscription = await this.store.getOpenVtcCompanionSubscriptionForApprover(approver.id);
    if (!subscription) return;
    const claimedAt = new Date();
    if (!await this.store.claimOpenVtcCompanionPushDelivery({
      id: randomUUID(),
      taskId: task.id,
      subscriptionId: subscription.id,
      claimedAt,
    })) return;
    await this.deliverClaimedCompanionPush(task.id, subscription.id, subscription.subscriptionCiphertext);
  }

  private async deliverClaimedCompanionPush(taskId: string, subscriptionId: string, subscriptionCiphertext: string) {
    if (!this.pushProvider) return;
    const result = await this.pushProvider.sendHint(subscriptionCiphertext)
      .catch(() => ({ delivered: false, terminal: false, failureCode: "WEB_PUSH_PROVIDER_UNAVAILABLE" }));
    await this.store.recordOpenVtcCompanionPushDelivery({
      taskId,
      subscriptionId,
      delivered: result.delivered,
      terminal: result.terminal,
      failureCode: result.failureCode,
      attemptedAt: new Date(),
    });
  }

  private async assertStoredRequest(task: OpenVtcConsentTaskRecord, approver: OpenVtcApproverRecord, operation: GovernedOperationRecord) {
    const request = task.requestDocument;
    if (!isObject(request) || request.issuer !== this.consent.executorDid || request.recipient !== approver.approverDid
      || task.taskType !== MICROSOFT365_TASK_TYPE) {
      throw new OneComputerError("OPENVTC_TASK_BINDING_INVALID", "The persisted consent request no longer matches its governed operation", 409);
    }
    const expected = await this.consent.signRequest({
      id: String(request.id),
      recipientDid: approver.approverDid,
      issuedAt: String(request.issuedAt),
      expiresAt: task.expiresAt.toISOString(),
      challenge: task.challenge,
      taskType: task.taskType,
      taskPayload: taskPayloadFor(operation),
      requesterDid: String((request.payload as Record<string, unknown>).requester),
      approverSet: "onecomputer-workspace-owners",
      minApprovals: 1,
      excludeRequester: true,
      sideEffects: operation.toolName.startsWith("delete-") ? "destructive" : "mutating",
      exposure: { discloses: "none", actsAsSubject: true },
      effects: [{ kind: effectKind(operation.toolName), summary: operation.safeSummary, path: operation.resourceLocation }],
      consequences: [operation.toolName.startsWith("delete-")
        ? "This operation removes the selected Microsoft 365 resource."
        : "This operation changes Microsoft 365 data or communicates as the signed-in user."],
      subject: `urn:onecomputer:operation:${operation.id}`,
      origin: "ONEComputer Control",
      statePin: { resource: operation.resourceName, version: operation.operationDigest },
    });
    if (expected.payloadDigest !== task.payloadDigest
      || expected.documentHash !== task.requestHash
      || expected.proofHash !== task.requestProofHash) {
      throw new OneComputerError("OPENVTC_TASK_BINDING_INVALID", "The persisted consent request no longer matches its governed operation", 409);
    }
  }
}
