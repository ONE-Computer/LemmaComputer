import { createHmac } from "node:crypto";
import { OneComputerError, hermesChatSessionIdSchema, type IdentityContext, type RuntimePolicy } from "@onecomputer/contracts";

export type HermesApiAccess = {
  workspaceId: string;
  key: string;
  baseUrl: string;
};

export type HermesChatSession = {
  id: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type HermesChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt?: string;
};

const hasHermes = (policy: RuntimePolicy) => policy.agentProfile === "hermes-claw-managed-v1"
  || policy.agents?.some((agent) => agent.catalogId === "hermes-claw") === true;

export class HermesApiAuthority {
  constructor(private readonly rootSecret: string) {}

  issue(identity: IdentityContext, workspaceId: string, policy: RuntimePolicy): HermesApiAccess | undefined {
    if (!hasHermes(policy)) return undefined;
    const key = createHmac("sha256", this.rootSecret)
      .update("onecomputer-hermes-api/v1\0")
      .update(identity.tenantId).update("\0")
      .update(identity.subjectId).update("\0")
      .update(workspaceId).update("\0")
      .update("hermes-claw").update("\0")
      .update(policy.policyHash)
      .digest("base64url");
    return {
      workspaceId,
      key,
      baseUrl: `http://onecomputer-sandbox-${workspaceId}:8642`,
    };
  }
}

export interface HermesChatClient {
  health(access: HermesApiAccess): Promise<void>;
  listSessions(access: HermesApiAccess): Promise<HermesChatSession[]>;
  createSession(access: HermesApiAccess, title?: string): Promise<HermesChatSession>;
  listMessages(access: HermesApiAccess, sessionId: string): Promise<HermesChatMessage[]>;
  sendMessage(access: HermesApiAccess, sessionId: string, message: string): Promise<HermesChatMessage>;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object"
  ? value as Record<string, unknown>
  : {};

const nullableText = (value: unknown) => typeof value === "string" && value.length ? value : null;

const session = (value: unknown): HermesChatSession => {
  const item = object(value);
  const id = hermesChatSessionIdSchema.safeParse(item.id);
  if (!id.success) throw new OneComputerError("HERMES_INVALID_RESPONSE", "Hermes returned an invalid session", 502, true);
  return {
    id: id.data,
    title: nullableText(item.title),
    createdAt: nullableText(item.created_at ?? item.createdAt),
    updatedAt: nullableText(item.updated_at ?? item.updatedAt),
  };
};

const message = (value: unknown): HermesChatMessage => {
  const item = object(value);
  const role = ["user", "assistant", "system", "tool"].includes(String(item.role))
    ? item.role as HermesChatMessage["role"]
    : undefined;
  if (!role || typeof item.content !== "string") {
    throw new OneComputerError("HERMES_INVALID_RESPONSE", "Hermes returned an invalid message", 502, true);
  }
  const createdAt = nullableText(item.created_at ?? item.createdAt);
  return { role, content: item.content, ...(createdAt ? { createdAt } : {}) };
};

export class HttpHermesChatClient implements HermesChatClient {
  private async call(access: HermesApiAccess, path: string, init?: RequestInit, timeoutMs = 15_000) {
    let response: Response;
    try {
      response = await fetch(`${access.baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${access.key}`,
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new OneComputerError("HERMES_UNAVAILABLE", "Hermes is not available in this sandbox", 503, true);
    }
    if (!response.ok) {
      throw new OneComputerError(
        response.status === 404 ? "HERMES_SESSION_NOT_FOUND" : "HERMES_UNAVAILABLE",
        response.status === 404 ? "Chat session not found" : "Hermes could not complete the request",
        response.status === 404 ? 404 : 503,
        response.status !== 404,
      );
    }
    return response.status === 204 ? {} : response.json().catch(() => {
      throw new OneComputerError("HERMES_INVALID_RESPONSE", "Hermes returned an invalid response", 502, true);
    });
  }

  async health(access: HermesApiAccess) {
    await this.call(access, "/health");
  }

  async listSessions(access: HermesApiAccess) {
    const payload = object(await this.call(access, "/api/sessions"));
    const values = Array.isArray(payload.sessions) ? payload.sessions : Array.isArray(payload.data) ? payload.data : [];
    return values.map(session);
  }

  async createSession(access: HermesApiAccess, title?: string) {
    const payload = object(await this.call(access, "/api/sessions", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }));
    return session(payload.session ?? payload);
  }

  async listMessages(access: HermesApiAccess, sessionId: string) {
    const id = hermesChatSessionIdSchema.parse(sessionId);
    const payload = object(await this.call(access, `/api/sessions/${encodeURIComponent(id)}/messages`));
    const values = Array.isArray(payload.messages) ? payload.messages : Array.isArray(payload.data) ? payload.data : [];
    return values.map(message);
  }

  async sendMessage(access: HermesApiAccess, sessionId: string, text: string) {
    const id = hermesChatSessionIdSchema.parse(sessionId);
    const payload = object(await this.call(access, `/api/sessions/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      body: JSON.stringify({ message: text }),
    }, 5 * 60_000));
    return message(payload.message);
  }
}
