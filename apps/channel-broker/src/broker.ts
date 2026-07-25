import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
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
};

export interface TelegramBotClient {
  validate(token: string): Promise<{ botId: string; username: string | null }>;
  getUpdates(token: string, offset: string): Promise<TelegramUpdate[]>;
  sendMessage(token: string, chatId: string, text: string): Promise<void>;
}

export interface ChannelControlClient {
  validateRoute(input: ChannelRoute): Promise<void>;
  turn(input: ChannelTurnRequest): Promise<ChannelTurnResponse>;
}

export class HttpChannelControlClient implements ChannelControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async post(path: string, input: unknown) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-onecomputer-channel-token": this.internalToken,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15 * 60_000),
      });
    } catch {
      throw new OneComputerError("CHANNEL_CONTROL_UNAVAILABLE", "ONEComputer Control is unavailable", 503, true);
    }
    if (!response.ok) {
      throw new OneComputerError("CHANNEL_ROUTE_REJECTED", "ONEComputer rejected the channel route", response.status, response.status >= 500);
    }
    return response.status === 204 ? null : response.json();
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
      allowed_updates: ["message"],
    });
    if (!Array.isArray(result)) throw new OneComputerError("TELEGRAM_INVALID_RESPONSE", "Telegram returned invalid updates", 502, true);
    return result.flatMap((raw): TelegramUpdate[] => {
      const update = botResponseSchema.object(raw);
      const message = update.message && typeof update.message === "object"
        ? update.message as Record<string, unknown>
        : null;
      const sender = message?.from && typeof message.from === "object"
        ? message.from as Record<string, unknown>
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
      }];
    });
  }

  async sendMessage(token: string, chatId: string, text: string) {
    await this.request(token, "sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
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

const safeFailureMessage = "ONEComputer could not complete that message. Please try again.";

export class ChannelBrokerService {
  constructor(
    private readonly store: ChannelStore,
    private readonly vault: ChannelCredentialVault,
    private readonly telegram: TelegramBotClient,
    private readonly control: ChannelControlClient,
  ) {}

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
      || !update.text
      || update.text.length > 4_096
    ) {
      await this.store.finishChannelUpdate(connection.id, update.updateId, "rejected", "CHANNEL_INPUT_REJECTED");
      return;
    }

    const requestedAgent = /^\/agent(?:@\w+)?\s+(\S+)\s*$/.exec(update.text)?.[1];
    if (requestedAgent) {
      try {
        if (!connection.allowAgentSwitch) throw new OneComputerError("CHANNEL_AGENT_SWITCH_DISABLED", "Agent switching is disabled", 403);
        const agentCatalogId = chatAgentCatalogIdSchema.parse(requestedAgent === "hermes-agent" ? "hermes-claw" : requestedAgent);
        const route = this.route(connection, identity, update.senderId, agentCatalogId);
        await this.control.validateRoute(route);
        await this.store.setChannelSenderAgent(connection.id, update.senderId, agentCatalogId);
        await this.telegram.sendMessage(token, update.chatId, `Agent changed to ${displayNames[agentCatalogId]}.`);
        await this.store.finishChannelUpdate(connection.id, update.updateId, "delivered");
      } catch {
        await this.telegram.sendMessage(token, update.chatId, "That agent is not available for this workspace.");
        await this.store.finishChannelUpdate(connection.id, update.updateId, "rejected", "CHANNEL_AGENT_UNAVAILABLE");
      }
      return;
    }

    const agentCatalogId = await this.store.getChannelSenderAgent(connection.id, update.senderId)
      ?? connection.defaultAgentId;
    const sessionId = await this.store.getChannelSession(connection.id, update.senderId, agentCatalogId);
    try {
      const response = channelTurnResponseSchema.parse(await this.control.turn(channelTurnRequestSchema.parse({
        ...this.route(connection, identity, update.senderId, agentCatalogId),
        updateId: update.updateId,
        ...(sessionId ? { sessionId } : {}),
        text: update.text,
      })));
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
