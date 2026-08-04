import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { channelAttachmentMaxBytes, type ChannelTurnRequest, type IdentityContext } from "@onecomputer/contracts";
import {
  ChannelBrokerService,
  ChannelCredentialVault,
  groupTelegramUpdates,
  HttpChannelControlClient,
  TelegramBotApiClient,
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeTelegram implements TelegramBotClient {
  updates: TelegramUpdate[] = [];
  updateRequests: Array<{ token: string; offset: string; timeoutSeconds?: number }> = [];
  sent: Array<{ token: string; chatId: string; text: string; options?: TelegramMessageOptions }> = [];
  sentDocuments: Array<{ token: string; chatId: string; filename: string; data: Buffer }> = [];
  documentFailuresRemaining = 0;
  edits: Array<{ token: string; chatId: string; messageId: string; text: string }> = [];
  chatActions: Array<{ token: string; chatId: string; action: "typing" }> = [];
  answeredCallbacks: Array<{ token: string; callbackQueryId: string; text?: string }> = [];
  downloads = new Map<string, Buffer>();
  downloadRequests: Array<{ token: string; fileId: string; maxBytes: number }> = [];
  sendFailuresRemaining = 0;
  sendFailureMatch = "";

  async validate(received: string) {
    assert.ok(received === token || received === secondToken);
    return received === token
      ? { botId: "123456789", username: "onecomputer_test_bot" }
      : { botId: "987654321", username: "onecomputer_second_bot" };
  }

  async getUpdates(received: string, offset: string, timeoutSeconds?: number) {
    assert.ok(received === token || received === secondToken);
    this.updateRequests.push({ token: received, offset, timeoutSeconds });
    return this.updates.filter((update) => BigInt(update.updateId) >= BigInt(offset));
  }

  async downloadFile(received: string, fileId: string, maxBytes: number) {
    this.downloadRequests.push({ token: received, fileId, maxBytes });
    const data = this.downloads.get(fileId);
    if (!data) throw new Error("missing fake Telegram file");
    if (data.length > maxBytes) throw new Error("fake Telegram file exceeds limit");
    return data;
  }

  async sendMessage(received: string, chatId: string, text: string, options?: TelegramMessageOptions) {
    if (this.sendFailuresRemaining > 0 && (!this.sendFailureMatch || text.includes(this.sendFailureMatch))) {
      this.sendFailuresRemaining -= 1;
      throw new Error("temporary Telegram outage");
    }
    this.sent.push({ token: received, chatId, text, options });
    return String(this.sent.length);
  }

  async sendDocument(received: string, chatId: string, artifact: { filename: string }, data: Buffer) {
    if (this.documentFailuresRemaining > 0) { this.documentFailuresRemaining -= 1; throw new Error("temporary document outage"); }
    this.sentDocuments.push({ token: received, chatId, filename: artifact.filename, data });
    return `document-${this.sentDocuments.length}`;
  }

  async editMessage(received: string, chatId: string, messageId: string, text: string) {
    this.edits.push({ token: received, chatId, messageId, text });
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
  textDeltas: string[] = [];
  state: "needs_input" | "completed" | "cancelled" | "failed" = "completed";
  turns: ChannelTurnRequest[] = [];
  artifacts: Array<{ artifactId: string; mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"; filename: string; byteLength: number; sha256: string }> = [];
  artifactData = new Map<string, Buffer>();

  async validateRoute(input: { agentCatalogId: string }) {
    if (!["hermes-claw", "claude-cli", "codex-cli"].includes(input.agentCatalogId)) {
      throw new Error("agent unavailable");
    }
  }

  async downloadArtifact(_route: unknown, artifact: { artifactId: string }) {
    const data = this.artifactData.get(artifact.artifactId);
    if (!data) throw new Error("missing fake artifact");
    return data;
  }

  async turn(input: ChannelTurnRequest, onNotice?: (notice: string) => Promise<void>, onTextDelta?: (delta: string) => Promise<void>) {
    this.turns.push(input);
    if (this.notice) await onNotice?.(this.notice);
    for (const delta of this.textDeltas) await onTextDelta?.(delta);
    if (this.turnDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.turnDelayMs));
    }
    if (this.failAfterNotice) throw new Error("turn failed after approval");
    return {
      sessionId: input.sessionId ?? `session-${input.agentCatalogId}`,
      text: this.textDeltas.join("") || `${input.agentCatalogId}: ${input.text ?? "Analyze the attached file."}`,
      notices: [],
      ...(this.artifacts.length ? { artifacts: this.artifacts } : {}),
      state: this.state,
    };
  }
}

test("the channel control client owns a long response timeout instead of inheriting fetch's five-minute header limit", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
    response.write(`${JSON.stringify({
      type: "notice",
      notice: "Approval needed: Send Teams chat message. Open LemmaComputer to review this protected action.",
    })}\n`);
    response.write(`${JSON.stringify({
      type: "text-delta",
      delta: "Working on it. ",
    })}\n`);
    setTimeout(() => {
      response.end(`${JSON.stringify({
        type: "result",
        response: {
          sessionId: "932b72c3-220a-465d-96d0-d1ac11270f25",
          text: "Working on it. Completed.",
          notices: ["Approval needed: Send Teams chat message. Open LemmaComputer to review this protected action."],
          state: "completed",
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
    const deltas: string[] = [];
    let completed = false;
    const patientTurn = patient.turn(
      input,
      async (notice) => { notices.push(notice); },
      async (delta) => { deltas.push(delta); },
    )
      .finally(() => { completed = true; });
    await waitUntil(() => notices.length === 1 && deltas.length === 1);
    assert.deepEqual(notices, [
      "Approval needed: Send Teams chat message. Open LemmaComputer to review this protected action.",
    ]);
    assert.deepEqual(deltas, ["Working on it. "]);
    assert.equal(completed, false);
    const result = await patientTurn;
    assert.equal(result.text, "Working on it. Completed.");
    assert.deepEqual(result.notices, []);
    assert.equal(result.state, "completed");

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

test("the channel control client downloads only hash-bound generated artifacts", async () => {
  const deck = Buffer.from("control-artifact-download");
  const artifact = { artifactId: "artifact-55555555555555555555555555555555", filename: "Plan.pptx",
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const,
    byteLength: deck.length, sha256: createHash("sha256").update(deck).digest("hex") };
  const server = createServer((request, response) => {
    assert.equal(request.url, "/internal/v1/channels/artifacts");
    assert.equal(request.headers["x-onecomputer-channel-token"], "channel-control-test-secret-at-least-32-characters");
    response.writeHead(200, { "content-type": artifact.mediaType, "content-length": deck.length });
    response.end(deck);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const client = new HttpChannelControlClient(`http://127.0.0.1:${address.port}`, "channel-control-test-secret-at-least-32-characters");
  const route = { connectionId: "29637bba-a710-49b6-8b44-7dac938a6088", identity: alpha,
    workspaceId: "fcebb39a-df27-4b69-acde-44c9542fca29", agentCatalogId: "hermes-claw" as const, externalSenderId: "10001" };
  try {
    assert.deepEqual(await client.downloadArtifact(route, artifact), deck);
    await assert.rejects(client.downloadArtifact(route, { ...artifact, sha256: "0".repeat(64) }), /changed before delivery/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("Telegram parses document captions and largest photos, then downloads through a bounded getFile URL", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const deck = Buffer.from("telegram-presentation-bytes");
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/getUpdates")) {
      return Response.json({
        ok: true,
        result: [
          {
            update_id: 10,
            message: {
              from: { id: 10001 },
              chat: { id: 10001, type: "private" },
              caption: "Save this in OneDrive",
              document: {
                file_id: "deck-file-id",
                file_unique_id: "deck-unique-id",
                file_name: "LemmaComputer-Architecture.pptx",
                mime_type: "application/octet-stream",
                file_size: deck.length,
              },
            },
          },
          {
            update_id: 11,
            message: {
              from: { id: 10001 },
              chat: { id: 10001, type: "private" },
              media_group_id: "album-1",
              photo: [
                { file_id: "small-photo", file_unique_id: "small", width: 90, height: 90, file_size: 100 },
                { file_id: "large-photo", file_unique_id: "large", width: 1280, height: 720, file_size: 500 },
              ],
            },
          },
        ],
      });
    }
    if (url.endsWith("/getFile")) {
      const fileId = JSON.parse(String(init?.body)).file_id;
      return Response.json({
        ok: true,
        result: fileId === "too-large"
          ? { file_path: "documents/large.bin", file_size: channelAttachmentMaxBytes + 1 }
          : fileId === "traversal"
            ? { file_path: "documents/../secret", file_size: deck.length }
            : { file_path: "documents/Quarterly deck.pptx", file_size: deck.length },
      });
    }
    if (url.includes("/file/bot")) {
      return new Response(deck, { headers: { "content-length": String(deck.length) } });
    }
    throw new Error(`Unexpected Telegram URL: ${url}`);
  }) as typeof fetch;
  const client = new TelegramBotApiClient(fetcher);

  const updates = await client.getUpdates(token, "0");
  assert.deepEqual(updates[0], {
    updateId: "10",
    senderId: "10001",
    chatId: "10001",
    chatType: "private",
    text: "Save this in OneDrive",
    attachment: {
      fileId: "deck-file-id",
      fileUniqueId: "deck-unique-id",
      filename: "LemmaComputer-Architecture.pptx",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileSize: deck.length,
    },
  });
  assert.equal(updates[1]?.attachment?.fileId, "large-photo");
  assert.equal(updates[1]?.attachment?.mediaType, "image/jpeg");
  assert.equal(updates[1]?.mediaGroupId, "album-1");
  assert.deepEqual(await client.downloadFile(token, "deck-file-id", channelAttachmentMaxBytes), deck);
  assert.equal(calls.at(-1)?.url.includes("documents/Quarterly%20deck.pptx"), true);
  assert.equal(calls.at(-1)?.init?.redirect, "error");
  await assert.rejects(
    client.downloadFile(token, "too-large", channelAttachmentMaxBytes),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CHANNEL_ATTACHMENT_TOO_LARGE"),
  );
  await assert.rejects(
    client.downloadFile(token, "traversal", channelAttachmentMaxBytes),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "TELEGRAM_INVALID_RESPONSE"),
  );
});

test("Telegram uploads generated documents with sendDocument multipart metadata", async () => {
  const deck = Buffer.from("generated-deck");
  const artifact = {
    artifactId: "artifact-22222222222222222222222222222222",
    filename: "Board Update.pptx",
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const,
    byteLength: deck.length,
    sha256: createHash("sha256").update(deck).digest("hex"),
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input).endsWith("/sendDocument"), true);
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("chat_id"), "10001");
    const document = init.body.get("document");
    assert.ok(document instanceof Blob);
    assert.equal((document as Blob & { name?: string }).name, "Board Update.pptx");
    assert.equal(document.type, artifact.mediaType);
    assert.equal(Buffer.from(await document.arrayBuffer()).toString(), deck.toString());
    return Response.json({ ok: true, result: { message_id: 44 } });
  }) as typeof fetch;
  const client = new TelegramBotApiClient(fetcher);
  assert.equal(await client.sendDocument(token, "10001", artifact, deck), "44");
});

test("Telegram groups adjacent text, files, and media albums without merging unrelated messages or commands", () => {
  const text = { updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "Review this" };
  const file = {
    updateId: "2", chatId: "10001", senderId: "10001", chatType: "private",
    attachment: { fileId: "deck", filename: "deck.pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  };
  const photo = {
    updateId: "3", chatId: "10001", senderId: "10001", chatType: "private", mediaGroupId: "album-1",
    attachment: { fileId: "photo-1", filename: "photo-1.jpg", mediaType: "image/jpeg" },
  };
  const secondPhoto = {
    updateId: "4", chatId: "10001", senderId: "10001", chatType: "private", mediaGroupId: "album-1",
    attachment: { fileId: "photo-2", filename: "photo-2.jpg", mediaType: "image/jpeg" },
  };
  assert.deepEqual(groupTelegramUpdates([text, file]).map((group) => group.map((item) => item.updateId)), [["1", "2"]]);
  assert.deepEqual(groupTelegramUpdates([file, text]).map((group) => group.map((item) => item.updateId)), [["2", "1"]]);
  assert.deepEqual(groupTelegramUpdates([photo, secondPhoto]).map((group) => group.map((item) => item.updateId)), [["3", "4"]]);
  assert.deepEqual(groupTelegramUpdates([
    text,
    { ...text, updateId: "5", text: "A separate thought" },
    { ...text, updateId: "6", text: "/new" },
  ]).map((group) => group.map((item) => item.updateId)), [["1"], ["5"], ["6"]]);
});

test("Telegram waits briefly for a companion file, then sends one acknowledgement and one agent turn", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
    5,
    25,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-composition-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: false,
  });
  const deck = Buffer.from("presentation-bytes");
  telegram.downloads.set("deck-file", deck);
  telegram.updates = [{
    updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "Summarize this deck",
  }];
  const polling = service.pollOnce();
  setTimeout(() => telegram.updates.push({
    updateId: "2",
    chatId: "10001",
    senderId: "10001",
    chatType: "private",
    attachment: {
      fileId: "deck-file",
      filename: "Business-Overview.pptx",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileSize: deck.length,
    },
  }), 5);
  await polling;

  assert.equal(control.turns.length, 1);
  assert.equal(control.turns[0]?.text, "Summarize this deck");
  assert.equal(control.turns[0]?.attachments?.[0]?.filename, "Business-Overview.pptx");
  assert.equal(telegram.sent.filter((message) => message.text === "Message received.").length, 1);
  assert.equal(telegram.updateRequests.some((request) => request.timeoutSeconds === 0), true);
  await service.pollOnce();
  assert.equal(control.turns.length, 1);
});

test("Telegram forwards bounded files and images while rejecting unsupported or oversized attachments", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-attachment-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: false,
  });
  const deck = Buffer.from("presentation-bytes");
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  telegram.downloads.set("deck-file", deck);
  telegram.downloads.set("photo-file", photo);

  telegram.updates = [{
    updateId: "1",
    chatId: "10001",
    senderId: "10001",
    chatType: "private",
    text: "Save this in OneDrive",
    attachment: {
      fileId: "deck-file",
      filename: "Architecture.pptx",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileSize: deck.length,
    },
  }];
  await service.pollOnce();
  assert.equal(control.turns[0]?.text, "Save this in OneDrive");
  assert.deepEqual(control.turns[0]?.attachments, [{
    type: "file",
    filename: "Architecture.pptx",
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    url: `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${deck.toString("base64")}`,
  }]);

  telegram.updates = [{
    updateId: "2",
    chatId: "10001",
    senderId: "10001",
    chatType: "private",
    attachment: { fileId: "photo-file", filename: "photo.jpg", mediaType: "image/jpeg", fileSize: photo.length },
  }];
  await service.pollOnce();
  assert.equal(control.turns[1]?.text, undefined);
  assert.equal(control.turns[1]?.attachments?.[0]?.mediaType, "image/jpeg");

  telegram.updates = [{
    updateId: "3",
    chatId: "10001",
    senderId: "10001",
    chatType: "private",
    attachment: { fileId: "zip-file", filename: "archive.zip", mediaType: "application/zip", fileSize: 100 },
  }];
  await service.pollOnce();
  assert.equal(control.turns.length, 2);
  assert.equal(telegram.sent.at(-1)?.text.includes("not supported"), true);

  telegram.updates = [{
    updateId: "4",
    chatId: "10001",
    senderId: "10001",
    chatType: "private",
    attachment: { fileId: "large-file", filename: "large.pdf", mediaType: "application/pdf", fileSize: channelAttachmentMaxBytes + 1 },
  }];
  await service.pollOnce();
  assert.equal(control.turns.length, 2);
  assert.equal(telegram.sent.at(-1)?.text.includes("20 MB or smaller"), true);
  assert.deepEqual(telegram.downloadRequests.map((request) => request.fileId), ["deck-file", "photo-file"]);
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
  assert.equal(telegram.sent[0]?.text, "Message received.");
  assert.equal(telegram.sent[0]?.options?.disableNotification, true);
  await polling;
  assert.equal(telegram.sent.at(-1)?.text, "hermes-claw: send the deck");
});

test("the broker streams native agent text by editing one Telegram message and resumes needs_input sessions", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  control.textDeltas = [
    "Which workspace should I use",
    " for the quarterly report?",
  ];
  control.state = "needs_input";
  const service = new ChannelBrokerService(
    store,
    new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"),
    telegram,
    control,
  );
  const workspace = await store.createOrGet(alpha, "personal", "channel-streaming-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, {
    workspaceId: workspace.id,
    credentialId: credential.id,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: false,
  });

  telegram.updates = [
    { updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "Prepare the report" },
  ];
  await service.pollOnce();

  assert.deepEqual(telegram.sent.map((message) => message.text), [
    "Message received.",
    "Which workspace should I use",
  ]);
  assert.equal(telegram.edits.at(-1)?.text, "Which workspace should I use for the quarterly report?");
  assert.equal(control.turns[0]?.sessionId, undefined);

  telegram.updates = [
    { updateId: "2", chatId: "10001", senderId: "10001", chatType: "private", text: "Use Finance" },
  ];
  await service.pollOnce();
  assert.equal(control.turns[1]?.sessionId, "session-hermes-claw");
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
    "Message received.",
  ]);
  assert.equal(control.turns.length, 1);

  await service.pollOnce();
  assert.deepEqual(telegram.sent.map((message) => message.text), [
    "Message received.",
    "hermes-claw: send the deck",
  ]);
  assert.equal(control.turns.length, 1);
});

test("the broker sends generated PowerPoint artifacts and retries file delivery without rerunning the agent", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  const service = new ChannelBrokerService(store, new ChannelCredentialVault("channel-vault-test-secret-at-least-32-characters"), telegram, control);
  const workspace = await store.createOrGet(alpha, "personal", "channel-generated-artifact-workspace");
  const credential = await service.saveCredential(alpha, { botToken: token });
  await service.saveConnection(alpha, { workspaceId: workspace.id, credentialId: credential.id, allowedUserIds: ["10001"], defaultAgentId: "hermes-claw", allowAgentSwitch: false });
  const deck = Buffer.from("generated-powerpoint-bytes");
  const artifact = {
    artifactId: "artifact-11111111111111111111111111111111",
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const,
    filename: "Quarterly-Review.pptx",
    byteLength: deck.length,
    sha256: createHash("sha256").update(deck).digest("hex"),
  };
  control.artifacts = [artifact];
  control.artifactData.set(artifact.artifactId, deck);
  telegram.documentFailuresRemaining = 1;
  telegram.updates = [{ updateId: "1", chatId: "10001", senderId: "10001", chatType: "private", text: "Make and send me a PowerPoint" }];

  await service.pollOnce();
  assert.equal(control.turns.length, 1);
  assert.equal(telegram.sentDocuments.length, 0);
  assert.equal(telegram.sent.at(-1)?.text, "hermes-claw: Make and send me a PowerPoint");

  await service.pollOnce();
  assert.equal(control.turns.length, 1);
  assert.deepEqual(telegram.sentDocuments.map((item) => ({ filename: item.filename, data: item.data.toString() })), [
    { filename: "Quarterly-Review.pptx", data: "generated-powerpoint-bytes" },
  ]);
});

test("the broker forwards approval notices during a turn and keeps a later failure actionable", async () => {
  const store = new MemoryChannelStore();
  const telegram = new FakeTelegram();
  const control = new FakeControl();
  control.notice = "Approval needed: Send Teams chat message. Open LemmaComputer to review this protected action.";
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
    "Message received.",
    "Approval needed: Send Teams chat message. Open LemmaComputer to review this protected action.",
    "I couldn’t finish the task while the protected action was awaiting review. Open LemmaComputer to check the approval, then retry if needed.",
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
