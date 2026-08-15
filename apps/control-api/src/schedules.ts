import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  LemmaComputerError,
  scheduleRunSchema,
  scheduleSchema,
  type ChatAgentCatalogId,
  type ChatUiMessage,
  type CreateSchedule,
  type IdentityContext,
  type Schedule,
  type ScheduleRun,
  type UpdateSchedule,
} from "@lemmacomputer/contracts";
import {
  nextScheduleAt,
  type ClaimedScheduleRun,
  type ScheduleRecord,
  type ScheduleRunRecord,
  type ScheduleStore,
} from "@lemmacomputer/workspace-store";
import type { AgentChatAccess, AgentChatClient } from "./agent-chat.js";
import type { AgentProcessLifecycle } from "./agent-process-lifecycle.js";

const key = (secret: string) => createHash("sha256")
  .update("lemmacomputer/schedule-prompt/k1\0")
  .update(secret)
  .digest();

const additionalData = (identity: IdentityContext, scheduleId: string) => Buffer.from(
  `lemmacomputer/schedule-prompt/k1:${identity.tenantId}:${identity.subjectId}:${scheduleId}`,
  "utf8",
);

export class SchedulePromptVault {
  private readonly encryptionKey: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("Schedule prompt secret must be at least 32 characters");
    this.encryptionKey = key(secret);
  }

  protect(identity: IdentityContext, scheduleId: string, prompt: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(additionalData(identity, scheduleId));
    const ciphertext = Buffer.concat([cipher.update(prompt, "utf8"), cipher.final()]);
    return `k1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  unprotect(identity: IdentityContext, scheduleId: string, protectedValue: string) {
    try {
      const [version, iv, tag, ciphertext, extra] = protectedValue.split(".");
      if (version !== "k1" || !iv || !tag || !ciphertext || extra) throw new Error("invalid ciphertext");
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
      decipher.setAAD(additionalData(identity, scheduleId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new LemmaComputerError(
        "SCHEDULE_PROMPT_UNAVAILABLE",
        "The saved schedule prompt could not be unlocked",
        503,
        true,
      );
    }
  }
}

const identityFor = (record: Pick<ScheduleRecord, "tenantId" | "subjectId">): IdentityContext => ({
  tenantId: record.tenantId,
  subjectId: record.subjectId,
  audience: "lemmacomputer-control",
});

const scheduleView = (record: ScheduleRecord, prompt: string): Schedule => scheduleSchema.parse({
  id: record.id,
  title: record.title,
  workspaceId: record.workspaceId,
  agentCatalogId: record.agentCatalogId,
  prompt,
  cronExpression: record.cronExpression,
  timeZone: record.timeZone,
  state: record.state,
  nextRunAt: record.nextRunAt?.toISOString() ?? null,
  lastRunAt: record.lastRunAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const runView = (record: ScheduleRunRecord): ScheduleRun => scheduleRunSchema.parse({
  id: record.id,
  scheduleId: record.scheduleId,
  scheduledFor: record.scheduledFor.toISOString(),
  state: record.state,
  sessionId: record.sessionId,
  failureCode: record.failureCode,
  failureSummary: record.failureSummary,
  startedAt: record.startedAt?.toISOString() ?? null,
  completedAt: record.completedAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const invalidSchedule = () => new LemmaComputerError(
  "SCHEDULE_INVALID",
  "The schedule or timezone is invalid",
  400,
);

const unavailableCodes = new Set([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_READY",
  "CHAT_AGENT_NOT_SELECTED",
  "CHAT_RUNTIME_UNAVAILABLE",
  "POLICY_NOT_ASSIGNED",
]);

const workspaceTransitionCode = "WORKSPACE_POLICY_TRANSITION_IN_PROGRESS";
const workspaceTransitionRetryMs = 30_000;

export class ScheduleService {
  constructor(
    private readonly store: ScheduleStore,
    private readonly vault: SchedulePromptVault,
    private readonly agentChat: AgentChatClient,
    private readonly validateTarget: (
      identity: IdentityContext,
      workspaceId: string,
      agentCatalogId: ChatAgentCatalogId,
    ) => Promise<void>,
    private readonly resolveAccess: (
      identity: IdentityContext,
      workspaceId: string,
      agentCatalogId: ChatAgentCatalogId,
    ) => Promise<AgentChatAccess>,
    private readonly issueUsageTaskBinding?: (input: {
      identity: IdentityContext; workspaceId: string; agentId: string;
      taskId: string; sessionId: string; turnId: string; agentInstanceId?: string;
    }) => string | undefined,
    private readonly beginAgentProcess?: (input: {
      identity: IdentityContext; workspaceId: string; catalogId: ChatAgentCatalogId;
      logicalAgentId: string; sessionId: string; runId: string;
    }) => Promise<AgentProcessLifecycle>,
  ) {}

  private next(cronExpression: string, timeZone: string, after = new Date()) {
    try {
      return nextScheduleAt(cronExpression, timeZone, after);
    } catch {
      throw invalidSchedule();
    }
  }

  private view(record: ScheduleRecord) {
    return scheduleView(record, this.vault.unprotect(identityFor(record), record.id, record.promptCiphertext));
  }

  async list(identity: IdentityContext) {
    const records = await this.store.listSchedules(identity);
    return { schedules: records.map((record) => this.view(record)) };
  }

  async create(identity: IdentityContext, input: CreateSchedule) {
    await this.validateTarget(identity, input.workspaceId, input.agentCatalogId);
    const id = randomUUID();
    const nextRunAt = input.state === "enabled"
      ? this.next(input.cronExpression, input.timeZone)
      : null;
    const created = await this.store.createSchedule(identity, {
      id,
      workspaceId: input.workspaceId,
      agentCatalogId: input.agentCatalogId,
      title: input.title,
      promptCiphertext: this.vault.protect(identity, id, input.prompt),
      cronExpression: input.cronExpression,
      timeZone: input.timeZone,
      state: input.state,
      nextRunAt,
    });
    if (!created) {
      throw new LemmaComputerError("SCHEDULE_TARGET_INVALID", "The selected workspace is unavailable", 409);
    }
    return this.view(created);
  }

  async update(identity: IdentityContext, scheduleId: string, input: UpdateSchedule) {
    const current = await this.store.getSchedule(identity, scheduleId);
    if (!current) throw new LemmaComputerError("SCHEDULE_NOT_FOUND", "Schedule not found", 404);
    const workspaceId = input.workspaceId ?? current.workspaceId;
    const agentCatalogId = input.agentCatalogId ?? current.agentCatalogId;
    if (input.workspaceId || input.agentCatalogId) {
      await this.validateTarget(identity, workspaceId, agentCatalogId);
    }
    const cronExpression = input.cronExpression ?? current.cronExpression;
    const timeZone = input.timeZone ?? current.timeZone;
    const state = input.state ?? current.state;
    const timingChanged = Boolean(input.cronExpression || input.timeZone || input.state);
    const nextRunAt = state === "paused"
      ? null
      : timingChanged
        ? this.next(cronExpression, timeZone)
        : current.nextRunAt ?? this.next(cronExpression, timeZone);
    const { prompt, ...safeInput } = input;
    const updated = await this.store.updateSchedule(identity, scheduleId, {
      ...safeInput,
      ...(prompt ? { promptCiphertext: this.vault.protect(identity, scheduleId, prompt) } : {}),
      nextRunAt,
    });
    if (!updated) throw new LemmaComputerError("SCHEDULE_NOT_FOUND", "Schedule not found", 404);
    return this.view(updated);
  }

  async remove(identity: IdentityContext, scheduleId: string) {
    if (!await this.store.deleteSchedule(identity, scheduleId)) {
      throw new LemmaComputerError("SCHEDULE_NOT_FOUND", "Schedule not found", 404);
    }
  }

  async runs(identity: IdentityContext, scheduleId: string, limit = 20) {
    if (!await this.store.getSchedule(identity, scheduleId)) {
      throw new LemmaComputerError("SCHEDULE_NOT_FOUND", "Schedule not found", 404);
    }
    return {
      runs: (await this.store.listScheduleRuns(identity, scheduleId, limit)).map(runView),
    };
  }

  async runNow(identity: IdentityContext, scheduleId: string) {
    const schedule = await this.store.getSchedule(identity, scheduleId);
    if (!schedule) throw new LemmaComputerError("SCHEDULE_NOT_FOUND", "Schedule not found", 404);
    const queued = await this.store.queueScheduleRun(identity, scheduleId, new Date());
    if (!queued) throw new LemmaComputerError("SCHEDULE_NOT_FOUND", "Schedule not found", 404);
    return runView(queued);
  }

  async executeClaimed(runId: string, leaseToken: string) {
    const claimed = await this.store.beginScheduleRun(runId, leaseToken, new Date());
    if (!claimed) {
      throw new LemmaComputerError("SCHEDULE_RUN_LEASE_INVALID", "The scheduled run lease is invalid or expired", 409);
    }
    return this.execute(claimed);
  }

  private async execute({ run, schedule }: ClaimedScheduleRun) {
    const identity = identityFor(schedule);
    let sessionId: string | undefined;
    let lifecycle: AgentProcessLifecycle | undefined;
    let processStarted = false;
    let processEnded = false;
    try {
      const access = await this.resolveAccess(identity, schedule.workspaceId, schedule.agentCatalogId);
      await this.agentChat.health(access);
      const session = await this.agentChat.createSession(access, `Scheduled: ${schedule.title}`);
      sessionId = session.id;
      lifecycle = await this.beginAgentProcess?.({
        identity, workspaceId: schedule.workspaceId, catalogId: schedule.agentCatalogId,
        logicalAgentId: access.agentId, sessionId, runId: run.id,
      });
      const agentInstanceId = lifecycle?.identity.state === "verified" ? lifecycle.identity.agentInstanceId : undefined;
      const message: ChatUiMessage = {
        id: randomUUID(),
        role: "user",
        metadata: {
          agentCatalogId: schedule.agentCatalogId,
          state: "completed",
          createdAt: new Date().toISOString(),
        },
        parts: [{
          type: "text",
          text: this.vault.unprotect(identity, schedule.id, schedule.promptCiphertext),
        }],
      };
      let terminal: "needs_input" | "completed" | "cancelled" | "failed" | null = null;
      let terminalMessage: string | undefined;
      const usageTaskBinding = this.issueUsageTaskBinding?.({
        identity, workspaceId: schedule.workspaceId, agentId: access.agentId,
        taskId: `schedule:${run.id}`, sessionId: session.id, turnId: message.id, agentInstanceId,
      });
      for await (const event of this.agentChat.streamTurn(access, session.id, message, undefined, usageTaskBinding, agentInstanceId)) {
        if (event.type === "turn-start" && lifecycle) { await lifecycle.markRunning(event.turnId); processStarted = true; }
        if (event.type === "turn-finish") {
          terminal = event.state;
          terminalMessage = event.message;
        }
      }
      if (lifecycle) { await lifecycle.end(terminal === "failed" ? "provider_failed" : "process_exited"); processEnded = true; }
      if (terminal !== "completed") {
        throw new LemmaComputerError(
          terminal === "cancelled"
            ? "SCHEDULE_TURN_CANCELLED"
            : terminal === "needs_input" ? "SCHEDULE_NEEDS_INPUT" : "SCHEDULE_TURN_FAILED",
          terminalMessage ?? (
            terminal === "needs_input"
              ? "The scheduled agent needs input before it can continue"
              : "The scheduled agent turn did not complete"
          ),
          502,
          terminal !== "cancelled" && terminal !== "needs_input",
        );
      }
      const completed = await this.store.finishScheduleRun(run.id, {
        state: "succeeded",
        sessionId,
        completedAt: new Date(),
      });
      if (!completed) throw new Error("Scheduled run ownership was lost");
      return runView(completed);
    } catch (error) {
      if (lifecycle && !processEnded) {
        try { await lifecycle.end(processStarted ? "provider_failed" : "launch_failed"); } catch (lifecycleError) { error = lifecycleError; }
      }
      const known = error instanceof LemmaComputerError ? error : new LemmaComputerError(
        "SCHEDULE_EXECUTION_FAILED",
        "The scheduled agent turn failed",
        500,
        true,
      );
      if (known.code === workspaceTransitionCode && run.failureCode !== workspaceTransitionCode) {
        const deferred = await this.store.deferScheduleRun(run.id, {
          retryAt: new Date(Date.now() + workspaceTransitionRetryMs),
          failureCode: workspaceTransitionCode,
          failureSummary: known.message.slice(0, 500),
        });
        if (!deferred) throw error;
        return runView(deferred);
      }
      if (known.code === workspaceTransitionCode) {
        const completed = await this.store.finishScheduleRun(run.id, {
          state: "failed",
          failureCode: "WORKSPACE_POLICY_TRANSITION_TIMEOUT",
          failureSummary: "The workspace did not finish applying updated guardrails before the deferred run was retried.",
          completedAt: new Date(),
        });
        if (!completed) throw error;
        return runView(completed);
      }
      const skipped = unavailableCodes.has(known.code);
      const completed = await this.store.finishScheduleRun(run.id, {
        state: skipped ? "skipped" : "failed",
        ...(sessionId ? { sessionId } : {}),
        failureCode: known.code,
        failureSummary: known.message.slice(0, 500),
        completedAt: new Date(),
      });
      if (!completed) throw error;
      return runView(completed);
    }
  }
}
