import { randomUUID } from "node:crypto";
import pg from "pg";
import { CronExpressionParser } from "cron-parser";
import type {
  ChatAgentCatalogId,
  IdentityContext,
  ScheduleRunState,
  ScheduleState,
} from "@onecomputer/contracts";

export type ScheduleRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  agentCatalogId: ChatAgentCatalogId;
  title: string;
  promptCiphertext: string;
  cronExpression: string;
  timeZone: string;
  state: ScheduleState;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ScheduleRunRecord = {
  id: string;
  scheduleId: string;
  tenantId: string;
  subjectId: string;
  scheduledFor: Date;
  state: ScheduleRunState;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  sessionId: string | null;
  failureCode: string | null;
  failureSummary: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ClaimedScheduleRun = {
  run: ScheduleRunRecord;
  schedule: ScheduleRecord;
};

export interface ScheduleStore {
  listSchedules(identity: IdentityContext): Promise<ScheduleRecord[]>;
  getSchedule(identity: IdentityContext, scheduleId: string): Promise<ScheduleRecord | null>;
  createSchedule(identity: IdentityContext, input: {
    id: string;
    workspaceId: string;
    agentCatalogId: ChatAgentCatalogId;
    title: string;
    promptCiphertext: string;
    cronExpression: string;
    timeZone: string;
    state: ScheduleState;
    nextRunAt: Date | null;
  }): Promise<ScheduleRecord | null>;
  updateSchedule(identity: IdentityContext, scheduleId: string, input: Partial<{
    workspaceId: string;
    agentCatalogId: ChatAgentCatalogId;
    title: string;
    promptCiphertext: string;
    cronExpression: string;
    timeZone: string;
    state: ScheduleState;
    nextRunAt: Date | null;
  }>): Promise<ScheduleRecord | null>;
  deleteSchedule(identity: IdentityContext, scheduleId: string): Promise<boolean>;
  listScheduleRuns(identity: IdentityContext, scheduleId: string, limit: number): Promise<ScheduleRunRecord[]>;
  queueScheduleRun(identity: IdentityContext, scheduleId: string, scheduledFor: Date): Promise<ScheduleRunRecord | null>;
  claimDueScheduleRuns(now: Date, limit: number, leaseMs: number): Promise<ClaimedScheduleRun[]>;
  beginScheduleRun(runId: string, leaseToken: string, now: Date): Promise<ClaimedScheduleRun | null>;
  finishScheduleRun(runId: string, input: {
    state: Extract<ScheduleRunState, "succeeded" | "failed" | "skipped">;
    sessionId?: string;
    failureCode?: string;
    failureSummary?: string;
    completedAt: Date;
  }): Promise<ScheduleRunRecord | null>;
  close(): Promise<void>;
}

export const nextScheduleAt = (
  cronExpression: string,
  timeZone: string,
  after: Date,
): Date => {
  // Force validation here because Intl and cron-parser otherwise report
  // different errors for an unknown IANA zone.
  new Intl.DateTimeFormat("en", { timeZone }).format(after);
  return CronExpressionParser.parse(cronExpression, {
    currentDate: after,
    tz: timeZone,
  }).next().toDate();
};

const mapSchedule = (row: Record<string, unknown>): ScheduleRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  workspaceId: String(row.workspace_id),
  agentCatalogId: String(row.agent_catalog_id) as ChatAgentCatalogId,
  title: String(row.title),
  promptCiphertext: String(row.prompt_ciphertext),
  cronExpression: String(row.cron_expression),
  timeZone: String(row.time_zone),
  state: row.state as ScheduleState,
  nextRunAt: row.next_run_at ? new Date(String(row.next_run_at)) : null,
  lastRunAt: row.last_run_at ? new Date(String(row.last_run_at)) : null,
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const mapRun = (row: Record<string, unknown>): ScheduleRunRecord => ({
  id: String(row.id),
  scheduleId: String(row.schedule_id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  scheduledFor: new Date(String(row.scheduled_for)),
  state: row.state as ScheduleRunState,
  leaseToken: row.lease_token ? String(row.lease_token) : null,
  leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)) : null,
  sessionId: row.session_id ? String(row.session_id) : null,
  failureCode: row.failure_code ? String(row.failure_code) : null,
  failureSummary: row.failure_summary ? String(row.failure_summary) : null,
  startedAt: row.started_at ? new Date(String(row.started_at)) : null,
  completedAt: row.completed_at ? new Date(String(row.completed_at)) : null,
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const schedulePatch = (input: Record<string, unknown>) => {
  const columns: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    columns.push(`${column}=$${values.length + 4}`);
  };
  if (Object.hasOwn(input, "workspaceId")) add("workspace_id", input.workspaceId);
  if (Object.hasOwn(input, "agentCatalogId")) add("agent_catalog_id", input.agentCatalogId);
  if (Object.hasOwn(input, "title")) add("title", input.title);
  if (Object.hasOwn(input, "promptCiphertext")) add("prompt_ciphertext", input.promptCiphertext);
  if (Object.hasOwn(input, "cronExpression")) add("cron_expression", input.cronExpression);
  if (Object.hasOwn(input, "timeZone")) add("time_zone", input.timeZone);
  if (Object.hasOwn(input, "state")) add("state", input.state);
  if (Object.hasOwn(input, "nextRunAt")) add("next_run_at", input.nextRunAt);
  return { columns, values };
};

export class PostgresScheduleStore implements ScheduleStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresScheduleStore(new pg.Pool({ connectionString, max: 5 }));
  }

  async close() { await this.pool.end(); }

  async listSchedules(identity: IdentityContext) {
    const result = await this.pool.query(
      "SELECT * FROM schedules WHERE tenant_id=$1 AND subject_id=$2 ORDER BY updated_at DESC,id",
      [identity.tenantId, identity.subjectId],
    );
    return result.rows.map(mapSchedule);
  }

  async getSchedule(identity: IdentityContext, scheduleId: string) {
    const result = await this.pool.query(
      "SELECT * FROM schedules WHERE id=$1 AND tenant_id=$2 AND subject_id=$3",
      [scheduleId, identity.tenantId, identity.subjectId],
    );
    return result.rowCount ? mapSchedule(result.rows[0]) : null;
  }

  async createSchedule(identity: IdentityContext, input: Parameters<ScheduleStore["createSchedule"]>[1]) {
    const result = await this.pool.query(
      `INSERT INTO schedules (
         id,tenant_id,subject_id,workspace_id,agent_catalog_id,title,prompt_ciphertext,
         cron_expression,time_zone,state,next_run_at,created_at,updated_at
       )
       SELECT $1,$2,$3,w.id,$5,$6,$7,$8,$9,$10,$11,now(),now()
       FROM workspaces w
       WHERE w.id=$4 AND w.tenant_id=$2 AND w.subject_id=$3
       RETURNING *`,
      [input.id, identity.tenantId, identity.subjectId, input.workspaceId, input.agentCatalogId,
        input.title, input.promptCiphertext, input.cronExpression, input.timeZone, input.state, input.nextRunAt],
    );
    return result.rowCount ? mapSchedule(result.rows[0]) : null;
  }

  async updateSchedule(
    identity: IdentityContext,
    scheduleId: string,
    input: Parameters<ScheduleStore["updateSchedule"]>[2],
  ) {
    const { columns, values } = schedulePatch(input);
    if (!columns.length) return this.getSchedule(identity, scheduleId);
    const result = await this.pool.query(
      `UPDATE schedules SET ${columns.join(",")},updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND subject_id=$3
         AND (
           $4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM workspaces w
             WHERE w.id=$4 AND w.tenant_id=$2 AND w.subject_id=$3
           )
         )
       RETURNING *`,
      [scheduleId, identity.tenantId, identity.subjectId, input.workspaceId ?? null, ...values],
    );
    return result.rowCount ? mapSchedule(result.rows[0]) : null;
  }

  async deleteSchedule(identity: IdentityContext, scheduleId: string) {
    const result = await this.pool.query(
      "DELETE FROM schedules WHERE id=$1 AND tenant_id=$2 AND subject_id=$3",
      [scheduleId, identity.tenantId, identity.subjectId],
    );
    return Boolean(result.rowCount);
  }

  async listScheduleRuns(identity: IdentityContext, scheduleId: string, limit: number) {
    const result = await this.pool.query(
      `SELECT r.* FROM schedule_runs r
       JOIN schedules s ON s.id=r.schedule_id
       WHERE r.schedule_id=$1 AND s.tenant_id=$2 AND s.subject_id=$3
       ORDER BY r.scheduled_for DESC,r.id DESC LIMIT $4`,
      [scheduleId, identity.tenantId, identity.subjectId, limit],
    );
    return result.rows.map(mapRun);
  }

  async queueScheduleRun(identity: IdentityContext, scheduleId: string, scheduledFor: Date) {
    const result = await this.pool.query(
      `INSERT INTO schedule_runs (
         id,schedule_id,tenant_id,subject_id,scheduled_for,state,created_at,updated_at
       )
       SELECT $1,s.id,s.tenant_id,s.subject_id,$5,'claimed',now(),now()
       FROM schedules s
       WHERE s.id=$2 AND s.tenant_id=$3 AND s.subject_id=$4
       RETURNING *`,
      [randomUUID(), scheduleId, identity.tenantId, identity.subjectId, scheduledFor],
    );
    return result.rowCount ? mapRun(result.rows[0]) : null;
  }

  async claimDueScheduleRuns(now: Date, limit: number, leaseMs: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE schedule_runs SET
           state='failed',
           failure_code='SCHEDULE_RUN_OUTCOME_UNKNOWN',
           failure_summary='The scheduler lost contact with this run after dispatch; it was not retried.',
           completed_at=$1,
           lease_token=NULL,
           lease_expires_at=NULL,
           updated_at=now()
         WHERE state='running' AND started_at < $1::timestamptz - interval '20 minutes'`,
        [now],
      );
      const due = await client.query(
        `SELECT * FROM schedules
         WHERE state='enabled' AND next_run_at IS NOT NULL AND next_run_at <= $1
         ORDER BY next_run_at,id
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      for (const row of due.rows) {
        const schedule = mapSchedule(row);
        const active = await client.query(
          "SELECT 1 FROM schedule_runs WHERE schedule_id=$1 AND state IN ('claimed','running') LIMIT 1",
          [schedule.id],
        );
        const state = active.rowCount ? "skipped" : "claimed";
        await client.query(
          `INSERT INTO schedule_runs (
             id,schedule_id,tenant_id,subject_id,scheduled_for,state,failure_code,failure_summary,
             completed_at,created_at,updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
           ON CONFLICT (schedule_id,scheduled_for) DO NOTHING`,
          [
            randomUUID(), schedule.id, schedule.tenantId, schedule.subjectId, schedule.nextRunAt,
            state,
            state === "skipped" ? "SCHEDULE_OVERLAP_SKIPPED" : null,
            state === "skipped" ? "The prior scheduled run was still active." : null,
            state === "skipped" ? now : null,
          ],
        );
        // Advance from the poll time, not the missed occurrence. This makes
        // downtime a skip rather than an unbounded catch-up queue.
        const next = nextScheduleAt(schedule.cronExpression, schedule.timeZone, now);
        await client.query(
          "UPDATE schedules SET next_run_at=$2,updated_at=now() WHERE id=$1",
          [schedule.id, next],
        );
      }

      const claimable = await client.query(
        `SELECT r.id FROM schedule_runs r
         WHERE r.state='claimed' AND (r.lease_expires_at IS NULL OR r.lease_expires_at < $1)
         ORDER BY r.scheduled_for,r.id
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      const claimed: ClaimedScheduleRun[] = [];
      for (const row of claimable.rows) {
        const leaseToken = randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + leaseMs);
        const updated = await client.query(
          `UPDATE schedule_runs SET lease_token=$2,lease_expires_at=$3,updated_at=now()
           WHERE id=$1 RETURNING *`,
          [row.id, leaseToken, leaseExpiresAt],
        );
        const run = mapRun(updated.rows[0]);
        const schedule = await client.query("SELECT * FROM schedules WHERE id=$1", [run.scheduleId]);
        if (schedule.rowCount) claimed.push({ run, schedule: mapSchedule(schedule.rows[0]) });
      }
      await client.query("COMMIT");
      return claimed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async beginScheduleRun(runId: string, leaseToken: string, now: Date) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE schedule_runs SET state='running',started_at=$3,updated_at=now()
         WHERE id=$1 AND lease_token=$2 AND state='claimed' AND lease_expires_at >= $3
         RETURNING *`,
        [runId, leaseToken, now],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const run = mapRun(updated.rows[0]);
      const schedule = await client.query("SELECT * FROM schedules WHERE id=$1", [run.scheduleId]);
      if (!schedule.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("UPDATE schedules SET last_run_at=$2,updated_at=now() WHERE id=$1", [run.scheduleId, now]);
      await client.query("COMMIT");
      return { run, schedule: mapSchedule(schedule.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async finishScheduleRun(runId: string, input: Parameters<ScheduleStore["finishScheduleRun"]>[1]) {
    const result = await this.pool.query(
      `UPDATE schedule_runs SET
         state=$2,session_id=$3,failure_code=$4,failure_summary=$5,
         completed_at=$6,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND state='running'
       RETURNING *`,
      [runId, input.state, input.sessionId ?? null, input.failureCode ?? null,
        input.failureSummary ?? null, input.completedAt],
    );
    return result.rowCount ? mapRun(result.rows[0]) : null;
  }
}
