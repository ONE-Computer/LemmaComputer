import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  ChatAgentCatalogId,
  IdentityContext,
  ScheduleRunState,
} from "@lemmacomputer/contracts";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import {
  MemoryChatStore,
  nextScheduleAt,
  type ClaimedScheduleRun,
  type ScheduleRecord,
  type ScheduleRunRecord,
  type ScheduleStore,
} from "@lemmacomputer/workspace-store";
import { MemoryArtifactStore } from "@lemmacomputer/artifact-store";
import { SchedulePromptVault, ScheduleService } from "../apps/control-api/src/schedules.js";
import { DurableChatService } from "../apps/control-api/src/durable-chat.js";
import { SchedulerWorker } from "../apps/scheduler-worker/src/server.js";
import type { AgentChatAccess, AgentChatClient } from "../apps/control-api/src/agent-chat.js";

const identity: IdentityContext = {
  tenantId: "acme",
  subjectId: "alex",
  audience: "lemmacomputer-control",
};
const workspaceId = "11111111-1111-4111-8111-111111111111";

class MemoryScheduleStore implements ScheduleStore {
  schedules = new Map<string, ScheduleRecord>();
  runs = new Map<string, ScheduleRunRecord>();
  close = async () => {};

  async listSchedules(owner: IdentityContext) {
    return [...this.schedules.values()].filter((item) => (
      item.tenantId === owner.tenantId && item.subjectId === owner.subjectId
    ));
  }

  async getSchedule(owner: IdentityContext, id: string) {
    const schedule = this.schedules.get(id);
    return schedule?.tenantId === owner.tenantId && schedule.subjectId === owner.subjectId ? schedule : null;
  }

  async createSchedule(owner: IdentityContext, input: Parameters<ScheduleStore["createSchedule"]>[1]) {
    const now = new Date("2026-07-26T00:00:00Z");
    const schedule: ScheduleRecord = {
      ...input,
      tenantId: owner.tenantId,
      subjectId: owner.subjectId,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async updateSchedule(owner: IdentityContext, id: string, input: Parameters<ScheduleStore["updateSchedule"]>[2]) {
    const current = await this.getSchedule(owner, id);
    if (!current) return null;
    const updated = { ...current, ...input, updatedAt: new Date() };
    this.schedules.set(id, updated);
    return updated;
  }

  async deleteSchedule(owner: IdentityContext, id: string) {
    if (!await this.getSchedule(owner, id)) return false;
    return this.schedules.delete(id);
  }

  async listScheduleRuns(owner: IdentityContext, scheduleId: string, limit: number) {
    return [...this.runs.values()].filter((run) => (
      run.scheduleId === scheduleId
      && run.tenantId === owner.tenantId
      && run.subjectId === owner.subjectId
    )).slice(0, limit);
  }

  async queueScheduleRun(owner: IdentityContext, scheduleId: string, scheduledFor: Date) {
    if (!await this.getSchedule(owner, scheduleId)) return null;
    const id = crypto.randomUUID();
    const now = new Date();
    const run: ScheduleRunRecord = {
      id,
      scheduleId,
      tenantId: owner.tenantId,
      subjectId: owner.subjectId,
      scheduledFor,
      state: "claimed",
      leaseToken: null,
      leaseExpiresAt: null,
      sessionId: null,
      failureCode: null,
      failureSummary: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(id, run);
    return run;
  }

  async claimDueScheduleRuns(now: Date, limit: number, leaseMs: number) {
    const claimed: ClaimedScheduleRun[] = [];
    for (const run of this.runs.values()) {
      if (
        claimed.length >= limit
        || run.state !== "claimed"
        || (run.leaseExpiresAt && run.leaseExpiresAt >= now)
      ) continue;
      const leaseToken = crypto.randomUUID();
      const updated = { ...run, leaseToken, leaseExpiresAt: new Date(now.getTime() + leaseMs) };
      this.runs.set(run.id, updated);
      const schedule = this.schedules.get(run.scheduleId);
      if (schedule) claimed.push({ run: updated, schedule });
    }
    return claimed;
  }

  async beginScheduleRun(runId: string, leaseToken: string, now: Date) {
    const run = this.runs.get(runId);
    if (!run || run.state !== "claimed" || run.leaseToken !== leaseToken) return null;
    const updated = { ...run, state: "running" as const, startedAt: now, updatedAt: now };
    this.runs.set(run.id, updated);
    const schedule = this.schedules.get(run.scheduleId);
    return schedule ? { run: updated, schedule } : null;
  }

  async finishScheduleRun(
    runId: string,
    input: {
      state: Extract<ScheduleRunState, "succeeded" | "failed" | "skipped">;
      sessionId?: string;
      failureCode?: string;
      failureSummary?: string;
      completedAt: Date;
    },
  ) {
    const run = this.runs.get(runId);
    if (!run || run.state !== "running") return null;
    const updated: ScheduleRunRecord = {
      ...run,
      state: input.state,
      sessionId: input.sessionId ?? null,
      failureCode: input.failureCode ?? null,
      failureSummary: input.failureSummary ?? null,
      completedAt: input.completedAt,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: input.completedAt,
    };
    this.runs.set(run.id, updated);
    return updated;
  }

  async deferScheduleRun(
    runId: string,
    input: { retryAt: Date; failureCode: string; failureSummary: string },
  ) {
    const run = this.runs.get(runId);
    if (!run || run.state !== "running") return null;
    const updated: ScheduleRunRecord = {
      ...run,
      state: "claimed",
      leaseToken: null,
      leaseExpiresAt: input.retryAt,
      failureCode: input.failureCode,
      failureSummary: input.failureSummary,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    };
    this.runs.set(run.id, updated);
    return updated;
  }
}

const access: AgentChatAccess = {
  tenantId: "acme",
  subjectId: "alex",
  workspaceId,
  workspaceNodeId: "node-1",
  accessGeneration: 1,
  policyVersionId: "policy-version-1",
  policyVersion: 1,
  policyHash: "a".repeat(64),
  catalogId: "codex-cli",
  displayName: "Codex",
  agentId: "codex-agent-policy-id",
  key: "workspace-bound-key",
  baseUrl: "http://sandbox",
};
const scheduledInstanceId = "22222222-2222-4222-8222-222222222222";

const successfulAgent: AgentChatClient = {
  health: async () => {},
  cancelTurn: async () => {},
  downloadArtifact: async () => Buffer.alloc(0),
  async *streamTurn(_access, sessionId, message, _signal, usageTaskBinding, agentInstanceId, _reasoningEffort, history) {
    assert.equal(usageTaskBinding, "signed-schedule-binding");
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(agentInstanceId, scheduledInstanceId);
    assert.equal(message.parts[0]?.type, "text");
    assert.equal(message.parts[0]?.type === "text" ? message.parts[0].text : "", "Summarize the project.");
    assert.deepEqual(history, [], "the current scheduled prompt must not also be sent as prior history");
    yield {
      version: 1,
      sequence: 0,
      sessionId,
      turnId: "turn-scheduled-1",
      type: "turn-start",
      messageId: "message-scheduled-1",
      createdAt: new Date().toISOString(),
    };
    yield {
      version: 1,
      sequence: 1,
      sessionId,
      turnId: "turn-scheduled-1",
      type: "turn-finish",
      state: "completed",
      completedAt: new Date().toISOString(),
    };
  },
};

test("cron schedules retain IANA timezone behavior across weekdays and DST", () => {
  assert.equal(
    nextScheduleAt("0 9 * * 1-5", "Asia/Singapore", new Date("2026-07-24T02:00:00Z")).toISOString(),
    "2026-07-27T01:00:00.000Z",
  );
  assert.equal(
    nextScheduleAt("0 9 * * *", "America/New_York", new Date("2026-03-07T15:00:00Z")).toISOString(),
    "2026-03-08T13:00:00.000Z",
  );
});

test("saved prompts are encrypted and bound to their owner and schedule", () => {
  const vault = new SchedulePromptVault("test-schedule-prompt-secret-with-at-least-32-characters");
  const protectedValue = vault.protect(identity, "22222222-2222-4222-8222-222222222222", "private prompt");
  assert.equal(protectedValue.includes("private prompt"), false);
  assert.equal(
    vault.unprotect(identity, "22222222-2222-4222-8222-222222222222", protectedValue),
    "private prompt",
  );
  assert.throws(
    () => vault.unprotect(identity, "33333333-3333-4333-8333-333333333333", protectedValue),
    /could not be unlocked/,
  );
});

test("a claimed run revalidates its target and creates a fresh Control conversation", async () => {
  const store = new MemoryScheduleStore();
  let validations = 0;
  let bindingIssued = false;
  let runningTurn: string | undefined;
  let endReason: string | undefined;
  const chatStore = new MemoryChatStore(() => ({ workspaceNodeId: "node-1", accessGeneration: 1 }));
  const durableChat = new DurableChatService(chatStore, new MemoryArtifactStore(), { requireNodePlacement: false });
  const service = new ScheduleService(
    store,
    new SchedulePromptVault("test-schedule-prompt-secret-with-at-least-32-characters"),
    successfulAgent,
    async () => { validations += 1; },
    async (_owner, targetWorkspaceId, catalogId: ChatAgentCatalogId) => {
      validations += 1;
      assert.equal(targetWorkspaceId, workspaceId);
      assert.equal(catalogId, "codex-cli");
      return access;
    },
    (input) => {
      bindingIssued = true;
      assert.deepEqual(input.identity, identity);
      assert.equal(input.workspaceId, workspaceId);
      assert.equal(input.agentId, "codex-agent-policy-id");
      assert.match(input.taskId, /^schedule:[0-9a-f-]{36}$/);
      assert.match(input.sessionId, /^[0-9a-f-]{36}$/);
      assert.match(input.turnId, /^[0-9a-f-]{36}$/);
      assert.equal(input.agentInstanceId, scheduledInstanceId);
      return "signed-schedule-binding";
    },
    async (input) => {
      assert.equal(input.catalogId, "codex-cli");
      assert.match(input.runId, /^[0-9a-f-]{36}$/);
      return {
        identity: { state: "verified", agentInstanceId: scheduledInstanceId },
        markRunning: async (turnId: string) => { runningTurn = turnId; },
        end: async (reason) => { endReason = reason; },
      };
    },
    chatStore,
    durableChat,
  );
  const schedule = await service.create(identity, {
    title: "Daily project summary",
    workspaceId,
    agentCatalogId: "codex-cli",
    prompt: "Summarize the project.",
    cronExpression: "0 9 * * 1-5",
    timeZone: "Asia/Singapore",
    state: "enabled",
  });
  const queued = await store.queueScheduleRun(identity, schedule.id, new Date());
  assert.ok(queued);
  const [claimed] = await store.claimDueScheduleRuns(new Date(), 1, 120_000);
  assert.ok(claimed?.run.leaseToken);
  const completed = await service.executeClaimed(claimed.run.id, claimed.run.leaseToken!);
  assert.equal(completed.state, "succeeded");
  assert.match(completed.sessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(validations, 2);
  assert.equal(bindingIssued, true);
  assert.equal(runningTurn, "turn-scheduled-1");
  assert.equal(endReason, "process_exited");
  const conversations = await chatStore.listConversations(identity, workspaceId, { limit: 10 });
  assert.equal(conversations.conversations.length, 1);
  assert.deepEqual(
    (await chatStore.listMessages(identity, conversations.conversations[0]!.id)).map((message) => message.role),
    ["user", "assistant"],
  );
});

test("a claimed run with revoked authority is skipped before contacting the agent", async () => {
  const store = new MemoryScheduleStore();
  let agentCalls = 0;
  const agent: AgentChatClient = {
    ...successfulAgent,
    health: async () => { agentCalls += 1; },
  };
  const service = new ScheduleService(
    store,
    new SchedulePromptVault("test-schedule-prompt-secret-with-at-least-32-characters"),
    agent,
    async () => {},
    async () => {
      throw new LemmaComputerError("POLICY_NOT_ASSIGNED", "No active workspace policy is assigned", 403);
    },
  );
  const schedule = await service.create(identity, {
    title: "Revoked schedule",
    workspaceId,
    agentCatalogId: "codex-cli",
    prompt: "Must not execute.",
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    state: "enabled",
  });
  await store.queueScheduleRun(identity, schedule.id, new Date());
  const [claimed] = await store.claimDueScheduleRuns(new Date(), 1, 120_000);
  assert.ok(claimed?.run.leaseToken);

  const completed = await service.executeClaimed(claimed.run.id, claimed.run.leaseToken!);
  assert.equal(completed.state, "skipped");
  assert.equal(completed.failureCode, "POLICY_NOT_ASSIGNED");
  assert.equal(agentCalls, 0);
});

test("a scheduled run waits once for a workspace guardrail transition instead of being skipped", async () => {
  const store = new MemoryScheduleStore();
  let accessAttempts = 0;
  const agent: AgentChatClient = {
    ...successfulAgent,
    async *streamTurn(_access, sessionId) {
      yield {
        version: 1,
        sequence: 0,
        sessionId,
        turnId: "turn-after-policy-transition",
        type: "turn-start",
        messageId: "message-after-policy-transition",
        createdAt: new Date().toISOString(),
      };
      yield {
        version: 1,
        sequence: 1,
        sessionId,
        turnId: "turn-after-policy-transition",
        type: "turn-finish",
        state: "completed",
        completedAt: new Date().toISOString(),
      };
    },
  };
  const service = new ScheduleService(
    store,
    new SchedulePromptVault("test-schedule-prompt-secret-with-at-least-32-characters"),
    agent,
    async () => {},
    async () => {
      accessAttempts += 1;
      if (accessAttempts === 1) {
        throw new LemmaComputerError(
          "WORKSPACE_POLICY_TRANSITION_IN_PROGRESS",
          "The workspace is applying updated guardrails.",
          409,
          true,
        );
      }
      return access;
    },
  );
  const schedule = await service.create(identity, {
    title: "Transition-safe schedule",
    workspaceId,
    agentCatalogId: "codex-cli",
    prompt: "Run after the guardrail update.",
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    state: "enabled",
  });
  await store.queueScheduleRun(identity, schedule.id, new Date());
  const [firstClaim] = await store.claimDueScheduleRuns(new Date(), 1, 120_000);
  assert.ok(firstClaim?.run.leaseToken);

  const deferred = await service.executeClaimed(firstClaim.run.id, firstClaim.run.leaseToken!);
  assert.equal(deferred.state, "claimed");
  assert.equal(deferred.failureCode, "WORKSPACE_POLICY_TRANSITION_IN_PROGRESS");
  assert.equal((await store.claimDueScheduleRuns(new Date(), 1, 120_000)).length, 0);

  const [retry] = await store.claimDueScheduleRuns(new Date(Date.now() + 31_000), 1, 120_000);
  assert.ok(retry?.run.leaseToken);
  const completed = await service.executeClaimed(retry.run.id, retry.run.leaseToken!);
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.failureCode, null);
  assert.equal(accessAttempts, 2);
});

test("the worker sends only leased run identifiers to Control", async () => {
  const store = new MemoryScheduleStore();
  const vault = new SchedulePromptVault("test-schedule-prompt-secret-with-at-least-32-characters");
  const id = crypto.randomUUID();
  await store.createSchedule(identity, {
    id,
    workspaceId,
    agentCatalogId: "codex-cli",
    title: "Test",
    promptCiphertext: vault.protect(identity, id, "must not leave Control"),
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    state: "enabled",
    nextRunAt: new Date(),
  });
  await store.queueScheduleRun(identity, id, new Date());
  const calls: Array<{ runId: string; leaseToken: string }> = [];
  const worker = new SchedulerWorker(store, {
    execute: async (runId, leaseToken) => { calls.push({ runId, leaseToken }); },
  });
  const result = await worker.pollOnce(new Date());
  assert.equal(result.completed, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.leaseToken, /^[0-9a-f-]{36}$/);
});

test("the migration enforces ownership lifecycle, unique occurrences, and leased claiming", async () => {
  const migration = await readFile(
    new URL("../packages/workspace-store/migrations/027_schedules.sql", import.meta.url),
    "utf8",
  );
  const store = await readFile(
    new URL("../packages/workspace-store/src/schedules.ts", import.meta.url),
    "utf8",
  );
  assert.match(migration, /REFERENCES workspaces\(id\) ON DELETE CASCADE/);
  assert.match(migration, /UNIQUE \(schedule_id, scheduled_for\)/);
  assert.match(store, /FOR UPDATE SKIP LOCKED/);
  assert.match(store, /SCHEDULE_RUN_OUTCOME_UNKNOWN/);
});

test("Schedules is URL-backed and uses the owned selector and workspace-aware copy", async () => {
  const app = await readFile(new URL("../apps/web/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /schedules: "Schedules"/);
  assert.match(app, /activeNav === "Schedules"/);
  assert.match(app, /<SelectMenu value=\{draft\.workspaceId\}/);
  assert.match(app, /Runs are skipped while this workspace is stopped/);
  assert.doesNotMatch(app.slice(app.indexOf("function ScheduleDialog"), app.indexOf("function SchedulesScreen")), /<select/);
});
