import { randomUUID } from "node:crypto";
import pg from "pg";
import { LemmaComputerError, type AgentCatalogId } from "@lemmacomputer/contracts";

export const agentInstanceStatuses = ["starting", "running", "ended"] as const;
export type AgentInstanceStatus = typeof agentInstanceStatuses[number];

export const agentInstanceEndReasons = [
  "process_exited",
  "workspace_restarted",
  "workspace_stopped",
  "workspace_terminated",
  "launch_failed",
  "provider_failed",
  "reconciled_abandoned",
] as const;
export type AgentInstanceEndReason = typeof agentInstanceEndReasons[number];

export const agentInstanceCleanupStatuses = ["not_required", "pending", "confirmed", "incomplete"] as const;
export type AgentInstanceCleanupStatus = typeof agentInstanceCleanupStatuses[number];

export type AgentInstanceIdentityState =
  | { state: "verified"; agentInstanceId: string }
  | { state: "legacy_no_instance"; agentInstanceId: null };

export const agentInstanceIdentityState = (
  agentInstanceId: string | null | undefined,
): AgentInstanceIdentityState => agentInstanceId
  ? { state: "verified", agentInstanceId }
  : { state: "legacy_no_instance", agentInstanceId: null };

export type AgentInstanceRecord = {
  id: string;
  tenantId: string;
  ownerSubjectId: string;
  workspaceId: string;
  agentCatalogId: AgentCatalogId;
  logicalAgentId: string;
  accessGeneration: number;
  providerRuntimeId: string | null;
  imageDigest: string | null;
  imageVersion: string | null;
  policyVersionId: string;
  policyVersion: number;
  policyHash: string;
  launchIdempotencyKey: string;
  status: AgentInstanceStatus;
  launchRequestedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  endReason: AgentInstanceEndReason | null;
  cleanupStatus: AgentInstanceCleanupStatus;
  cleanupFailureCode: string | null;
  cleanupFailureAt: Date | null;
  cleanupConfirmedAt: Date | null;
  cleanupUpdatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type RegisterAgentInstanceInput = {
  tenantId: string;
  ownerSubjectId: string;
  workspaceId: string;
  agentCatalogId: AgentCatalogId;
  logicalAgentId: string;
  accessGeneration: number;
  policyVersionId: string;
  policyVersion: number;
  policyHash: string;
  launchIdempotencyKey: string;
};

export type AgentInstanceLocator = {
  tenantId: string;
  ownerSubjectId: string;
  workspaceId: string;
  agentInstanceId: string;
};

export interface AgentInstanceStore {
  registerLaunch(input: RegisterAgentInstanceInput): Promise<{
    disposition: "created" | "existing";
    instance: AgentInstanceRecord;
  }>;
  get(input: AgentInstanceLocator): Promise<AgentInstanceRecord | null>;
  listForWorkspace(input: Omit<AgentInstanceLocator, "agentInstanceId">): Promise<AgentInstanceRecord[]>;
  markRunning(input: AgentInstanceLocator & {
    providerRuntimeId: string;
    imageDigest?: string | null;
    imageVersion?: string | null;
  }): Promise<AgentInstanceRecord | null>;
  end(input: AgentInstanceLocator & {
    reason: AgentInstanceEndReason;
    cleanupStatus?: AgentInstanceCleanupStatus;
    cleanupFailureCode?: string | null;
  }): Promise<AgentInstanceRecord | null>;
  recordCleanupOutcome(input: AgentInstanceLocator & {
    status: AgentInstanceCleanupStatus;
    failureCode?: string | null;
  }): Promise<AgentInstanceRecord | null>;
}

const dateOrNull = (value: unknown) => value === null || value === undefined
  ? null
  : new Date(String(value));

const mapRow = (row: Record<string, unknown>): AgentInstanceRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  ownerSubjectId: String(row.owner_subject_id),
  workspaceId: String(row.workspace_id),
  agentCatalogId: row.agent_catalog_id as AgentCatalogId,
  logicalAgentId: String(row.logical_agent_id),
  accessGeneration: Number(row.access_generation),
  providerRuntimeId: row.provider_runtime_id === null ? null : String(row.provider_runtime_id),
  imageDigest: row.image_digest === null ? null : String(row.image_digest),
  imageVersion: row.image_version === null ? null : String(row.image_version),
  policyVersionId: String(row.policy_version_id),
  policyVersion: Number(row.policy_version),
  policyHash: String(row.policy_hash),
  launchIdempotencyKey: String(row.launch_idempotency_key),
  status: row.status as AgentInstanceStatus,
  launchRequestedAt: new Date(String(row.launch_requested_at)),
  startedAt: dateOrNull(row.started_at),
  endedAt: dateOrNull(row.ended_at),
  endReason: row.end_reason === null ? null : row.end_reason as AgentInstanceEndReason,
  cleanupStatus: row.cleanup_status as AgentInstanceCleanupStatus,
  cleanupFailureCode: row.cleanup_failure_code === null ? null : String(row.cleanup_failure_code),
  cleanupFailureAt: dateOrNull(row.cleanup_failure_at),
  cleanupConfirmedAt: dateOrNull(row.cleanup_confirmed_at),
  cleanupUpdatedAt: new Date(String(row.cleanup_updated_at)),
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const sameRegistration = (record: AgentInstanceRecord, input: RegisterAgentInstanceInput) => (
  record.tenantId === input.tenantId
  && record.ownerSubjectId === input.ownerSubjectId
  && record.workspaceId === input.workspaceId
  && record.agentCatalogId === input.agentCatalogId
  && record.logicalAgentId === input.logicalAgentId
  && record.accessGeneration === input.accessGeneration
  && record.policyVersionId === input.policyVersionId
  && record.policyVersion === input.policyVersion
  && record.policyHash === input.policyHash
  && record.launchIdempotencyKey === input.launchIdempotencyKey
);

const validCleanupInput = (status: AgentInstanceCleanupStatus, failureCode: string | null | undefined) => (
  status === "incomplete" ? Boolean(failureCode) : !failureCode
);

const cleanupInputError = () => new LemmaComputerError(
  "AGENT_INSTANCE_CLEANUP_INVALID",
  "Incomplete cleanup requires one bounded failure code and other cleanup states cannot supply one",
  409,
);

export class PostgresAgentInstanceStore implements AgentInstanceStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresAgentInstanceStore(new pg.Pool({ connectionString, max: 5 }));
  }

  async close() {
    await this.pool.end();
  }

  async registerLaunch(input: RegisterAgentInstanceInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const workspace = await client.query(
        `SELECT 1 FROM workspaces
         WHERE id=$1 AND tenant_id=$2 AND subject_id=$3 AND access_generation=$4
           AND state IN ('provisioning','ready','open','restarting')
         FOR SHARE`,
        [input.workspaceId, input.tenantId, input.ownerSubjectId, input.accessGeneration],
      );
      if (!workspace.rowCount) {
        throw new LemmaComputerError(
          "AGENT_INSTANCE_WORKSPACE_INVALID",
          "The agent process launch is not bound to an active owned workspace generation",
          409,
        );
      }
      const inserted = await client.query(
        `INSERT INTO agent_instances (
           id,tenant_id,owner_subject_id,workspace_id,agent_catalog_id,logical_agent_id,
           access_generation,policy_version_id,policy_version,policy_hash,launch_idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id,owner_subject_id,workspace_id,launch_idempotency_key) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          input.tenantId,
          input.ownerSubjectId,
          input.workspaceId,
          input.agentCatalogId,
          input.logicalAgentId,
          input.accessGeneration,
          input.policyVersionId,
          input.policyVersion,
          input.policyHash,
          input.launchIdempotencyKey,
        ],
      );
      if (inserted.rowCount) {
        await client.query("COMMIT");
        return { disposition: "created" as const, instance: mapRow(inserted.rows[0]) };
      }
      const existing = await client.query(
        `SELECT * FROM agent_instances
         WHERE tenant_id=$1 AND owner_subject_id=$2 AND workspace_id=$3
           AND launch_idempotency_key=$4
         FOR UPDATE`,
        [input.tenantId, input.ownerSubjectId, input.workspaceId, input.launchIdempotencyKey],
      );
      const instance = mapRow(existing.rows[0]);
      if (!sameRegistration(instance, input)) {
        throw new LemmaComputerError(
          "AGENT_INSTANCE_IDEMPOTENCY_CONFLICT",
          "The trusted launch idempotency key was already bound to different immutable process facts",
          409,
        );
      }
      await client.query("COMMIT");
      return { disposition: "existing" as const, instance };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(input: AgentInstanceLocator) {
    const result = await this.pool.query(
      `SELECT * FROM agent_instances
       WHERE id=$1 AND tenant_id=$2 AND owner_subject_id=$3 AND workspace_id=$4`,
      [input.agentInstanceId, input.tenantId, input.ownerSubjectId, input.workspaceId],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async listForWorkspace(input: Omit<AgentInstanceLocator, "agentInstanceId">) {
    const result = await this.pool.query(
      `SELECT * FROM agent_instances
       WHERE tenant_id=$1 AND owner_subject_id=$2 AND workspace_id=$3
       ORDER BY launch_requested_at,id`,
      [input.tenantId, input.ownerSubjectId, input.workspaceId],
    );
    return result.rows.map(mapRow);
  }

  async markRunning(input: AgentInstanceLocator & {
    providerRuntimeId: string;
    imageDigest?: string | null;
    imageVersion?: string | null;
  }) {
    return this.withLockedInstance(input, async (client, current) => {
      if (current.status === "ended") {
        throw new LemmaComputerError(
          "AGENT_INSTANCE_LIFECYCLE_CONFLICT",
          "An ended agent process cannot return to running",
          409,
        );
      }
      if (current.status === "running") {
        const exactReplay = current.providerRuntimeId === input.providerRuntimeId
          && (input.imageDigest === undefined || current.imageDigest === input.imageDigest)
          && (input.imageVersion === undefined || current.imageVersion === input.imageVersion);
        if (!exactReplay) {
          throw new LemmaComputerError(
            "AGENT_INSTANCE_LIFECYCLE_CONFLICT",
            "The running agent process is already bound to different provider evidence",
            409,
          );
        }
        return current;
      }
      const result = await client.query(
        `UPDATE agent_instances SET
           status='running',provider_runtime_id=$5,image_digest=$6,image_version=$7,
           started_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND owner_subject_id=$3 AND workspace_id=$4
         RETURNING *`,
        [
          input.agentInstanceId,
          input.tenantId,
          input.ownerSubjectId,
          input.workspaceId,
          input.providerRuntimeId,
          input.imageDigest ?? null,
          input.imageVersion ?? null,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async end(input: AgentInstanceLocator & {
    reason: AgentInstanceEndReason;
    cleanupStatus?: AgentInstanceCleanupStatus;
    cleanupFailureCode?: string | null;
  }) {
    const cleanupStatus = input.cleanupStatus ?? "not_required";
    if (!validCleanupInput(cleanupStatus, input.cleanupFailureCode)) throw cleanupInputError();
    return this.withLockedInstance(input, async (client, current) => {
      if (current.status === "ended") return current;
      const result = await client.query(
        `UPDATE agent_instances SET
           status='ended',ended_at=now(),end_reason=$5,cleanup_status=$6,
           cleanup_failure_code=CASE WHEN $6='incomplete' THEN $7 ELSE cleanup_failure_code END,
           cleanup_failure_at=CASE WHEN $6='incomplete' THEN now() ELSE cleanup_failure_at END,
           cleanup_confirmed_at=CASE WHEN $6='confirmed' THEN now() ELSE cleanup_confirmed_at END,
           cleanup_updated_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND owner_subject_id=$3 AND workspace_id=$4
         RETURNING *`,
        [
          input.agentInstanceId,
          input.tenantId,
          input.ownerSubjectId,
          input.workspaceId,
          input.reason,
          cleanupStatus,
          input.cleanupFailureCode ?? null,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async recordCleanupOutcome(input: AgentInstanceLocator & {
    status: AgentInstanceCleanupStatus;
    failureCode?: string | null;
  }) {
    if (!validCleanupInput(input.status, input.failureCode)) throw cleanupInputError();
    return this.withLockedInstance(input, async (client, current) => {
      if (current.status !== "ended") {
        throw new LemmaComputerError(
          "AGENT_INSTANCE_LIFECYCLE_CONFLICT",
          "Provider cleanup outcomes can only be recorded for an ended agent process",
          409,
        );
      }
      if (current.cleanupStatus === "confirmed" && input.status !== "confirmed") {
        throw new LemmaComputerError(
          "AGENT_INSTANCE_CLEANUP_CONFLICT",
          "Confirmed provider cleanup cannot be downgraded",
          409,
        );
      }
      if (input.status === "not_required" && current.cleanupStatus !== "not_required") {
        throw new LemmaComputerError(
          "AGENT_INSTANCE_CLEANUP_CONFLICT",
          "Recorded provider cleanup cannot be reset to not required",
          409,
        );
      }
      const result = await client.query(
        `UPDATE agent_instances SET
           cleanup_status=$5,
           cleanup_failure_code=CASE WHEN $5='incomplete' THEN $6 ELSE cleanup_failure_code END,
           cleanup_failure_at=CASE WHEN $5='incomplete' THEN now() ELSE cleanup_failure_at END,
           cleanup_confirmed_at=CASE WHEN $5='confirmed' THEN COALESCE(cleanup_confirmed_at,now()) ELSE cleanup_confirmed_at END,
           cleanup_updated_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND owner_subject_id=$3 AND workspace_id=$4
         RETURNING *`,
        [
          input.agentInstanceId,
          input.tenantId,
          input.ownerSubjectId,
          input.workspaceId,
          input.status,
          input.failureCode ?? null,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  private async withLockedInstance<T>(
    input: AgentInstanceLocator,
    operation: (client: pg.PoolClient, current: AgentInstanceRecord) => Promise<T>,
  ): Promise<T | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT * FROM agent_instances
         WHERE id=$1 AND tenant_id=$2 AND owner_subject_id=$3 AND workspace_id=$4
         FOR UPDATE`,
        [input.agentInstanceId, input.tenantId, input.ownerSubjectId, input.workspaceId],
      );
      if (!selected.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      const result = await operation(client, mapRow(selected.rows[0]));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
