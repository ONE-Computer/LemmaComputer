import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  OneComputerError,
  type CreateTeam,
  type MinimalSpendingTeam,
  type TeamDetail,
  type TeamMembership,
  type TeamSummary,
  type UpdateTeam,
} from "@onecomputer/contracts";

export type TeamAuditEvent = {
  id: string;
  action: string;
  targetType: "team" | "membership" | "default_spending_team";
  targetId: string;
  details: Record<string, unknown>;
  occurredAt: string;
};

export interface TeamStore {
  listTeams(tenantId: string, includeArchived?: boolean): Promise<TeamSummary[]>;
  getTeam(tenantId: string, teamId: string): Promise<TeamDetail | null>;
  createTeam(input: CreateTeam & { tenantId: string; createdBy: string }): Promise<TeamDetail>;
  updateTeam(input: UpdateTeam & { tenantId: string; teamId: string; updatedBy: string }): Promise<TeamDetail>;
  archiveTeam(input: { tenantId: string; teamId: string; archivedBy: string }): Promise<TeamDetail>;
  assignMembership(input: {
    tenantId: string;
    teamId: string;
    userId: string;
    assignedBy: string;
    effectiveFrom?: Date;
    makeDefault?: boolean;
  }): Promise<TeamMembership>;
  removeMembership(input: {
    tenantId: string;
    teamId: string;
    userId: string;
    removedBy: string;
    effectiveTo?: Date;
  }): Promise<boolean>;
  setDefaultSpendingTeam(input: {
    tenantId: string;
    teamId: string;
    userId: string;
    assignedBy: string;
    effectiveFrom?: Date;
  }): Promise<MinimalSpendingTeam>;
  getCurrentDefaultSpendingTeam(tenantId: string, userId: string): Promise<MinimalSpendingTeam | null>;
  resolveDefaultSpendingTeam(input: {
    tenantId: string;
    userId: string;
    actorUserId: string;
  }): Promise<MinimalSpendingTeam>;
  listAuditEvents(tenantId: string, limit?: number): Promise<TeamAuditEvent[]>;
}

const teamSelect = `
  SELECT unit.id,unit.display_name,unit.description,unit.owner_user_id,
    unit.cost_center_code,unit.status,unit.is_rollout_fallback,
    unit.created_at,unit.updated_at,unit.archived_at,
    count(membership.id) FILTER (WHERE membership.effective_to IS NULL)::integer AS active_member_count
  FROM allocation_units unit
  LEFT JOIN allocation_memberships membership
    ON membership.tenant_id=unit.tenant_id
   AND membership.allocation_unit_id=unit.id
  WHERE unit.tenant_id=$1 AND unit.allocation_type='team'`;

const mapTeam = (row: Record<string, unknown>): TeamSummary => ({
  id: String(row.id),
  displayName: String(row.display_name),
  description: String(row.description),
  ownerUserId: String(row.owner_user_id),
  costCenterCode: row.cost_center_code === null ? null : String(row.cost_center_code),
  status: String(row.status) as TeamSummary["status"],
  isRolloutFallback: Boolean(row.is_rollout_fallback),
  activeMemberCount: Number(row.active_member_count),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
  archivedAt: row.archived_at === null ? null : new Date(String(row.archived_at)).toISOString(),
});

const mapMembership = (row: Record<string, unknown>): TeamMembership => ({
  id: String(row.id),
  teamId: String(row.allocation_unit_id),
  userId: String(row.user_id),
  effectiveFrom: new Date(String(row.effective_from)).toISOString(),
  effectiveTo: row.effective_to === null ? null : new Date(String(row.effective_to)).toISOString(),
  isDefaultSpendingTeam: Boolean(row.is_default_spending_team),
});

const minimalTeam = (row: Record<string, unknown>): MinimalSpendingTeam => ({
  id: String(row.id),
  displayName: String(row.display_name),
  costCenterCode: row.cost_center_code === null ? null : String(row.cost_center_code),
  isRolloutFallback: Boolean(row.is_rollout_fallback),
});

const isPgUniqueViolation = (error: unknown) => (
  error instanceof Error && "code" in error && (error as Error & { code?: string }).code === "23505"
);

export class PostgresTeamStore implements TeamStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresTeamStore(new pg.Pool({ connectionString, max: 5 }));
  }

  async close() {
    await this.pool.end();
  }

  async listTeams(tenantId: string, includeArchived = false) {
    const result = await this.pool.query(
      `${teamSelect}
       ${includeArchived ? "" : "AND unit.status='active'"}
       GROUP BY unit.id
       ORDER BY unit.is_rollout_fallback,unit.display_name`,
      [tenantId],
    );
    return result.rows.map(mapTeam);
  }

  async getTeam(tenantId: string, teamId: string) {
    const team = await this.pool.query(
      `${teamSelect} AND unit.id=$2 GROUP BY unit.id`,
      [tenantId, teamId],
    );
    if (!team.rowCount) return null;
    const memberships = await this.pool.query(
      `SELECT membership.*,
         EXISTS (
           SELECT 1 FROM default_spending_team_assignments default_team
           WHERE default_team.tenant_id=membership.tenant_id
             AND default_team.user_id=membership.user_id
             AND default_team.allocation_unit_id=membership.allocation_unit_id
             AND default_team.effective_to IS NULL
         ) AND membership.effective_to IS NULL AS is_default_spending_team
       FROM allocation_memberships membership
       WHERE membership.tenant_id=$1 AND membership.allocation_unit_id=$2
       ORDER BY membership.effective_from DESC`,
      [tenantId, teamId],
    );
    return { ...mapTeam(team.rows[0]), memberships: memberships.rows.map(mapMembership) };
  }

  async createTeam(input: CreateTeam & { tenantId: string; createdBy: string }) {
    if (input.displayName.trim().toLowerCase() === "unallocated") {
      throw new OneComputerError("TEAM_NAME_RESERVED", "Unallocated is reserved for the rollout fallback Team", 409);
    }
    const client = await this.pool.connect();
    const teamId = randomUUID();
    try {
      await client.query("BEGIN");
      await this.assertTenantUser(client, input.tenantId, input.createdBy, "TEAM_ACTOR_NOT_FOUND");
      await this.assertTenantUser(client, input.tenantId, input.ownerUserId, "TEAM_OWNER_NOT_FOUND");
      await client.query(
        `INSERT INTO allocation_units (
           id,tenant_id,allocation_type,display_name,description,owner_user_id,
           cost_center_code,created_by,updated_by
         ) VALUES ($1,$2,'team',$3,$4,$5,$6,$7,$7)`,
        [
          teamId,
          input.tenantId,
          input.displayName,
          input.description,
          input.ownerUserId,
          input.costCenterCode ?? null,
          input.createdBy,
        ],
      );
      const assignedAt = new Date();
      await client.query(
        `INSERT INTO allocation_memberships (id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by)
         VALUES ($1,$2,$3,$4,$5,$4)`,
        [randomUUID(), input.tenantId, teamId, input.ownerUserId, assignedAt],
      );
      await client.query(
        `INSERT INTO default_spending_team_assignments (id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by)
         SELECT $1,$2,$3,$4,$5,$4
         WHERE NOT EXISTS (
           SELECT 1 FROM default_spending_team_assignments
           WHERE tenant_id=$2 AND user_id=$4 AND effective_to IS NULL
         )`,
        [randomUUID(), input.tenantId, teamId, input.ownerUserId, assignedAt],
      );
      await this.audit(client, input.tenantId, input.createdBy, "team.created", "team", teamId, {
        changedFields: ["displayName", "description", "ownerUserId", "costCenterCode"],
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isPgUniqueViolation(error)) {
        throw new OneComputerError("TEAM_NAME_CONFLICT", "An active Team already uses that name", 409);
      }
      throw error;
    } finally {
      client.release();
    }
    return (await this.getTeam(input.tenantId, teamId))!;
  }

  async updateTeam(input: UpdateTeam & { tenantId: string; teamId: string; updatedBy: string }) {
    if (input.displayName?.trim().toLowerCase() === "unallocated") {
      throw new OneComputerError("TEAM_NAME_RESERVED", "Unallocated is reserved for the rollout fallback Team", 409);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertTenantUser(client, input.tenantId, input.updatedBy, "TEAM_ACTOR_NOT_FOUND");
      const current = await client.query(
        `SELECT * FROM allocation_units
         WHERE tenant_id=$1 AND id=$2 AND allocation_type='team' FOR UPDATE`,
        [input.tenantId, input.teamId],
      );
      if (!current.rowCount) throw new OneComputerError("TEAM_NOT_FOUND", "Team not found", 404);
      if (current.rows[0].status !== "active") {
        throw new OneComputerError("TEAM_ARCHIVED", "Archived Teams cannot be changed", 409);
      }
      if (current.rows[0].is_rollout_fallback) {
        throw new OneComputerError("TEAM_FALLBACK_IMMUTABLE", "The rollout fallback Team cannot be edited", 409);
      }
      if (input.ownerUserId !== undefined) {
        await this.assertTenantUser(client, input.tenantId, input.ownerUserId, "TEAM_OWNER_NOT_FOUND");
      }
      const changedFields = Object.keys(input).filter((key) => !["tenantId", "teamId", "updatedBy"].includes(key));
      await client.query(
        `UPDATE allocation_units SET
           display_name=COALESCE($3,display_name),
           description=COALESCE($4,description),
           owner_user_id=COALESCE($5,owner_user_id),
           cost_center_code=CASE WHEN $6 THEN $7 ELSE cost_center_code END,
           updated_by=$8,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          input.tenantId,
          input.teamId,
          input.displayName ?? null,
          input.description ?? null,
          input.ownerUserId ?? null,
          input.costCenterCode !== undefined,
          input.costCenterCode ?? null,
          input.updatedBy,
        ],
      );
      await this.audit(client, input.tenantId, input.updatedBy, "team.updated", "team", input.teamId, {
        changedFields,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isPgUniqueViolation(error)) {
        throw new OneComputerError("TEAM_NAME_CONFLICT", "An active Team already uses that name", 409);
      }
      throw error;
    } finally {
      client.release();
    }
    return (await this.getTeam(input.tenantId, input.teamId))!;
  }

  async archiveTeam(input: { tenantId: string; teamId: string; archivedBy: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertTenantUser(client, input.tenantId, input.archivedBy, "TEAM_ACTOR_NOT_FOUND");
      const team = await client.query(
        `SELECT * FROM allocation_units
         WHERE tenant_id=$1 AND id=$2 AND allocation_type='team' FOR UPDATE`,
        [input.tenantId, input.teamId],
      );
      if (!team.rowCount) throw new OneComputerError("TEAM_NOT_FOUND", "Team not found", 404);
      if (team.rows[0].is_rollout_fallback) {
        throw new OneComputerError("TEAM_FALLBACK_ARCHIVE_FORBIDDEN", "The rollout fallback Team cannot be archived", 409);
      }
      if (team.rows[0].status === "archived") {
        await client.query("COMMIT");
        return (await this.getTeam(input.tenantId, input.teamId))!;
      }
      const defaultUsers = await client.query(
        `SELECT user_id FROM default_spending_team_assignments
         WHERE tenant_id=$1 AND allocation_unit_id=$2 AND effective_to IS NULL
         ORDER BY user_id`,
        [input.tenantId, input.teamId],
      );
      for (const assignment of defaultUsers.rows) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`team-default:${input.tenantId}:${assignment.user_id}`],
        );
      }
      const defaults = await client.query(
        `SELECT * FROM default_spending_team_assignments
         WHERE tenant_id=$1 AND allocation_unit_id=$2 AND effective_to IS NULL
         FOR UPDATE`,
        [input.tenantId, input.teamId],
      );
      const fallback = defaults.rowCount
        ? await this.ensureFallback(client, input.tenantId, input.archivedBy)
        : null;
      for (const assignment of defaults.rows) {
        const changedAt = await this.nextBoundary(client, assignment.effective_from);
        await this.ensureMembership(client, input.tenantId, fallback!.id, String(assignment.user_id), input.archivedBy, changedAt);
        await client.query(
          `UPDATE default_spending_team_assignments
           SET effective_to=$2,ended_by=$3 WHERE id=$1`,
          [assignment.id, changedAt, input.archivedBy],
        );
        await client.query(
          `INSERT INTO default_spending_team_assignments (
             id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), input.tenantId, fallback!.id, assignment.user_id, changedAt, input.archivedBy],
        );
        await this.audit(
          client,
          input.tenantId,
          input.archivedBy,
          "default_spending_team.transferred_on_archive",
          "default_spending_team",
          String(assignment.user_id),
          { fromTeamId: input.teamId, toTeamId: fallback!.id },
        );
      }
      await client.query(
        `UPDATE allocation_memberships
         SET effective_to=GREATEST(clock_timestamp(),effective_from + interval '1 microsecond'),
             ended_by=$3
         WHERE tenant_id=$1 AND allocation_unit_id=$2 AND effective_to IS NULL`,
        [input.tenantId, input.teamId, input.archivedBy],
      );
      await client.query(
        `UPDATE allocation_units
         SET status='archived',archived_at=now(),updated_at=now(),updated_by=$3
         WHERE tenant_id=$1 AND id=$2`,
        [input.tenantId, input.teamId, input.archivedBy],
      );
      await this.audit(client, input.tenantId, input.archivedBy, "team.archived", "team", input.teamId, {
        transferredDefaultCount: defaults.rowCount ?? 0,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return (await this.getTeam(input.tenantId, input.teamId))!;
  }

  async assignMembership(input: {
    tenantId: string;
    teamId: string;
    userId: string;
    assignedBy: string;
    effectiveFrom?: Date;
    makeDefault?: boolean;
  }) {
    this.assertNotFuture(input.effectiveFrom, "TEAM_MEMBERSHIP_FUTURE_UNSUPPORTED");
    const client = await this.pool.connect();
    let membership: TeamMembership;
    try {
      await client.query("BEGIN");
      await this.assertTenantUser(client, input.tenantId, input.assignedBy, "TEAM_ACTOR_NOT_FOUND");
      await this.assertActiveTenantUser(client, input.tenantId, input.userId);
      await this.assertActiveTeam(client, input.tenantId, input.teamId);
      const effectiveFrom = input.effectiveFrom ?? new Date();
      membership = await this.ensureMembership(
        client,
        input.tenantId,
        input.teamId,
        input.userId,
        input.assignedBy,
        effectiveFrom,
      );
      await this.audit(client, input.tenantId, input.assignedBy, "membership.assigned", "membership", membership.id, {
        teamId: input.teamId,
        userId: input.userId,
      });
      if (input.makeDefault) await this.setDefaultWithClient(client, { ...input, effectiveFrom });
      membership = (await this.readActiveMembership(client, input.tenantId, input.teamId, input.userId))!;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return membership!;
  }

  async removeMembership(input: {
    tenantId: string;
    teamId: string;
    userId: string;
    removedBy: string;
    effectiveTo?: Date;
  }) {
    this.assertNotFuture(input.effectiveTo, "TEAM_MEMBERSHIP_FUTURE_UNSUPPORTED");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertTenantUser(client, input.tenantId, input.removedBy, "TEAM_ACTOR_NOT_FOUND");
      await this.lockTeam(client, input.tenantId, input.teamId, false);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`team-default:${input.tenantId}:${input.userId}`],
      );
      const isDefault = await client.query(
        `SELECT id FROM default_spending_team_assignments
         WHERE tenant_id=$1 AND user_id=$2 AND allocation_unit_id=$3 AND effective_to IS NULL`,
        [input.tenantId, input.userId, input.teamId],
      );
      if (isDefault.rowCount) {
        throw new OneComputerError(
          "TEAM_DEFAULT_TRANSFER_REQUIRED",
          "Choose another default spending Team before removing this membership",
          409,
        );
      }
      const membership = await client.query(
        `SELECT * FROM allocation_memberships
         WHERE tenant_id=$1 AND allocation_unit_id=$2 AND user_id=$3 AND effective_to IS NULL
         FOR UPDATE`,
        [input.tenantId, input.teamId, input.userId],
      );
      if (!membership.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      const effectiveTo = input.effectiveTo
        ? await this.nextBoundary(client, membership.rows[0].effective_from, input.effectiveTo)
        : await this.nextBoundary(client, membership.rows[0].effective_from);
      await client.query(
        "UPDATE allocation_memberships SET effective_to=$2,ended_by=$3 WHERE id=$1",
        [membership.rows[0].id, effectiveTo, input.removedBy],
      );
      await this.audit(
        client,
        input.tenantId,
        input.removedBy,
        "membership.removed",
        "membership",
        String(membership.rows[0].id),
        { teamId: input.teamId, userId: input.userId },
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setDefaultSpendingTeam(input: {
    tenantId: string;
    teamId: string;
    userId: string;
    assignedBy: string;
    effectiveFrom?: Date;
  }) {
    this.assertNotFuture(input.effectiveFrom, "TEAM_DEFAULT_FUTURE_UNSUPPORTED");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertTenantUser(client, input.tenantId, input.assignedBy, "TEAM_ACTOR_NOT_FOUND");
      await this.assertActiveTenantUser(client, input.tenantId, input.userId);
      await this.assertActiveTeam(client, input.tenantId, input.teamId);
      const team = await this.setDefaultWithClient(client, input);
      await client.query("COMMIT");
      return team;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCurrentDefaultSpendingTeam(tenantId: string, userId: string) {
    const current = await this.pool.query(
      `SELECT unit.id,unit.display_name,unit.cost_center_code,unit.is_rollout_fallback
       FROM default_spending_team_assignments assignment
       JOIN allocation_units unit
         ON unit.tenant_id=assignment.tenant_id
        AND unit.id=assignment.allocation_unit_id
       JOIN allocation_memberships membership
         ON membership.tenant_id=assignment.tenant_id
        AND membership.allocation_unit_id=assignment.allocation_unit_id
        AND membership.user_id=assignment.user_id
        AND membership.effective_to IS NULL
       WHERE assignment.tenant_id=$1 AND assignment.user_id=$2
         AND assignment.effective_to IS NULL AND unit.status='active'`,
      [tenantId, userId],
    );
    return current.rowCount ? minimalTeam(current.rows[0]) : null;
  }

  async resolveDefaultSpendingTeam(input: {
    tenantId: string;
    userId: string;
    actorUserId: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertTenantUser(client, input.tenantId, input.actorUserId, "TEAM_ACTOR_NOT_FOUND");
      await this.assertActiveTenantUser(client, input.tenantId, input.userId);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`team-default:${input.tenantId}:${input.userId}`],
      );
      const current = await client.query(
        `SELECT unit.id,unit.display_name,unit.cost_center_code,unit.is_rollout_fallback
         FROM default_spending_team_assignments assignment
         JOIN allocation_units unit
           ON unit.tenant_id=assignment.tenant_id
          AND unit.id=assignment.allocation_unit_id
         JOIN allocation_memberships membership
           ON membership.tenant_id=assignment.tenant_id
          AND membership.allocation_unit_id=assignment.allocation_unit_id
          AND membership.user_id=assignment.user_id
          AND membership.effective_to IS NULL
         WHERE assignment.tenant_id=$1 AND assignment.user_id=$2
           AND assignment.effective_to IS NULL AND unit.status='active'
         FOR UPDATE OF assignment`,
        [input.tenantId, input.userId],
      );
      if (current.rowCount) {
        await client.query("COMMIT");
        return minimalTeam(current.rows[0]);
      }
      const stale = await client.query(
        `SELECT * FROM default_spending_team_assignments
         WHERE tenant_id=$1 AND user_id=$2 AND effective_to IS NULL FOR UPDATE`,
        [input.tenantId, input.userId],
      );
      const fallback = await this.ensureFallback(client, input.tenantId, input.actorUserId);
      const requestedBoundary = new Date();
      const boundary = stale.rowCount
        ? await this.nextBoundary(client, stale.rows[0].effective_from, requestedBoundary)
        : requestedBoundary;
      if (stale.rowCount) {
        await client.query(
          `UPDATE default_spending_team_assignments
           SET effective_to=$3,ended_by=$4
           WHERE tenant_id=$1 AND user_id=$2 AND effective_to IS NULL`,
          [input.tenantId, input.userId, boundary, input.actorUserId],
        );
      }
      await this.ensureMembership(
        client,
        input.tenantId,
        fallback.id,
        input.userId,
        input.actorUserId,
        boundary,
      );
      await client.query(
        `INSERT INTO default_spending_team_assignments (
           id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), input.tenantId, fallback.id, input.userId, boundary, input.actorUserId],
      );
      await this.audit(
        client,
        input.tenantId,
        input.actorUserId,
        "default_spending_team.rollout_fallback_resolved",
        "default_spending_team",
        input.userId,
        { teamId: fallback.id },
      );
      await client.query("COMMIT");
      return minimalTeam(fallback);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAuditEvents(tenantId: string, limit = 100) {
    const result = await this.pool.query(
      `SELECT id,action,target_type,target_id,details,occurred_at
       FROM team_administrator_audit_events
       WHERE tenant_id=$1 ORDER BY occurred_at DESC LIMIT $2`,
      [tenantId, Math.max(1, Math.min(limit, 500))],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      targetType: String(row.target_type) as TeamAuditEvent["targetType"],
      targetId: String(row.target_id),
      details: row.details as Record<string, unknown>,
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
    }));
  }

  private async setDefaultWithClient(client: pg.PoolClient, input: {
    tenantId: string;
    teamId: string;
    userId: string;
    assignedBy: string;
    effectiveFrom?: Date;
  }) {
    this.assertNotFuture(input.effectiveFrom, "TEAM_DEFAULT_FUTURE_UNSUPPORTED");
    await this.assertActiveTeam(client, input.tenantId, input.teamId);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`team-default:${input.tenantId}:${input.userId}`],
    );
    const current = await client.query(
      `SELECT * FROM default_spending_team_assignments
       WHERE tenant_id=$1 AND user_id=$2 AND effective_to IS NULL FOR UPDATE`,
      [input.tenantId, input.userId],
    );
    if (current.rows[0]?.allocation_unit_id === input.teamId) {
      const team = await this.readMinimalTeam(client, input.tenantId, input.teamId);
      return minimalTeam(team);
    }
    const requested = input.effectiveFrom ?? new Date();
    const boundary = current.rowCount
      ? await this.nextBoundary(client, current.rows[0].effective_from, requested)
      : requested;
    await this.ensureMembership(
      client,
      input.tenantId,
      input.teamId,
      input.userId,
      input.assignedBy,
      boundary,
    );
    if (current.rowCount) {
      await client.query(
        `UPDATE default_spending_team_assignments
         SET effective_to=$2,ended_by=$3 WHERE id=$1`,
        [current.rows[0].id, boundary, input.assignedBy],
      );
    }
    await client.query(
      `INSERT INTO default_spending_team_assignments (
         id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), input.tenantId, input.teamId, input.userId, boundary, input.assignedBy],
    );
    await this.audit(
      client,
      input.tenantId,
      input.assignedBy,
      "default_spending_team.changed",
      "default_spending_team",
      input.userId,
      {
        fromTeamId: current.rows[0]?.allocation_unit_id ?? null,
        toTeamId: input.teamId,
      },
    );
    return minimalTeam(await this.readMinimalTeam(client, input.tenantId, input.teamId));
  }

  private async ensureFallback(client: pg.PoolClient, tenantId: string, actorUserId: string) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`team-rollout-fallback:${tenantId}`],
    );
    const existing = await client.query(
      `SELECT id,display_name,cost_center_code,is_rollout_fallback
       FROM allocation_units
       WHERE tenant_id=$1 AND allocation_type='team'
         AND is_rollout_fallback AND status='active'`,
      [tenantId],
    );
    if (existing.rowCount) return existing.rows[0];
    const id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO allocation_units (
         id,tenant_id,allocation_type,display_name,description,owner_user_id,
         status,is_rollout_fallback,created_by,updated_by
       ) VALUES ($1,$2,'team','Unallocated',
         'Rollout fallback for spend that has not been assigned to a Team.',
         $3,'active',true,$3,$3)
       RETURNING id,display_name,cost_center_code,is_rollout_fallback`,
      [id, tenantId, actorUserId],
    );
    await this.audit(client, tenantId, actorUserId, "team.rollout_fallback_created", "team", id, {
      systemOwned: true,
    });
    return inserted.rows[0];
  }

  private async ensureMembership(
    client: pg.PoolClient,
    tenantId: string,
    teamId: string,
    userId: string,
    assignedBy: string,
    effectiveFrom: Date,
  ) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`team-membership:${tenantId}:${teamId}:${userId}`],
    );
    const active = await client.query(
      `SELECT membership.*,
         EXISTS (
           SELECT 1 FROM default_spending_team_assignments default_team
           WHERE default_team.tenant_id=membership.tenant_id
             AND default_team.user_id=membership.user_id
             AND default_team.allocation_unit_id=membership.allocation_unit_id
             AND default_team.effective_to IS NULL
         ) AND membership.effective_to IS NULL AS is_default_spending_team
       FROM allocation_memberships membership
       WHERE membership.tenant_id=$1 AND membership.allocation_unit_id=$2
         AND membership.user_id=$3 AND membership.effective_to IS NULL
       FOR UPDATE`,
      [tenantId, teamId, userId],
    );
    if (active.rowCount) return mapMembership(active.rows[0]);
    const id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO allocation_memberships (
         id,tenant_id,allocation_unit_id,user_id,effective_from,assigned_by
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *,false AS is_default_spending_team`,
      [id, tenantId, teamId, userId, effectiveFrom, assignedBy],
    );
    return mapMembership(inserted.rows[0]);
  }

  private async assertTenantUser(
    client: pg.PoolClient,
    tenantId: string,
    userId: string,
    code: string,
  ) {
    const user = await client.query(
      "SELECT id FROM users WHERE tenant_id=$1 AND id=$2",
      [tenantId, userId],
    );
    if (!user.rowCount) throw new OneComputerError(code, "User not found in this tenant", 404);
  }

  private async assertActiveTenantUser(client: pg.PoolClient, tenantId: string, userId: string) {
    const user = await client.query(
      "SELECT status FROM users WHERE tenant_id=$1 AND id=$2",
      [tenantId, userId],
    );
    if (!user.rowCount) throw new OneComputerError("TEAM_MEMBER_NOT_FOUND", "User not found in this tenant", 404);
    if (user.rows[0].status !== "active") {
      throw new OneComputerError("TEAM_MEMBER_DISABLED", "A suspended user cannot receive a new Team assignment", 409);
    }
  }

  private async assertActiveTeam(client: pg.PoolClient, tenantId: string, teamId: string) {
    await this.lockTeam(client, tenantId, teamId, true);
  }

  private async lockTeam(client: pg.PoolClient, tenantId: string, teamId: string, requireActive: boolean) {
    const team = await client.query(
      `SELECT id,status FROM allocation_units
       WHERE tenant_id=$1 AND id=$2 AND allocation_type='team'
       FOR UPDATE`,
      [tenantId, teamId],
    );
    if (!team.rowCount || (requireActive && team.rows[0].status !== "active")) {
      throw new OneComputerError("TEAM_NOT_FOUND", requireActive ? "Active Team not found" : "Team not found", 404);
    }
  }

  private async readMinimalTeam(client: pg.PoolClient, tenantId: string, teamId: string) {
    const team = await client.query(
      `SELECT id,display_name,cost_center_code,is_rollout_fallback
       FROM allocation_units
       WHERE tenant_id=$1 AND id=$2 AND allocation_type='team'`,
      [tenantId, teamId],
    );
    if (!team.rowCount) throw new OneComputerError("TEAM_NOT_FOUND", "Team not found", 404);
    return team.rows[0];
  }

  private async readActiveMembership(client: pg.PoolClient, tenantId: string, teamId: string, userId: string) {
    const membership = await client.query(
      `SELECT membership.*,
         EXISTS (
           SELECT 1 FROM default_spending_team_assignments default_team
           WHERE default_team.tenant_id=membership.tenant_id
             AND default_team.user_id=membership.user_id
             AND default_team.allocation_unit_id=membership.allocation_unit_id
             AND default_team.effective_to IS NULL
         ) AS is_default_spending_team
       FROM allocation_memberships membership
       WHERE membership.tenant_id=$1 AND membership.allocation_unit_id=$2
         AND membership.user_id=$3 AND membership.effective_to IS NULL`,
      [tenantId, teamId, userId],
    );
    return membership.rowCount ? mapMembership(membership.rows[0]) : null;
  }

  private assertNotFuture(value: Date | undefined, code: string) {
    if (value && value.getTime() > Date.now()) {
      throw new OneComputerError(
        code,
        "Future Team membership transitions are not supported in this release",
        400,
      );
    }
  }

  private async nextBoundary(client: pg.PoolClient, previous: unknown, requested?: Date) {
    const result = await client.query<{ boundary: Date }>(
      `SELECT GREATEST(
         COALESCE($2::timestamptz,clock_timestamp()),
         $1::timestamptz + interval '1 microsecond'
       ) AS boundary`,
      [previous, requested ?? null],
    );
    return new Date(result.rows[0]!.boundary);
  }

  private async audit(
    client: pg.PoolClient,
    tenantId: string,
    actorUserId: string,
    action: string,
    targetType: TeamAuditEvent["targetType"],
    targetId: string,
    details: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO team_administrator_audit_events (
         id,tenant_id,actor_user_id,action,target_type,target_id,details
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [randomUUID(), tenantId, actorUserId, action, targetType, targetId, JSON.stringify(details)],
    );
  }
}
