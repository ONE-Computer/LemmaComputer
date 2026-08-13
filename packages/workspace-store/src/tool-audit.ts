import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  LemmaComputerError,
  canonicalJson,
  toolAuditAdmissionInputSchema,
  toolAuditAdmissionRecordInputSchema,
  toolAuditAdmissionSchema,
  toolAuditTerminalInputSchema,
  toolAuditTerminalRecordSchema,
  toolAuditTargetSummarySchema,
  type ToolAuditAdmission,
  type ToolAuditAdmissionInput,
  type ToolAuditAdmissionRecordInput,
  type ToolAuditQuery,
  type ToolAuditSummaryBucket,
  type ToolAuditTargetSummary,
  type ToolAuditTargetDescriptor,
  type ManagedToolAuditTargetType,
  type ToolAuditTerminalInput,
  type ToolAuditTerminalRecord,
} from "@lemmacomputer/contracts";

const secretAssignments = /\b(password|passwd|secret|token|api[-_ ]?key|client[-_ ]?secret|authorization)\s*[:=]\s*([^\s,;]+)/giu;
const bearerTokens = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/giu;
const structuredTokens = /\b(?:sk|pk|ghp|github_pat|xox[baprs]|pat)[-_][A-Za-z0-9_-]{12,}\b/giu;
const jsonWebTokens = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const longOpaqueTokens = /\b[A-Za-z0-9_-]{40,}\b/gu;
const pemMaterial = /-----BEGIN [^-]{1,80}-----[\s\S]*?-----END [^-]{1,80}-----/gu;

const safeTargetLabel = (value: string) => {
  let normalized = value.normalize("NFKC").replace(pemMaterial, "[redacted]");
  try {
    const url = new URL(normalized);
    normalized = `${url.protocol}//${url.host}`;
  } catch {
    // Human-facing filenames, recipients, and destinations are ordinarily not URLs.
  }
  normalized = normalized
    .replace(secretAssignments, (_match, name: string) => `${name}=[redacted]`)
    .replace(bearerTokens, "[redacted]")
    .replace(structuredTokens, "[redacted]")
    .replace(jsonWebTokens, "[redacted]")
    .replace(longOpaqueTokens, "[redacted]")
    .replace(/[\u0000-\u001f\u007f<>]/gu, " ")
    .replace(/javascript\s*:/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized === "[redacted]") return null;
  return normalized.length <= 150 ? normalized : `${normalized.slice(0, 149)}…`;
};

const targetTypeLabels: Record<ManagedToolAuditTargetType, string> = {
  recipient: "Recipient",
  chat: "Chat",
  channel: "Channel",
  file: "File",
  folder: "Folder",
  event: "Event",
  message: "Message",
  item: "Item",
  destination: "Destination",
};

/**
 * Produces the only free-text field accepted by the tool audit store. Generic
 * connectors never contribute arguments or provider results to this summary.
 */
export const buildToolAuditTargetSummary = (descriptor: ToolAuditTargetDescriptor): ToolAuditTargetSummary => {
  if (descriptor.provenance === "generic_template") {
    return toolAuditTargetSummarySchema.parse({
      targetType: "connector",
      text: "Connector tool invocation",
      provenance: "generic_template",
      redacted: false,
    });
  }
  const safe = safeTargetLabel(descriptor.target);
  const label = targetTypeLabels[descriptor.targetType];
  return toolAuditTargetSummarySchema.parse({
    targetType: descriptor.targetType,
    text: safe ? `${label}: ${safe}` : `${label} target`,
    provenance: "managed_schema",
    redacted: safe !== descriptor.target.normalize("NFKC").trim(),
  });
};

export type AuditScope = Pick<ToolAuditAdmission, "tenantId" | "subjectId" | "workspaceId" | "agentInstanceId">;
export type FinalizeToolAuditInput = AuditScope & ToolAuditTerminalInput & { invocationId: string };
export type FinalizeToolAuditBySourceInput = AuditScope & ToolAuditTerminalInput & {
  sourceSystem: ToolAuditAdmission["sourceSystem"];
  sourceInvocationId: string;
};
export type ToolAuditAdmissionResult = {
  status: "created" | "duplicate";
  admission: ToolAuditAdmission;
  terminal: ToolAuditTerminalRecord | null;
};
export type ToolAuditTerminalResult = { status: "created" | "duplicate"; record: ToolAuditTerminalRecord };

export interface ToolAuditStore {
  admit(input: ToolAuditAdmissionInput): ToolAuditAdmissionResult | Promise<ToolAuditAdmissionResult>;
  finalize(input: FinalizeToolAuditInput): ToolAuditTerminalResult | Promise<ToolAuditTerminalResult>;
  finalizeBySource(input: FinalizeToolAuditBySourceInput): ToolAuditTerminalResult | Promise<ToolAuditTerminalResult>;
  reconcileUnconfirmed(staleBefore: Date, completedAt?: Date): number | Promise<number>;
  getPending(tenantId: string, invocationId: string): ToolAuditAdmission | null | Promise<ToolAuditAdmission | null>;
  getTerminal(tenantId: string, invocationId: string): ToolAuditTerminalRecord | null | Promise<ToolAuditTerminalRecord | null>;
  listTerminal(tenantId: string): ToolAuditTerminalRecord[] | Promise<ToolAuditTerminalRecord[]>;
  queryTerminal?(input: ToolAuditStoreQuery): Promise<ToolAuditStorePage>;
}

export type ToolAuditStoreQuery = Omit<ToolAuditQuery, "cursor"> & {
  tenantId: string;
  asOf: Date;
  after: { completedAt: Date; invocationId: string } | null;
};

export type ToolAuditStorePage = {
  events: ToolAuditTerminalRecord[];
  hasMore: boolean;
  total: number;
  summary: ToolAuditSummaryBucket[];
  retainedDetailFrom: Date | null;
  detailState: "complete" | "partial" | "rollup_only";
};

const cloneAdmission = (value: ToolAuditAdmission): ToolAuditAdmission => structuredClone(value);
const cloneTerminal = (value: ToolAuditTerminalRecord): ToolAuditTerminalRecord => structuredClone(value);
const sourceKey = (input: Pick<ToolAuditAdmissionRecordInput, "tenantId" | "sourceSystem" | "sourceInvocationId">) => (
  canonicalJson([input.tenantId, input.sourceSystem, input.sourceInvocationId])
);
const terminalSemantic = (value: Pick<ToolAuditTerminalRecord, "outcome" | "latencyMs" | "failureClass">) => canonicalJson({
  outcome: value.outcome,
  latencyMs: value.latencyMs,
  failureClass: value.failureClass,
});
const scopeMatches = (record: ToolAuditAdmission, scope: AuditScope) => (
  record.tenantId === scope.tenantId
  && record.subjectId === scope.subjectId
  && record.workspaceId === scope.workspaceId
  && record.agentInstanceId === scope.agentInstanceId
);
const fixedPolicyOutcome = (decision: ToolAuditAdmission["policyDecision"]) => (
  decision === "deny" ? "denied" as const
    : decision === "approval_required" ? "approval_required" as const
      : null
);

export class InMemoryToolAuditStore {
  private readonly admissions = new Map<string, ToolAuditAdmission>();
  private readonly terminals = new Map<string, ToolAuditTerminalRecord>();
  private readonly invocationBySource = new Map<string, string>();
  private readonly admissionSemantics = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  admit(inputValue: ToolAuditAdmissionInput): ToolAuditAdmissionResult {
    const input = toolAuditAdmissionInputSchema.parse(inputValue);
    const { target, ...facts } = input;
    const persistedInput = toolAuditAdmissionRecordInputSchema.parse({
      ...facts,
      targetSummary: buildToolAuditTargetSummary(target),
    });
    const key = sourceKey(persistedInput);
    const semantic = canonicalJson(persistedInput);
    const existingId = this.invocationBySource.get(key);
    if (existingId) {
      if (this.admissionSemantics.get(existingId) !== semantic) {
        throw new LemmaComputerError(
          "TOOL_AUDIT_IDEMPOTENCY_CONFLICT",
          "The tool invocation source identity was already bound to different compliance facts",
          409,
        );
      }
      const existingTerminal = this.terminals.get(existingId) ?? null;
      const admission = this.admissions.get(existingId) ?? existingTerminal;
      if (!admission) throw new Error("Tool audit source index is inconsistent");
      return {
        status: "duplicate",
        admission: cloneAdmission(admission),
        terminal: existingTerminal ? cloneTerminal(existingTerminal) : null,
      };
    }

    const admittedAt = this.now().toISOString();
    const admission = toolAuditAdmissionSchema.parse({ ...persistedInput, invocationId: randomUUID(), admittedAt });
    this.invocationBySource.set(key, admission.invocationId);
    this.admissionSemantics.set(admission.invocationId, semantic);
    this.admissions.set(admission.invocationId, admission);

    const immediateOutcome = fixedPolicyOutcome(admission.policyDecision);
    if (!immediateOutcome) return { status: "created", admission: cloneAdmission(admission), terminal: null };
    const terminal = this.createTerminal(admission, {
      outcome: immediateOutcome,
      latencyMs: 0,
      failureClass: null,
    }, this.now());
    return { status: "created", admission: cloneAdmission(admission), terminal: cloneTerminal(terminal) };
  }

  finalize(inputValue: FinalizeToolAuditInput): ToolAuditTerminalResult {
    const terminal = toolAuditTerminalInputSchema.parse({
      outcome: inputValue.outcome,
      latencyMs: inputValue.latencyMs,
      failureClass: inputValue.failureClass,
    });
    const input = {
      ...inputValue,
      ...terminal,
    };
    const existing = this.terminals.get(input.invocationId);
    if (existing) {
      if (!scopeMatches(existing, input)) this.notFound();
      if (terminalSemantic(existing) !== terminalSemantic(input)) {
        throw new LemmaComputerError(
          "TOOL_AUDIT_TERMINAL_CONFLICT",
          "Terminal compliance evidence is append-only and cannot be replaced",
          409,
        );
      }
      return { status: "duplicate", record: cloneTerminal(existing) };
    }
    const admission = this.admissions.get(input.invocationId);
    if (!admission || !scopeMatches(admission, input)) this.notFound();
    if (admission.policyDecision !== "allow") {
      throw new LemmaComputerError("TOOL_AUDIT_TERMINAL_CONFLICT", "Policy terminals are recorded during admission", 409);
    }
    const record = this.createTerminal(admission, input, this.now());
    return { status: "created", record: cloneTerminal(record) };
  }

  finalizeBySource(input: FinalizeToolAuditBySourceInput): ToolAuditTerminalResult {
    const invocationId = this.invocationBySource.get(sourceKey(input));
    if (!invocationId) this.notFound();
    return this.finalize({ ...input, invocationId });
  }

  reconcileUnconfirmed(staleBefore: Date, completedAt = this.now()) {
    let count = 0;
    for (const admission of [...this.admissions.values()]) {
      if (admission.policyDecision !== "allow" || Date.parse(admission.admittedAt) > staleBefore.getTime()) continue;
      const latencyMs = Math.min(7 * 24 * 60 * 60 * 1_000, Math.max(0, completedAt.getTime() - Date.parse(admission.admittedAt)));
      this.createTerminal(admission, {
        outcome: "unconfirmed",
        latencyMs,
        failureClass: "TOOL_AUDIT_TERMINAL_EVIDENCE_MISSING",
      }, completedAt);
      count += 1;
    }
    return count;
  }

  getPending(tenantId: string, invocationId: string) {
    const admission = this.admissions.get(invocationId);
    return admission?.tenantId === tenantId ? cloneAdmission(admission) : null;
  }

  getTerminal(tenantId: string, invocationId: string) {
    const record = this.terminals.get(invocationId);
    return record?.tenantId === tenantId ? cloneTerminal(record) : null;
  }

  listTerminal(tenantId: string) {
    return [...this.terminals.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt) || right.invocationId.localeCompare(left.invocationId))
      .map(cloneTerminal);
  }

  private createTerminal(admission: ToolAuditAdmission, input: ToolAuditTerminalInput, completedAt: Date) {
    const record = toolAuditTerminalRecordSchema.parse({
      ...admission,
      ...input,
      completedAt: completedAt.toISOString(),
    });
    this.terminals.set(record.invocationId, record);
    this.admissions.delete(record.invocationId);
    return record;
  }

  private notFound(): never {
    throw new LemmaComputerError("TOOL_AUDIT_INVOCATION_NOT_FOUND", "Tool invocation audit admission was not found", 404);
  }
}

const rowToAdmission = (row: Record<string, unknown>): ToolAuditAdmission => toolAuditAdmissionSchema.parse({
  tenantId: row.tenant_id,
  subjectId: row.subject_id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  agentInstanceId: row.agent_instance_id,
  context: {
    kind: row.context_kind,
    taskId: row.task_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
  },
  sourceSystem: row.source_system,
  sourceInvocationId: row.source_invocation_id,
  correlationId: row.correlation_id,
  connectorId: row.connector_id,
  serverId: row.server_id,
  serverName: row.server_name,
  toolName: row.tool_name,
  policyDecision: row.policy_decision,
  policyCode: row.policy_code,
  policyVersionId: row.policy_version_id,
  policyHash: row.policy_hash,
  governedOperationId: row.governed_operation_id,
  targetSummary: {
    targetType: row.target_type,
    text: row.target_summary,
    provenance: row.target_provenance,
    redacted: row.target_redacted,
  },
  invocationId: row.invocation_id,
  admittedAt: new Date(String(row.admitted_at)).toISOString(),
});

const rowToTerminal = (row: Record<string, unknown>): ToolAuditTerminalRecord => toolAuditTerminalRecordSchema.parse({
  ...rowToAdmission(row),
  outcome: row.outcome,
  latencyMs: Number(row.latency_ms),
  failureClass: row.failure_class,
  completedAt: new Date(String(row.completed_at)).toISOString(),
});

const persistedAdmission = (inputValue: ToolAuditAdmissionInput): ToolAuditAdmissionRecordInput => {
  const input = toolAuditAdmissionInputSchema.parse(inputValue);
  const { target, ...facts } = input;
  return toolAuditAdmissionRecordInputSchema.parse({
    ...facts,
    targetSummary: buildToolAuditTargetSummary(target),
  });
};

const admissionSemanticHash = (input: ToolAuditAdmissionRecordInput) => createHash("sha256")
  .update(canonicalJson(input))
  .digest("hex");

const pendingInsertValues = (input: ToolAuditAdmissionRecordInput, invocationId: string, admittedAt: Date) => [
  input.tenantId,
  invocationId,
  input.subjectId,
  input.workspaceId,
  input.agentId,
  input.agentInstanceId,
  input.context.kind,
  input.context.taskId,
  input.context.sessionId,
  input.context.turnId,
  input.sourceSystem,
  input.sourceInvocationId,
  input.correlationId,
  input.connectorId,
  input.serverId,
  input.serverName,
  input.toolName,
  input.policyDecision,
  input.policyCode,
  input.policyVersionId,
  input.policyHash,
  input.governedOperationId,
  input.targetSummary.targetType,
  input.targetSummary.text,
  input.targetSummary.provenance,
  input.targetSummary.redacted,
  admittedAt,
];

const pendingColumns = `
  tenant_id,invocation_id,subject_id,workspace_id,agent_id,agent_instance_id,
  context_kind,task_id,session_id,turn_id,source_system,source_invocation_id,
  correlation_id,connector_id,server_id,server_name,tool_name,policy_decision,
  policy_code,policy_version_id,policy_hash,governed_operation_id,target_type,
  target_summary,target_provenance,target_redacted,admitted_at`;

export class PostgresToolAuditStore implements ToolAuditStore {
  constructor(private readonly pool: pg.Pool, private readonly now: () => Date = () => new Date()) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresToolAuditStore(new pg.Pool({ connectionString, max: 6 }));
  }

  async close() {
    await this.pool.end();
  }

  async ensureMonthlyPartitions(now = this.now(), monthsAhead = 3) {
    if (!Number.isInteger(monthsAhead) || monthsAhead < 1 || monthsAhead > 12) {
      throw new Error("Tool audit partition horizon must be between 1 and 12 months");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('lemmacomputer-tool-audit-partitions'))");
      for (let offset = 0; offset <= monthsAhead; offset += 1) {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
        const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
        const suffix = `${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
        if (!/^\d{4}_\d{2}$/.test(suffix)) throw new Error("Invalid tool audit partition suffix");
        await client.query(
          `CREATE TABLE IF NOT EXISTS tool_audit_events_${suffix} PARTITION OF tool_audit_events
           FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async admit(inputValue: ToolAuditAdmissionInput): Promise<ToolAuditAdmissionResult> {
    const input = persistedAdmission(inputValue);
    const semanticHash = admissionSemanticHash(input);
    const key = [input.tenantId, input.sourceSystem, input.sourceInvocationId] as const;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const invocationId = randomUUID();
      const admittedAt = this.now();
      const insertedKey = await client.query(
        `INSERT INTO tool_audit_invocation_keys (
           tenant_id,source_system,source_invocation_id,invocation_id,semantic_hash,admitted_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id,source_system,source_invocation_id) DO NOTHING
         RETURNING invocation_id`,
        [...key, invocationId, semanticHash, admittedAt],
      );
      if (!insertedKey.rowCount) {
        const existingKey = await client.query(
          `SELECT invocation_id,semantic_hash FROM tool_audit_invocation_keys
           WHERE tenant_id=$1 AND source_system=$2 AND source_invocation_id=$3
           FOR SHARE`,
          [...key],
        );
        if (!existingKey.rowCount || existingKey.rows[0].semantic_hash !== semanticHash) {
          throw new LemmaComputerError(
            "TOOL_AUDIT_IDEMPOTENCY_CONFLICT",
            "The tool invocation source identity was already bound to different compliance facts",
            409,
          );
        }
        const existingId = String(existingKey.rows[0].invocation_id);
        const terminal = await this.findTerminal(client, input.tenantId, existingId);
        const admission = terminal ?? await this.findPending(client, input.tenantId, existingId);
        if (!admission) throw new Error("Tool audit source index is inconsistent");
        await client.query("COMMIT");
        return { status: "duplicate", admission, terminal };
      }

      const placeholders = pendingInsertValues(input, invocationId, admittedAt).map((_, index) => `$${index + 1}`).join(",");
      const pending = await client.query(
        `INSERT INTO tool_audit_pending_admissions (${pendingColumns})
         VALUES (${placeholders}) RETURNING *`,
        pendingInsertValues(input, invocationId, admittedAt),
      );
      const admission = rowToAdmission(pending.rows[0]);
      const immediateOutcome = fixedPolicyOutcome(admission.policyDecision);
      const terminal = immediateOutcome
        ? await this.insertTerminal(client, admission.tenantId, admission.invocationId, {
          outcome: immediateOutcome,
          latencyMs: 0,
          failureClass: null,
        }, this.now())
        : null;
      await client.query("COMMIT");
      return { status: "created", admission, terminal };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async finalize(inputValue: FinalizeToolAuditInput): Promise<ToolAuditTerminalResult> {
    const terminalInput = toolAuditTerminalInputSchema.parse({
      outcome: inputValue.outcome,
      latencyMs: inputValue.latencyMs,
      failureClass: inputValue.failureClass,
    });
    return this.finalizeResolved(inputValue, terminalInput);
  }

  async finalizeBySource(inputValue: FinalizeToolAuditBySourceInput): Promise<ToolAuditTerminalResult> {
    const terminalInput = toolAuditTerminalInputSchema.parse({
      outcome: inputValue.outcome,
      latencyMs: inputValue.latencyMs,
      failureClass: inputValue.failureClass,
    });
    const key = await this.pool.query(
      `SELECT invocation_id FROM tool_audit_invocation_keys
       WHERE tenant_id=$1 AND source_system=$2 AND source_invocation_id=$3`,
      [inputValue.tenantId, inputValue.sourceSystem, inputValue.sourceInvocationId],
    );
    if (!key.rowCount) this.notFound();
    return this.finalizeResolved({ ...inputValue, invocationId: String(key.rows[0].invocation_id) }, terminalInput);
  }

  async reconcileUnconfirmed(staleBefore: Date, completedAt = this.now()) {
    const result = await this.pool.query(
      `WITH stale AS (
         SELECT * FROM tool_audit_pending_admissions
         WHERE admitted_at <= $1 AND policy_decision='allow'
         FOR UPDATE SKIP LOCKED
       ), inserted AS (
         INSERT INTO tool_audit_events (${pendingColumns},outcome,latency_ms,failure_class,completed_at)
         SELECT ${pendingColumns},'unconfirmed',
           LEAST(604800000,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz-admitted_at))*1000)::integer)),
           'TOOL_AUDIT_TERMINAL_EVIDENCE_MISSING',$2
         FROM stale
         RETURNING tenant_id,invocation_id
       )
       DELETE FROM tool_audit_pending_admissions pending
       USING inserted
       WHERE pending.tenant_id=inserted.tenant_id AND pending.invocation_id=inserted.invocation_id
       RETURNING pending.invocation_id`,
      [staleBefore, completedAt],
    );
    return result.rowCount ?? 0;
  }

  async getPending(tenantId: string, invocationId: string) {
    return this.findPending(this.pool, tenantId, invocationId);
  }

  async getTerminal(tenantId: string, invocationId: string) {
    return this.findTerminal(this.pool, tenantId, invocationId);
  }

  async listTerminal(tenantId: string) {
    const result = await this.pool.query(
      `SELECT * FROM tool_audit_events
       WHERE tenant_id=$1
       ORDER BY completed_at DESC,invocation_id DESC`,
      [tenantId],
    );
    return result.rows.map(rowToTerminal);
  }

  async queryTerminal(input: ToolAuditStoreQuery): Promise<ToolAuditStorePage> {
    const values: unknown[] = [input.tenantId, new Date(input.from), new Date(input.to), input.asOf];
    const where = [
      "tenant_id=$1",
      "completed_at >= $2",
      "completed_at < $3",
      "completed_at <= $4",
    ];
    const filter = (column: string, value: unknown) => {
      if (value === null || value === undefined) return;
      values.push(value);
      where.push(`${column}=$${values.length}`);
    };
    filter("subject_id", input.subjectId);
    filter("workspace_id", input.workspaceId);
    filter("agent_instance_id", input.agentInstanceId);
    filter("connector_id", input.connectorId);
    filter("tool_name", input.toolName);
    filter("policy_decision", input.policyDecision);
    filter("outcome", input.outcome);
    if (input.after) {
      values.push(input.after.completedAt, input.after.invocationId);
      where.push(`(completed_at,invocation_id) < ($${values.length - 1},$${values.length})`);
    }
    values.push(input.pageSize + 1);
    const page = await this.pool.query(
      `SELECT * FROM tool_audit_events
       WHERE ${where.join(" AND ")}
       ORDER BY completed_at DESC,invocation_id DESC
       LIMIT $${values.length}`,
      values,
    );
    const hasMore = page.rows.length > input.pageSize;
    const events = page.rows.slice(0, input.pageSize).map(rowToTerminal);

    const summary = await this.querySummary(input);
    const detailRange = await this.pool.query(
      `SELECT min(completed_at) AS first_detail FROM tool_audit_events WHERE tenant_id=$1`,
      [input.tenantId],
    );
    const rollupRange = await this.pool.query(
      `SELECT min(period_start) AS first_rollup FROM tool_audit_daily_rollups WHERE tenant_id=$1`,
      [input.tenantId],
    );
    const retainedDetailFrom = detailRange.rows[0]?.first_detail
      ? new Date(String(detailRange.rows[0].first_detail))
      : null;
    const firstRollup = rollupRange.rows[0]?.first_rollup
      ? new Date(`${String(rollupRange.rows[0].first_rollup).slice(0, 10)}T00:00:00.000Z`)
      : null;
    const detailState = !retainedDetailFrom && firstRollup
      ? "rollup_only" as const
      : retainedDetailFrom && firstRollup && firstRollup < retainedDetailFrom
        ? "partial" as const
        : "complete" as const;
    return {
      events,
      hasMore,
      total: summary.reduce((total, bucket) => total + bucket.count, 0),
      summary,
      retainedDetailFrom,
      detailState,
    };
  }

  private async querySummary(input: ToolAuditStoreQuery): Promise<ToolAuditSummaryBucket[]> {
    const identityFiltered = Boolean(input.subjectId || input.workspaceId || input.agentInstanceId);
    const effectiveTo = new Date(Math.min(Date.parse(input.to), input.asOf.getTime() + 1));
    if (identityFiltered) {
      const values: unknown[] = [input.tenantId, new Date(input.from), effectiveTo];
      const where = ["tenant_id=$1", "completed_at >= $2", "completed_at < $3"];
      const add = (column: string, value: unknown) => {
        if (value === null || value === undefined) return;
        values.push(value);
        where.push(`${column}=$${values.length}`);
      };
      add("subject_id", input.subjectId);
      add("workspace_id", input.workspaceId);
      add("agent_instance_id", input.agentInstanceId);
      add("connector_id", input.connectorId);
      add("tool_name", input.toolName);
      add("policy_decision", input.policyDecision);
      add("outcome", input.outcome);
      const result = await this.pool.query(
        `SELECT outcome,count(*)::integer AS count FROM tool_audit_events
         WHERE ${where.join(" AND ")} GROUP BY outcome ORDER BY outcome`,
        values,
      );
      return result.rows.map((row) => ({ outcome: row.outcome, count: Number(row.count) })) as ToolAuditSummaryBucket[];
    }

    const from = new Date(input.from);
    const fullStart = new Date(Math.ceil(from.getTime() / 3_600_000) * 3_600_000);
    const fullEnd = new Date(Math.floor(effectiveTo.getTime() / 3_600_000) * 3_600_000);
    const values: unknown[] = [input.tenantId, from, effectiveTo, fullStart, fullEnd];
    const rawFilters: string[] = [];
    const rollupFilters: string[] = [];
    const add = (column: string, value: unknown) => {
      if (value === null || value === undefined) return;
      values.push(value);
      rawFilters.push(`${column}=$${values.length}`);
      rollupFilters.push(`${column}=$${values.length}`);
    };
    add("connector_id", input.connectorId);
    add("tool_name", input.toolName);
    add("policy_decision", input.policyDecision);
    add("outcome", input.outcome);
    const result = await this.pool.query(
      `WITH counts AS (
         SELECT outcome,count(*)::bigint AS count
         FROM tool_audit_events
         WHERE tenant_id=$1 AND completed_at >= $2 AND completed_at < $3
           AND (completed_at < $4 OR completed_at >= $5)
           ${rawFilters.length ? `AND ${rawFilters.join(" AND ")}` : ""}
         GROUP BY outcome
         UNION ALL
         SELECT outcome,sum(invocation_count)::bigint AS count
         FROM tool_audit_hourly_rollups
         WHERE tenant_id=$1 AND period_start >= $4 AND period_start < $5
           ${rollupFilters.length ? `AND ${rollupFilters.join(" AND ")}` : ""}
         GROUP BY outcome
       )
       SELECT outcome,sum(count)::integer AS count FROM counts GROUP BY outcome ORDER BY outcome`,
      values,
    );
    return result.rows.map((row) => ({ outcome: row.outcome, count: Number(row.count) })) as ToolAuditSummaryBucket[];
  }

  private async finalizeResolved(
    input: AuditScope & { invocationId: string },
    terminalInput: ToolAuditTerminalInput,
  ): Promise<ToolAuditTerminalResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let existing = await this.findTerminal(client, input.tenantId, input.invocationId);
      if (existing) {
        this.assertScope(existing, input);
        this.assertTerminalSemantic(existing, terminalInput);
        await client.query("COMMIT");
        return { status: "duplicate", record: existing };
      }
      const pending = await client.query(
        `SELECT * FROM tool_audit_pending_admissions
         WHERE tenant_id=$1 AND invocation_id=$2 FOR UPDATE`,
        [input.tenantId, input.invocationId],
      );
      if (!pending.rowCount) {
        existing = await this.findTerminal(client, input.tenantId, input.invocationId);
        if (!existing) this.notFound();
        this.assertScope(existing, input);
        this.assertTerminalSemantic(existing, terminalInput);
        await client.query("COMMIT");
        return { status: "duplicate", record: existing };
      }
      const admission = rowToAdmission(pending.rows[0]);
      this.assertScope(admission, input);
      if (admission.policyDecision !== "allow") {
        throw new LemmaComputerError("TOOL_AUDIT_TERMINAL_CONFLICT", "Policy terminals are recorded during admission", 409);
      }
      const record = await this.insertTerminal(
        client,
        input.tenantId,
        input.invocationId,
        terminalInput,
        this.now(),
      );
      await client.query("COMMIT");
      return { status: "created", record };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertTerminal(
    query: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
    tenantId: string,
    invocationId: string,
    input: ToolAuditTerminalInput,
    completedAt: Date,
  ) {
    const terminal = toolAuditTerminalInputSchema.parse(input);
    const inserted = await query.query(
      `INSERT INTO tool_audit_events (${pendingColumns},outcome,latency_ms,failure_class,completed_at)
       SELECT ${pendingColumns},$3,$4,$5,$6
       FROM tool_audit_pending_admissions
       WHERE tenant_id=$1 AND invocation_id=$2
       RETURNING *`,
      [tenantId, invocationId, terminal.outcome, terminal.latencyMs, terminal.failureClass, completedAt],
    );
    if (!inserted.rowCount) this.notFound();
    await query.query(
      `DELETE FROM tool_audit_pending_admissions WHERE tenant_id=$1 AND invocation_id=$2`,
      [tenantId, invocationId],
    );
    return rowToTerminal(inserted.rows[0]);
  }

  private async findPending(query: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">, tenantId: string, invocationId: string) {
    const result = await query.query(
      `SELECT * FROM tool_audit_pending_admissions WHERE tenant_id=$1 AND invocation_id=$2`,
      [tenantId, invocationId],
    );
    return result.rowCount ? rowToAdmission(result.rows[0]) : null;
  }

  private async findTerminal(query: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">, tenantId: string, invocationId: string) {
    const result = await query.query(
      `SELECT * FROM tool_audit_events WHERE tenant_id=$1 AND invocation_id=$2
       ORDER BY completed_at DESC LIMIT 1`,
      [tenantId, invocationId],
    );
    return result.rowCount ? rowToTerminal(result.rows[0]) : null;
  }

  private assertScope(record: ToolAuditAdmission, scope: AuditScope) {
    if (!scopeMatches(record, scope)) this.notFound();
  }

  private assertTerminalSemantic(record: ToolAuditTerminalRecord, input: ToolAuditTerminalInput) {
    if (terminalSemantic(record) !== terminalSemantic(input as ToolAuditTerminalRecord)) {
      throw new LemmaComputerError(
        "TOOL_AUDIT_TERMINAL_CONFLICT",
        "Terminal compliance evidence is append-only and cannot be replaced",
        409,
      );
    }
  }

  private notFound(): never {
    throw new LemmaComputerError("TOOL_AUDIT_INVOCATION_NOT_FOUND", "Tool invocation audit admission was not found", 404);
  }
}
