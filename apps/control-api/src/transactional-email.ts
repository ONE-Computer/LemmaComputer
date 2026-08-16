export const transactionalEmailKinds = ["email-verification", "password-recovery", "organization-invitation"] as const;
export type TransactionalEmailKind = typeof transactionalEmailKinds[number];

export type TransactionalEmailMessage = {
  kind: TransactionalEmailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type TransactionalEmailResult = {
  accepted: boolean;
  providerMessageId: string | null;
  failure: "retryable" | "terminal" | null;
};

export interface TransactionalEmailAdapter {
  send(message: TransactionalEmailMessage): Promise<TransactionalEmailResult>;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
}[character]!));

export const deliverOrganizationInvitationEmail = async (
  adapter: TransactionalEmailAdapter,
  input: {
    recipient: string;
    organizationDisplayName: string;
    role: "owner" | "admin" | "member";
    activationUrl: string;
    expiresAt: Date;
  },
) => {
  const roleLabel = { owner: "Owner", admin: "Administrator", member: "Member" }[input.role];
  const expiry = input.expiresAt.toISOString();
  const result = await adapter.send({
    kind: "organization-invitation",
    to: input.recipient,
    subject: `Join ${input.organizationDisplayName} on LemmaComputer`,
    text: `${input.organizationDisplayName} invited you to LemmaComputer as ${roleLabel}.\n\nAccept this invitation:\n${input.activationUrl}\n\nThis link expires at ${expiry}. The invitation fixes your organization and role; your authentication provider cannot change them. If you did not expect this invitation, ignore this email.`,
    html: `<p><strong>${escapeHtml(input.organizationDisplayName)}</strong> invited you to LemmaComputer as <strong>${escapeHtml(roleLabel)}</strong>.</p><p><a href="${escapeHtml(input.activationUrl)}">Accept invitation</a></p><p>This link expires at ${escapeHtml(expiry)}. The invitation fixes your organization and role; your authentication provider cannot change them.</p><p>If you did not expect this invitation, ignore this email.</p>`,
  });
  if (!result.accepted) throw new Error("Transactional invitation email delivery failed");
  return result;
};

const assertRenderedMessage = (message: TransactionalEmailMessage) => {
  if (!transactionalEmailKinds.includes(message.kind)) throw new Error("Unknown transactional email kind");
  if (!message.to.trim() || /[\r\n]/.test(message.to) || message.to.length > 320) throw new Error("Transactional email recipient is invalid");
  if (!message.subject.trim() || /[\r\n]/.test(message.subject) || message.subject.length > 200) throw new Error("Transactional email subject is invalid");
  if (!message.text || Buffer.byteLength(message.text, "utf8") > 256 * 1024) throw new Error("Transactional email text body is invalid");
  if (!message.html || Buffer.byteLength(message.html, "utf8") > 256 * 1024) throw new Error("Transactional email HTML body is invalid");
};

export class CaptureTransactionalEmailAdapter implements TransactionalEmailAdapter {
  private readonly messages: TransactionalEmailMessage[] = [];
  private readonly capacity: number;

  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? 100;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > 1_000) {
      throw new Error("Transactional email capture capacity must be between 1 and 1000");
    }
  }

  get size() {
    return this.messages.length;
  }

  async send(message: TransactionalEmailMessage): Promise<TransactionalEmailResult> {
    assertRenderedMessage(message);
    if (this.messages.length >= this.capacity) throw new Error("Transactional email capture capacity exhausted");
    this.messages.push(structuredClone(message));
    return { accepted: true, providerMessageId: null, failure: null };
  }

  take(to: string, kind: TransactionalEmailKind): TransactionalEmailMessage | null {
    const index = this.messages.findIndex((message) => message.to === to && message.kind === kind);
    if (index < 0) return null;
    return this.messages.splice(index, 1)[0] ?? null;
  }

  takeLatest(to: string, kind: TransactionalEmailKind): TransactionalEmailMessage | null {
    const index = this.messages.findLastIndex((message) => message.to === to && message.kind === kind);
    if (index < 0) return null;
    return this.messages.splice(index, 1)[0] ?? null;
  }

  clear() {
    this.messages.splice(0, this.messages.length);
  }
}

export type PostmarkTransactionalEmailOptions = {
  serverToken: string;
  from: string;
  messageStream?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export class PostmarkTransactionalEmailAdapter implements TransactionalEmailAdapter {
  private readonly serverToken: string;
  private readonly from: string;
  private readonly messageStream: string;
  private readonly timeoutMs: number;
  private readonly request: typeof globalThis.fetch;

  constructor(options: PostmarkTransactionalEmailOptions) {
    if (!options.serverToken.trim()) throw new Error("Postmark server token is required");
    if (!options.from.trim() || /[\r\n]/.test(options.from) || options.from.length > 320) throw new Error("Postmark sender is invalid");
    const messageStream = options.messageStream?.trim() || "outbound";
    if (/[^a-zA-Z0-9._-]/.test(messageStream) || messageStream.length > 100) throw new Error("Postmark message stream is invalid");
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error("Postmark timeout must be between 1 and 30000 milliseconds");
    this.serverToken = options.serverToken;
    this.from = options.from;
    this.messageStream = messageStream;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async send(message: TransactionalEmailMessage): Promise<TransactionalEmailResult> {
    assertRenderedMessage(message);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-postmark-server-token": this.serverToken,
        },
        body: JSON.stringify({
          From: this.from,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          HtmlBody: message.html,
          MessageStream: this.messageStream,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        return { accepted: false, providerMessageId: null, failure: retryable ? "retryable" : "terminal" };
      }
      const body = await response.json().catch(() => null) as { MessageID?: unknown; ErrorCode?: unknown } | null;
      if (!body || body.ErrorCode !== 0 || typeof body.MessageID !== "string" || !body.MessageID) {
        return { accepted: false, providerMessageId: null, failure: "terminal" };
      }
      return { accepted: true, providerMessageId: body.MessageID, failure: null };
    } catch {
      return { accepted: false, providerMessageId: null, failure: "retryable" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type TransactionalEmailConfiguration = {
  transport: "capture" | "postmark";
  installationKind: "customer-managed" | "hosted" | "worktree";
  runtimeEnvironment: "test" | "development" | "production";
  captureCapacity?: number;
  postmarkServerToken?: string;
  postmarkFrom?: string;
  postmarkMessageStream?: string;
  postmarkTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export const createTransactionalEmailAdapter = (configuration: TransactionalEmailConfiguration): TransactionalEmailAdapter => {
  if (configuration.transport === "capture") {
    if (configuration.runtimeEnvironment === "production") {
      throw new Error("Capture transactional email is unavailable in hosted production or any production runtime");
    }
    return new CaptureTransactionalEmailAdapter({ capacity: configuration.captureCapacity });
  }
  if (!configuration.postmarkServerToken) throw new Error("Postmark server token is required");
  if (!configuration.postmarkFrom) throw new Error("Postmark sender is required");
  return new PostmarkTransactionalEmailAdapter({
    serverToken: configuration.postmarkServerToken,
    from: configuration.postmarkFrom,
    messageStream: configuration.postmarkMessageStream,
    timeoutMs: configuration.postmarkTimeoutMs,
    fetch: configuration.fetch,
  });
};
