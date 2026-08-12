import { createHash } from "node:crypto";
import {
  LemmaComputerError,
  type AgentCatalogId,
  type IdentityContext,
  type RuntimePolicy,
} from "@lemmacomputer/contracts";
import {
  agentInstanceIdentityState,
  type AgentInstanceEndReason,
  type AgentInstanceIdentityState,
  type AgentInstanceStore,
  type WorkspaceRecord,
} from "@lemmacomputer/workspace-store";

export type AgentProcessLaunch = {
  identity: IdentityContext;
  workspace: WorkspaceRecord;
  policy: RuntimePolicy;
  catalogId: AgentCatalogId;
  logicalAgentId: string;
  launchKind: "browser-chat" | "channel" | "schedule" | "interactive";
  sessionId?: string;
  idempotencyKey: string;
};

export interface AgentProcessLifecycle {
  readonly identity: AgentInstanceIdentityState;
  markRunning(providerTurnId: string): Promise<void>;
  end(reason: Extract<AgentInstanceEndReason, "process_exited" | "launch_failed" | "provider_failed">): Promise<void>;
}

const legacyLifecycle: AgentProcessLifecycle = Object.freeze({
  identity: agentInstanceIdentityState(null),
  markRunning: async () => undefined,
  end: async () => undefined,
});

const launchKey = (input: AgentProcessLaunch) => `${input.launchKind}:v1:${createHash("sha256")
  .update(JSON.stringify({
    tenantId: input.identity.tenantId,
    ownerSubjectId: input.identity.subjectId,
    workspaceId: input.workspace.id,
    accessGeneration: input.workspace.accessGeneration,
    catalogId: input.catalogId,
    logicalAgentId: input.logicalAgentId,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
  }))
  .digest("hex")}`;

class RegisteredAgentProcessLifecycle implements AgentProcessLifecycle {
  readonly identity: Extract<AgentInstanceIdentityState, { state: "verified" }>;

  constructor(
    private readonly store: AgentInstanceStore,
    private readonly input: AgentProcessLaunch,
    agentInstanceId: string,
  ) {
    this.identity = { state: "verified", agentInstanceId };
  }

  private locator() {
    return {
      tenantId: this.input.identity.tenantId,
      ownerSubjectId: this.input.identity.subjectId,
      workspaceId: this.input.workspace.id,
      agentInstanceId: this.identity.agentInstanceId,
    };
  }

  async markRunning(providerTurnId: string) {
    const updated = await this.store.markRunning({
      ...this.locator(),
      providerRuntimeId: `chat-turn:${providerTurnId}`,
    });
    if (!updated) {
      throw new LemmaComputerError(
        "AGENT_INSTANCE_NOT_FOUND",
        "The registered agent process identity is no longer available",
        409,
      );
    }
  }

  async end(reason: Extract<AgentInstanceEndReason, "process_exited" | "launch_failed" | "provider_failed">) {
    const updated = await this.store.end({ ...this.locator(), reason });
    if (!updated) {
      throw new LemmaComputerError(
        "AGENT_INSTANCE_NOT_FOUND",
        "The registered agent process identity is no longer available",
        409,
      );
    }
  }
}

export class AgentProcessLifecycleService {
  constructor(private readonly store?: AgentInstanceStore) {}

  async begin(input: AgentProcessLaunch): Promise<AgentProcessLifecycle> {
    // Each managed execution boundary gets its own identity. Long-lived
    // catalogue brokers remain unlabelled; they propagate the identity only
    // into the actual chat turn, interactive process, or child tool process.
    if (!this.store) return legacyLifecycle;
    const registered = await this.store.registerLaunch({
      tenantId: input.identity.tenantId,
      ownerSubjectId: input.identity.subjectId,
      workspaceId: input.workspace.id,
      agentCatalogId: input.catalogId,
      logicalAgentId: input.logicalAgentId,
      accessGeneration: input.workspace.accessGeneration,
      policyVersionId: input.policy.policyVersionId,
      policyVersion: input.policy.policyVersion,
      policyHash: input.policy.policyHash,
      launchIdempotencyKey: launchKey(input),
    });
    if (registered.disposition !== "created") {
      throw new LemmaComputerError(
        "AGENT_INSTANCE_LAUNCH_REPLAYED",
        "This agent process launch was already registered and cannot start a second process",
        409,
      );
    }
    return new RegisteredAgentProcessLifecycle(this.store, input, registered.instance.id);
  }

  async beginBrowserChat(input: Omit<AgentProcessLaunch, "launchKind">): Promise<AgentProcessLifecycle> {
    return this.begin({ ...input, launchKind: "browser-chat" });
  }

  async requireActive(input: {
    identity: IdentityContext; workspace: WorkspaceRecord; logicalAgentId: string; agentInstanceId: string;
  }) {
    if (!this.store) throw new LemmaComputerError("AGENT_INSTANCE_NOT_CONFIGURED", "Agent process identity is unavailable", 503, true);
    const record = await this.store.get({
      tenantId: input.identity.tenantId,
      ownerSubjectId: input.identity.subjectId,
      workspaceId: input.workspace.id,
      agentInstanceId: input.agentInstanceId,
    });
    if (!record || record.status !== "running" || record.accessGeneration !== input.workspace.accessGeneration
      || record.logicalAgentId !== input.logicalAgentId) {
      throw new LemmaComputerError("AGENT_INSTANCE_INVALID", "The agent process identity is unknown, stale, or belongs to another execution boundary", 403);
    }
    return record;
  }
}

const normalizedInstanceKey = (key: string) => key.replace(/[-_]/g, "").toLowerCase() === "agentinstanceid";

export const callerSuppliedAgentInstanceId = (value: unknown): boolean => {
  const pending = [value];
  const visited = new Set<object>();
  while (pending.length) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      pending.push(...candidate);
      continue;
    }
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      if (normalizedInstanceKey(key)) return true;
      pending.push(nested);
    }
  }
  return false;
};
