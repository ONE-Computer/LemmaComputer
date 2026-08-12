import { createHmac } from "node:crypto";
import type { InferUIMessageChunk } from "ai";
import {
  LemmaComputerError,
  agentChatEventSchema,
  chatAgentCatalogIdSchema,
  channelArtifactMaxBytes,
  chatSessionIdSchema,
  chatUiMessageSchema,
  ownedAgentCatalog,
  type AgentChatEvent,
  type ChatAgentCatalogId,
  type ChatArtifact,
  type ChatUiMessage,
  type IdentityContext,
  type RuntimePolicy,
} from "@lemmacomputer/contracts";

export type AgentChatAccess = {
  workspaceId: string;
  catalogId: ChatAgentCatalogId;
  displayName: string;
  key: string;
  agentId: string;
  baseUrl: string;
};

export type AgentChatSession = {
  id: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AgentChatSessionPage = {
  sessions: AgentChatSession[];
  nextCursor: string | null;
};

const chatRuntimePorts: Readonly<Record<ChatAgentCatalogId, number>> = Object.freeze({
  "claude-cli": 8643,
  "codex-cli": 8644,
  "hermes-claw": 8642,
});

const chatDisplayNames: Readonly<Record<ChatAgentCatalogId, string>> = Object.freeze(
  Object.fromEntries(
    ownedAgentCatalog
      .filter((agent) => chatAgentCatalogIdSchema.safeParse(agent.id).success)
      .map((agent) => [agent.id, agent.displayName]),
  ) as Record<ChatAgentCatalogId, string>,
);

const fallbackCatalogId = (policy: RuntimePolicy): ChatAgentCatalogId | undefined => ({
  "claude-cli-managed-v1": "claude-cli",
  "codex-cli-managed-v1": "codex-cli",
  "hermes-claw-managed-v1": "hermes-claw",
} as const)[policy.agentProfile as "claude-cli-managed-v1" | "codex-cli-managed-v1" | "hermes-claw-managed-v1"];

export const assignedChatAgentIds = (policy: RuntimePolicy): ChatAgentCatalogId[] => {
  const selected = policy.agents?.map((agent) => agent.catalogId) ?? [fallbackCatalogId(policy)];
  return selected.flatMap((catalogId) => {
    const parsed = chatAgentCatalogIdSchema.safeParse(catalogId);
    return parsed.success ? [parsed.data] : [];
  });
};

export class AgentChatAuthority {
  constructor(private readonly rootSecret: string) {}

  issue(
    identity: IdentityContext,
    workspaceId: string,
    policy: RuntimePolicy,
    catalogId: ChatAgentCatalogId,
  ): AgentChatAccess | undefined {
    if (!assignedChatAgentIds(policy).includes(catalogId)) return undefined;
    const agentId = policy.agents?.find((agent) => agent.catalogId === catalogId)?.agentId ?? policy.agentId;
    const key = createHmac("sha256", this.rootSecret)
      .update("lemmacomputer-agent-chat/v1\0")
      .update(identity.tenantId).update("\0")
      .update(identity.subjectId).update("\0")
      .update(workspaceId).update("\0")
      .update(catalogId).update("\0")
      .update(policy.policyHash)
      .digest("base64url");
    return {
      workspaceId,
      catalogId,
      displayName: chatDisplayNames[catalogId],
      agentId,
      key,
      baseUrl: `http://lemmacomputer-sandbox-${workspaceId}:${chatRuntimePorts[catalogId]}`,
    };
  }

  list(identity: IdentityContext, workspaceId: string, policy: RuntimePolicy): AgentChatAccess[] {
    return assignedChatAgentIds(policy).flatMap((catalogId) => {
      const access = this.issue(identity, workspaceId, policy, catalogId);
      return access ? [access] : [];
    });
  }
}

export interface AgentChatClient {
  health(access: AgentChatAccess): Promise<void>;
  listSessions(access: AgentChatAccess, options?: { cursor?: string; limit?: number }): Promise<AgentChatSessionPage>;
  createSession(access: AgentChatAccess, title?: string): Promise<AgentChatSession>;
  listMessages(access: AgentChatAccess, sessionId: string): Promise<ChatUiMessage[]>;
  cancelTurn(access: AgentChatAccess, sessionId: string): Promise<void>;
  downloadArtifact(access: AgentChatAccess, artifactId: string): Promise<Buffer>;
  streamTurn(
    access: AgentChatAccess,
    sessionId: string,
    message: ChatUiMessage,
    signal?: AbortSignal,
    usageTaskBinding?: string,
    agentInstanceId?: string,
  ): AsyncIterable<AgentChatEvent>;
}

type ChatApprovalState = Extract<
  ChatUiMessage["parts"][number],
  { type: "data-approval" }
>["data"]["state"];

export const chatApprovalSummary = (state: ChatApprovalState, action?: string) => action ? ({
  approval_required: `Approval needed: ${action}`,
  approved: `Approved: ${action}`,
  executing: `Running: ${action}`,
  succeeded: `Completed: ${action}`,
  denied: `Denied: ${action}`,
  failed: `Failed: ${action}`,
  expired: `Expired: ${action}`,
})[state] : ({
  approval_required: "Waiting for signed approval",
  approved: "Approval received",
  executing: "Approved action is running",
  succeeded: "Approved action completed",
  denied: "Approval was denied; the action did not run",
  failed: "The governed action failed",
  expired: "Approval expired; the action did not run",
})[state];

/**
 * Reconcile durable agent history with Control-owned operation truth.
 *
 * A governed operation can finish after an employee stops the model turn.
 * The workspace transcript is intentionally not authoritative for that later
 * transition, so Control closes stale activity rows and projects the current
 * owned operation state whenever history is read.
 */
export const reconcileChatMessages = async (
  messages: ChatUiMessage[],
  operationState: (operationId: string) => Promise<{
    state: ChatApprovalState;
    safeSummary: string;
  } | undefined>,
): Promise<ChatUiMessage[]> => Promise.all(messages.map(async (message) => {
  if (message.role !== "assistant") return message;
  const terminalState = message.metadata.state;
  const parts = await Promise.all(message.parts.map(async (part) => {
    if (part.type === "data-approval") {
      const operation = await operationState(part.data.operationId);
      return operation && (operation.state !== part.data.state
        || part.data.summary !== chatApprovalSummary(operation.state, operation.safeSummary))
        ? {
          ...part,
          data: {
            ...part.data,
            state: operation.state,
            summary: chatApprovalSummary(operation.state, operation.safeSummary),
          },
        }
        : part;
    }
    if (terminalState === "streaming") return part;
    if (part.type === "data-progress" && part.data.state === "running") {
      return {
        ...part,
        data: {
          ...part.data,
          state: "completed" as const,
          label: terminalState === "cancelled"
            ? "Work stopped"
            : terminalState === "failed"
              ? "Work failed"
              : "Work complete",
        },
      };
    }
    if (part.type === "data-tool" && part.data.state === "running") {
      return {
        ...part,
        data: {
          ...part.data,
          state: "failed" as const,
          summary: terminalState === "cancelled"
            ? "Stopped before the tool returned"
            : "The tool did not return a final result",
        },
      };
    }
    return part;
  }));
  return { ...message, parts };
}));

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object"
  ? value as Record<string, unknown>
  : {};

const nullableText = (value: unknown) => typeof value === "string" && value.length ? value : null;
const agentTurnTimeoutMs = 15 * 60_000;

const session = (value: unknown): AgentChatSession => {
  const item = object(value);
  const id = chatSessionIdSchema.safeParse(item.id);
  if (!id.success) throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent returned an invalid session", 502, true);
  return {
    id: id.data,
    title: nullableText(item.title),
    createdAt: nullableText(item.created_at ?? item.createdAt),
    updatedAt: nullableText(item.updated_at ?? item.updatedAt),
  };
};

const upstreamError = (access: AgentChatAccess, status: number) => new LemmaComputerError(
  status === 400
    ? "CHAT_SESSION_REJECTED"
    : status === 404
    ? "CHAT_SESSION_NOT_FOUND"
    : status === 409
      ? "CHAT_TURN_ACTIVE"
      : "CHAT_RUNTIME_UNAVAILABLE",
  status === 400
    ? "The chat session could not be created"
    : status === 404
    ? "Chat session not found"
    : status === 409
      ? "That conversation already has a turn in progress"
      : `${access.displayName} could not complete the request`,
  status === 400 ? 400 : status === 404 ? 404 : status === 409 ? 409 : 503,
  ![400, 404, 409].includes(status),
);

export class HttpAgentChatClient implements AgentChatClient {
  private async response(access: AgentChatAccess, path: string, init?: RequestInit, timeoutMs = 15_000) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const response = await fetch(`${access.baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${access.key}`,
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        },
        signal,
      });
      if (!response.ok) throw upstreamError(access, response.status);
      return response;
    } catch (error) {
      if (error instanceof LemmaComputerError) throw error;
      if (init?.signal?.aborted) throw error;
      throw new LemmaComputerError(
        "CHAT_RUNTIME_UNAVAILABLE",
        `${access.displayName} is not available in this workspace`,
        503,
        true,
      );
    }
  }

  private async json(access: AgentChatAccess, path: string, init?: RequestInit) {
    const response = await this.response(access, path, init);
    if (response.status === 204) return {};
    return response.json().catch(() => {
      throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent returned an invalid response", 502, true);
    });
  }

  async health(access: AgentChatAccess) {
    await this.response(access, "/health");
  }

  async downloadArtifact(access: AgentChatAccess, artifactId: string) {
    const response = await this.response(access, `/api/artifacts/${encodeURIComponent(artifactId)}`, undefined, 60_000);
    if (!response.body) throw new LemmaComputerError("CHAT_ARTIFACT_UNAVAILABLE", "The generated file is unavailable", 502, true);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > channelArtifactMaxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new LemmaComputerError("CHAT_ARTIFACT_TOO_LARGE", "The generated file exceeds its delivery limit", 502);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > channelArtifactMaxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new LemmaComputerError("CHAT_ARTIFACT_TOO_LARGE", "The generated file exceeds its delivery limit", 502);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (!size) throw new LemmaComputerError("CHAT_ARTIFACT_UNAVAILABLE", "The generated file is empty", 502);
    return Buffer.concat(chunks, size);
  }

  async listSessions(access: AgentChatAccess, options: { cursor?: string; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    const payload = object(await this.json(access, `/api/sessions${query.size ? `?${query}` : ""}`));
    const values = Array.isArray(payload.sessions) ? payload.sessions : [];
    return {
      sessions: values.map(session),
      nextCursor: nullableText(payload.nextCursor ?? payload.next_cursor),
    };
  }

  async createSession(access: AgentChatAccess, title?: string) {
    const payload = object(await this.json(access, "/api/sessions", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }));
    return session(payload.session ?? payload);
  }

  async listMessages(access: AgentChatAccess, sessionId: string) {
    const id = chatSessionIdSchema.parse(sessionId);
    const payload = object(await this.json(access, `/api/sessions/${encodeURIComponent(id)}/messages`));
    if (!Array.isArray(payload.messages)) {
      throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent returned invalid conversation history", 502, true);
    }
    return payload.messages.map((value) => {
      const parsed = chatUiMessageSchema.safeParse(value);
      if (!parsed.success || parsed.data.metadata.agentCatalogId !== access.catalogId) {
        throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent returned invalid conversation history", 502, true);
      }
      return parsed.data;
    });
  }

  async cancelTurn(access: AgentChatAccess, sessionId: string) {
    const id = chatSessionIdSchema.parse(sessionId);
    await this.response(access, `/api/sessions/${encodeURIComponent(id)}/turns/active`, {
      method: "DELETE",
    });
  }

  async *streamTurn(
    access: AgentChatAccess,
    sessionId: string,
    message: ChatUiMessage,
    signal?: AbortSignal,
    usageTaskBinding?: string,
    agentInstanceId?: string,
  ): AsyncIterable<AgentChatEvent> {
    const id = chatSessionIdSchema.parse(sessionId);
    const response = await this.response(access, `/api/sessions/${encodeURIComponent(id)}/turns`, {
      method: "POST",
      body: JSON.stringify({
        message,
        ...(usageTaskBinding ? { usageTaskBinding } : {}),
        ...(agentInstanceId ? { agentInstanceId } : {}),
      }),
      signal,
    }, agentTurnTimeoutMs);
    if (!response.body || !response.headers.get("content-type")?.startsWith("application/x-ndjson")) {
      await response.body?.cancel();
      throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent returned an invalid event stream", 502, true);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let expectedSequence = 0;
    let turnId = "";
    let terminal = false;
    let textSize = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        if (buffer.length > 64 * 1024) {
          throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent event stream exceeded its frame limit", 502, true);
        }
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let decoded: unknown;
          try {
            decoded = JSON.parse(line);
          } catch {
            throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent returned a malformed event", 502, true);
          }
          const parsed = agentChatEventSchema.safeParse(decoded);
          if (
            !parsed.success
            || parsed.data.sessionId !== id
            || parsed.data.sequence !== expectedSequence
            || (expectedSequence === 0 && parsed.data.type !== "turn-start")
            || (turnId && parsed.data.turnId !== turnId)
            || terminal
          ) {
            throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent returned an invalid event sequence", 502, true);
          }
          const event = parsed.data;
          turnId ||= event.turnId;
          expectedSequence += 1;
          if (event.type === "text-delta") {
            textSize += event.delta.length;
            if (textSize > 128_000) {
              throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent response exceeded its text limit", 502, true);
            }
          }
          terminal = event.type === "turn-finish";
          yield event;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() || !terminal) {
        throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent event stream ended unexpectedly", 502, true);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

export class AgentUiStreamMapper {
  private readonly textIds = new Set<string>();
  private createdAt = "";

  constructor(private readonly catalogId: ChatAgentCatalogId) {}

  chunks(event: AgentChatEvent): InferUIMessageChunk<ChatUiMessage>[] {
    if (event.type === "turn-start") {
      this.createdAt = event.createdAt;
      return [{
        type: "start",
        messageId: event.messageId,
        messageMetadata: {
          agentCatalogId: this.catalogId,
          turnId: event.turnId,
          state: "streaming",
          createdAt: event.createdAt,
        },
      }];
    }
    if (event.type === "progress") {
      return [{
        type: "data-progress",
        id: event.activityId,
        data: {
          activityId: event.activityId,
          label: event.label,
          state: event.state,
        },
      }];
    }
    if (event.type === "artifact") {
      const artifact: ChatArtifact = {
        artifactId: event.artifactId, mediaType: event.mediaType, filename: event.filename,
        byteLength: event.byteLength, sha256: event.sha256,
      };
      return [{ type: "data-file-reference", id: artifact.artifactId, data: {
        mediaType: artifact.mediaType, filename: artifact.filename, storage: "workspace",
      } }];
    }
    if (event.type === "text-delta") {
      const chunks: InferUIMessageChunk<ChatUiMessage>[] = [];
      if (!this.textIds.has(event.textId)) {
        this.textIds.add(event.textId);
        chunks.push({ type: "text-start", id: event.textId });
      }
      chunks.push({ type: "text-delta", id: event.textId, delta: event.delta });
      return chunks;
    }
    if (event.type === "tool") {
      if (!event.progressLabel) {
        return [];
      }
      return [{
        type: "data-progress",
        id: `progress-${event.turnId}`,
        data: {
          activityId: `progress-${event.turnId}`,
          label: event.progressLabel,
          state: "running",
        },
      }];
    }
    if (event.type === "approval") {
      return [{
        type: "data-approval",
        id: event.approvalId,
        data: {
          approvalId: event.approvalId,
          toolCallId: event.toolCallId,
          operationId: event.operationId,
          state: event.state,
          summary: event.summary,
        },
      }];
    }
    if (event.type !== "turn-finish") return [];

    return [
      ...[...this.textIds].map((textId): InferUIMessageChunk<ChatUiMessage> => ({ type: "text-end", id: textId })),
      {
        type: "data-terminal",
        id: `terminal-${event.turnId}`,
        data: {
          turnId: event.turnId,
          state: event.state,
          ...(event.message ? { message: event.message } : {}),
        },
      },
      {
        type: "finish",
        finishReason: ["completed", "needs_input"].includes(event.state)
          ? "stop"
          : event.state === "cancelled" ? "other" : "error",
        messageMetadata: {
          agentCatalogId: this.catalogId,
          turnId: event.turnId,
          state: event.state,
          createdAt: this.createdAt || event.completedAt,
        },
      },
    ];
  }
}
