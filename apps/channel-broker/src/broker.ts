import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  OneComputerError,
  channelRouteSchema,
  channelTurnRequestSchema,
  channelTurnResponseSchema,
  chatAgentCatalogIdSchema,
  saveTelegramChannelConnectionSchema,
  saveTelegramCredentialSchema,
  telegramChannelConnectionStatusSchema,
  telegramCredentialListSchema,
  telegramCredentialStatusSchema,
  type ChannelRoute,
  type ChannelTurnRequest,
  type ChannelTurnResponse,
  type ChatAgentCatalogId,
  type IdentityContext,
  type TelegramChannelConnectionStatus,
  type TelegramCredentialStatus,
} from "@onecomputer/contracts";
import type { ChannelConnectionRecord, ChannelCredentialRecord, ChannelStore } from "./store.js";

export type TelegramUpdate = {
  updateId: string;
  chatId: string;
  senderId: string;
  chatType: string;
  text?: string;
  callbackData?: string;
  callbackQueryId?: string;
};

export type TelegramInlineButton = {
  text: string;
  callbackData: string;
};

export type TelegramMessageOptions = {
  inlineKeyboard?: readonly (readonly TelegramInlineButton[])[];
};

export interface TelegramBotClient {
  validate(token: string): Promise<{ botId: string; username: string | null }>;
  getUpdates(token: string, offset: string): Promise<TelegramUpdate[]>;
  sendMessage(token: string, chatId: string, text: string, options?: TelegramMessageOptions): Promise<void>;
  sendChatAction(token: string, chatId: string, action: "typing"): Promise<void>;
  answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void>;
}

export interface ChannelControlClient {
  validateRoute(input: ChannelRoute): Promise<void>;
  turn(input: ChannelTurnRequest): Promise<ChannelTurnResponse>;
}

export class HttpChannelControlClient implements ChannelControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  private async post(path: string, input: unknown) {
    const target = new URL(path, this.baseUrl);
    if (!["http:", "https:"].includes(target.protocol)) {
      throw new OneComputerError("CHANNEL_CONTROL_UNAVAILABLE", "ONEComputer Control is unavailable", 503, true);
    }
    const payload = Buffer.from(JSON.stringify(input));
    let response: { statusCode: number; body: string };
    try {
      response = await new Promise((resolve, reject) => {
        const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(payload.length),
            "x-onecomputer-channel-token": this.internalToken,
          },
        }, (upstream) => {
          const chunks: Buffer[] = [];
          let size = 0;
          upstream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024) {
              request.destroy(new Error("Control response exceeded its limit"));
              return;
            }
            chunks.push(chunk);
          });
          upstream.on("end", () => resolve({
            statusCode: upstream.statusCode ?? 502,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
          upstream.on("error", reject);
        });
        request.setTimeout(this.timeoutMs, () => request.destroy(new Error("Control request timed out")));
        request.on("error", reject);
        request.end(payload);
      });
    } catch {
      throw new OneComputerError("CHANNEL_CONTROL_UNAVAILABLE", "ONEComputer Control is unavailable", 503, true);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new OneComputerError("CHANNEL_ROUTE_REJECTED", "ONEComputer rejected the channel route", response.statusCode, response.statusCode >= 500);
    }
    if (response.statusCode === 204) return null;
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new OneComputerError("CHANNEL_CONTROL_INVALID_RESPONSE", "ONEComputer Control returned an invalid response", 502, true);
    }
  }

  async validateRoute(input: ChannelRoute) {
    await this.post("/internal/v1/channels/routes/validate", channelRouteSchema.parse(input));
  }

  async turn(input: ChannelTurnRequest) {
    return channelTurnResponseSchema.parse(
      await this.post("/internal/v1/channels/turns", channelTurnRequestSchema.parse(input)),
    );
  }
}

const key = (secret: string) => createHash("sha256")
  .update("onecomputer/channel-credential/k1\0")
  .update(secret)
  .digest();

const additionalData = (identity: IdentityContext, credentialId: string) => Buffer.from(
  `onecomputer/channel-credential/k1:${identity.tenantId}:${identity.subjectId}:${credentialId}:telegram_bot_token`,
  "utf8",
);

export class ChannelCredentialVault {
  private readonly encryptionKey: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("Channel credential secret must be at least 32 characters");
    this.encryptionKey = key(secret);
  }

  protect(identity: IdentityContext, credentialId: string, plaintext: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(additionalData(identity, credentialId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `k1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  unprotect(identity: IdentityContext, credentialId: string, protectedValue: string) {
    try {
      const [version, iv, tag, ciphertext, extra] = protectedValue.split(".");
      if (version !== "k1" || !iv || !tag || !ciphertext || extra) throw new Error("invalid ciphertext");
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
      decipher.setAAD(additionalData(identity, credentialId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new OneComputerError(
        "CHANNEL_CREDENTIAL_UNAVAILABLE",
        "The channel credential could not be unlocked",
        503,
        true,
      );
    }
  }

  fingerprint(plaintext: string) {
    return createHmac("sha256", this.encryptionKey)
      .update("onecomputer/channel-credential-fingerprint/k1\0")
      .update(plaintext)
      .digest("base64url");
  }
}

const botResponseSchema = {
  object(value: unknown) {
    if (!value || typeof value !== "object") throw new Error("invalid Telegram response");
    return value as Record<string, unknown>;
  },
};

export class TelegramBotApiClient implements TelegramBotClient {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly apiOrigin = "https://api.telegram.org",
  ) {
    if (apiOrigin !== "https://api.telegram.org") {
      throw new Error("Telegram Bot API origin must be exactly https://api.telegram.org");
    }
  }

  private async request(token: string, method: string, body?: Record<string, unknown>) {
    const response = await this.fetcher(`${this.apiOrigin}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(35_000),
    });
    const payload = botResponseSchema.object(await response.json().catch(() => null));
    if (!response.ok || payload.ok !== true) {
      throw new OneComputerError("TELEGRAM_API_UNAVAILABLE", "Telegram rejected the bot request", 503, true);
    }
    return payload.result;
  }

  async validate(token: string) {
    const result = botResponseSchema.object(await this.request(token, "getMe"));
    return {
      botId: String(result.id),
      username: typeof result.username === "string" ? result.username : null,
    };
  }

  async getUpdates(token: string, offset: string) {
    const result = await this.request(token, "getUpdates", {
      offset,
      timeout: 20,
      allowed_updates: ["message", "callback_query"],
    });
    if (!Array.isArray(result)) throw new OneComputerError("TELEGRAM_INVALID_RESPONSE", "Telegram returned invalid updates", 502, true);
    return result.flatMap((raw): TelegramUpdate[] => {
      const update = botResponseSchema.object(raw);
      const callback = update.callback_query && typeof update.callback_query === "object"
        ? update.callback_query as Record<string, unknown>
        : null;
      const message = (callback?.message ?? update.message) && typeof (callback?.message ?? update.message) === "object"
        ? (callback?.message ?? update.message) as Record<string, unknown>
        : null;
      const sender = (callback?.from ?? message?.from) && typeof (callback?.from ?? message?.from) === "object"
        ? (callback?.from ?? message?.from) as Record<string, unknown>
        : null;
      const chat = message?.chat && typeof message.chat === "object"
        ? message.chat as Record<string, unknown>
        : null;
      if (
        !Number.isSafeInteger(update.update_id)
        || !Number.isSafeInteger(sender?.id)
        || !Number.isSafeInteger(chat?.id)
        || typeof chat?.type !== "string"
      ) return [];
      return [{
        updateId: String(update.update_id),
        senderId: String(sender!.id),
        chatId: String(chat!.id),
        chatType: chat!.type as string,
        ...(typeof message?.text === "string" ? { text: message.text } : {}),
        ...(typeof callback?.data === "string" ? { callbackData: callback.data } : {}),
        ...(typeof callback?.id === "string" ? { callbackQueryId: callback.id } : {}),
      }];
    });
  }

  async sendMessage(token: string, chatId: string, text: string, options: TelegramMessageOptions = {}) {
    await this.request(token, "sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(options.inlineKeyboard ? {
        reply_markup: {
          inline_keyboard: options.inlineKeyboard.map((row) => row.map((button) => ({
            text: button.text,
            callback_data: button.callbackData,
          }))),
        },
      } : {}),
    });
  }

  async sendChatAction(token: string, chatId: string, action: "typing") {
    await this.request(token, "sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  async answerCallbackQuery(token: string, callbackQueryId: string, text?: string) {
    await this.request(token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }
}

const status = (record: ChannelConnectionRecord): TelegramChannelConnectionStatus => (
  telegramChannelConnectionStatusSchema.parse({
    state: "connected",
    connectionId: record.id,
    workspaceId: record.workspaceId,
    credentialId: record.credentialId,
    allowedUserIds: record.allowedUserIds,
    allowedUserCount: record.allowedUserIds.length,
    defaultAgentId: record.defaultAgentId,
    allowAgentSwitch: record.allowAgentSwitch,
    botUsername: record.botUsername,
    tokenVersion: record.tokenVersion,
    updatedAt: record.updatedAt.toISOString(),
  })
);

const credentialStatus = (
  record: ChannelCredentialRecord & { workspaceId?: string | null; connectionId?: string | null },
): TelegramCredentialStatus => telegramCredentialStatusSchema.parse({
  id: record.id,
  kind: record.kind,
  displayName: record.displayName,
  botUsername: record.botUsername,
  version: record.version,
  workspaceId: record.workspaceId ?? null,
  connectionId: record.connectionId ?? null,
  updatedAt: record.updatedAt.toISOString(),
});

const displayNames: Readonly<Record<ChatAgentCatalogId, string>> = Object.freeze({
  "hermes-claw": "Hermes Agent",
  "claude-cli": "Claude CLI",
  "codex-cli": "Codex CLI",
});

const safeFailureMessage = "ONEComputer could not complete that message. Select an available agent with /agent, or restart the workspace from ONEComputer, then try again.";
const telegramAgentCallbackPrefix = "onecomputer:agent:";
const switchableAgentIds = ["hermes-claw", "claude-cli", "codex-cli"] as const;

const agentFromCallback = (value: string | undefined): ChatAgentCatalogId | undefined => {
  if (!value?.startsWith(telegramAgentCallbackPrefix)) return undefined;
  const parsed = chatAgentCatalogIdSchema.safeParse(value.slice(telegramAgentCallbackPrefix.length));
  return parsed.success ? parsed.data : undefined;
};

export class ChannelBrokerService {
  constructor(
    private readonly store: ChannelStore,
    private readonly vault: ChannelCredentialVault,
    private readonly telegram: TelegramBotClient,
    private readonly control: ChannelControlClient,
    private readonly typingRefreshMs = 4_000,
  ) {}

  private async withTypingIndicator<T>(token: string, chatId: string, turn: () => Promise<T>) {
    let stopped = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      await this.telegram.sendChatAction(token, chatId, "typing").catch(() => undefined);
      if (!stopped) {
        refreshTimer = setTimeout(() => void refresh(), this.typingRefreshMs);
      }
    };

    void refresh();
    try {
      return await turn();
    } finally {
      stopped = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    }
  }

  async listCredentials(identity: IdentityContext) {
    return telegramCredentialListSchema.parse({
      credentials: (await this.store.listOwnedChannelCredentials(identity)).map(credentialStatus),
    });
  }

  async saveCredential(identity: IdentityContext, raw: unknown, credentialId?: string) {
    const input = saveTelegramCredentialSchema.parse(raw);
    const prior = credentialId
      ? await this.store.getOwnedChannelCredential(identity, credentialId)
      : null;
    if (credentialId && !prior) {
      throw new OneComputerError("CHANNEL_CREDENTIAL_NOT_FOUND", "The channel credential was not found", 404);
    }
    const id = prior?.id ?? randomUUID();
    const bot = await this.telegram.validate(input.botToken);
    const saved = await this.store.saveChannelCredential(identity, {
      id,
      kind: "telegram_bot_token",
      credentialCiphertext: this.vault.protect(identity, id, input.botToken),
      credentialKeyVersion: 1,
      version: (prior?.version ?? 0) + 1,
      fingerprint: this.vault.fingerprint(input.botToken),
      displayName: bot.username ? `@${bot.username}` : `Telegram bot ${bot.botId}`,
      botUsername: bot.username,
    });
    const linked = (await this.store.listOwnedChannelCredentials(identity))
      .find((item) => item.id === saved.id && item.workspaceId);
    if (linked?.workspaceId) {
      const connection = await this.store.getOwnedChannelConnection(identity, "telegram", linked.workspaceId);
      if (connection) {
        const backlog = await this.telegram.getUpdates(input.botToken, "-1");
        const telegramUpdateOffset = backlog.length
          ? String(backlog.reduce((latest, update) => BigInt(update.updateId) > latest ? BigInt(update.updateId) : latest, -1n) + 1n)
          : "0";
        await this.store.saveChannelConnection(identity, {
          id: connection.id,
          workspaceId: connection.workspaceId,
          adapter: "telegram",
          credentialId: saved.id,
          allowedUserIds: connection.allowedUserIds,
          defaultAgentId: connection.defaultAgentId,
          allowAgentSwitch: connection.allowAgentSwitch,
          telegramUpdateOffset,
        });
      }
    }
    return credentialStatus({
      ...saved,
      workspaceId: linked?.workspaceId ?? null,
      connectionId: linked?.connectionId ?? null,
    });
  }

  async deleteCredential(identity: IdentityContext, credentialId: string) {
    if (!await this.store.deleteChannelCredential(identity, credentialId)) {
      throw new OneComputerError("CHANNEL_CREDENTIAL_NOT_FOUND", "The channel credential was not found", 404);
    }
  }

  async status(identity: IdentityContext, workspaceId: string) {
    const record = await this.store.getOwnedChannelConnection(identity, "telegram", workspaceId);
    return record ? status(record) : null;
  }

  async saveConnection(identity: IdentityContext, raw: unknown) {
    const input = saveTelegramChannelConnectionSchema.parse(raw);
    const prior = await this.store.getOwnedChannelConnection(identity, "telegram", input.workspaceId);
    const credential = await this.store.getOwnedChannelCredential(identity, input.credentialId);
    if (!credential) throw new OneComputerError("CHANNEL_CREDENTIAL_NOT_FOUND", "The Telegram credential was not found", 404);
    const inventory = await this.store.listOwnedChannelCredentials(identity);
    const attached = inventory.find((item) => item.id === credential.id);
    if (attached?.workspaceId && attached.workspaceId !== input.workspaceId) {
      throw new OneComputerError("CHANNEL_CREDENTIAL_IN_USE", "That Telegram credential is attached to another workspace", 409);
    }
    const id = prior?.id ?? randomUUID();
    const token = this.vault.unprotect(identity, credential.id, credential.credentialCiphertext);
    const backlog = prior?.credentialId === credential.id ? [] : await this.telegram.getUpdates(token, "-1");
    const telegramUpdateOffset = backlog.length
      ? String(backlog.reduce((latest, update) => BigInt(update.updateId) > latest ? BigInt(update.updateId) : latest, -1n) + 1n)
      : prior?.credentialId === credential.id ? prior.telegramUpdateOffset : "0";
    const allowedUserIds = [...new Set(input.allowedUserIds)];
    const record = await this.store.saveChannelConnection(identity, {
      id,
      workspaceId: input.workspaceId,
      adapter: "telegram",
      credentialId: credential.id,
      allowedUserIds,
      defaultAgentId: input.defaultAgentId,
      allowAgentSwitch: input.allowAgentSwitch,
      telegramUpdateOffset,
    });
    return status(record);
  }

  async disconnect(identity: IdentityContext, workspaceId: string) {
    await this.store.deleteChannelConnection(identity, "telegram", workspaceId);
  }

  async pollOnce() {
    const connections = await this.store.listActiveChannelConnections("telegram");
    const results = await Promise.allSettled(connections.map((connection) => this.pollConnection(connection)));
    const failures = results.filter((result) => result.status === "rejected").length;
    if (failures) {
      throw new OneComputerError(
        "CHANNEL_POLL_FAILED",
        `${failures} Telegram connection${failures === 1 ? "" : "s"} could not be polled`,
        503,
        true,
      );
    }
  }

  private async pollConnection(connection: ChannelConnectionRecord) {
    const identity: IdentityContext = {
      tenantId: connection.tenantId,
      subjectId: connection.subjectId,
      audience: "onecomputer-control",
    };
    const token = this.vault.unprotect(identity, connection.credentialId, connection.credentialCiphertext);
    const updates = (await this.telegram.getUpdates(token, connection.telegramUpdateOffset))
      .sort((left, right) => Number(BigInt(left.updateId) - BigInt(right.updateId)));
    const current = await this.store.getOwnedChannelConnection(identity, "telegram", connection.workspaceId);
    if (!current || current.id !== connection.id || current.tokenVersion !== connection.tokenVersion) return;
    for (const update of updates) {
      await this.processUpdate(current, identity, token, update);
      await this.store.advanceTelegramUpdateOffset(connection.id, String(BigInt(update.updateId) + 1n));
    }
  }

  private route(
    connection: ChannelConnectionRecord,
    identity: IdentityContext,
    senderId: string,
    agentCatalogId: ChatAgentCatalogId,
  ): ChannelRoute {
    return channelRouteSchema.parse({
      connectionId: connection.id,
      identity,
      workspaceId: connection.workspaceId,
      agentCatalogId,
      externalSenderId: senderId,
    });
  }

  private async chooseAgent(
    connection: ChannelConnectionRecord,
    identity: IdentityContext,
    token: string,
    update: TelegramUpdate,
    agentCatalogId: ChatAgentCatalogId,
  ) {
    if (!connection.allowAgentSwitch) {
      await this.telegram.sendMessage(token, update.chatId, "Agent switching is disabled for this workspace.");
      return false;
    }
    const route = this.route(connection, identity, update.senderId, agentCatalogId);
    await this.control.validateRoute(route);
    await this.store.setChannelSenderAgent(connection.id, update.senderId, agentCatalogId);
    await this.telegram.sendMessage(token, update.chatId, `Agent changed to ${displayNames[agentCatalogId]}.`);
    return true;
  }

  private async showAgentChoices(
    connection: ChannelConnectionRecord,
    identity: IdentityContext,
    token: string,
    update: TelegramUpdate,
  ) {
    if (!connection.allowAgentSwitch) {
      await this.telegram.sendMessage(token, update.chatId, "Agent switching is disabled for this workspace.");
      return false;
    }
    const available = (await Promise.all(switchableAgentIds.map(async (agentCatalogId) => {
      try {
        await this.control.validateRoute(this.route(connection, identity, update.senderId, agentCatalogId));
        return agentCatalogId;
      } catch {
        return undefined;
      }
    }))).filter((agentCatalogId): agentCatalogId is ChatAgentCatalogId => Boolean(agentCatalogId));
    if (!available.length) {
      await this.telegram.sendMessage(token, update.chatId, "No alternative agents are available for this workspace.");
      return false;
    }
    await this.telegram.sendMessage(token, update.chatId, "Tap an agent below, then wait for its confirmation before sending a message:", {
      inlineKeyboard: available.map((agentCatalogId) => [{
        text: displayNames[agentCatalogId],
        callbackData: `${telegramAgentCallbackPrefix}${agentCatalogId}`,
      }]),
    });
    return true;
  }

  private async processUpdate(
    connection: ChannelConnectionRecord,
    identity: IdentityContext,
    token: string,
    update: TelegramUpdate,
  ) {
    if (!await this.store.reserveChannelUpdate(connection.id, update.updateId, update.senderId)) return;
    if (
      update.chatType !== "private"
      || !connection.allowedUserIds.includes(update.senderId)
      || update.chatId !== update.senderId
      || (!update.text && !agentFromCallback(update.callbackData))
      || (update.text?.length ?? 0) > 4_096
    ) {
      await this.store.finishChannelUpdate(connection.id, update.updateId, "rejected", "CHANNEL_INPUT_REJECTED");
      return;
    }

    const agentCommand = update.text ? /^\/agent(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(update.text) : null;
    const selectedFromButton = agentFromCallback(update.callbackData);
    if (agentCommand || selectedFromButton) {
      try {
        if (update.callbackQueryId) {
          await this.telegram.answerCallbackQuery(token, update.callbackQueryId).catch(() => undefined);
        }
        const requestedAgent = selectedFromButton ?? agentCommand?.[1];
        const delivered = requestedAgent
          ? await this.chooseAgent(
            connection,
            identity,
            token,
            update,
            chatAgentCatalogIdSchema.parse(requestedAgent === "hermes-agent" ? "hermes-claw" : requestedAgent),
          )
          : await this.showAgentChoices(connection, identity, token, update);
        await this.store.finishChannelUpdate(connection.id, update.updateId, delivered ? "delivered" : "rejected", delivered ? undefined : "CHANNEL_AGENT_UNAVAILABLE");
      } catch {
        if (update.callbackQueryId) {
          await this.telegram.answerCallbackQuery(token, update.callbackQueryId, "That agent is not available.").catch(() => undefined);
        }
        await this.telegram.sendMessage(token, update.chatId, "That agent is not available for this workspace.");
        await this.store.finishChannelUpdate(connection.id, update.updateId, "rejected", "CHANNEL_AGENT_UNAVAILABLE");
      }
      return;
    }

    const agentCatalogId = await this.store.getChannelSenderAgent(connection.id, update.senderId)
      ?? connection.defaultAgentId;
    const newChatCommand = update.text ? /^\/new(?:@\w+)?\s*$/.test(update.text) : false;
    if (newChatCommand) {
      await this.store.clearChannelSession(connection.id, update.senderId, agentCatalogId);
      await this.telegram.sendMessage(
        token,
        update.chatId,
        `New chat started with ${displayNames[agentCatalogId]}. Send a message when you are ready.`,
      );
      await this.store.finishChannelUpdate(connection.id, update.updateId, "delivered");
      return;
    }

    const sessionId = await this.store.getChannelSession(connection.id, update.senderId, agentCatalogId);
    try {
      const response = channelTurnResponseSchema.parse(await this.withTypingIndicator(
        token,
        update.chatId,
        () => this.control.turn(channelTurnRequestSchema.parse({
          ...this.route(connection, identity, update.senderId, agentCatalogId),
          updateId: update.updateId,
          ...(sessionId ? { sessionId } : {}),
          text: update.text,
        })),
      ));
      await this.store.saveChannelSession(connection.id, update.senderId, agentCatalogId, response.sessionId);
      const rendered = [response.text, ...response.notices].filter(Boolean).join("\n\n") || "The agent completed without a text response.";
      for (let start = 0; start < rendered.length; start += 4_000) {
        await this.telegram.sendMessage(token, update.chatId, rendered.slice(start, start + 4_000));
      }
      await this.store.finishChannelUpdate(connection.id, update.updateId, "delivered");
    } catch {
      await this.telegram.sendMessage(token, update.chatId, safeFailureMessage).catch(() => undefined);
      await this.store.finishChannelUpdate(connection.id, update.updateId, "failed", "CHANNEL_TURN_FAILED");
    }
  }
}
