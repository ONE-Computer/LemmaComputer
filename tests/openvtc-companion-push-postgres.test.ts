import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { IdentityContext } from "@lemmacomputer/contracts";
import { PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";
import { OpenVtcApprovalCoordinator } from "../apps/control-api/src/openvtc.js";
import type { CompanionPushProvider, CompanionPushSubscription } from "../apps/control-api/src/web-push.js";
import { TestOpenVtcConsentClient } from "./helpers/openvtc-consent.js";

const connectionString = process.env.OPENVTC_PUSH_TEST_DATABASE_URL;

test("PostgreSQL Companion push enqueue is immediate, claimable, and deduplicated", {
  skip: !connectionString,
}, async () => {
  const store = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const identity: IdentityContext = {
    tenantId: `companion-push-test-${randomUUID()}`,
    subjectId: "owner",
    audience: "lemmacomputer-control",
  };
  const sent: string[] = [];
  const provider: CompanionPushProvider = {
    publicKey: "test-public-key",
    protect(value: CompanionPushSubscription) {
      return {
        endpointHash: createHash("sha256").update(value.endpoint).digest("hex"),
        ciphertext: Buffer.from(JSON.stringify(value)).toString("base64url"),
      };
    },
    async sendHint(ciphertext: string) {
      sent.push(ciphertext);
      return { delivered: true, terminal: false };
    },
  };
  const coordinator = new OpenVtcApprovalCoordinator(store, new TestOpenVtcConsentClient(), provider);
  let workspaceId: string | undefined;
  try {
    await store.migrate();
    const approverDid = "did:key:zPostgresCompanion";
    await store.enrollOpenVtcApprover({
      id: randomUUID(),
      identity,
      approverDid,
      verificationMethod: `${approverDid}#zPostgresCompanion`,
      displayName: "PostgreSQL Companion",
      transportTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      enrolledAt: new Date(),
    });
    await coordinator.subscribeCompanion(identity, {
      approverDid,
      installationId: randomUUID(),
      browserFamily: "edge",
      platform: "windows",
      subscription: {
        endpoint: "https://push.example.test/postgres",
        expirationTime: null,
        keys: { p256dh: "p".repeat(65), auth: "a".repeat(22) },
      },
    });

    const workspace = await store.createOrGet(identity, "postgres-companion", randomUUID());
    workspaceId = workspace.id;
    const now = new Date();
    const operation = await store.createGovernedOperation({
      id: randomUUID(),
      identity,
      workspaceId,
      agentId: "agent-postgres-companion",
      capabilityId: "m365-write-protected",
      serverName: "lemmacomputer_ms365",
      toolName: "send-chat-message",
      schemaId: "lemmacomputer.m365.send-chat-message.v1",
      arguments: {
        chatId: "chat-1",
        body: { body: { contentType: "html", content: "Hello" } },
        lemmacomputerAudit: { target: "Project chat", targetType: "chat" },
      },
      operationDigest: "c".repeat(64),
      nonce: randomUUID(),
      safeSummary: "Send Teams chat message: Project chat",
      resourceName: "Project chat",
      resourceLocation: "Microsoft Teams",
      correlationId: "postgres-companion-push-test",
      idempotencyKey: randomUUID(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    assert.ok(operation);

    await coordinator.ensureTask(identity, operation);
    await coordinator.ensureTask(identity, operation);
    assert.equal((await store.listDueOpenVtcCompanionPushDeliveries(new Date(), 10)).length, 1);
    assert.equal(await coordinator.flushCompanionPushQueue(), 1);
    assert.equal(sent.length, 1);
    assert.equal((await store.listDueOpenVtcCompanionPushDeliveries(new Date(), 10)).length, 0);
    await coordinator.ensureTask(identity, operation);
    assert.equal(await coordinator.flushCompanionPushQueue(), 0);
    assert.equal(sent.length, 1);
  } finally {
    if (workspaceId) await store.remove(identity, workspaceId);
    await store.close();
  }
});
