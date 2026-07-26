import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { IdentityContext } from "@onecomputer/contracts";
import {
  ChannelBrokerService,
  ChannelCredentialVault,
  HttpChannelControlClient,
  type ChannelControlClient,
  type TelegramBotClient,
  type TelegramMessageOptions,
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
  sent: Array<{ token: string; chatId: string; text: string; options?: TelegramMessageOptions }> = [];
  chatActions: Array<{ token: string; chatId: string; action: "typing" }> = [];
  answeredCallbacks: Array<{ token: string; callbackQueryId: string; text?: string }> = [];
  sendFailuresRemaining = 0;
  sendFailureMatch = "";

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

  async sendMessage(received: string, chatId: string, text: string, options?: TelegramMessageOptions) {
    if (this.sendFailuresRemaining > 0 && (!this.sendFailureMatch || text.includes(this.sendFailureMatch))) {
      this.sendFailuresRemaining -= 1;
      throw new Error("temporary Telegram outage");
    }
    this.sent.push({ token: received, chatId, text, options });
  }

  async sendChatAction(received: string, chatId: string, action: "typing") {
    this.chatActions.push({ token: received, chatId, action });
  }

  async answerCallbackQuery(received: string, callbackQueryId: string, text?: string) {
    this.answeredCallbacks.push({ token: received, callbackQueryId, text });
  }
}

class FakeControl implements ChannelControlClient {
  turnDelayMs = 0;
  notice: string | undefined;
  failAfterNotice = false;
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
  }, onNotice?: (notice: string) => Promise<void>) {
    this.turns.push(input);
    if (this.notice) await onNotice?.(this.notice);
    if (this.turnDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.turnDelayMs));
    }
    if (this.failAfterNotice) throw new Error("turn failed after approval");
    return {
      sessionId: input.sessionId ?? `session-${input.agentCatalogId}`,
      text: `${input.agentCatalogId}: ${input.text}`,
      notices: [],
    };
  }
}

test("the channel control client owns a long response timeout instead of inheriting fetch's five-minute header limit", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
    response.write(`${JSON.stringify({
      type: "notice",
      notice: "Approval needed: Send Teams chat message. Open ONEComputer to review this protected action.",
    })}\n`);
    setTimeout(() => {
      response.end(`${JSON.stringify({
        type: "result",
        response: {
          sessionId: "932b72c3-220a-465d-96d0-d1ac11270f25",
          text: "completed",
          notices: ["Approval needed: Send Teams chat message. Open ONEComputer to review this protected action."],
        },
      })}\n`);
    }, 75);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const input = {
    connectionId: "29637bba-a710-49b6-8b44-7dac938a6088",
    identity: alpha,
    workspaceId: "fcebb39a-df27-4b69-acde-44c9542fca29",
    agentCatalogId: "hermes-claw" as const,
    externalSenderId: "10001",
    updateId: "1",
    text: "Complete a long-running task.",
  };
  try {
    const patient = new HttpChannelControlClient(
      `http://127.0.0.1:${address.port}`,
      "channel-control-test-secret-at-least-32-characters",
      250,
    );
    const notices: string[] = [];
    let completed = false;
    const patientTurn = patient.turn(input, async (notice) => { notices.push(notice); })
      .finally(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(notices, [
      "Approval needed: Send Teams chat message. Open ONEComputer to review this protected action.",
    ]);
    assert.equal(completed, false);
    const result = await patientTurn;
    assert.equal(result.text, "completed");
    assert.deepEqual(result.notices, []);

    const impatient = new HttpChannelControlClient(
      `http://127.0.0.1:${address.port}`,
      "channel-control-test-secret-at-least-32-characters",
      20,
    );
    await assert.rejects(
      impatient.turn({ ...input, updateId: "2" }),
      (error: unknown) => Boolean(
        error
        && typeof error === "object"
        && "code" in error
        && error.code === "CHANNEL_CONTROL_UNAVAILABLE"
      ),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

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

test("/agent presents available agent buttons and callback selections switch the sender route", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-agent-menu-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: true,
  });

  telegram.updates = [{ updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "/agent" }];
  await service.pollOnce();

  assert.deepEqual(telegram.sent[0], {
    token,
    chatId: "10001",
    text: "Tap an agent below, then wait for its confirmation before sending a message:",
    options: {
      inlineKeyboard: [
        [{ text: "Hermes Agent", callbackData: "onecomputer:agent:hermes-claw" }],
        [{ text: "Claude CLI", callbackData: "onecomputer:agent:claude-cli" }],
        [{ text: "Codex CLI", callbackData: "onecomputer:agent:codex-cli" }],
      ],
    },
  });

  telegram.updates = [{
    updateId: "2",
    chatId: "10001",
    senderId: "10001",
    chatType: "private",
    callbackData: "onecomputer:agent:codex-cli",
    callbackQueryId: "callback-1",
  }];
  await service.pollOnce();

  assert.deepEqual(telegram.answeredCallbacks, [{ token, callbackQueryId: "callback-1", text: undefined }]);
  assert.equal(telegram.sent.at(-1)?.text, "Agent changed to Codex CLI.");
  telegram.updates = [{ updateId: "3", chatId: "10001", senderId: "10001", chatType: "private", text: "hello" }];
  await service.pollOnce();
  assert.equal(control.turns.at(-1)?.agentCatalogId, "codex-cli");
});

test("/new starts a fresh chat for the sender's current agent without resetting other agents", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-new-chat-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: true,
  });

  telegram.updates = [
    { updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "first Hermes turn" },
    { updateId: "2", chatId: "10001", senderId: "10001", chatType: "private", text: "/agent claude-cli" },
    { updateId: "3", chatId: "10001", senderId: "10001", chatType: "private", text: "first Claude turn" },
    { updateId: "4", chatId: "10001", senderId: "10001", chatType: "private", text: "/new" },
    { updateId: "5", chatId: "10001", senderId: "10001", chatType: "private", text: "fresh Claude turn" },
    { updateId: "6", chatId: "10001", senderId: "10001", chatType: "private", text: "/agent hermes-claw" },
    { updateId: "7", chatId: "10001", senderId: "10001", chatType: "private", text: "continued Hermes turn" },
  ];

  await service.pollOnce();

  assert.deepEqual(control.turns.map((turn) => ({
    agent: turn.agentCatalogId,
    session: turn.sessionId ?? null,
    text: turn.text,
  })), [
    { agent: "hermes-claw", session: null, text: "first Hermes turn" },
    { agent: "claude-cli", session: null, text: "first Claude turn" },
    { agent: "claude-cli", session: null, text: "fresh Claude turn" },
    { agent: "hermes-claw", session: "session-hermes-claw", text: "continued Hermes turn" },
  ]);
  assert.equal(
    telegram.sent.some((message) => message.text === "New chat started with Claude CLI. Send a message when you are ready."),
    true,
  );
  assert.equal(control.turns.some((turn) => turn.text === "/new"), false);
});

test("the broker shows and renews Telegram typing only while an agent turn is pending", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  control.turnDelayMs = 30;
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
    5,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-typing-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: false,
  });

  telegram.updates = [
    { updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "take your time" },
  ];
  await service.pollOnce();

  assert.ok(telegram.chatActions.length >= 2);
  assert.ok(telegram.chatActions.every((action) => (
    action.token === token && action.chatId === "10001" && action.action === "typing"
  )));
  const completedActionCount = telegram.chatActions.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(telegram.chatActions.length, completedActionCount);
  assert.equal(telegram.sent.at(-1)?.text, "hermes-claw: take your time");
});

test("the broker acknowledges an accepted Telegram task before the agent finishes", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  control.turnDelayMs = 40;
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
    5,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-acknowledgement-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: false,
  });
  telegram.updates = [
    { updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "send the deck" },
  ];

  let completed = false;
  const polling = service.pollOnce().finally(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(completed, false);
  assert.equal(telegram.sent[0]?.text, "Got it — I’m starting on that now.");
  await polling;
  assert.equal(telegram.sent.at(-1)?.text, "hermes-claw: send the deck");
});

test("the broker durably retries a completed response without rerunning the agent", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-delivery-retry-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: false,
  });
  telegram.updates = [
    { updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "send the deck" },
  ];
  telegram.sendFailuresRemaining = 1;
  telegram.sendFailureMatch = "hermes-claw:";

  await service.pollOnce();
  assert.deepEqual(telegram.sent.map((message) => message.text), [
    "Got it — I’m starting on that now.",
  ]);
  assert.equal(control.turns.length, 1);

  await service.pollOnce();
  assert.deepEqual(telegram.sent.map((message) => message.text), [
    "Got it — I’m starting on that now.",
    "hermes-claw: send the deck",
  ]);
  assert.equal(control.turns.length, 1);
});

test("the broker forwards approval notices during a turn and keeps a later failure actionable", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  control.notice = "Approval needed: Send Teams chat message. Open ONEComputer to review this protected action.";
  control.failAfterNotice = true;
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-approval-notice-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: false,
  });
  telegram.updates = [
    { updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "send the deck" },
  ];

  await service.pollOnce();

  assert.deepEqual(telegram.sent.map((message) => message.text), [
    "Got it — I’m starting on that now.",
    "Approval needed: Send Teams chat message. Open ONEComputer to review this protected action.",
    "I couldn’t finish the task while the protected action was awaiting review. Open ONEComputer to check the approval, then retry if needed.",
  ]);
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
