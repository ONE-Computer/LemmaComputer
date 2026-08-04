import {
  LemmaComputerError,
  activityEventReplaySchema,
  type ActivityEventDraft,
  type ActivityEventReplay,
  type ActivityEventV1,
  type AgentChatEvent,
  type ChatAgentCatalogId,
  type IdentityContext,
} from "@lemmacomputer/contracts";
import type { ActivityEventScope, ActivityStore } from "@lemmacomputer/workspace-store";

const sensitiveKey = /(?:authorization|cookie|password|secret|token|api[_-]?key|credential|session|signature|signed[_-]?url)/i;
const omittedKey = /(?:system[_-]?prompt|prompt|provider[_-]?payload|raw[_-]?payload|reasoning|chain[_-]?of[_-]?thought|page[_-]?content|screenshot)/i;
const sensitiveQueryKey = /^(?:access_token|api[_-]?key|awsaccesskeyid|code|credential|key|password|refresh_token|sig|signature|token|x-amz-.+|x-goog-.+)$/i;

export function sanitizeActivityUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveQueryKey.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function sanitizeActivityText(value: unknown, fallback: string, maximum = 500): string {
  if (typeof value !== "string") return fallback;
  let text = value.replace(/\s+/g, " ").trim();
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => sanitizeActivityUrl(candidate) ?? "[redacted-url]");
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gi, "[redacted-secret]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[redacted-secret]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .replace(/\b(authorization|cookie|password|secret|token|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  return text.slice(0, maximum) || fallback;
}

export function redactActivityValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[omitted]";
  if (typeof value === "string") return sanitizeActivityText(value, "[redacted]", 2_000);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactActivityValue(item, depth + 1));
  if (!value || typeof value !== "object") return "[omitted]";
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => {
    if (omittedKey.test(key)) return [key, "[omitted]"];
    if (sensitiveKey.test(key)) return [key, "[redacted]"];
    if (/url$/i.test(key) && typeof item === "string") return [key, sanitizeActivityUrl(item) ?? "[redacted-url]"];
    return [key, redactActivityValue(item, depth + 1)];
  }));
}

const toolState = (state: "running" | "completed" | "failed") => state;
const approvalState = (state: Extract<AgentChatEvent, { type: "approval" }>["state"]): ActivityEventV1["state"] => ({
  approval_required: "requires_action",
  approved: "running",
  executing: "running",
  succeeded: "completed",
  denied: "cancelled",
  failed: "failed",
  expired: "cancelled",
}[state] as ActivityEventV1["state"]);
const terminalState = (state: Extract<AgentChatEvent, { type: "turn-finish" }>["state"]): ActivityEventV1["state"] => ({
  needs_input: "requires_action",
  completed: "completed",
  cancelled: "cancelled",
  failed: "failed",
}[state] as ActivityEventV1["state"]);

const webActionLabel = (action: "search" | "open" | "find") => ({
  search: "Searched the web",
  open: "Opened a webpage",
  find: "Found text on a webpage",
}[action]);

export class ActivityEventMapper {
  constructor(private readonly displayName: string) {}

  drafts(event: AgentChatEvent): ActivityEventDraft[] {
    const base = { turnId: event.turnId, visibility: "user" as const };
    if (event.type === "turn-start") return [{
      ...base,
      kind: "plan",
      state: "running",
      provenance: "deterministic_system",
      payload: { title: `${sanitizeActivityText(this.displayName, "Agent", 160)} started work` },
    }];
    if (event.type === "plan") return [{
      ...base,
      kind: "plan",
      state: event.state ?? "running",
      provenance: "provider_generated",
      payload: {
        title: sanitizeActivityText(event.title, "Work plan", 240),
        ...(event.summary ? { summary: sanitizeActivityText(event.summary, "Plan updated") } : {}),
      },
    }];
    if (event.type === "progress") return [{
      ...base,
      kind: "progress",
      state: event.state,
      provenance: "deterministic_system",
      payload: { activityId: event.activityId, label: sanitizeActivityText(event.label, "Working", 240) },
    }];
    if (event.type === "provider-summary") return [{
      ...base,
      kind: "provider_summary",
      state: "completed",
      provenance: "provider_generated",
      payload: {
        summary: sanitizeActivityText(event.summary, "Provider update"),
        ...(event.provider ? { provider: sanitizeActivityText(event.provider, "Provider", 80) } : {}),
      },
    }];
    if (event.type === "tool") {
      const summary = event.summary ? sanitizeActivityText(event.summary, "Tool update") : undefined;
      return [{
        ...base,
        kind: "tool",
        state: toolState(event.state),
        provenance: "tool",
        payload: { toolCallId: event.toolCallId, name: event.name, ...(summary ? { summary } : {}) },
      }];
    }
    if (event.type === "approval") return [{
      ...base,
      kind: "approval",
      state: approvalState(event.state),
      provenance: "tool",
      payload: {
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        operationId: event.operationId,
        summary: sanitizeActivityText(event.summary, "Approval update"),
      },
    }];
    if (event.type === "web-action") {
      const url = event.url ? sanitizeActivityUrl(event.url) : undefined;
      return [{
        ...base,
        kind: "web_action",
        state: "completed",
        provenance: "tool",
        payload: {
          action: event.action,
          label: sanitizeActivityText(event.label, webActionLabel(event.action), 240),
          ...(url ? { url } : {}),
        },
      }];
    }
    if (event.type === "source") {
      const url = sanitizeActivityUrl(event.url);
      if (!url) return [];
      return [{
        ...base,
        kind: "source",
        state: "completed",
        provenance: "provider_generated",
        payload: {
          title: sanitizeActivityText(event.title, "Source", 240),
          url,
          ...(event.citation ? { citation: sanitizeActivityText(event.citation, "Source", 80) } : {}),
        },
      }];
    }
    if (event.type === "computer-action") return [{
      ...base,
      kind: "computer_action",
      state: event.state,
      provenance: "tool",
      payload: {
        actionId: event.actionId,
        label: sanitizeActivityText(event.label, "Computer action", 240),
        ...(event.viewerRef ? { viewerRef: event.viewerRef } : {}),
      },
    }];
    if (event.type === "notice") return [{
      ...base,
      kind: "notice",
      state: "completed",
      provenance: "deterministic_system",
      payload: { message: sanitizeActivityText(event.message, "Activity notice") },
    }];
    if (event.type === "error") return [{
      ...base,
      kind: "error",
      state: "failed",
      provenance: "deterministic_system",
      payload: {
        code: event.code,
        message: sanitizeActivityText(event.message, "The activity failed"),
        retryable: event.retryable,
      },
    }];
    if (event.type === "turn-finish") {
      const message = event.message ? sanitizeActivityText(event.message, "Turn finished") : undefined;
      const terminal: ActivityEventDraft = {
        ...base,
        kind: "terminal",
        state: terminalState(event.state),
        provenance: "deterministic_system",
        payload: { turnState: event.state, ...(message ? { message } : {}) },
      };
      return event.state === "failed" ? [{
        ...base,
        kind: "error",
        state: "failed",
        provenance: "deterministic_system",
        payload: { code: "AGENT_TURN_FAILED", message: message ?? "The agent could not complete the turn", retryable: true },
      }, terminal] : [terminal];
    }
    return [];
  }
}

const eventTime = (event: AgentChatEvent, fallback: Date) => (
  event.type === "turn-start" ? new Date(event.createdAt)
    : event.type === "turn-finish" ? new Date(event.completedAt)
      : fallback
);

const wait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, milliseconds);
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  }
  signal?.addEventListener("abort", done, { once: true });
});

export class ActivityEventService {
  constructor(
    private readonly store: ActivityStore,
    private readonly pollMilliseconds = 250,
    private readonly heartbeatMilliseconds = 15_000,
  ) {}

  async recordAgentEvent(input: {
    identity: IdentityContext;
    workspaceId: string;
    agentCatalogId: ChatAgentCatalogId;
    sessionId: string;
    displayName: string;
    event: AgentChatEvent;
    receivedAt?: Date;
  }) {
    const drafts = new ActivityEventMapper(input.displayName).drafts(input.event);
    const recorded: ActivityEventV1[] = [];
    for (const [index, draft] of drafts.entries()) {
      const event = await this.store.appendActivityEvent({
        identity: input.identity,
        workspaceId: input.workspaceId,
        agentCatalogId: input.agentCatalogId,
        sessionId: input.sessionId,
        turnId: input.event.turnId,
        dedupeKey: `agent:${input.event.sequence}:${input.event.type}:${index}`,
        occurredAt: eventTime(input.event, input.receivedAt ?? new Date()),
        draft,
      });
      if (!event) throw new LemmaComputerError("ACTIVITY_TURN_NOT_FOUND", "Activity turn not found", 404);
      recorded.push(event);
    }
    return recorded;
  }

  async replay(
    identity: IdentityContext,
    scope: ActivityEventScope,
    afterSequence: number,
    limit = 200,
  ): Promise<ActivityEventReplay> {
    const result = await this.store.replayActivityEvents(identity, scope, afterSequence, Math.min(500, limit));
    if (!result.found) throw new LemmaComputerError("ACTIVITY_TURN_NOT_FOUND", "Activity turn not found", 404);
    const returnedThrough = result.events.at(-1)?.sequence ?? afterSequence;
    const terminal = result.terminalSequence !== null && returnedThrough >= result.terminalSequence;
    return activityEventReplaySchema.parse({
      events: result.events,
      nextAfterSequence: result.events.at(-1)?.sequence ?? null,
      terminal,
    });
  }

  async *subscribe(
    identity: IdentityContext,
    scope: ActivityEventScope,
    afterSequence: number,
    signal?: AbortSignal,
  ): AsyncGenerator<ActivityEventV1 | null> {
    let cursor = afterSequence;
    let lastHeartbeat = Date.now();
    while (!signal?.aborted) {
      const page = await this.replay(identity, scope, cursor, 200);
      for (const event of page.events) {
        cursor = event.sequence;
        lastHeartbeat = Date.now();
        yield event;
      }
      if (page.terminal) return;
      if (Date.now() - lastHeartbeat >= this.heartbeatMilliseconds) {
        lastHeartbeat = Date.now();
        yield null;
      }
      await wait(this.pollMilliseconds, signal);
    }
  }
}

export const activitySseFrame = (event: ActivityEventV1 | null) => event
  ? `id: ${event.sequence}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`
  : ": heartbeat\n\n";
