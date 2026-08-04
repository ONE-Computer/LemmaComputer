import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import webPush, { type PushSubscription } from "web-push";

export const COMPANION_PUSH_PROTOCOL = "lemmacomputer-companion-push-0.1" as const;

export type CompanionPushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type CompanionPushResult = {
  delivered: boolean;
  terminal: boolean;
  failureCode?: string;
};

export interface CompanionPushProvider {
  readonly publicKey: string;
  protect(subscription: CompanionPushSubscription): { endpointHash: string; ciphertext: string };
  sendHint(ciphertext: string): Promise<CompanionPushResult>;
}

// Intentionally contains no task, operation, tenant, user, resource, URL token,
// or signing material. It is only a wake-up hint; the authenticated companion
// retrieves current task truth from Control after the notification is opened.
export const genericCompanionPushPayload = JSON.stringify({
  version: "1",
  event: "approval-pending",
});

const encryptionKey = (secret: string) => createHash("sha256").update(`lemmacomputer/web-push/subscription/v1:${secret}`).digest();
const endpointHash = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex");

export class WebPushProvider implements CompanionPushProvider {
  readonly publicKey: string;
  private readonly key: Buffer;

  constructor(input: {
    subject: string;
    publicKey: string;
    privateKey: string;
    subscriptionSecret: string;
  }) {
    this.publicKey = input.publicKey;
    this.key = encryptionKey(input.subscriptionSecret);
    webPush.setVapidDetails(input.subject, input.publicKey, input.privateKey);
  }

  protect(subscription: CompanionPushSubscription) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from("lemmacomputer/openvtc/companion-subscription/v1"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(subscription), "utf8"), cipher.final()]);
    return {
      endpointHash: endpointHash(subscription.endpoint),
      ciphertext: [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join("."),
    };
  }

  async sendHint(ciphertext: string): Promise<CompanionPushResult> {
    let subscription: CompanionPushSubscription;
    try {
      const [version, iv, tag, encrypted, extra] = ciphertext.split(".");
      if (version !== "v1" || !iv || !tag || !encrypted || extra) throw new Error("invalid protected subscription");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from("lemmacomputer/openvtc/companion-subscription/v1"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      subscription = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64url")),
        decipher.final(),
      ]).toString("utf8")) as CompanionPushSubscription;
    } catch {
      return { delivered: false, terminal: true, failureCode: "WEB_PUSH_SUBSCRIPTION_DECRYPT_FAILED" };
    }

    try {
      await webPush.sendNotification(subscription as PushSubscription, genericCompanionPushPayload, {
        TTL: 300,
        urgency: "high",
        topic: "lemmacomputer-approval",
      });
      return { delivered: true, terminal: false };
    } catch (error) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 0;
      return {
        delivered: false,
        terminal: statusCode === 404 || statusCode === 410,
        failureCode: statusCode ? `WEB_PUSH_HTTP_${statusCode}` : "WEB_PUSH_PROVIDER_UNAVAILABLE",
      };
    }
  }
}
