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
  type ChatReasoningEffort,
  type ChatUiMessage,
  type IdentityContext,
  type RuntimePolicy,
} from "@lemmacomputer/contracts";

export type AgentChatAccess = {
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  workspaceNodeId: string | null;
  accessGeneration: number;
  policyVersionId: string;
  policyVersion: number;
  policyHash: string;
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
  reasoningEffort?: ChatReasoningEffort;
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
    workspace: { id: string; workspaceNodeId?: string | null; accessGeneration: number },
    policy: RuntimePolicy,
    catalogId: ChatAgentCatalogId,
  ): AgentChatAccess | undefined {
    if (!assignedChatAgentIds(policy).includes(catalogId)) return undefined;
    const agentId = policy.agents?.find((agent) => agent.catalogId === catalogId)?.agentId ?? policy.agentId;
    const key = createHmac("sha256", this.rootSecret)
      .update("lemmacomputer-agent-chat/v1\0")
      .update(identity.tenantId).update("\0")
      .update(identity.subjectId).update("\0")
      .update(workspace.id).update("\0")
      .update(workspace.workspaceNodeId ?? "colocated").update("\0")
      .update(String(workspace.accessGeneration)).update("\0")
      .update(catalogId).update("\0")
      .update(policy.policyHash)
      .digest("base64url");
    return {
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      workspaceId: workspace.id,
      workspaceNodeId: workspace.workspaceNodeId ?? null,
      accessGeneration: workspace.accessGeneration,
      policyVersionId: policy.policyVersionId,
      policyVersion: policy.policyVersion,
      policyHash: policy.policyHash,
      catalogId,
      displayName: chatDisplayNames[catalogId],
      agentId,
      key,
      baseUrl: `http://lemmacomputer-sandbox-${workspace.id}:${chatRuntimePorts[catalogId]}`,
    };
  }

  list(identity: IdentityContext, workspace: { id: string; workspaceNodeId?: string | null; accessGeneration: number }, policy: RuntimePolicy): AgentChatAccess[] {
    return assignedChatAgentIds(policy).flatMap((catalogId) => {
      const access = this.issue(identity, workspace, policy, catalogId);
      return access ? [access] : [];
    });
  }
}

export interface AgentChatClient {
  health(access: AgentChatAccess): Promise<void>;
  cancelTurn(access: AgentChatAccess, sessionId: string): Promise<void>;
  downloadArtifact(access: AgentChatAccess, artifactId: string): Promise<Buffer>;
  streamTurn(
    access: AgentChatAccess,
    sessionId: string,
    message: ChatUiMessage,
    signal?: AbortSignal,
    usageTaskBinding?: string,
    agentInstanceId?: string,
    reasoningEffort?: ChatReasoningEffort,
    history?: ChatUiMessage[],
    vendorSessionId?: string,
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

const agentTurnTimeoutMs = 15 * 60_000;

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
    reasoningEffort?: ChatReasoningEffort,
    history: ChatUiMessage[] = [],
    vendorSessionId?: string,
  ): AsyncIterable<AgentChatEvent> {
    const id = chatSessionIdSchema.parse(sessionId);
    const response = await this.response(access, `/api/sessions/${encodeURIComponent(id)}/turns`, {
      method: "POST",
      body: JSON.stringify({
        message,
        ...(usageTaskBinding ? { usageTaskBinding } : {}),
        ...(agentInstanceId ? { agentInstanceId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        history,
        ...(vendorSessionId ? { vendorSessionId } : {}),
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
      if (!event.revisionId) {
        throw new LemmaComputerError("CHAT_ARTIFACT_NOT_FINALIZED", "The generated file was not finalized by Control", 502);
      }
      const artifact: ChatArtifact = {
        artifactId: event.artifactId, revisionId: event.revisionId, mediaType: event.mediaType, filename: event.filename,
        byteLength: event.byteLength, sha256: event.sha256,
      };
      return [{ type: "data-file-reference", id: artifact.artifactId, data: {
        mediaType: artifact.mediaType, filename: artifact.filename, storage: "control", revisionId: artifact.revisionId,
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

export class AgentMessageAccumulator {
  private message?: ChatUiMessage;
  private readonly textParts = new Map<string, number>();

  constructor(private readonly catalogId: ChatAgentCatalogId) {}

  apply(event: AgentChatEvent) {
    if (event.type === "turn-start") {
      this.message = {
        id: event.messageId,
        role: "assistant",
        metadata: {
          agentCatalogId: this.catalogId,
          turnId: event.turnId,
          state: "streaming",
          createdAt: event.createdAt,
        },
        parts: [],
      } as ChatUiMessage;
      return;
    }
    if (!this.message) throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent event stream has no message", 502);
    const parts = this.message.parts;
    if (event.type === "text-delta") {
      const index = this.textParts.get(event.textId);
      if (index === undefined) {
        this.textParts.set(event.textId, parts.length);
        parts.push({ type: "text", text: event.delta, state: "streaming" });
      } else {
        const part = parts[index];
        if (part?.type !== "text") throw new LemmaComputerError("CHAT_INVALID_RESPONSE", "The agent reused a chat part identifier", 502);
        part.text += event.delta;
      }
      return;
    }
    if (event.type === "artifact") {
      if (!event.revisionId) throw new LemmaComputerError("CHAT_ARTIFACT_NOT_FINALIZED", "The generated file was not finalized by Control", 502);
      parts.push({
        type: "data-file-reference",
        id: event.artifactId,
        data: { mediaType: event.mediaType, filename: event.filename, storage: "control", revisionId: event.revisionId },
      });
      return;
    }
    if (event.type === "progress") {
      const replacement = {
        type: "data-progress" as const,
        id: event.activityId,
        data: { activityId: event.activityId, label: event.label, state: event.state },
      };
      const index = parts.findIndex((part) => "id" in part && part.id === event.activityId);
      if (index < 0) parts.push(replacement); else parts[index] = replacement;
      return;
    }
    if (event.type === "tool" && event.progressLabel) {
      const id = `progress-${event.turnId}`;
      const replacement = {
        type: "data-progress" as const,
        id,
        data: { activityId: id, label: event.progressLabel, state: "running" as const },
      };
      const index = parts.findIndex((part) => "id" in part && part.id === id);
      if (index < 0) parts.push(replacement); else parts[index] = replacement;
      return;
    }
    if (event.type === "approval") {
      const replacement = {
        type: "data-approval" as const,
        id: event.approvalId,
        data: {
          approvalId: event.approvalId,
          toolCallId: event.toolCallId,
          operationId: event.operationId,
          state: event.state,
          summary: event.summary,
        },
      };
      const index = parts.findIndex((part) => "id" in part && part.id === event.approvalId);
      if (index < 0) parts.push(replacement); else parts[index] = replacement;
      return;
    }
    if (event.type !== "turn-finish") return;
    for (const part of parts) {
      if (part.type === "text") part.state = "done";
      if (part.type === "data-progress" && part.data.state === "running") {
        part.data.state = "completed";
        part.data.label = event.state === "needs_input" ? "Waiting for your reply"
          : event.state === "cancelled" ? "Work stopped"
          : event.state === "failed" ? "Work failed" : "Work complete";
      }
    }
    parts.push({
      type: "data-terminal",
      id: `terminal-${event.turnId}`,
      data: { turnId: event.turnId, state: event.state, ...(event.message ? { message: event.message } : {}) },
    });
    this.message.metadata.state = event.state;
  }

  snapshot() {
    if (!this.message?.parts.length) return undefined;
    return chatUiMessageSchema.parse(structuredClone(this.message));
  }
}
