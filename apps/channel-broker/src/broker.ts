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
  LemmaComputerError,
  TelegramTokenIntakeEnvelope,
  TelegramTokenIntakeGrantVerifier,
  channelArtifactDownloadRequestSchema,
  channelRouteSchema,
  channelTurnRequestSchema,
  channelTurnResponseSchema,
  channelTurnStreamEventSchema,
  chatAgentCatalogIdSchema,
  channelArtifactMaxBytes,
  channelAttachmentMaxBytes,
  channelAttachmentMaxTotalBytes,
  chatAttachmentMediaTypes,
  chatFilePartSchema,
  saveTelegramChannelConnectionSchema,
  saveTelegramCredentialSchema,
  telegramTokenIntakeSubmissionSchema,
  telegramChannelConnectionStatusSchema,
  telegramCredentialListSchema,
  telegramCredentialStatusSchema,
  type ChannelRoute,
  type ChannelTurnRequest,
  type ChannelTurnResponse,
  type ChatAgentCatalogId,
  type ChatArtifact,
  type ChatFilePart,
  type IdentityContext,
  type TelegramChannelConnectionStatus,
  type TelegramCredentialStatus,
} from "@lemmacomputer/contracts";
import type {
  ChannelConnectionRecord,
  ChannelCredentialRecord,
  ChannelPendingResponse,
  ChannelStore,
} from "./store.js";

export type TelegramAttachment = {
  fileId: string;
  fileUniqueId?: string;
  filename: string;
  mediaType?: string;
  fileSize?: number;
};

export type TelegramUpdate = {
  updateId: string;
  chatId: string;
  senderId: string;
  chatType: string;
  text?: string;
  attachment?: TelegramAttachment;
  mediaGroupId?: string;
  callbackData?: string;
  callbackQueryId?: string;
  addressedToBot?: boolean;
};

export type TelegramInlineButton = {
  text: string;
  callbackData: string;
};

export type TelegramMessageOptions = {
  inlineKeyboard?: readonly (readonly TelegramInlineButton[])[];
  disableNotification?: boolean;
};

export interface TelegramBotClient {
  validate(token: string): Promise<{ botId: string; username: string | null }>;
  getUpdates(token: string, offset: string, timeoutSeconds?: number, botUsername?: string | null): Promise<TelegramUpdate[]>;
  downloadFile(token: string, fileId: string, maxBytes: number): Promise<Buffer>;
  sendMessage(token: string, chatId: string, text: string, options?: TelegramMessageOptions): Promise<string>;
  sendDocument(token: string, chatId: string, artifact: ChatArtifact, data: Buffer): Promise<string>;
  editMessage(token: string, chatId: string, messageId: string, text: string): Promise<void>;
  sendChatAction(token: string, chatId: string, action: "typing"): Promise<void>;
  answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void>;
}

export interface ChannelControlClient {
  validateRoute(input: ChannelRoute): Promise<void>;
  turn(
    input: ChannelTurnRequest,
    onNotice?: (notice: string) => Promise<void>,
    onTextDelta?: (delta: string) => Promise<void>,
  ): Promise<ChannelTurnResponse>;
  downloadArtifact(route: ChannelRoute, artifact: ChatArtifact): Promise<Buffer>;
}

export type TelegramTokenIntakeDependencies = {
  grantVerifier: TelegramTokenIntakeGrantVerifier;
  envelope: TelegramTokenIntakeEnvelope;
  now?: () => Date;
};

export class HttpChannelControlClient implements ChannelControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  private async post(path: string, input: unknown) {
    const target = new URL(path, this.baseUrl);
    if (!["http:", "https:"].includes(target.protocol)) {
      throw new LemmaComputerError("CHANNEL_CONTROL_UNAVAILABLE", "LemmaComputer Control is unavailable", 503, true);
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
            "x-lemmacomputer-channel-token": this.internalToken,
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
      throw new LemmaComputerError("CHANNEL_CONTROL_UNAVAILABLE", "LemmaComputer Control is unavailable", 503, true);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new LemmaComputerError("CHANNEL_ROUTE_REJECTED", "LemmaComputer rejected the channel route", response.statusCode, response.statusCode >= 500);
    }
    if (response.statusCode === 204) return null;
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new LemmaComputerError("CHANNEL_CONTROL_INVALID_RESPONSE", "LemmaComputer Control returned an invalid response", 502, true);
    }
  }

  private async streamTurn(
    path: string,
    input: unknown,
    onNotice?: (notice: string) => Promise<void>,
    onTextDelta?: (delta: string) => Promise<void>,
  ): Promise<ChannelTurnResponse> {
    const target = new URL(path, this.baseUrl);
    if (!["http:", "https:"].includes(target.protocol)) {
      throw new LemmaComputerError("CHANNEL_CONTROL_UNAVAILABLE", "LemmaComputer Control is unavailable", 503, true);
    }
    const payload = Buffer.from(JSON.stringify(input));
    return new Promise((resolve, reject) => {
      const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "x-lemmacomputer-channel-token": this.internalToken,
        },
      }, (upstream) => {
        void (async () => {
          try {
            if ((upstream.statusCode ?? 502) < 200 || (upstream.statusCode ?? 502) >= 300) {
              for await (const _chunk of upstream) {
                // Drain the bounded internal error response before rejecting.
              }
              throw new LemmaComputerError(
                "CHANNEL_ROUTE_REJECTED",
                "LemmaComputer rejected the channel route",
                upstream.statusCode ?? 502,
                (upstream.statusCode ?? 502) >= 500,
              );
            }
            const contentType = Array.isArray(upstream.headers["content-type"])
              ? upstream.headers["content-type"][0]
              : upstream.headers["content-type"];
            if (!contentType?.startsWith("application/x-ndjson")) {
              throw new LemmaComputerError(
                "CHANNEL_CONTROL_INVALID_RESPONSE",
                "LemmaComputer Control returned an invalid response",
                502,
                true,
              );
            }

            let buffer = "";
            let totalSize = 0;
            let result: ChannelTurnResponse | undefined;
            const deliveredNotices = new Set<string>();
            for await (const chunk of upstream) {
              const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
              totalSize += Buffer.byteLength(text);
              if (totalSize > 512 * 1024) {
                throw new LemmaComputerError(
                  "CHANNEL_CONTROL_INVALID_RESPONSE",
                  "LemmaComputer Control response exceeded its limit",
                  502,
                  true,
                );
              }
              buffer += text;
              while (buffer.includes("\n")) {
                const index = buffer.indexOf("\n");
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                if (!line) continue;
                const event = channelTurnStreamEventSchema.parse(JSON.parse(line));
                if (event.type === "heartbeat") continue;
                if (event.type === "text-delta") {
                  if (onTextDelta) {
                    try {
                      await onTextDelta(event.delta);
                    } catch {
                      // The final result retains the complete text for durable fallback delivery.
                    }
                  }
                  continue;
                }
                if (event.type === "notice") {
                  if (onNotice && !deliveredNotices.has(event.notice)) {
                    try {
                      await onNotice(event.notice);
                      deliveredNotices.add(event.notice);
                    } catch {
                      // Keep the notice in the final response so delivery can be retried.
                    }
                  }
                  continue;
                }
                if (event.type === "error") {
                  throw new LemmaComputerError(
                    event.code,
                    event.message,
                    event.code === "CHAT_RUNTIME_UNAVAILABLE" ? 503 : 502,
                    event.retryable,
                  );
                }
                if (result) {
                  throw new LemmaComputerError(
                    "CHANNEL_CONTROL_INVALID_RESPONSE",
                    "LemmaComputer Control returned multiple results",
                    502,
                    true,
                  );
                }
                result = channelTurnResponseSchema.parse({
                  ...event.response,
                  notices: event.response.notices.filter((notice) => !deliveredNotices.has(notice)),
                });
              }
            }
            if (buffer.length || !result) {
              throw new LemmaComputerError(
                "CHANNEL_CONTROL_INVALID_RESPONSE",
                "LemmaComputer Control ended without a complete result",
                502,
                true,
              );
            }
            resolve(result);
          } catch (error) {
            reject(error instanceof LemmaComputerError
              ? error
              : new LemmaComputerError(
                "CHANNEL_CONTROL_INVALID_RESPONSE",
                "LemmaComputer Control returned an invalid response",
                502,
                true,
              ));
          }
        })();
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error("Control request timed out")));
      request.on("error", () => reject(
        new LemmaComputerError("CHANNEL_CONTROL_UNAVAILABLE", "LemmaComputer Control is unavailable", 503, true),
      ));
      request.end(payload);
    });
  }

  async validateRoute(input: ChannelRoute) {
    await this.post("/internal/v1/channels/routes/validate", channelRouteSchema.parse(input));
  }

  async downloadArtifact(route: ChannelRoute, artifact: ChatArtifact) {
    const target = new URL("/internal/v1/channels/artifacts", this.baseUrl);
    if (!["http:", "https:"].includes(target.protocol)) throw new LemmaComputerError("CHANNEL_CONTROL_UNAVAILABLE", "LemmaComputer Control is unavailable", 503, true);
    const input = channelArtifactDownloadRequestSchema.parse({ ...route, artifact });
    let response: Response;
    try { response = await fetch(target, { method: "POST", headers: { "content-type": "application/json", "x-lemmacomputer-channel-token": this.internalToken }, body: JSON.stringify(input), signal: AbortSignal.timeout(60_000) }); }
    catch { throw new LemmaComputerError("CHANNEL_CONTROL_UNAVAILABLE", "LemmaComputer Control is unavailable", 503, true); }
    if (!response.ok || !response.body) throw new LemmaComputerError("CHANNEL_ARTIFACT_UNAVAILABLE", "The generated file is unavailable", response.status || 502, true);
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > artifact.byteLength || size > channelArtifactMaxBytes) { await reader.cancel().catch(() => undefined); throw new LemmaComputerError("CHANNEL_ARTIFACT_MISMATCH", "The generated file changed before delivery", 409); }
      chunks.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
    const data = Buffer.concat(chunks, size);
    if (data.length !== artifact.byteLength || createHash("sha256").update(data).digest("hex") !== artifact.sha256) throw new LemmaComputerError("CHANNEL_ARTIFACT_MISMATCH", "The generated file changed before delivery", 409);
    return data;
  }

  async turn(
    input: ChannelTurnRequest,
    onNotice?: (notice: string) => Promise<void>,
    onTextDelta?: (delta: string) => Promise<void>,
  ) {
    return this.streamTurn(
      "/internal/v1/channels/turns",
      channelTurnRequestSchema.parse(input),
      onNotice,
      onTextDelta,
    );
  }
}

const key = (secret: string) => createHash("sha256")
  .update("lemmacomputer/channel-credential/k1\0")
  .update(secret)
  .digest();

const additionalData = (identity: IdentityContext, credentialId: string) => Buffer.from(
  `lemmacomputer/channel-credential/k1:${identity.tenantId}:${identity.subjectId}:${credentialId}:telegram_bot_token`,
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
      throw new LemmaComputerError(
        "CHANNEL_CREDENTIAL_UNAVAILABLE",
        "The channel credential could not be unlocked",
        503,
        true,
      );
    }
  }

  fingerprint(plaintext: string) {
    return createHmac("sha256", this.encryptionKey)
      .update("lemmacomputer/channel-credential-fingerprint/k1\0")
      .update(plaintext)
      .digest("base64url");
  }
}

const telegramAttachmentTypes = new Set<string>(chatAttachmentMediaTypes);
const telegramMediaTypesByExtension: Readonly<Record<string, (typeof chatAttachmentMediaTypes)[number]>> = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});

const telegramMediaType = (value: unknown, filename: string) => {
  const claimed = typeof value === "string" ? value.split(";", 1)[0]!.trim().toLowerCase() : "";
  if (telegramAttachmentTypes.has(claimed)) return claimed;
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(filename)?.[1]?.toLowerCase();
  return extension ? telegramMediaTypesByExtension[extension] : undefined;
};

const safeTelegramFilename = (value: unknown, fallback: string) => {
  const candidate = typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 180)
    : "";
  return candidate && candidate !== "." && candidate !== ".." ? candidate : fallback;
};

const optionalTelegramFileSize = (value: unknown) => (
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
);

const botResponseSchema = {
  object(value: unknown) {
    if (!value || typeof value !== "object") throw new Error("invalid Telegram response");
    return value as Record<string, unknown>;
  },
};

const telegramMessageAddressesBot = (
  message: Record<string, unknown>,
  text: string | undefined,
  botUsername: string | null | undefined,
) => {
  if (!botUsername) return false;
  const normalizedBot = botUsername.toLowerCase();
  const reply = message.reply_to_message && typeof message.reply_to_message === "object"
    ? message.reply_to_message as Record<string, unknown>
    : null;
  const replyFrom = reply?.from && typeof reply.from === "object"
    ? reply.from as Record<string, unknown>
    : null;
  if (
    replyFrom?.is_bot === true
    && typeof replyFrom.username === "string"
    && replyFrom.username.toLowerCase() === normalizedBot
  ) return true;
  if (!text) return false;
  const rawEntities = Array.isArray(message.entities)
    ? message.entities
    : Array.isArray(message.caption_entities) ? message.caption_entities : [];
  return rawEntities.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const entity = raw as Record<string, unknown>;
    if (!["mention", "bot_command"].includes(String(entity.type))) return false;
    if (!Number.isSafeInteger(entity.offset) || !Number.isSafeInteger(entity.length)) return false;
    const offset = Number(entity.offset);
    const length = Number(entity.length);
    if (offset < 0 || length <= 0) return false;
    return text.slice(offset, offset + length).toLowerCase().endsWith(`@${normalizedBot}`);
  });
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
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiOrigin}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new LemmaComputerError("TELEGRAM_API_UNAVAILABLE", "Telegram could not be reached", 503, true);
    }
    let payload: Record<string, unknown>;
    try {
      payload = botResponseSchema.object(await response.json());
    } catch {
      throw new LemmaComputerError("TELEGRAM_INVALID_RESPONSE", "Telegram returned an invalid response", 502, true);
    }
    if (!response.ok || payload.ok !== true) {
      throw new LemmaComputerError("TELEGRAM_API_UNAVAILABLE", "Telegram rejected the bot request", 503, true);
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

  async getUpdates(token: string, offset: string, timeoutSeconds = 20, botUsername?: string | null) {
    const result = await this.request(token, "getUpdates", {
      offset,
      timeout: Math.max(0, Math.min(30, Math.trunc(timeoutSeconds))),
      allowed_updates: ["message", "callback_query"],
    });
    if (!Array.isArray(result)) throw new LemmaComputerError("TELEGRAM_INVALID_RESPONSE", "Telegram returned invalid updates", 502, true);
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

      const document = message?.document && typeof message.document === "object"
        ? message.document as Record<string, unknown>
        : null;
      const photos = Array.isArray(message?.photo)
        ? message.photo.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        : [];
      const photo = photos
        .filter((item) => typeof item.file_id === "string")
        .sort((left, right) => (
          Number(left.width ?? 0) * Number(left.height ?? 0)
          - Number(right.width ?? 0) * Number(right.height ?? 0)
        ))
        .at(-1);
      let attachment: TelegramAttachment | undefined;
      if (document && typeof document.file_id === "string") {
        const fallback = `document-${String(update.update_id)}`;
        const filename = safeTelegramFilename(document.file_name, fallback);
        const mediaType = telegramMediaType(document.mime_type, filename);
        const fileSize = optionalTelegramFileSize(document.file_size);
        attachment = {
          fileId: document.file_id,
          ...(typeof document.file_unique_id === "string" ? { fileUniqueId: document.file_unique_id } : {}),
          filename,
          ...(mediaType ? { mediaType } : {}),
          ...(fileSize === undefined ? {} : { fileSize }),
        };
      } else if (photo && typeof photo.file_id === "string") {
        const fileSize = optionalTelegramFileSize(photo.file_size);
        attachment = {
          fileId: photo.file_id,
          ...(typeof photo.file_unique_id === "string" ? { fileUniqueId: photo.file_unique_id } : {}),
          filename: `photo-${String(update.update_id)}.jpg`,
          mediaType: "image/jpeg",
          ...(fileSize === undefined ? {} : { fileSize }),
        };
      }

      const text = typeof message?.text === "string"
        ? message.text
        : typeof message?.caption === "string" ? message.caption : undefined;
      const addressedToBot = Boolean(callback) || telegramMessageAddressesBot(message!, text, botUsername);
      return [{
        updateId: String(update.update_id),
        senderId: String(sender!.id),
        chatId: String(chat!.id),
        chatType: chat!.type as string,
        ...(text === undefined ? {} : { text }),
        ...(attachment ? { attachment } : {}),
        ...(typeof message?.media_group_id === "string" ? { mediaGroupId: message.media_group_id } : {}),
        ...(typeof callback?.data === "string" ? { callbackData: callback.data } : {}),
        ...(typeof callback?.id === "string" ? { callbackQueryId: callback.id } : {}),
        ...(addressedToBot ? { addressedToBot: true } : {}),
      }];
    });
  }

  async downloadFile(token: string, fileId: string, maxBytes: number) {
    const result = botResponseSchema.object(await this.request(token, "getFile", { file_id: fileId }));
    const filePath = typeof result.file_path === "string" ? result.file_path : "";
    const pathSegments = filePath.split("/");
    if (
      !filePath
      || filePath.length > 512
      || filePath.startsWith("/")
      || pathSegments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
    ) {
      throw new LemmaComputerError("TELEGRAM_INVALID_RESPONSE", "Telegram returned an invalid file path", 502, true);
    }
    const reportedSize = optionalTelegramFileSize(result.file_size);
    if (reportedSize !== undefined && reportedSize > maxBytes) {
      throw new LemmaComputerError("CHANNEL_ATTACHMENT_TOO_LARGE", "The Telegram attachment exceeds its size limit", 400);
    }
    const encodedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join("/");
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiOrigin}/file/bot${token}/${encodedPath}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new LemmaComputerError("TELEGRAM_FILE_UNAVAILABLE", "Telegram could not download the attachment", 503, true);
    }
    if (!response.ok || !response.body) {
      throw new LemmaComputerError("TELEGRAM_FILE_UNAVAILABLE", "Telegram could not download the attachment", 503, true);
    }
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
    if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new LemmaComputerError("CHANNEL_ATTACHMENT_TOO_LARGE", "The Telegram attachment exceeds its size limit", 400);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new LemmaComputerError("CHANNEL_ATTACHMENT_TOO_LARGE", "The Telegram attachment exceeds its size limit", 400);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof LemmaComputerError) throw error;
      throw new LemmaComputerError("TELEGRAM_FILE_UNAVAILABLE", "Telegram could not download the attachment", 503, true);
    } finally {
      reader.releaseLock();
    }
    if (!size) throw new LemmaComputerError("TELEGRAM_FILE_UNAVAILABLE", "Telegram returned an empty attachment", 502, true);
    return Buffer.concat(chunks, size);
  }

  async sendMessage(token: string, chatId: string, text: string, options: TelegramMessageOptions = {}) {
    const result = botResponseSchema.object(await this.request(token, "sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(options.disableNotification ? { disable_notification: true } : {}),
      ...(options.inlineKeyboard ? {
        reply_markup: {
          inline_keyboard: options.inlineKeyboard.map((row) => row.map((button) => ({
            text: button.text,
            callback_data: button.callbackData,
          }))),
        },
      } : {}),
    }));
    if (!Number.isSafeInteger(result.message_id)) {
      throw new LemmaComputerError("TELEGRAM_INVALID_RESPONSE", "Telegram returned an invalid message", 502, true);
    }
    return String(result.message_id);
  }

  async sendDocument(token: string, chatId: string, artifact: ChatArtifact, data: Buffer) {
    const form = new FormData(); form.set("chat_id", chatId); form.set("document", new Blob([Uint8Array.from(data)], { type: artifact.mediaType }), artifact.filename);
    let response: Response;
    try { response = await this.fetcher(`${this.apiOrigin}/bot${token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) }); }
    catch { throw new LemmaComputerError("TELEGRAM_API_UNAVAILABLE", "Telegram could not be reached", 503, true); }
    let payload: Record<string, unknown>;
    try { payload = botResponseSchema.object(await response.json()); } catch { throw new LemmaComputerError("TELEGRAM_INVALID_RESPONSE", "Telegram returned an invalid response", 502, true); }
    if (!response.ok || payload.ok !== true) throw new LemmaComputerError("TELEGRAM_API_UNAVAILABLE", "Telegram rejected the generated file", 503, true);
    const result = botResponseSchema.object(payload.result);
    if (!Number.isSafeInteger(result.message_id)) throw new LemmaComputerError("TELEGRAM_INVALID_RESPONSE", "Telegram returned an invalid message", 502, true);
    return String(result.message_id);
  }

  async editMessage(token: string, chatId: string, messageId: string, text: string) {
    await this.request(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
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
    allowedGroupChatIds: record.allowedGroupChatIds,
    allowedGroupChatCount: record.allowedGroupChatIds.length,
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

const acknowledgementMessage = "Message received.";
const unsupportedAttachmentMessage = "I can receive images, PDF, text, Word, Excel, and PowerPoint files. This attachment type is not supported.";
const oversizedAttachmentMessage = "Telegram attachments must be 20 MB or smaller. Please send a smaller file.";
const unavailableAttachmentMessage = "I could not download that Telegram attachment. Please send it again.";
const safeFailureMessage = "I started the task, but the agent could not complete it. Try again, or use /agent to select another available agent.";
const approvalFailureMessage = "I couldn’t finish the task while the protected action was awaiting review. Open LemmaComputer to check the approval, then retry if needed.";
const telegramAgentCallbackPrefix = "lemmacomputer:agent:";
const switchableAgentIds = ["hermes-claw", "claude-cli", "codex-cli"] as const;
const telegramMessageLimit = 4_000;
const telegramStreamStartCharacters = 24;
const telegramStreamEditCharacters = 160;
const telegramStreamEditMs = 900;
const telegramCommandPattern = /^\/(?:agent|new|chatid)(?:@\w+)?(?:\s|$)/;

const immediateTelegramUpdate = (update: TelegramUpdate) => Boolean(
  update.callbackData || (update.text && !update.attachment && telegramCommandPattern.test(update.text)),
);

const groupedText = (updates: TelegramUpdate[]) => updates
  .flatMap((update) => update.text?.trim() ? [update.text.trim()] : [])
  .join("\n\n");

const canAppendTelegramUpdate = (group: TelegramUpdate[], candidate: TelegramUpdate) => {
  const first = group[0];
  if (
    !first
    || immediateTelegramUpdate(first)
    || immediateTelegramUpdate(candidate)
    || candidate.chatId !== first.chatId
    || candidate.senderId !== first.senderId
    || candidate.chatType !== first.chatType
  ) return false;
  const attachmentCount = group.filter((update) => update.attachment).length;
  if (attachmentCount + Number(Boolean(candidate.attachment)) > 4) return false;
  if (groupedText([...group, candidate]).length > 4_096) return false;
  if (first.mediaGroupId && candidate.mediaGroupId === first.mediaGroupId) return true;
  const hasText = group.some((update) => Boolean(update.text?.trim()));
  const hasAttachment = attachmentCount > 0;
  return (
    (hasText && Boolean(candidate.attachment))
    || (hasAttachment && Boolean(candidate.text?.trim()))
    || (hasAttachment && Boolean(candidate.attachment))
  );
};

export const groupTelegramUpdates = (updates: TelegramUpdate[]) => {
  const groups: TelegramUpdate[][] = [];
  for (const update of updates) {
    const current = groups.at(-1);
    if (current && canAppendTelegramUpdate(current, update)) current.push(update);
    else groups.push([update]);
  }
  return groups;
};

class TelegramResponseStream {
  private text = "";
  private published = "";
  private messageId: string | undefined;
  private publishedAt = 0;
  private streamed = false;

  constructor(
    private readonly telegram: TelegramBotClient,
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  async append(delta: string) {
    this.streamed = true;
    this.text += delta;
    const textLength = [...this.text].length;
    const publishedLength = [...this.published].length;
    if (
      !this.messageId
        ? textLength >= telegramStreamStartCharacters || this.text.includes("\n")
        : Date.now() - this.publishedAt >= telegramStreamEditMs
          || textLength - publishedLength >= telegramStreamEditCharacters
    ) {
      await this.publish();
    }
  }

  async finish(text: string) {
    this.text = text;
    if (!this.streamed) return 0;
    await this.publish();
    return text.startsWith(this.published) ? [...this.published].length : 0;
  }

  private async publish() {
    const preview = [...this.text].slice(0, telegramMessageLimit).join("");
    if (!preview.trim() || preview === this.published) return;
    try {
      if (this.messageId) {
        await this.telegram.editMessage(this.token, this.chatId, this.messageId, preview);
      } else {
        this.messageId = await this.telegram.sendMessage(this.token, this.chatId, preview);
      }
      this.published = preview;
      this.publishedAt = Date.now();
    } catch {
      // The complete final response is durably staged after the turn.
    }
  }
}

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
    private readonly compositionWindowMs = 0,
    private readonly tokenIntake?: TelegramTokenIntakeDependencies,
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

  async saveCredential(
    identity: IdentityContext,
    raw: unknown,
    credentialId?: string,
    options: { allowCreateWithCredentialId?: boolean } = {},
  ) {
    const input = saveTelegramCredentialSchema.parse(raw);
    const prior = credentialId
      ? await this.store.getOwnedChannelCredential(identity, credentialId)
      : null;
    if (credentialId && prior && options.allowCreateWithCredentialId) {
      throw new LemmaComputerError("TELEGRAM_INTAKE_CREDENTIAL_EXISTS", "The Telegram credential request is no longer valid", 409);
    }
    if (credentialId && !prior && !options.allowCreateWithCredentialId) {
      throw new LemmaComputerError("CHANNEL_CREDENTIAL_NOT_FOUND", "The channel credential was not found", 404);
    }
    const id = prior?.id ?? credentialId ?? randomUUID();
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
        const backlog = await this.telegram.getUpdates(input.botToken, "-1", undefined, bot.username);
        const telegramUpdateOffset = backlog.length
          ? String(backlog.reduce((latest, update) => BigInt(update.updateId) > latest ? BigInt(update.updateId) : latest, -1n) + 1n)
          : "0";
        await this.store.saveChannelConnection(identity, {
          id: connection.id,
          workspaceId: connection.workspaceId,
          adapter: "telegram",
          credentialId: saved.id,
          allowedUserIds: connection.allowedUserIds,
          allowedGroupChatIds: connection.allowedGroupChatIds,
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

  async redeemTelegramTokenIntake(raw: unknown) {
    if (!this.tokenIntake) {
      throw new LemmaComputerError("TELEGRAM_INTAKE_NOT_CONFIGURED", "Telegram credential intake is unavailable", 503, true);
    }
    const submission = telegramTokenIntakeSubmissionSchema.parse(raw);
    const now = this.tokenIntake.now?.() ?? new Date();
    const grant = this.tokenIntake.grantVerifier.verify(submission.grant, now);
    const consumed = await this.store.consumeTelegramTokenIntakeGrant({
      grantId: grant.grantId,
      tenantId: grant.tenantId,
      subjectId: grant.subjectId,
      action: grant.action,
      credentialId: grant.credentialId,
      idempotencyKey: grant.idempotencyKey,
      expiresAt: new Date(grant.expiresAt * 1_000),
    });
    if (!consumed) {
      throw new LemmaComputerError("TELEGRAM_INTAKE_GRANT_REPLAYED", "The Telegram credential request is no longer valid", 409);
    }
    const botToken = this.tokenIntake.envelope.open(submission.envelope, grant.grantId);
    const identity: IdentityContext = {
      tenantId: grant.tenantId,
      subjectId: grant.subjectId,
      audience: "lemmacomputer-control",
    };
    return this.saveCredential(
      identity,
      { botToken },
      grant.credentialId,
      { allowCreateWithCredentialId: grant.action === "create" },
    );
  }

  async deleteCredential(identity: IdentityContext, credentialId: string) {
    if (!await this.store.deleteChannelCredential(identity, credentialId)) {
      throw new LemmaComputerError("CHANNEL_CREDENTIAL_NOT_FOUND", "The channel credential was not found", 404);
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
    if (!credential) throw new LemmaComputerError("CHANNEL_CREDENTIAL_NOT_FOUND", "The Telegram credential was not found", 404);
    const inventory = await this.store.listOwnedChannelCredentials(identity);
    const attached = inventory.find((item) => item.id === credential.id);
    if (attached?.workspaceId && attached.workspaceId !== input.workspaceId) {
      throw new LemmaComputerError("CHANNEL_CREDENTIAL_IN_USE", "That Telegram credential is attached to another workspace", 409);
    }
    const id = prior?.id ?? randomUUID();
    const token = this.vault.unprotect(identity, credential.id, credential.credentialCiphertext);
    const backlog = prior?.credentialId === credential.id ? [] : await this.telegram.getUpdates(token, "-1", undefined, credential.botUsername);
    const telegramUpdateOffset = backlog.length
      ? String(backlog.reduce((latest, update) => BigInt(update.updateId) > latest ? BigInt(update.updateId) : latest, -1n) + 1n)
      : prior?.credentialId === credential.id ? prior.telegramUpdateOffset : "0";
    const allowedUserIds = [...new Set(input.allowedUserIds)];
    const allowedGroupChatIds = [...new Set(input.allowedGroupChatIds)];
    const record = await this.store.saveChannelConnection(identity, {
      id,
      workspaceId: input.workspaceId,
      adapter: "telegram",
      credentialId: credential.id,
      allowedUserIds,
      allowedGroupChatIds,
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
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length === 1 && failures[0]!.reason instanceof LemmaComputerError) {
      throw failures[0]!.reason;
    }
    if (failures.length) {
      throw new LemmaComputerError(
        "CHANNEL_POLL_FAILED",
        `${failures.length} Telegram connection${failures.length === 1 ? "" : "s"} could not be polled`,
        503,
        true,
      );
    }
  }

  private async pollConnection(connection: ChannelConnectionRecord) {
    const identity: IdentityContext = {
      tenantId: connection.tenantId,
      subjectId: connection.subjectId,
      audience: "lemmacomputer-control",
    };
    const token = this.vault.unprotect(identity, connection.credentialId, connection.credentialCiphertext);
    await this.deliverPendingResponses(connection, token);
    let updates = (await this.telegram.getUpdates(token, connection.telegramUpdateOffset, undefined, connection.botUsername))
      .sort((left, right) => Number(BigInt(left.updateId) - BigInt(right.updateId)));
    if (this.compositionWindowMs > 0 && updates.some((update) => !immediateTelegramUpdate(update))) {
      await new Promise((resolve) => setTimeout(resolve, this.compositionWindowMs));
      const nextOffset = updates.length
        ? String(BigInt(updates.at(-1)!.updateId) + 1n)
        : connection.telegramUpdateOffset;
      const followUps = await this.telegram.getUpdates(token, nextOffset, 0, connection.botUsername);
      const byId = new Map(updates.map((update) => [update.updateId, update]));
      for (const update of followUps) byId.set(update.updateId, update);
      updates = [...byId.values()]
        .sort((left, right) => Number(BigInt(left.updateId) - BigInt(right.updateId)));
    }
    const current = await this.store.getOwnedChannelConnection(identity, "telegram", connection.workspaceId);
    if (!current || current.id !== connection.id || current.tokenVersion !== connection.tokenVersion) return;
    for (const group of groupTelegramUpdates(updates)) {
      await this.processUpdates(current, identity, token, group);
      await this.store.advanceTelegramUpdateOffset(
        connection.id,
        String(BigInt(group.at(-1)!.updateId) + 1n),
      );
    }
  }

  private async deliverPendingResponse(connection: ChannelConnectionRecord, token: string, response: ChannelPendingResponse) {
    const characters = [...response.text];
    for (let start = response.offset; start < characters.length; start += 4_000) {
      const end = Math.min(start + 4_000, characters.length);
      await this.telegram.sendMessage(token, response.chatId, characters.slice(start, end).join(""));
      await this.store.advanceChannelResponseDelivery(response.connectionId, response.updateId, end);
    }
    if (response.artifacts.length && !response.agentCatalogId) throw new LemmaComputerError("CHANNEL_ARTIFACT_ROUTE_MISSING", "The generated file route is unavailable", 500, true);
    for (let index = response.artifactOffset; index < response.artifacts.length; index += 1) {
      const artifact = response.artifacts[index]!;
      const identity = { tenantId: connection.tenantId, subjectId: connection.subjectId, audience: "lemmacomputer-control" as const };
      const data = await this.control.downloadArtifact(
        this.route(connection, identity, response.senderId, response.chatId, response.agentCatalogId!),
        artifact,
      );
      await this.telegram.sendDocument(token, response.chatId, artifact, data);
      await this.store.advanceChannelArtifactDelivery(response.connectionId, response.updateId, index + 1);
    }
  }

  private async deliverPendingResponses(connection: ChannelConnectionRecord, token: string) {
    for (const response of await this.store.listPendingChannelResponses(connection.id)) await this.deliverPendingResponse(connection, token, response);
  }

  private route(
    connection: ChannelConnectionRecord,
    identity: IdentityContext,
    senderId: string,
    chatId: string,
    agentCatalogId: ChatAgentCatalogId,
  ): ChannelRoute {
    return channelRouteSchema.parse({
      connectionId: connection.id,
      identity,
      workspaceId: connection.workspaceId,
      agentCatalogId,
      externalSenderId: senderId,
      externalChatId: chatId,
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
    const route = this.route(connection, identity, update.senderId, update.chatId, agentCatalogId);
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
        await this.control.validateRoute(this.route(connection, identity, update.senderId, update.chatId, agentCatalogId));
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

  private async attachmentPart(token: string, attachment: TelegramAttachment): Promise<{ part: ChatFilePart; byteLength: number }> {
    if (!attachment.mediaType || !telegramAttachmentTypes.has(attachment.mediaType)) {
      throw new LemmaComputerError("CHANNEL_ATTACHMENT_UNSUPPORTED", "The Telegram attachment type is not supported", 400);
    }
    if (attachment.fileSize !== undefined && attachment.fileSize > channelAttachmentMaxBytes) {
      throw new LemmaComputerError("CHANNEL_ATTACHMENT_TOO_LARGE", "The Telegram attachment exceeds its size limit", 400);
    }
    const data = await this.telegram.downloadFile(token, attachment.fileId, channelAttachmentMaxBytes);
    return {
      part: chatFilePartSchema.parse({
        type: "file",
        mediaType: attachment.mediaType,
        filename: safeTelegramFilename(attachment.filename, "telegram-file"),
        url: `data:${attachment.mediaType};base64,${data.toString("base64")}`,
      }),
      byteLength: data.length,
    };
  }

  private async processUpdates(
    connection: ChannelConnectionRecord,
    identity: IdentityContext,
    token: string,
    candidates: TelegramUpdate[],
  ) {
    const updates: TelegramUpdate[] = [];
    for (const candidate of candidates) {
      if (await this.store.reserveChannelUpdate(connection.id, candidate.updateId, candidate.senderId)) {
        updates.push(candidate);
      }
    }
    if (!updates.length) return;
    const update = updates[0]!;
    const updateIds = updates.map((item) => item.updateId);
    const text = groupedText(updates);
    const telegramAttachments = updates.flatMap((item) => item.attachment ? [item.attachment] : []);
    const allowedSender = connection.allowedUserIds.includes(update.senderId);
    const privateChat = update.chatType === "private" && update.chatId === update.senderId;
    const groupChat = ["group", "supergroup"].includes(update.chatType);
    const approvedGroup = groupChat && connection.allowedGroupChatIds.includes(update.chatId);
    const addressedToBot = updates.some((item) => item.addressedToBot || agentFromCallback(item.callbackData));
    const finishUpdates = async (
      state: "delivered" | "rejected" | "failed",
      failureCode?: string,
      includePrimary = true,
    ) => {
      const selected = includePrimary ? updateIds : updateIds.slice(1);
      await Promise.all(selected.map((updateId) => (
        this.store.finishChannelUpdate(connection.id, updateId, state, failureCode)
      )));
    };
    const chatIdCommand = !telegramAttachments.length && /^\/chatid(?:@\w+)?\s*$/.test(text);
    if (allowedSender && chatIdCommand && (privateChat || (groupChat && addressedToBot))) {
      await this.telegram.sendMessage(
        token,
        update.chatId,
        groupChat
          ? `This Telegram group ID is ${update.chatId}. Add it under Allowed Telegram group IDs in LemmaComputer.`
          : `This Telegram chat ID is ${update.chatId}.`,
      );
      await finishUpdates("delivered");
      return;
    }
    if (
      !allowedSender
      || (!privateChat && !approvedGroup)
      || (groupChat && !addressedToBot)
      || (!text && !telegramAttachments.length && !agentFromCallback(update.callbackData))
      || text.length > 4_096
    ) {
      await finishUpdates("rejected", "CHANNEL_INPUT_REJECTED");
      return;
    }

    const agentCommand = !telegramAttachments.length && text ? /^\/agent(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text) : null;
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
        await finishUpdates(delivered ? "delivered" : "rejected", delivered ? undefined : "CHANNEL_AGENT_UNAVAILABLE");
      } catch {
        if (update.callbackQueryId) {
          await this.telegram.answerCallbackQuery(token, update.callbackQueryId, "That agent is not available.").catch(() => undefined);
        }
        await this.telegram.sendMessage(token, update.chatId, "That agent is not available for this workspace.");
        await finishUpdates("rejected", "CHANNEL_AGENT_UNAVAILABLE");
      }
      return;
    }

    const agentCatalogId = await this.store.getChannelSenderAgent(connection.id, update.senderId)
      ?? connection.defaultAgentId;
    const newChatCommand = !telegramAttachments.length && text ? /^\/new(?:@\w+)?\s*$/.test(text) : false;
    if (newChatCommand) {
      await this.store.clearChannelSession(connection.id, update.senderId, agentCatalogId);
      await this.telegram.sendMessage(
        token,
        update.chatId,
        `New chat started with ${displayNames[agentCatalogId]}. Send a message when you are ready.`,
      );
      await finishUpdates("delivered");
      return;
    }

    let attachments: ChatFilePart[] = [];
    if (telegramAttachments.length) {
      try {
        let totalBytes = 0;
        for (const attachment of telegramAttachments) {
          const downloaded = await this.attachmentPart(token, attachment);
          totalBytes += downloaded.byteLength;
          if (totalBytes > channelAttachmentMaxTotalBytes) {
            throw new LemmaComputerError("CHANNEL_ATTACHMENT_TOO_LARGE", "The Telegram attachments exceed their total size limit", 400);
          }
          attachments.push(downloaded.part);
        }
      } catch (error) {
        const code = error instanceof LemmaComputerError ? error.code : "TELEGRAM_FILE_UNAVAILABLE";
        const message = code === "CHANNEL_ATTACHMENT_UNSUPPORTED"
          ? unsupportedAttachmentMessage
          : code === "CHANNEL_ATTACHMENT_TOO_LARGE" ? oversizedAttachmentMessage : unavailableAttachmentMessage;
        await this.telegram.sendMessage(token, update.chatId, message).catch(() => undefined);
        await finishUpdates("rejected", code);
        return;
      }
    }

    const sessionId = await this.store.getChannelSession(connection.id, update.senderId, agentCatalogId);
    await this.telegram.sendMessage(token, update.chatId, acknowledgementMessage, {
      disableNotification: true,
    }).catch(() => undefined);
    const responseStream = new TelegramResponseStream(this.telegram, token, update.chatId);
    let approvalNoticeSent = false;
    let responseStaged = false;
    try {
      const response = channelTurnResponseSchema.parse(await this.withTypingIndicator(
        token,
        update.chatId,
        () => this.control.turn(
          channelTurnRequestSchema.parse({
            ...this.route(connection, identity, update.senderId, update.chatId, agentCatalogId),
            updateId: update.updateId,
            ...(sessionId ? { sessionId } : {}),
            ...(text ? { text } : {}),
            ...(attachments.length ? { attachments } : {}),
          }),
          async (notice) => {
            await this.telegram.sendMessage(token, update.chatId, notice);
            approvalNoticeSent = true;
          },
          async (delta) => responseStream.append(delta),
        ),
      ));
      await this.store.saveChannelSession(connection.id, update.senderId, agentCatalogId, response.sessionId);
      const streamedCharacters = await responseStream.finish(response.text);
      const remainingText = [...response.text].slice(streamedCharacters).join("");
      const fallback = response.state === "needs_input"
        ? "The agent needs more information. Reply to continue this conversation."
        : response.artifacts?.length ? "" : "The agent completed without a text response.";
      const rendered = [remainingText, ...response.notices].filter(Boolean).join("\n\n")
        || (streamedCharacters ? "" : fallback);
      const delivered = ["completed", "needs_input"].includes(response.state);
      const failureCode = response.state === "cancelled" ? "CHANNEL_TURN_CANCELLED" : "CHANNEL_TURN_FAILED";
      if (rendered || response.artifacts?.length) {
        await this.store.stageChannelResponse(
          connection.id,
          update.updateId,
          update.chatId,
          rendered,
          agentCatalogId,
          response.artifacts ?? [],
          delivered ? "delivered" : "failed",
          delivered ? undefined : failureCode,
        );
        await finishUpdates(delivered ? "delivered" : "failed", delivered ? undefined : failureCode, false);
        responseStaged = true;
        await this.deliverPendingResponses(connection, token);
      } else {
        await finishUpdates(delivered ? "delivered" : "failed", delivered ? undefined : failureCode);
        responseStaged = true;
      }
    } catch (error) {
      if (responseStaged) return;
      const failureCode = error instanceof LemmaComputerError ? error.code : "CHANNEL_TURN_FAILED";
      await this.store.stageChannelResponse(
        connection.id,
        update.updateId,
        update.chatId,
        approvalNoticeSent ? approvalFailureMessage : safeFailureMessage,
        agentCatalogId,
        [],
        "failed",
        failureCode,
      );
      await finishUpdates("failed", failureCode, false);
      await this.deliverPendingResponses(connection, token).catch(() => undefined);
    }
  }
}
