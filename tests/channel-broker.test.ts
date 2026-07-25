import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext } from "@onecomputer/contracts";
import {
  ChannelBrokerService,
  ChannelCredentialVault,
  type ChannelControlClient,
  type TelegramBotClient,
  type TelegramUpdate,
} from "../apps/channel-broker/src/broker.js";
import { MemoryChannelStore } from "../apps/channel-broker/src/store.js";

const alpha: IdentityContext = {
  tenantId: "acme",
  subjectId: "alpha",
  audience: "onecomputer-control",
};
const bravo: IdentityContext = {
  tenantId: "acme",
  subjectId: "bravo",
  audience: "onecomputer-control",
};
const token = "123456789:telegram-token-that-must-remain-write-only";
const secondToken = "987654321:telegram-token-for-the-second-workspace";

class FakeTelegram implements TelegramBotClient {
  updates: TelegramUpdate[] = [];
  sent: Array<{ token: string; chatId: string; text: string }> = [];

  async validate(received: string) {
    assert.ok(received === token || received === secondToken);
    return received === token
      ? { botId: "123456789", username: "onecomputer_test_bot" }
      : { botId: "987654321", username: "onecomputer_second_bot" };
  }

  async getUpdates(received: string, offset: string) {
    assert.ok(received === token || received === secondToken);
    return this.updates.filter((update) => BigInt(update.updateId) >= BigInt(offset));
  }

  async sendMessage(received: string, chatId: string, text: string) {
    this.sent.push({ token: received, chatId, text });
  }
}

class FakeControl implements ChannelControlClient {
  turns: Array<{
    workspaceId: string;
    agentCatalogId: string;
    externalSenderId: string;
    sessionId?: string;
    text: string;
  }> = [];

  async validateRoute(input: { agentCatalogId: string }) {
    if (!["hermes-claw", "claude-cli", "codex-cli"].includes(input.agentCatalogId)) {
      throw new Error("agent unavailable");
    }
  }

  async turn(input: {
    workspaceId: string;
    agentCatalogId: string;
    externalSenderId: string;
    sessionId?: string;
    text: string;
  }) {
    this.turns.push(input);
    return {
      sessionId: input.sessionId ?? `session-${input.agentCatalogId}`,
      text: `${input.agentCatalogId}: ${input.text}`,
      notices: [],
    };
  }
}

test("Telegram credentials are encrypted, write-only, and owner scoped", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const vault = new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters");
  const service = new ChannelBrokerService(
    store,
    vault,
    telegram,
    new FakeControl(),
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-test-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });

  const saved = await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001", "10001", "10002"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: true,
  });

  assert.equal(saved.state, "connected");
  assert.deepEqual(saved.allowedUserIds, ["10001", "10002"]);
  assert.ok(!JSON.stringify(saved).includes(token));

  const stored = await store.getOwnedChannelConnection(alpha, "telegram", workspace.id);
  assert.ok(stored);
  assert.match(stored!.credentialCiphertext, /^k1\./);
  assert.ok(!stored!.credentialCiphertext.includes(token));
  assert.throws(
    () => vault.unprotect(bravo, stored!.credentialId, stored!.credentialCiphertext),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CHANNEL_CREDENTIAL_UNAVAILABLE"),
  );
  assert.throws(
    () => vault.unprotect(alpha, "92b8576c-83f1-4c7b-bbcb-6d4d50fbab24", stored!.credentialCiphertext),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CHANNEL_CREDENTIAL_UNAVAILABLE"),
  );
  assert.equal(await service.status(bravo, workspace.id), null);
  await service.disconnect(alpha, workspace.id);
  assert.equal(await store.getOwnedChannelConnection(alpha, "telegram", workspace.id), null);
  assert.equal((await service.listCredentials(alpha)).credentials.length, 1);
  await service.deleteCredential(alpha, credential.id);
  assert.equal((await service.listCredentials(alpha)).credentials.length, 0);
});

test("the broker allowlists senders, deduplicates updates, and isolates sessions by agent", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-routing-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: true,
  });

  telegram.updates = [
    { updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "hello" },
    { updateId: "2", chatId: "99999", senderId: "99999", chatType: "private", text: "steal data" },
    { updateId: "3", chatId: "10001", senderId: "10001", chatType: "private", text: "/agent claude-cli" },
    { updateId: "4", chatId: "10001", senderId: "10001", chatType: "private", text: "continue" },
  ];

  await service.pollOnce();
  await service.pollOnce();

  assert.deepEqual(control.turns.map((turn) => ({
    agent: turn.agentCatalogId,
    session: turn.sessionId ?? null,
    text: turn.text,
  })), [
    { agent: "hermes-claw", session: null, text: "hello" },
    { agent: "claude-cli", session: null, text: "continue" },
  ]);
  assert.equal(telegram.sent.some((message) => message.chatId === "99999"), false);
  assert.equal(telegram.sent.filter((message) => message.text === "Agent changed to Claude CLI.").length, 1);

  telegram.updates = [
    { updateId: "5", chatId: "10001", senderId: "10001", chatType: "private", text: "/agent hermes-agent" },
    { updateId: "6", chatId: "10001", senderId: "10001", chatType: "private", text: "back" },
  ];
  await service.pollOnce();

  assert.equal(control.turns[2]!.agentCatalogId, "hermes-claw");
  assert.equal(control.turns[2]!.sessionId, "session-hermes-claw");
});

test("each workspace can own one Telegram connection and credentials cannot be shared across workspaces", async () => {
  const store = new MemoryChannelStore();
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    new FakeTelegram(),
    new FakeControl(),
  );
  const first = await store.createOrGet(alpha, "workspace-first", "channel-first");
  const second = await store.createOrGet(alpha, "workspace-second", "channel-second");
  const firstCredential = await service.saveCredential(alpha, { botToken: token });
  const secondCredential = await service.saveCredential(alpha, { botToken: secondToken });
  const routing = {
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw" as const,
    allowAgentSwitch: false,
  };

  await service.saveConnection(alpha, { workspaceId: first.id, credentialId: firstCredential.id, ...routing });
  await assert.rejects(
    service.saveConnection(alpha, { workspaceId: second.id, credentialId: firstCredential.id, ...routing }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CHANNEL_CREDENTIAL_IN_USE"),
  );
  await service.saveConnection(alpha, { workspaceId: second.id, credentialId: secondCredential.id, ...routing });

  assert.equal((await store.listActiveChannelConnections("telegram")).length, 2);
  assert.equal((await service.status(alpha, first.id))?.credentialId, firstCredential.id);
  assert.equal((await service.status(alpha, second.id))?.credentialId, secondCredential.id);
});
