import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { IdentityContext } from "@onecomputer/contracts";
import type { GovernedToolExecutionInput, GovernedToolExecutionResult, GovernedToolExecutor } from "@onecomputer/litellm-adapter";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import { OpenVtcApprovalCoordinator, openVtcTimestamp } from "../apps/control-api/src/openvtc.js";
import { FixtureApprovalAuthority, GovernedOperationService } from "../apps/control-api/src/operations.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";
import { TestOpenVtcConsentClient, type TestDidSigner } from "./helpers/openvtc-consent.js";

const identity: IdentityContext = { tenantId: "tenant-browser", subjectId: "mike", audience: "onecomputer-control" };

test("OpenVTC enrollment timestamps retain the verifier's whole-second RFC 3339 form", () => {
  assert.equal(openVtcTimestamp(new Date("2026-07-25T12:35:45.000Z")), "2026-07-25T12:35:45Z");
  assert.equal(openVtcTimestamp(new Date("2026-07-25T12:35:45.819Z")), "2026-07-25T12:35:45.819Z");
});

class FakeExecutor implements GovernedToolExecutor {
  calls: GovernedToolExecutionInput[] = [];
  async executeGovernedTool(input: GovernedToolExecutionInput): Promise<GovernedToolExecutionResult> {
    this.calls.push(input);
    return { upstreamReference: `m365:${input.operationId}`, resultSummary: `Executed approved ${input.toolName}`, result: { completed: true } };
  }
}

const setup = async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "browser-approval", randomUUID());
  await store.update(workspace.id, { state: "ready" });
  const executor = new FakeExecutor();
  const consent = new TestOpenVtcConsentClient();
  const coordinator = new OpenVtcApprovalCoordinator(store, consent);
  const browser = consent.createApprover();
  const challenge = await coordinator.createEnrollmentChallenge(identity);
  const enrollment = consent.enrollmentDocument(browser, challenge, identity.tenantId, identity.subjectId, "Mike's browser");
  const enrolled = await coordinator.enroll(identity, challenge.id, enrollment);
  const service = new GovernedOperationService(
    store,
    executor,
    new FixtureApprovalAuthority("openvtc-control-test-fixture-secret-32-chars"),
    60_000,
    coordinator,
  );
  return { store, workspace, executor, coordinator, consent, browser, transportToken: enrolled.transportToken, service };
};

const signedDecision = (
  consent: TestOpenVtcConsentClient,
  request: Record<string, unknown>,
  browser: TestDidSigner,
  decision: "approve" | "deny",
) => consent.decisionDocument(browser, request, decision);

test("OpenVTC browser enrollment, inbox, signed approval, and exact execution form one path", async () => {
  const { workspace, executor, coordinator, consent, browser, transportToken, service } = await setup();
  const pending = await service.createMicrosoft365Delete(
    identity,
    workspace.id,
    { driveId: "drive-1", driveItemId: "item-1", "If-Match": "etag-1" },
    "agent-1",
    { policyVersionId: "policy-1", policyHash: "a".repeat(64) },
    "browser-approval-idempotency",
    "browser-approval-create",
  );
  assert.equal(pending.state, "approval_required");
  assert.equal(executor.calls.length, 0);

  const request = await coordinator.inboxForIdentity(identity) as Record<string, unknown>;
  assert.equal(request.recipient, browser.did);
  const decision = signedDecision(consent, request, browser, "approve");
  const [completed, retry] = await Promise.all([
    service.applyOpenVtcDecision(transportToken, decision, "browser-approval-decision"),
    service.applyOpenVtcDecision(transportToken, decision, "browser-approval-retry"),
  ]);

  assert.equal(completed.state, "succeeded");
  assert.equal(retry.state, "succeeded");
  assert.equal(completed.approval?.channel, "openvtc-task-consent");
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls[0]?.arguments, {
    "If-Match": "etag-1",
    confirm: true,
    driveId: "drive-1",
    driveItemId: "item-1",
    excludeResponse: true,
  });
});

test("a signed browser denial is durable and reaches the connector zero times", async () => {
  const { workspace, executor, coordinator, consent, browser, transportToken, service } = await setup();
  await service.createMicrosoft365Delete(
    identity,
    workspace.id,
    { driveId: "drive-deny", driveItemId: "item-deny", "If-Match": "etag-deny" },
    "agent-deny",
    { policyVersionId: "policy-deny", policyHash: "b".repeat(64) },
    "browser-denial-idempotency",
    "browser-denial-create",
  );
  const request = await coordinator.inbox(transportToken) as Record<string, unknown>;
  const denied = await service.applyOpenVtcDecision(transportToken, signedDecision(consent, request, browser, "deny"), "browser-denial-decision");
  assert.equal(denied.state, "denied");
  assert.equal(denied.approval?.decision, "deny");
  assert.equal(executor.calls.length, 0);
});

test("a protected Calendar write uses the generic redacted OpenVTC path and executes once", async () => {
  const { workspace, executor, coordinator, consent, browser, transportToken, service } = await setup();
  const sensitiveSubject = "private-calendar-subject-must-not-enter-approval-ui";
  const sensitiveBody = "private-calendar-body-must-not-enter-audit-projection";
  const pending = await service.createMicrosoft365Operation(
    identity,
    workspace.id,
    {
      capabilityId: "m365.create-calendar-event",
      serverName: "onecomputer_ms365",
      toolName: "create-calendar-event",
      schemaId: "onecomputer.m365.create-calendar-event.v1",
      arguments: {
        confirm: true,
        body: {
          subject: sensitiveSubject,
          body: { contentType: "text", content: sensitiveBody },
          start: { dateTime: "2026-07-23T09:00:00", timeZone: "Asia/Singapore" },
          end: { dateTime: "2026-07-23T09:15:00", timeZone: "Asia/Singapore" },
        },
      },
      displayName: "Create calendar event",
    },
    "agent-calendar",
    { policyVersionId: "policy-calendar", policyHash: "f".repeat(64) },
    "calendar-create-idempotency",
    "calendar-create-correlation",
  );
  assert.equal(pending.state, "approval_required");
  assert.equal(pending.resourceLocation, "Outlook Calendar");
  assert.equal(pending.safeSummary, "Create calendar event");
  assert.ok(!JSON.stringify(pending).includes(sensitiveSubject));
  assert.ok(!JSON.stringify(pending).includes(sensitiveBody));
  assert.equal(executor.calls.length, 0);

  const request = await coordinator.inbox(transportToken) as Record<string, unknown>;
  assert.ok(!JSON.stringify(request).includes(sensitiveSubject));
  assert.ok(!JSON.stringify(request).includes(sensitiveBody));
  const decision = signedDecision(consent, request, browser, "approve");
  const [completed, replay] = await Promise.all([
    service.applyOpenVtcDecision(transportToken, decision, "calendar-create-decision"),
    service.applyOpenVtcDecision(transportToken, decision, "calendar-create-replay"),
  ]);
  assert.equal(completed.state, "succeeded");
  assert.equal(replay.state, "succeeded");
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0]?.toolName, "create-calendar-event");
  assert.equal((executor.calls[0]?.arguments.body as Record<string, unknown>)?.subject, sensitiveSubject);

  const audit = await service.audit(identity, pending.id);
  assert.ok(!JSON.stringify(audit).includes(sensitiveSubject));
  assert.ok(!JSON.stringify(audit).includes(sensitiveBody));
});

test("multiple browsers receive recipient-bound requests but converge on one legal decision path", async () => {
  const { store, workspace, executor, coordinator, consent, browser, transportToken: oldToken, service } = await setup();
  const pending = await service.createMicrosoft365Delete(
    identity,
    workspace.id,
    { driveId: "drive-rotate", driveItemId: "item-rotate", "If-Match": "etag-rotate" },
    "agent-rotate",
    { policyVersionId: "policy-rotate", policyHash: "e".repeat(64) },
    "browser-rotate-idempotency",
    "browser-rotate-create",
  );
  const priorTask = await store.getOpenVtcConsentTask(identity, pending.id);
  assert.ok(priorTask);

  const replacementBrowser = consent.createApprover();
  const challenge = await coordinator.createEnrollmentChallenge(identity);
  const enrollment = consent.enrollmentDocument(
    replacementBrowser,
    challenge,
    identity.tenantId,
    identity.subjectId,
    "Mike's replacement browser",
  );
  const replacement = await coordinator.enroll(identity, challenge.id, enrollment);

  const oldRequest = await coordinator.inbox(oldToken) as Record<string, unknown>;
  assert.equal(oldRequest.recipient, browser.did);
  const request = await coordinator.inboxForIdentity(identity, replacementBrowser.did) as Record<string, unknown>;
  assert.equal(request.recipient, replacementBrowser.did);
  const replacementTask = await store.getOpenVtcConsentTaskForApprover(identity, pending.id, replacement.approver.id);
  assert.ok(replacementTask);
  assert.notEqual(replacementTask.id, priorTask.id);
  assert.notEqual(replacementTask.payloadDigest, priorTask.payloadDigest);

  const completed = await service.applyOpenVtcDecision(
    replacement.transportToken,
    signedDecision(consent, request, replacementBrowser, "approve"),
    "browser-rotate-decision",
  );
  assert.equal(completed.state, "succeeded");
  await assert.rejects(
    service.applyOpenVtcDecision(oldToken, signedDecision(consent, oldRequest, browser, "approve"), "browser-old-late-decision"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "APPROVAL_STATE_INVALID",
  );
  assert.equal(executor.calls.length, 1);
});

test("the bearer transport token cannot substitute for an approver signature", async () => {
  const { workspace, coordinator, consent, browser, transportToken, service } = await setup();
  await service.createMicrosoft365Delete(
    identity,
    workspace.id,
    { driveId: "drive-tamper", driveItemId: "item-tamper", "If-Match": "etag-tamper" },
    "agent-tamper",
    { policyVersionId: "policy-tamper", policyHash: "c".repeat(64) },
    "browser-tamper-idempotency",
    "browser-tamper-create",
  );
  const request = await coordinator.inbox(transportToken) as Record<string, unknown>;
  const decision = signedDecision(consent, request, browser, "approve");
  (decision.payload as Record<string, unknown>).decision = "deny";
  await assert.rejects(
    service.applyOpenVtcDecision(transportToken, decision, "browser-tamper-decision"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OPENVTC_DECISION_INVALID",
  );
});

test("the local fixture cannot approve a Microsoft 365 operation", async () => {
  const { workspace, executor, service } = await setup();
  const pending = await service.createMicrosoft365Delete(
    identity,
    workspace.id,
    { driveId: "drive-no-fixture", driveItemId: "item-no-fixture", "If-Match": "etag-no-fixture" },
    "agent-no-fixture",
    { policyVersionId: "policy-no-fixture", policyHash: "d".repeat(64) },
    "browser-no-fixture-idempotency",
    "browser-no-fixture-create",
  );
  assert.equal(pending.requiredApprovalChannel, "openvtc-task-consent");
  await assert.rejects(
    service.decideWithFixture(identity, pending.id, "approve", "browser-no-fixture-decision"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "FIXTURE_APPROVAL_NOT_ALLOWED",
  );
  assert.equal(executor.calls.length, 0);
});

test("Control exposes session-bound enrollment and bearer-scoped browser transport", async () => {
  const store = new MemoryWorkspaceStore();
  const consent = new TestOpenVtcConsentClient();
  const coordinator = new OpenVtcApprovalCoordinator(store, consent);
  const proxyToken = "openvtc-api-proxy-token-at-least-24-characters";
  const headers = {
    "x-onecomputer-proxy-token": proxyToken,
    "x-onecomputer-test-tenant-id": identity.tenantId,
    "x-onecomputer-test-user-id": identity.subjectId,
  };
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, { testIdentityMode: true, openVtc: coordinator });
  try {
    const created = await app.inject({ method: "POST", url: "/v1/openvtc/enrollment-challenges", headers });
    assert.equal(created.statusCode, 201);
    const challenge = created.json();
    const browser = consent.createApprover();
    const document = consent.enrollmentDocument(browser, challenge, identity.tenantId, identity.subjectId, "API browser");
    const enrolled = await app.inject({
      method: "POST",
      url: "/v1/openvtc/approvers",
      headers,
      payload: { challengeId: challenge.id, document },
    });
    assert.equal(enrolled.statusCode, 201);
    const token = enrolled.json().transportToken;
    assert.match(token, /^ocvta_[A-Za-z0-9_-]{43}$/);

    const status = await app.inject({ method: "GET", url: "/v1/openvtc/approvers/current", headers });
    assert.equal(status.json().connected, true);
    assert.equal(status.json().approver.approverDid, browser.did);

    const sessionInbox = await app.inject({ method: "GET", url: "/v1/openvtc/approvals/pending", headers });
    assert.equal(sessionInbox.statusCode, 204);

    const invalidTransport = await app.inject({ method: "GET", url: "/v1/openvtc/inbox", headers: { authorization: "Bearer ocvta_invalid" } });
    assert.equal(invalidTransport.statusCode, 401);
    const emptyInbox = await app.inject({ method: "GET", url: "/v1/openvtc/inbox", headers: { authorization: `Bearer ${token}` } });
    assert.equal(emptyInbox.statusCode, 204);
  } finally {
    await app.close();
  }
});
