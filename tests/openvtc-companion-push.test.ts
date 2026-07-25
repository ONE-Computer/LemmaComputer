import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { IdentityContext } from "@onecomputer/contracts";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import webPush from "web-push";
import { OpenVtcApprovalCoordinator } from "../apps/control-api/src/openvtc.js";
import {
  genericCompanionPushPayload,
  WebPushProvider,
  type CompanionPushProvider,
  type CompanionPushSubscription,
} from "../apps/control-api/src/web-push.js";
import { TestOpenVtcConsentClient } from "./helpers/openvtc-consent.js";

const identity: IdentityContext = { tenantId: "tenant-companion", subjectId: "owner-companion", audience: "onecomputer-control" };
class FakePushProvider implements CompanionPushProvider {
  readonly publicKey = "fake-vapid-public-key";
  sent: string[] = [];

  protect(subscription: CompanionPushSubscription) {
    return {
      endpointHash: createHash("sha256").update(subscription.endpoint).digest("hex"),
      ciphertext: Buffer.from(JSON.stringify(subscription)).toString("base64url"),
    };
  }

  async sendHint(ciphertext: string) {
    this.sent.push(ciphertext);
    return { delivered: true, terminal: false };
  }
}

const enroll = (store: MemoryWorkspaceStore, did: string) => store.enrollOpenVtcApprover({
  id: randomUUID(),
  identity,
  approverDid: did,
  verificationMethod: `${did}#${did.slice("did:key:".length)}`,
  displayName: did.endsWith("A") ? "Office browser" : "Phone browser",
  transportTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
  enrolledAt: new Date(),
});

const subscription = (name: string): CompanionPushSubscription => ({
  endpoint: `https://push.example.test/${name}`,
  expirationTime: null,
  keys: { p256dh: "p".repeat(65), auth: "a".repeat(22) },
});

test("companion subscriptions are identity-bound, redacted, and receive one deduplicated hint per task", async () => {
  const store = new MemoryWorkspaceStore();
  const provider = new FakePushProvider();
  const coordinator = new OpenVtcApprovalCoordinator(store, new TestOpenVtcConsentClient(), provider);
  const first = await enroll(store, "did:key:zCompanionA");
  const second = await enroll(store, "did:key:zCompanionB");

  for (const [approver, name] of [[first, "office"], [second, "phone"]] as const) {
    await coordinator.subscribeCompanion(identity, {
      approverDid: approver.approverDid,
      installationId: randomUUID(),
      browserFamily: name === "office" ? "edge" : "safari",
      platform: name === "office" ? "windows" : "ios",
      subscription: subscription(name),
    });
  }

  await assert.rejects(
    coordinator.subscribeCompanion({ ...identity, subjectId: "other-owner" }, {
      approverDid: first.approverDid,
      installationId: randomUUID(),
      browserFamily: "edge",
      platform: "windows",
      subscription: subscription("cross-owner"),
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OPENVTC_APPROVER_NOT_FOUND",
  );

  const workspace = await store.createOrGet(identity, "companion", randomUUID());
  const now = new Date();
  const operation = await store.createGovernedOperation({
    id: randomUUID(),
    identity,
    workspaceId: workspace.id,
    agentId: "agent-companion",
    capabilityId: "m365-write-protected",
    serverName: "onecomputer_ms365",
    toolName: "send-mail",
    schemaId: "onecomputer.m365.send-mail.v1",
    arguments: { draftId: "redacted" },
    operationDigest: "a".repeat(64),
    nonce: randomUUID(),
    safeSummary: "Send a prepared email",
    resourceName: "Prepared email",
    resourceLocation: "Outlook Mail",
    correlationId: "companion-push-test",
    idempotencyKey: randomUUID(),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  });
  assert.ok(operation);

  await coordinator.ensureTask(identity, operation);
  await coordinator.ensureTask(identity, operation);
  assert.equal(provider.sent.length, 2);

  const publicStatus = await coordinator.companions(identity);
  assert.equal(publicStatus.companions.length, 2);
  const serialized = JSON.stringify(publicStatus);
  assert.ok(!serialized.includes("push.example.test"));
  assert.ok(!serialized.includes("p".repeat(65)));
  assert.ok(!serialized.includes("a".repeat(22)));
});

test("the Web Push adapter encrypts subscriptions and the notification payload carries no approval authority", async () => {
  const keys = webPush.generateVAPIDKeys();
  const provider = new WebPushProvider({
    subject: "mailto:security@example.test",
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subscriptionSecret: "subscription-secret-that-is-at-least-thirty-two-bytes",
  });
  const raw = subscription("encrypted");
  const protectedValue = provider.protect(raw);
  assert.equal(protectedValue.endpointHash, createHash("sha256").update(raw.endpoint).digest("hex"));
  assert.ok(!protectedValue.ciphertext.includes(raw.endpoint));
  assert.ok(!protectedValue.ciphertext.includes(raw.keys.p256dh));
  assert.deepEqual(JSON.parse(genericCompanionPushPayload), { version: "1", event: "approval-pending" });
  assert.ok(!/operation|task|tenant|subject|digest|token|decision|approve/i.test(genericCompanionPushPayload));

  const wrongKeyProvider = new WebPushProvider({
    subject: "mailto:security@example.test",
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subscriptionSecret: "a-different-subscription-secret-with-thirty-two-bytes",
  });
  assert.deepEqual(await wrongKeyProvider.sendHint(protectedValue.ciphertext), {
    delivered: false,
    terminal: true,
    failureCode: "WEB_PUSH_SUBSCRIPTION_DECRYPT_FAILED",
  });
});

test("the companion service worker never caches or decides a task", async () => {
  const source = await readFile(new URL("../apps/web/public/companion-sw.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /addEventListener\(["']fetch["']/);
  assert.doesNotMatch(source, /\bactions\s*:/);
  assert.doesNotMatch(source, /\bapprove\b|\bdeny\b|\btoken\b|\bdigest\b|\btenant\b|\bsubject\b/i);
  assert.match(source, /Object\.keys\(payload\)\.length === 2/);
  assert.match(source, /caches\.delete/);
});
