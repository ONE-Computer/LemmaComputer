import {
  LemmaComputerError,
  type AgentChatEvent,
  type ChatReasoningEffort,
  type ChatRequestedServiceClass,
  type ChatUiMessage,
  type IdentityContext,
} from "@lemmacomputer/contracts";
import type { ChatConversationRecord, ChatStore } from "@lemmacomputer/workspace-store";
import { AgentMessageAccumulator, type AgentChatAccess, type AgentChatClient } from "./agent-chat.js";
import type { AgentProcessLifecycle } from "./agent-process-lifecycle.js";
import type { ActivityEventService } from "./activity.js";
import type { DurableChatService } from "./durable-chat.js";

type TurnInput = {
  identity: IdentityContext;
  access: AgentChatAccess;
  sessionId: string;
  conversation?: ChatConversationRecord;
  message: ChatUiMessage;
  requestedServiceClass: ChatRequestedServiceClass;
  reasoningEffort?: ChatReasoningEffort;
};

type PreparedTurn = TurnInput & {
  history: ChatUiMessage[];
  vendorSessionId?: string;
};

/** One durable turn pipeline, independent of the trigger or a connected browser. */
export class ChatTurnExecutor {
  constructor(
    private readonly client: AgentChatClient,
    private readonly store?: ChatStore,
    private readonly durable?: DurableChatService,
    private readonly activity?: ActivityEventService,
    private readonly projectApproval?: (identity: IdentityContext, event: Extract<AgentChatEvent, { type: "approval" }>) => Promise<AgentChatEvent>,
  ) {}

  async health(access: AgentChatAccess) {
    await this.client.health(access);
  }

  async prepare(input: TurnInput): Promise<PreparedTurn> {
    const { identity, sessionId, conversation, access, message } = input;
    const history = conversation && this.store ? await this.store.listMessages(identity, sessionId) : [];
    const vendorSessionId = conversation && this.store
      ? await this.store.getVendorSession(identity, sessionId, access.catalogId) ?? undefined
      : undefined;
    const persisted = conversation && this.durable
      ? await this.durable.persistUserMessage({ identity, conversation, access, message })
      : undefined;
    return { ...input, message: persisted?.runtimeMessage ?? message, history, vendorSessionId };
  }

  async execute(input: PreparedTurn, options: {
    lifecycle?: AgentProcessLifecycle;
    issueUsageTaskBinding?: (agentInstanceId?: string) => string | undefined;
    onEvent?: (event: AgentChatEvent) => void;
  } = {}): Promise<Extract<AgentChatEvent, { type: "turn-finish" }>> {
    const { identity, access, sessionId, conversation, message } = input;
    const { lifecycle } = options;
    const agentInstanceId = lifecycle?.identity.state === "verified" ? lifecycle.identity.agentInstanceId : undefined;
    const accumulator = new AgentMessageAccumulator(access.catalogId);
    let lastEvent: AgentChatEvent | undefined;
    let terminal: Extract<AgentChatEvent, { type: "turn-finish" }> | undefined;
    let processStarted = false;
    let processEnded = false;
    const recordActivity = (event: AgentChatEvent) => this.activity?.recordAgentEvent({
      identity, workspaceId: access.workspaceId, agentCatalogId: access.catalogId,
      sessionId, displayName: access.displayName, agentInstanceId, event,
    });
    const checkpoint = async (event: AgentChatEvent) => {
      accumulator.apply(event);
      const saved = accumulator.snapshot();
      if (saved && conversation && this.store) {
        await this.store.upsertMessage(identity, sessionId, saved);
        await this.durable?.bindMessageArtifacts(identity, sessionId, saved);
      }
      return saved;
    };
    try {
      const usageTaskBinding = options.issueUsageTaskBinding?.(agentInstanceId);
      for await (const event of this.client.streamTurn(
        access, sessionId, message, undefined, usageTaskBinding, agentInstanceId,
        input.reasoningEffort, input.history, input.vendorSessionId,
      )) {
        lastEvent = event;
        if (event.type === "turn-start") {
          await lifecycle?.markRunning(event.turnId);
          processStarted = true;
          if (conversation && this.store) await this.store.beginRun({
            identity, conversationId: sessionId, turnId: event.turnId,
            effectiveAgentCatalogId: access.catalogId,
            requestedServiceClass: input.requestedServiceClass, reasoningEffort: input.reasoningEffort,
            policyVersionId: access.policyVersionId, policyVersion: access.policyVersion, policyHash: access.policyHash,
            workspaceId: access.workspaceId, workspaceNodeId: access.workspaceNodeId,
            accessGeneration: access.accessGeneration, agentInstanceId,
          });
        }
        let projected = event.type === "artifact" && conversation && this.durable
          ? await this.durable.persistGeneratedArtifact({ identity, conversation, access, client: this.client, event })
          : event;
        if (event.type === "approval" && this.projectApproval) projected = await this.projectApproval(identity, event);
        await recordActivity(projected);
        const saved = await checkpoint(projected);
        if (event.type === "turn-finish") {
          if (conversation && this.store) {
            if (event.vendorSessionId) await this.store.setVendorSession(identity, sessionId, access.catalogId, event.vendorSessionId);
            await this.store.finishRun(identity, sessionId, event.turnId, {
              status: event.state, assistantMessageId: saved?.id,
              ...(event.state === "failed" ? { failureCode: "AGENT_TURN_FAILED" } : {}),
              completedAt: new Date(event.completedAt),
            });
          }
          await lifecycle?.end(event.state === "failed" ? "provider_failed" : "process_exited");
          processEnded = true;
          terminal = event;
        }
        options.onEvent?.(projected);
      }
      if (!terminal) throw new LemmaComputerError("AGENT_STREAM_INCOMPLETE", "The agent stream ended before completion", 502, true);
      return terminal;
    } catch (error) {
      let failure = error;
      if (!processEnded) {
        try { await lifecycle?.end(processStarted ? "provider_failed" : "launch_failed"); }
        catch (lifecycleError) { failure = lifecycleError; }
      }
      if (lastEvent && lastEvent.type !== "turn-finish") {
        const failed: Extract<AgentChatEvent, { type: "turn-finish" }> = {
          version: 1, sequence: lastEvent.sequence + 1, sessionId, turnId: lastEvent.turnId,
          type: "turn-finish", state: "failed", message: "The agent stream ended before completion",
          completedAt: new Date().toISOString(),
        };
        // Attempt both records even if one persistence boundary is unavailable.
        try { await recordActivity(failed); } catch (activityError) { failure = activityError; }
        try {
          const saved = await checkpoint(failed);
          if (processStarted && conversation && this.store) await this.store.finishRun(identity, sessionId, failed.turnId, {
            status: "failed", assistantMessageId: saved?.id,
            failureCode: error instanceof LemmaComputerError ? error.code : "AGENT_STREAM_FAILED",
            completedAt: new Date(failed.completedAt),
          });
          options.onEvent?.(failed);
        } catch (persistenceError) { failure = persistenceError; }
      }
      throw failure;
    }
  }
}
