import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import {
  approvalRequiredPlatformSupportScopes,
  hasRecentPlatformOperatorStepUp,
  LemmaComputerError,
  platformOperatorPrincipalSchema,
  platformRoleAllowsAction,
  platformRoleSchema,
  platformSupportElevationAllows,
  platformSupportElevationRequestSchema,
  platformSupportElevationSchema,
  type AuthenticationAssurance,
  type PlatformOperatorPrincipal,
  type PlatformRole,
  type PlatformSupportElevation,
  type PlatformSupportElevationRequest,
  type PlatformSupportScope,
} from "@lemmacomputer/contracts";
import { tenantKindSchema, type TenantKind } from "./identity-policy.js";

const platformBetterAuthIssuer = "urn:lemmacomputer:platform-better-auth";

export type PlatformOperatorSession = {
  principal: PlatformOperatorPrincipal;
  roles: PlatformRole[];
};

export type PlatformOperatorAuditEvent = {
  id: string;
  operatorId: string | null;
  targetOrganizationId: string | null;
  elevationId: string | null;
  eventType: string;
  correlationId: string;
  reviewRequired: boolean;
  details: Record<string, unknown>;
  occurredAt: string;
};

export type PlatformSecurityAlert = {
  id: string;
  operatorId: string;
  targetOrganizationId: string;
  elevationId: string;
  correlationId: string;
  alertType: "break-glass";
  payload: Record<string, unknown>;
  status: "pending" | "delivering" | "retry" | "delivered" | "escalated";
  attemptCount: number;
  maxAttempts: number;
  leaseGeneration: number;
  availableAt: string;
  claimedAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClaimedPlatformSecurityAlert = PlatformSecurityAlert & { leaseToken: string };

export type PlatformTenantCleanupJob = {
  id: string;
  tenantId: string;
  workspaceId: string;
  subjectId: string;
  accessGeneration: number;
  providerId: string | null;
  workspaceNodeId: string | null;
  action: "suspend" | "close";
  status: "pending" | "delivering" | "retry" | "completed" | "escalated";
  attemptCount: number;
  maxAttempts: number;
  leaseGeneration: number;
  controllerDestroyedAt: string | null;
  gatewayRevokedAt: string | null;
  storagePurgedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  availableAt: string;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClaimedPlatformTenantCleanupJob = PlatformTenantCleanupJob & { leaseToken: string };

export const workspaceNodeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/).max(64);
export const workspaceNodeStateSchema = z.enum(["active", "draining", "disabled"]);
export const workspaceNodeEndpointSchema = z.string().url().max(2048).refine((value) => {
  const endpoint = new URL(value);
  return endpoint.protocol === "https:"
    && endpoint.username === ""
    && endpoint.password === ""
    && endpoint.pathname === "/"
    && endpoint.search === ""
    && endpoint.hash === "";
}, "Workspace node endpoints must be credential-free HTTPS origins").transform((value) => new URL(value).origin);
export const workspaceNodeTlsServerNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}[A-Za-z0-9]$/).max(254);

export type WorkspaceNode = {
  id: string;
  endpointUrl: string;
  tlsServerName: string;
  state: z.infer<typeof workspaceNodeStateSchema>;
  reason: string;
  createdByOperatorId: string;
  updatedByOperatorId: string;
  createdAt: string;
  updatedAt: string;
};

export type TenantWorkspaceNodeAssignment = {
  tenantId: string;
  workspaceNodeId: string;
  reason: string;
  updatedByOperatorId: string;
  createdAt: string;
  updatedAt: string;
};

export type PlatformSupportElevationListItem = PlatformSupportElevation & {
  approvedAt: string | null;
  status: "pending" | "active" | "expired" | "revoked";
};

export type PlatformOperatorLoginAttempt = {
  verifierCiphertext: string;
  nonce: string;
  returnPath: string;
  expiresAt: Date;
  createdAt: Date;
  purpose: "login" | "step-up";
  operatorSessionId: string | null;
};

export type ResolvedWorkforceOperator = {
  operatorId: string;
  issuer: string;
  subject: string;
  roles: PlatformRole[];
};

export const platformTenantLifecycleStateSchema = z.enum(["active", "suspended", "offboarding", "closed"]);
export type PlatformTenantLifecycleState = z.infer<typeof platformTenantLifecycleStateSchema>;
export type PlatformTenantLifecycle = {
  id: string;
  displayName: string;
  tenantKind: TenantKind;
  workspaceNodeId: string | null;
  workspaceNodeState: WorkspaceNode["state"] | null;
  lifecycleState: PlatformTenantLifecycleState;
  reason: string | null;
  updatedByOperatorId: string | null;
  updatedAt: string | null;
};

export const platformIncidentSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export const platformIncidentStatusSchema = z.enum(["open", "monitoring", "resolved"]);
export type PlatformIncident = {
  id: string;
  title: string;
  summary: string;
  severity: z.infer<typeof platformIncidentSeveritySchema>;
  status: z.infer<typeof platformIncidentStatusSchema>;
  createdByOperatorId: string;
  updatedByOperatorId: string;
  createdAt: string;
  updatedAt: string;
};

export type PlatformConfigurationEntry = {
  key: string;
  value: unknown;
  reason: string;
  updatedByOperatorId: string;
  updatedAt: string;
};

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const mapElevation = (row: Record<string, unknown>): PlatformSupportElevation => platformSupportElevationSchema.parse({
  id: row.id,
  operatorId: row.operator_id,
  operatorSessionId: row.operator_session_id,
  targetOrganizationId: row.target_organization_id,
  reason: row.reason,
  scopes: row.scopes,
  kind: row.kind,
  approvalRequired: row.approval_required,
  approvedByOperatorId: row.approved_by_operator_id,
  createdAt: new Date(String(row.created_at)).toISOString(),
  expiresAt: new Date(String(row.expires_at)).toISOString(),
  revokedAt: row.revoked_at === null ? null : new Date(String(row.revoked_at)).toISOString(),
});

const mapElevationListItem = (row: Record<string, unknown>, now: Date): PlatformSupportElevationListItem => {
  const elevation = mapElevation(row);
  return {
    ...elevation,
    approvedAt: row.approved_at === null ? null : new Date(String(row.approved_at)).toISOString(),
    status: elevation.revokedAt !== null
      ? "revoked"
      : new Date(elevation.expiresAt) <= now
        ? "expired"
        : elevation.approvalRequired && elevation.approvedByOperatorId === null
          ? "pending"
          : "active",
  };
};

const mapAudit = (row: Record<string, unknown>): PlatformOperatorAuditEvent => ({
  id: String(row.id),
  operatorId: row.operator_id === null ? null : String(row.operator_id),
  targetOrganizationId: row.target_organization_id === null ? null : String(row.target_organization_id),
  elevationId: row.elevation_id === null ? null : String(row.elevation_id),
  eventType: String(row.event_type),
  correlationId: String(row.correlation_id),
  reviewRequired: Boolean(row.review_required),
  details: row.details as Record<string, unknown>,
  occurredAt: new Date(String(row.occurred_at)).toISOString(),
});

const mapSecurityAlert = (row: Record<string, unknown>): PlatformSecurityAlert => ({
  id: String(row.id),
  operatorId: String(row.operator_id),
  targetOrganizationId: String(row.target_organization_id),
  elevationId: String(row.elevation_id),
  correlationId: String(row.correlation_id),
  alertType: "break-glass",
  payload: row.payload as Record<string, unknown>,
  status: z.enum(["pending", "delivering", "retry", "delivered", "escalated"]).parse(row.status),
  attemptCount: Number(row.attempt_count),
  maxAttempts: Number(row.max_attempts),
  leaseGeneration: Number(row.lease_generation),
  availableAt: new Date(String(row.available_at)).toISOString(),
  claimedAt: row.claimed_at === null ? null : new Date(String(row.claimed_at)).toISOString(),
  deliveredAt: row.delivered_at === null ? null : new Date(String(row.delivered_at)).toISOString(),
  lastError: row.last_error === null ? null : String(row.last_error),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
});

const mapTenantCleanupJob = (row: Record<string, unknown>): PlatformTenantCleanupJob => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  workspaceId: String(row.workspace_id),
  subjectId: String(row.subject_id),
  accessGeneration: Number(row.access_generation),
  providerId: row.provider_id === null ? null : String(row.provider_id),
  workspaceNodeId: row.workspace_node_id == null ? null : String(row.workspace_node_id),
  action: z.enum(["suspend", "close"]).parse(row.action),
  status: z.enum(["pending", "delivering", "retry", "completed", "escalated"]).parse(row.status),
  attemptCount: Number(row.attempt_count),
  maxAttempts: Number(row.max_attempts),
  leaseGeneration: Number(row.lease_generation),
  controllerDestroyedAt: row.controller_destroyed_at === null ? null : new Date(String(row.controller_destroyed_at)).toISOString(),
  gatewayRevokedAt: row.gateway_revoked_at === null ? null : new Date(String(row.gateway_revoked_at)).toISOString(),
  storagePurgedAt: row.storage_purged_at === null ? null : new Date(String(row.storage_purged_at)).toISOString(),
  completedAt: row.completed_at === null ? null : new Date(String(row.completed_at)).toISOString(),
  lastError: row.last_error === null ? null : String(row.last_error),
  availableAt: new Date(String(row.available_at)).toISOString(),
  claimedAt: row.claimed_at === null ? null : new Date(String(row.claimed_at)).toISOString(),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
});

const mapWorkspaceNode = (row: Record<string, unknown>): WorkspaceNode => ({
  id: workspaceNodeIdSchema.parse(row.id),
  endpointUrl: String(row.endpoint_url),
  tlsServerName: String(row.tls_server_name),
  state: workspaceNodeStateSchema.parse(row.state),
  reason: String(row.reason),
  createdByOperatorId: String(row.created_by_operator_id),
  updatedByOperatorId: String(row.updated_by_operator_id),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
});

const mapTenantWorkspaceNodeAssignment = (row: Record<string, unknown>): TenantWorkspaceNodeAssignment => ({
  tenantId: String(row.tenant_id),
  workspaceNodeId: workspaceNodeIdSchema.parse(row.workspace_node_id),
  reason: String(row.reason),
  updatedByOperatorId: String(row.updated_by_operator_id),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
});

export class PostgresPlatformOperatorStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresPlatformOperatorStore(new pg.Pool({ connectionString, max: 5 }));
  }

  async close() {
    await this.pool.end();
  }

  async provisionOperator(input: {
    id?: string;
    issuer: string;
    subject: string;
    workforceTenantId: string;
    email: string;
    displayName: string;
    roles: PlatformRole[];
  }) {
    const roles = input.roles.map((role) => platformRoleSchema.parse(role));
    if (new Set(roles).size !== roles.length || roles.length === 0) {
      throw new LemmaComputerError("PLATFORM_OPERATOR_ROLES_INVALID", "At least one unique platform role is required", 400);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const previous = await client.query(
        `SELECT operator.id FROM platform_operators operator
         WHERE operator.workforce_issuer=$1 AND operator.workforce_subject=$2
         FOR UPDATE`,
        [input.issuer, input.subject],
      );
      const previousRoleRows = previous.rowCount
        ? await client.query("SELECT role FROM platform_operator_role_assignments WHERE operator_id=$1 ORDER BY role", [previous.rows[0].id])
        : { rows: [] };
      const operator = await client.query(
        `INSERT INTO platform_operators (
           id,workforce_issuer,workforce_subject,workforce_tenant_id,email,display_name
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workforce_issuer,workforce_subject) DO UPDATE SET
           workforce_tenant_id=EXCLUDED.workforce_tenant_id,
           email=EXCLUDED.email,
           display_name=EXCLUDED.display_name,
           updated_at=now()
         RETURNING id,workforce_issuer,workforce_subject,workforce_tenant_id,email,display_name,status`,
        [input.id ?? randomUUID(), input.issuer, input.subject, input.workforceTenantId, input.email, input.displayName],
      );
      const operatorId = String(operator.rows[0].id);
      await client.query("DELETE FROM platform_operator_role_assignments WHERE operator_id=$1", [operatorId]);
      for (const role of roles) await client.query(
        "INSERT INTO platform_operator_role_assignments (operator_id,role) VALUES ($1,$2)",
        [operatorId, role],
      );
      const previousRoles = previousRoleRows.rows.map((row) => String(row.role));
      const rolesChanged = previous.rowCount
        && (previousRoles.length !== roles.length || previousRoles.some((role, index) => role !== [...roles].sort()[index]));
      if (rolesChanged) {
        const changedAt = new Date();
        await client.query(
          "UPDATE platform_operator_sessions SET revoked_at=$2 WHERE operator_id=$1 AND revoked_at IS NULL",
          [operatorId, changedAt],
        );
        await client.query(
          "UPDATE platform_support_elevations SET revoked_at=$2 WHERE operator_id=$1 AND revoked_at IS NULL",
          [operatorId, changedAt],
        );
        await this.audit(client, {
          operatorId,
          eventType: "operator.access_changed",
          correlationId: `operator-access-change:${randomUUID()}`,
          occurredAt: changedAt,
          reviewRequired: true,
          details: { previousRoles, roles },
        });
      }
      await client.query("COMMIT");
      return {
        id: operatorId,
        issuer: String(operator.rows[0].workforce_issuer),
        subject: String(operator.rows[0].workforce_subject),
        workforceTenantId: String(operator.rows[0].workforce_tenant_id),
        email: String(operator.rows[0].email),
        displayName: String(operator.rows[0].display_name),
        status: String(operator.rows[0].status) as "active" | "disabled",
        roles,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createSession(input: {
    operatorId: string;
    tokenHash: string;
    assurance: AuthenticationAssurance;
    authenticatedAt: Date;
    recentStepUpAt: Date | null;
    expiresAt: Date;
    correlationId: string;
  }): Promise<PlatformOperatorSession> {
    const client = await this.pool.connect();
    const sessionId = randomUUID();
    try {
      await client.query("BEGIN");
      const operator = await this.lockActiveOperator(client, input.operatorId);
      await client.query(
        `INSERT INTO platform_operator_sessions (
           id,operator_id,token_hash,assurance_level,assurance_factors,
           authenticated_at,recent_step_up_at,expires_at,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6)`,
        [
          sessionId,
          input.operatorId,
          input.tokenHash,
          input.assurance.level,
          input.assurance.factors,
          input.authenticatedAt,
          input.recentStepUpAt,
          input.expiresAt,
        ],
      );
      await this.audit(client, {
        operatorId: input.operatorId,
        eventType: "operator.login",
        correlationId: input.correlationId,
        occurredAt: input.authenticatedAt,
        details: { assuranceLevel: input.assurance.level },
      });
      await client.query("COMMIT");
      return this.sessionFrom(operator, sessionId, input.assurance, input.authenticatedAt, input.recentStepUpAt);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createOperatorLoginAttempt(input: {
    stateHash: string;
    verifierCiphertext: string;
    nonce: string;
    returnPath: string;
    expiresAt: Date;
    createdAt: Date;
    purpose?: "login" | "step-up";
    operatorSessionId?: string | null;
  }) {
    await this.pool.query(
      `INSERT INTO platform_operator_oidc_attempts (
         state_hash,verifier_ciphertext,nonce,return_path,expires_at,created_at,purpose,operator_session_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.stateHash, input.verifierCiphertext, input.nonce, input.returnPath, input.expiresAt, input.createdAt, input.purpose ?? "login", input.operatorSessionId ?? null],
    );
  }

  async consumeOperatorLoginAttempt(stateHash: string, now: Date): Promise<PlatformOperatorLoginAttempt | null> {
    const result = await this.pool.query(
      `DELETE FROM platform_operator_oidc_attempts WHERE state_hash=$1
       RETURNING verifier_ciphertext,nonce,return_path,expires_at,created_at,purpose,operator_session_id`,
      [stateHash],
    );
    if (!result.rowCount || new Date(result.rows[0].expires_at) <= now) return null;
    return {
      verifierCiphertext: String(result.rows[0].verifier_ciphertext),
      nonce: String(result.rows[0].nonce),
      returnPath: String(result.rows[0].return_path),
      expiresAt: new Date(result.rows[0].expires_at),
      createdAt: new Date(result.rows[0].created_at),
      purpose: z.enum(["login", "step-up"]).parse(result.rows[0].purpose),
      operatorSessionId: result.rows[0].operator_session_id === null ? null : String(result.rows[0].operator_session_id),
    };
  }

  async resolveWorkforceOperator(input: {
    issuer: string;
    subject: string;
    workforceTenantId: string;
  }): Promise<ResolvedWorkforceOperator | null> {
    const result = await this.pool.query(
      `SELECT operator.id,operator.workforce_issuer,operator.workforce_subject,
         COALESCE(array_agg(role.role ORDER BY role.role) FILTER (WHERE role.role IS NOT NULL),'{}') AS roles
       FROM platform_operators operator
       LEFT JOIN platform_operator_role_assignments role ON role.operator_id=operator.id
       WHERE operator.workforce_issuer=$1 AND operator.workforce_subject=$2
         AND operator.workforce_tenant_id=$3 AND operator.status='active'
       GROUP BY operator.id`,
      [input.issuer, input.subject, input.workforceTenantId],
    );
    if (!result.rowCount) return null;
    return {
      operatorId: String(result.rows[0].id),
      issuer: String(result.rows[0].workforce_issuer),
      subject: String(result.rows[0].workforce_subject),
      roles: (result.rows[0].roles as unknown[]).map((role) => platformRoleSchema.parse(role)),
    };
  }

  async getSession(tokenHash: string, now = new Date()): Promise<PlatformOperatorSession | null> {
    const result = await this.pool.query(
      `${this.sessionSelect()}
       WHERE session.token_hash=$1 AND session.revoked_at IS NULL AND session.expires_at>$2
         AND operator.status='active'
       GROUP BY session.id,operator.id`,
      [tokenHash, now],
    );
    return result.rowCount ? this.mapSession(result.rows[0]) : null;
  }

  async revokeSession(session: PlatformOperatorSession, correlationId: string, now = new Date()) {
    const parsed = platformOperatorPrincipalSchema.parse(session.principal);
    const result = await this.pool.query(
      `UPDATE platform_operator_sessions SET revoked_at=$2
       WHERE id=$1 AND revoked_at IS NULL RETURNING id`,
      [parsed.operatorSessionId, now],
    );
    if (result.rowCount) await this.audit(this.pool, {
      operatorId: parsed.operatorId,
      eventType: "operator.logout",
      correlationId,
      occurredAt: now,
    });
    return Boolean(result.rowCount);
  }

  async markSessionStepUp(input: {
    operatorSessionId: string;
    operatorId: string;
    authenticatedAt: Date;
    authenticationContext: string;
    correlationId: string;
  }): Promise<PlatformOperatorSession | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE platform_operator_sessions session SET
           recent_step_up_at=$3,
           assurance_level='aal2'
         FROM platform_operators operator
         WHERE session.id=$1 AND session.operator_id=$2 AND operator.id=session.operator_id
           AND session.revoked_at IS NULL AND session.expires_at>$3 AND operator.status='active'
         RETURNING operator.*,session.id AS session_id,session.assurance_level,session.assurance_factors,
           session.authenticated_at,session.recent_step_up_at`,
        [input.operatorSessionId, input.operatorId, input.authenticatedAt],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const roles = await client.query("SELECT role FROM platform_operator_role_assignments WHERE operator_id=$1 ORDER BY role", [input.operatorId]);
      await this.audit(client, {
        operatorId: input.operatorId,
        eventType: "operator.step_up",
        correlationId: input.correlationId,
        occurredAt: input.authenticatedAt,
        details: {
          operatorSessionId: input.operatorSessionId,
          authenticationContext: input.authenticationContext,
          assuranceSource: "workforce-conditional-access",
        },
      });
      await client.query("COMMIT");
      return this.mapSession({ ...updated.rows[0], roles: roles.rows.map((row) => row.role) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listTenantLifecycle(session: PlatformOperatorSession): Promise<PlatformTenantLifecycle[]> {
    this.requireRoleAuthority(session, "tenant.lifecycle.read");
    const result = await this.pool.query(
      `SELECT tenant.id,tenant.display_name,tenant.kind AS tenant_kind,
         assignment.workspace_node_id,node.state AS workspace_node_state,
         COALESCE(lifecycle.lifecycle_state,'active') AS lifecycle_state,
         lifecycle.reason,lifecycle.updated_by_operator_id,lifecycle.updated_at
       FROM tenants tenant
       LEFT JOIN platform_tenant_lifecycle lifecycle ON lifecycle.tenant_id=tenant.id
       LEFT JOIN tenant_workspace_node_assignments assignment ON assignment.tenant_id=tenant.id
       LEFT JOIN workspace_nodes node ON node.id=assignment.workspace_node_id
       ORDER BY tenant.display_name,tenant.id`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      tenantKind: tenantKindSchema.parse(row.tenant_kind),
      workspaceNodeId: row.workspace_node_id === null ? null : workspaceNodeIdSchema.parse(row.workspace_node_id),
      workspaceNodeState: row.workspace_node_state === null ? null : workspaceNodeStateSchema.parse(row.workspace_node_state),
      lifecycleState: platformTenantLifecycleStateSchema.parse(row.lifecycle_state),
      reason: row.reason === null ? null : String(row.reason),
      updatedByOperatorId: row.updated_by_operator_id === null ? null : String(row.updated_by_operator_id),
      updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
    }));
  }

  async updateTenantLifecycle(session: PlatformOperatorSession, input: {
    tenantId: string;
    lifecycleState: PlatformTenantLifecycleState;
    reason: string;
    correlationId: string;
    now?: Date;
  }): Promise<PlatformTenantLifecycle> {
    const lifecycleState = platformTenantLifecycleStateSchema.parse(input.lifecycleState);
    const reason = z.string().trim().min(12).max(1000).parse(input.reason);
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const principal = (await this.requireCurrentSessionAuthority(client, session, "tenant.lifecycle.manage", now)).principal;
      const tenant = await client.query(
        `SELECT tenant.id,tenant.display_name,tenant.kind AS tenant_kind,
           assignment.workspace_node_id,node.state AS workspace_node_state
         FROM tenants tenant
         LEFT JOIN tenant_workspace_node_assignments assignment ON assignment.tenant_id=tenant.id
         LEFT JOIN workspace_nodes node ON node.id=assignment.workspace_node_id
         WHERE tenant.id=$1 FOR UPDATE OF tenant`,
        [input.tenantId],
      );
      if (!tenant.rowCount) throw new LemmaComputerError("PLATFORM_TENANT_NOT_FOUND", "Tenant was not found", 404);
      const currentLifecycle = await client.query(
        "SELECT lifecycle_state FROM platform_tenant_lifecycle WHERE tenant_id=$1 FOR UPDATE",
        [input.tenantId],
      );
      const previousLifecycleState = currentLifecycle.rowCount
        ? platformTenantLifecycleStateSchema.parse(currentLifecycle.rows[0].lifecycle_state)
        : "active";
      if (previousLifecycleState === "closed" && lifecycleState === "suspended") {
        throw new LemmaComputerError("PLATFORM_TENANT_LIFECYCLE_TRANSITION_INVALID", "A closed tenant cannot be downgraded to suspended", 409);
      }
      if (lifecycleState === "active") {
        const cleanup = await client.query(
          "SELECT 1 FROM platform_tenant_cleanup_jobs WHERE tenant_id=$1 AND status<>'completed' LIMIT 1",
          [input.tenantId],
        );
        if (cleanup.rowCount) {
          throw new LemmaComputerError("PLATFORM_TENANT_CLEANUP_PENDING", "Tenant cannot be reactivated until workspace cleanup completes", 409, true);
        }
      }
      const result = await client.query(
        `INSERT INTO platform_tenant_lifecycle (
           tenant_id,lifecycle_state,reason,updated_by_operator_id,updated_at
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id) DO UPDATE SET
           lifecycle_state=EXCLUDED.lifecycle_state,
           reason=EXCLUDED.reason,
           updated_by_operator_id=EXCLUDED.updated_by_operator_id,
           updated_at=EXCLUDED.updated_at
         RETURNING lifecycle_state,reason,updated_by_operator_id,updated_at`,
        [input.tenantId, lifecycleState, reason, principal.operatorId, now],
      );
      const deniesCustomerAccess = lifecycleState === "suspended" || lifecycleState === "closed";
      const startsCleanup = deniesCustomerAccess && previousLifecycleState !== "suspended" && previousLifecycleState !== "closed";
      const upgradesCleanup = lifecycleState === "closed" && previousLifecycleState === "suspended";
      await client.query(
        "UPDATE organizations SET status=$2,updated_at=$3 WHERE id=$1",
        [input.tenantId, deniesCustomerAccess ? lifecycleState : "active", now],
      );
      if (deniesCustomerAccess) {
        await client.query(
          `UPDATE browser_sessions session SET revoked_at=$2
           FROM organization_memberships membership
           WHERE session.membership_id=membership.id AND membership.organization_id=$1
             AND session.revoked_at IS NULL`,
          [input.tenantId, now],
        );
        if (startsCleanup || upgradesCleanup) {
          const workspaces = startsCleanup
            ? await client.query(
              `UPDATE workspaces SET state='stopping',failure_code=$2,operation_token=NULL,
                 access_generation=access_generation+1,updated_at=$3
               WHERE tenant_id=$1 AND ($4::boolean OR state<>'stopped' OR provider_id IS NOT NULL)
               RETURNING id,subject_id,provider_id,access_generation,workspace_node_id`,
              [input.tenantId, lifecycleState === "closed" ? "TENANT_CLOSED" : "TENANT_SUSPENDED", now, lifecycleState === "closed"],
            )
            : await client.query(
              `UPDATE workspaces SET state='stopping',failure_code='TENANT_CLOSED',operation_token=NULL,updated_at=$2
               WHERE tenant_id=$1 RETURNING id,subject_id,provider_id,access_generation,workspace_node_id`,
              [input.tenantId, now],
            );
          for (const workspace of workspaces.rows) {
            await client.query(
              `INSERT INTO platform_tenant_cleanup_jobs (
                 id,tenant_id,workspace_id,subject_id,access_generation,provider_id,workspace_node_id,action,
                 available_at,created_at,updated_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)
               ON CONFLICT (workspace_id,access_generation) DO UPDATE SET
                 provider_id=EXCLUDED.provider_id,
                 workspace_node_id=EXCLUDED.workspace_node_id,
                 action=EXCLUDED.action,
                 status='pending',
                 attempt_count=0,
                 lease_token=NULL,
                 claimed_at=NULL,
                 storage_purged_at=NULL,
                 completed_at=NULL,
                 last_error=NULL,
                 available_at=EXCLUDED.available_at,
                 updated_at=EXCLUDED.updated_at`,
              [randomUUID(), input.tenantId, workspace.id, workspace.subject_id, workspace.access_generation,
                workspace.provider_id, workspace.workspace_node_id, lifecycleState === "closed" ? "close" : "suspend", now],
            );
          }
        }
      }
      await this.audit(client, {
        operatorId: principal.operatorId,
        targetOrganizationId: input.tenantId,
        eventType: "tenant_lifecycle.updated",
        correlationId: input.correlationId,
        occurredAt: now,
        details: { lifecycleState, reason, cleanupQueued: startsCleanup || upgradesCleanup },
      });
      await client.query("COMMIT");
      return {
        id: String(tenant.rows[0].id),
        displayName: String(tenant.rows[0].display_name),
        tenantKind: tenantKindSchema.parse(tenant.rows[0].tenant_kind),
        workspaceNodeId: tenant.rows[0].workspace_node_id === null
          ? null
          : workspaceNodeIdSchema.parse(tenant.rows[0].workspace_node_id),
        workspaceNodeState: tenant.rows[0].workspace_node_state === null
          ? null
          : workspaceNodeStateSchema.parse(tenant.rows[0].workspace_node_state),
        lifecycleState: platformTenantLifecycleStateSchema.parse(result.rows[0].lifecycle_state),
        reason: String(result.rows[0].reason),
        updatedByOperatorId: String(result.rows[0].updated_by_operator_id),
        updatedAt: new Date(result.rows[0].updated_at).toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getServiceHealth(session: PlatformOperatorSession) {
    this.requireRoleAuthority(session, "service.health.read");
    const result = await this.pool.query(
      `SELECT now() AS checked_at,
         count(*) FILTER (WHERE status IN ('open','monitoring'))::int AS active_incidents,
         count(*) FILTER (WHERE severity='critical' AND status <> 'resolved')::int AS critical_incidents
       FROM platform_incidents`,
    );
    return {
      status: Number(result.rows[0].critical_incidents) > 0 ? "degraded" as const : "available" as const,
      activeIncidents: Number(result.rows[0].active_incidents),
      checkedAt: new Date(result.rows[0].checked_at).toISOString(),
    };
  }

  async listIncidents(session: PlatformOperatorSession): Promise<PlatformIncident[]> {
    this.requireRoleAuthority(session, "incident.read");
    const result = await this.pool.query("SELECT * FROM platform_incidents ORDER BY updated_at DESC,id DESC LIMIT 500");
    return result.rows.map((row) => this.mapIncident(row));
  }

  async createIncident(session: PlatformOperatorSession, input: {
    title: string;
    summary: string;
    severity: z.infer<typeof platformIncidentSeveritySchema>;
    correlationId: string;
    now?: Date;
  }): Promise<PlatformIncident> {
    const title = z.string().trim().min(4).max(200).parse(input.title);
    const summary = z.string().trim().min(12).max(4000).parse(input.summary);
    const severity = platformIncidentSeveritySchema.parse(input.severity);
    const now = input.now ?? new Date();
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const principal = (await this.requireCurrentSessionAuthority(client, session, "incident.manage", now)).principal;
      const result = await client.query(
        `INSERT INTO platform_incidents (
           id,title,summary,severity,status,created_by_operator_id,updated_by_operator_id,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,'open',$5,$5,$6,$6) RETURNING *`,
        [id, title, summary, severity, principal.operatorId, now],
      );
      await this.audit(client, {
        operatorId: principal.operatorId,
        eventType: "incident.created",
        correlationId: input.correlationId,
        occurredAt: now,
        details: { incidentId: id, severity },
      });
      await client.query("COMMIT");
      return this.mapIncident(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateIncident(session: PlatformOperatorSession, input: {
    incidentId: string;
    title?: string;
    summary?: string;
    severity?: z.infer<typeof platformIncidentSeveritySchema>;
    status?: z.infer<typeof platformIncidentStatusSchema>;
    correlationId: string;
    now?: Date;
  }): Promise<PlatformIncident> {
    if (input.title === undefined && input.summary === undefined && input.severity === undefined && input.status === undefined) {
      throw new LemmaComputerError("PLATFORM_INCIDENT_UPDATE_EMPTY", "At least one incident field is required", 400);
    }
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const principal = (await this.requireCurrentSessionAuthority(client, session, "incident.manage", now)).principal;
      const current = await client.query("SELECT * FROM platform_incidents WHERE id=$1 FOR UPDATE", [input.incidentId]);
      if (!current.rowCount) throw new LemmaComputerError("PLATFORM_INCIDENT_NOT_FOUND", "Incident was not found", 404);
      const row = current.rows[0];
      const title = input.title === undefined ? String(row.title) : z.string().trim().min(4).max(200).parse(input.title);
      const summary = input.summary === undefined ? String(row.summary) : z.string().trim().min(12).max(4000).parse(input.summary);
      const severity = input.severity === undefined ? platformIncidentSeveritySchema.parse(row.severity) : platformIncidentSeveritySchema.parse(input.severity);
      const status = input.status === undefined ? platformIncidentStatusSchema.parse(row.status) : platformIncidentStatusSchema.parse(input.status);
      const result = await client.query(
        `UPDATE platform_incidents SET title=$2,summary=$3,severity=$4,status=$5,
           updated_by_operator_id=$6,updated_at=$7 WHERE id=$1 RETURNING *`,
        [input.incidentId, title, summary, severity, status, principal.operatorId, now],
      );
      await this.audit(client, {
        operatorId: principal.operatorId,
        eventType: "incident.updated",
        correlationId: input.correlationId,
        occurredAt: now,
        details: { incidentId: input.incidentId, severity, status },
      });
      await client.query("COMMIT");
      return this.mapIncident(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listWorkspaceNodes(session: PlatformOperatorSession): Promise<WorkspaceNode[]> {
    this.requireRoleAuthority(session, "platform.config.read");
    const result = await this.pool.query("SELECT * FROM workspace_nodes ORDER BY id");
    return result.rows.map(mapWorkspaceNode);
  }

  async registerWorkspaceNode(session: PlatformOperatorSession, input: {
    id: string;
    endpointUrl: string;
    tlsServerName: string;
    reason: string;
    correlationId: string;
    now?: Date;
  }): Promise<WorkspaceNode> {
    const id = workspaceNodeIdSchema.parse(input.id);
    const endpointUrl = workspaceNodeEndpointSchema.parse(input.endpointUrl);
    const tlsServerName = workspaceNodeTlsServerNameSchema.parse(input.tlsServerName);
    const reason = z.string().trim().min(12).max(1000).parse(input.reason);
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const principal = (await this.requireCurrentSessionAuthority(client, session, "platform.config.manage", now)).principal;
      const result = await client.query(
        `INSERT INTO workspace_nodes (
           id,endpoint_url,tls_server_name,state,reason,created_by_operator_id,updated_by_operator_id,created_at,updated_at
         ) VALUES ($1,$2,$3,'active',$4,$5,$5,$6,$6)
         ON CONFLICT DO NOTHING RETURNING *`,
        [id, endpointUrl, tlsServerName, reason, principal.operatorId, now],
      );
      if (!result.rowCount) {
        throw new LemmaComputerError("WORKSPACE_NODE_ALREADY_EXISTS", "That workspace node id or endpoint is already registered", 409);
      }
      await this.audit(client, {
        operatorId: principal.operatorId,
        eventType: "workspace_node.registered",
        correlationId: input.correlationId,
        occurredAt: now,
        details: { workspaceNodeId: id, state: "active" },
      });
      await client.query("COMMIT");
      return mapWorkspaceNode(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateWorkspaceNodeState(session: PlatformOperatorSession, input: {
    workspaceNodeId: string;
    state: WorkspaceNode["state"];
    reason: string;
    correlationId: string;
    now?: Date;
  }): Promise<WorkspaceNode> {
    const workspaceNodeId = workspaceNodeIdSchema.parse(input.workspaceNodeId);
    const state = workspaceNodeStateSchema.parse(input.state);
    const reason = z.string().trim().min(12).max(1000).parse(input.reason);
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const principal = (await this.requireCurrentSessionAuthority(client, session, "platform.config.manage", now)).principal;
      const result = await client.query(
        `UPDATE workspace_nodes SET state=$2,reason=$3,updated_by_operator_id=$4,updated_at=$5
         WHERE id=$1 RETURNING *`,
        [workspaceNodeId, state, reason, principal.operatorId, now],
      );
      if (!result.rowCount) throw new LemmaComputerError("WORKSPACE_NODE_NOT_FOUND", "Workspace node was not found", 404);
      await this.audit(client, {
        operatorId: principal.operatorId,
        eventType: "workspace_node.state_updated",
        correlationId: input.correlationId,
        occurredAt: now,
        details: { workspaceNodeId, state },
      });
      await client.query("COMMIT");
      return mapWorkspaceNode(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listTenantWorkspaceNodeAssignments(session: PlatformOperatorSession): Promise<TenantWorkspaceNodeAssignment[]> {
    this.requireRoleAuthority(session, "platform.config.read");
    const result = await this.pool.query("SELECT * FROM tenant_workspace_node_assignments ORDER BY tenant_id");
    return result.rows.map(mapTenantWorkspaceNodeAssignment);
  }

  async assignTenantWorkspaceNode(session: PlatformOperatorSession, input: {
    tenantId: string;
    workspaceNodeId: string;
    reason: string;
    backfillUnplacedWorkspaces?: boolean;
    correlationId: string;
    now?: Date;
  }): Promise<{ assignment: TenantWorkspaceNodeAssignment; backfilledWorkspaces: number }> {
    const workspaceNodeId = workspaceNodeIdSchema.parse(input.workspaceNodeId);
    const reason = z.string().trim().min(12).max(1000).parse(input.reason);
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const principal = (await this.requireCurrentSessionAuthority(client, session, "platform.config.manage", now)).principal;
      const tenant = await client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [input.tenantId]);
      if (!tenant.rowCount) throw new LemmaComputerError("PLATFORM_TENANT_NOT_FOUND", "Tenant was not found", 404);
      const node = await client.query("SELECT id,state FROM workspace_nodes WHERE id=$1 FOR SHARE", [workspaceNodeId]);
      if (!node.rowCount) throw new LemmaComputerError("WORKSPACE_NODE_NOT_FOUND", "Workspace node was not found", 404);
      if (node.rows[0].state !== "active") {
        throw new LemmaComputerError("WORKSPACE_NODE_NOT_ACTIVE", "New workspace placement requires an active workspace node", 409);
      }
      const result = await client.query(
        `INSERT INTO tenant_workspace_node_assignments (
           tenant_id,workspace_node_id,reason,updated_by_operator_id,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT (tenant_id) DO UPDATE SET
           workspace_node_id=EXCLUDED.workspace_node_id,reason=EXCLUDED.reason,
           updated_by_operator_id=EXCLUDED.updated_by_operator_id,updated_at=EXCLUDED.updated_at
         RETURNING *`,
        [input.tenantId, workspaceNodeId, reason, principal.operatorId, now],
      );
      const backfilled = input.backfillUnplacedWorkspaces
        ? await client.query(
          `UPDATE workspaces SET workspace_node_id=$2,updated_at=$3
           WHERE tenant_id=$1 AND workspace_node_id IS NULL`,
          [input.tenantId, workspaceNodeId, now],
        )
        : { rowCount: 0 };
      await this.audit(client, {
        operatorId: principal.operatorId,
        targetOrganizationId: input.tenantId,
        eventType: "tenant.workspace_node_assigned",
        correlationId: input.correlationId,
        occurredAt: now,
        details: {
          workspaceNodeId,
          backfilledWorkspaces: backfilled.rowCount ?? 0,
          backfillRequested: input.backfillUnplacedWorkspaces === true,
        },
      });
      await client.query("COMMIT");
      return {
        assignment: mapTenantWorkspaceNodeAssignment(result.rows[0]),
        backfilledWorkspaces: backfilled.rowCount ?? 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveWorkspaceNode(workspaceId: string, expectedWorkspaceNodeId?: string): Promise<WorkspaceNode> {
    const expected = expectedWorkspaceNodeId === undefined ? undefined : workspaceNodeIdSchema.parse(expectedWorkspaceNodeId);
    const result = await this.pool.query(
      `SELECT workspace.workspace_node_id,node.*
       FROM workspaces workspace
       LEFT JOIN workspace_nodes node ON node.id=workspace.workspace_node_id
       WHERE workspace.id=$1`,
      [z.uuid().parse(workspaceId)],
    );
    if (!result.rowCount || result.rows[0].workspace_node_id === null) {
      throw new LemmaComputerError(
        "WORKSPACE_NODE_PLACEMENT_MISSING",
        "Workspace node placement is not configured",
        503,
        true,
      );
    }
    const node = mapWorkspaceNode(result.rows[0]);
    if (expected !== undefined && node.id !== expected) {
      throw new LemmaComputerError(
        "WORKSPACE_NODE_PLACEMENT_MISMATCH",
        "Workspace cleanup placement does not match the persisted workspace owner",
        409,
      );
    }
    if (node.state === "disabled") {
      throw new LemmaComputerError("WORKSPACE_NODE_DISABLED", "The workspace node is disabled", 503, true);
    }
    return node;
  }

  async listPlatformConfiguration(session: PlatformOperatorSession): Promise<PlatformConfigurationEntry[]> {
    this.requireRoleAuthority(session, "platform.config.read");
    const result = await this.pool.query("SELECT * FROM platform_configuration ORDER BY key");
    return result.rows.map((row) => ({
      key: String(row.key),
      value: row.value,
      reason: String(row.reason),
      updatedByOperatorId: String(row.updated_by_operator_id),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async setPlatformConfiguration(session: PlatformOperatorSession, input: {
    key: string;
    value: unknown;
    reason: string;
    correlationId: string;
    now?: Date;
  }): Promise<PlatformConfigurationEntry> {
    const key = z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/).max(200).parse(input.key);
    const value = z.json().parse(input.value);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 16_000) {
      throw new LemmaComputerError("PLATFORM_CONFIGURATION_TOO_LARGE", "Platform configuration value is too large", 400);
    }
    const reason = z.string().trim().min(12).max(1000).parse(input.reason);
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const principal = (await this.requireCurrentSessionAuthority(client, session, "platform.config.manage", now)).principal;
      const result = await client.query(
        `INSERT INTO platform_configuration (key,value,reason,updated_by_operator_id,updated_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,reason=EXCLUDED.reason,
           updated_by_operator_id=EXCLUDED.updated_by_operator_id,updated_at=EXCLUDED.updated_at
         RETURNING *`,
        [key, JSON.stringify(value), reason, principal.operatorId, now],
      );
      await this.audit(client, {
        operatorId: principal.operatorId,
        eventType: "platform_configuration.updated",
        correlationId: input.correlationId,
        occurredAt: now,
        details: { key },
      });
      await client.query("COMMIT");
      return {
        key: String(result.rows[0].key),
        value: result.rows[0].value,
        reason: String(result.rows[0].reason),
        updatedByOperatorId: String(result.rows[0].updated_by_operator_id),
        updatedAt: new Date(result.rows[0].updated_at).toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async requestElevation(
    session: PlatformOperatorSession,
    request: PlatformSupportElevationRequest,
    options: { approvalConfigured: boolean; correlationId: string; now?: Date },
  ): Promise<PlatformSupportElevation> {
    const input = platformSupportElevationRequestSchema.parse(request);
    const now = options.now ?? new Date();
    const approvalRequiredScopes = new Set<PlatformSupportScope>(approvalRequiredPlatformSupportScopes);
    const approvalRequired = options.approvalConfigured
      || input.scopes.some((scope) => approvalRequiredScopes.has(scope));
    const elevationId = randomUUID();
    const expiresAt = new Date(now.getTime() + input.durationMinutes * 60_000);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentSession = await this.requireCurrentSessionAuthority(client, session, "support.elevation.request", now);
      const principal = currentSession.principal;
      if (input.kind === "break-glass" && !currentSession.roles.includes("platform-administrator")) {
        throw new LemmaComputerError("PLATFORM_BREAK_GLASS_DENIED", "Break-glass requires platform administrator authority", 403);
      }
      const target = await client.query("SELECT 1 FROM tenants WHERE id=$1 FOR SHARE", [input.targetOrganizationId]);
      if (!target.rowCount) throw new LemmaComputerError("PLATFORM_TARGET_ORGANIZATION_NOT_FOUND", "Target organization was not found", 404);
      const result = await client.query(
        `INSERT INTO platform_support_elevations (
           id,operator_id,operator_session_id,target_organization_id,reason,scopes,
           kind,approval_required,created_at,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          elevationId,
          principal.operatorId,
          principal.operatorSessionId,
          input.targetOrganizationId,
          input.reason,
          input.scopes,
          input.kind,
          approvalRequired,
          now,
          expiresAt,
        ],
      );
      await this.audit(client, {
        operatorId: principal.operatorId,
        targetOrganizationId: input.targetOrganizationId,
        elevationId,
        eventType: "support_elevation.requested",
        correlationId: options.correlationId,
        occurredAt: now,
        details: { kind: input.kind, scopes: input.scopes, approvalRequired, expiresAt: expiresAt.toISOString() },
      });
      if (!approvalRequired) await this.audit(client, {
        operatorId: principal.operatorId,
        targetOrganizationId: input.targetOrganizationId,
        elevationId,
        eventType: "support_elevation.started",
        correlationId: options.correlationId,
        occurredAt: now,
        details: { kind: input.kind, scopes: input.scopes },
      });
      if (input.kind === "break-glass") await this.audit(client, {
        operatorId: principal.operatorId,
        targetOrganizationId: input.targetOrganizationId,
        elevationId,
        eventType: "break_glass.security_alert",
        correlationId: options.correlationId,
        occurredAt: now,
        reviewRequired: true,
        details: { scopes: input.scopes, expiresAt: expiresAt.toISOString() },
      });
      if (input.kind === "break-glass") await client.query(
        `INSERT INTO platform_security_alert_outbox (
           id,operator_id,target_organization_id,elevation_id,correlation_id,
           alert_type,payload,available_at,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,'break-glass',$6::jsonb,$7,$7,$7)`,
        [
          randomUUID(),
          principal.operatorId,
          input.targetOrganizationId,
          elevationId,
          options.correlationId,
          JSON.stringify({
            operatorId: principal.operatorId,
            targetOrganizationId: input.targetOrganizationId,
            elevationId,
            reason: input.reason,
            scopes: input.scopes,
            expiresAt: expiresAt.toISOString(),
          }),
          now,
        ],
      );
      await client.query("COMMIT");
      return mapElevation(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listElevations(
    session: PlatformOperatorSession,
    filter: { status?: PlatformSupportElevationListItem["status"] } = {},
    now = new Date(),
  ): Promise<PlatformSupportElevationListItem[]> {
    const principal = this.requireRoleAuthority(session, "support.elevation.read");
    const mayReviewAll = session.roles.some((role) => role === "platform-administrator" || role === "security-auditor");
    const result = await this.pool.query(
      `SELECT * FROM platform_support_elevations
       WHERE ($1::boolean OR operator_id=$2)
       ORDER BY created_at DESC,id DESC LIMIT 500`,
      [mayReviewAll, principal.operatorId],
    );
    const elevations = result.rows.map((row) => mapElevationListItem(row, now));
    return filter.status ? elevations.filter((elevation) => elevation.status === filter.status) : elevations;
  }

  async listSecurityAlerts(filter: { elevationId?: string; status?: PlatformSecurityAlert["status"] } = {}) {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter.elevationId) {
      values.push(filter.elevationId);
      conditions.push(`elevation_id=$${values.length}`);
    }
    if (filter.status) {
      values.push(filter.status);
      conditions.push(`status=$${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM platform_security_alert_outbox
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at,id`,
      values,
    );
    return result.rows.map(mapSecurityAlert);
  }

  async claimSecurityAlerts(input: { limit: number; now?: Date }): Promise<ClaimedPlatformSecurityAlert[]> {
    const limit = z.number().int().min(1).max(100).parse(input.limit);
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const exhausted = await client.query(
        `SELECT * FROM platform_security_alert_outbox
         WHERE status='delivering' AND attempt_count>=max_attempts
           AND claimed_at<=$1::timestamptz-interval '5 minutes'
         ORDER BY claimed_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      for (const row of exhausted.rows) {
        const alert = mapSecurityAlert(row);
        await client.query(
          `UPDATE platform_security_alert_outbox SET status='escalated',lease_token=NULL,
             last_error='Delivery lease expired after final attempt',updated_at=$2
           WHERE id=$1`,
          [alert.id, now],
        );
        await this.audit(client, {
          operatorId: alert.operatorId,
          targetOrganizationId: alert.targetOrganizationId,
          elevationId: alert.elevationId,
          eventType: "break_glass.alert_escalated",
          correlationId: `security-alert:${alert.id}:generation:${alert.leaseGeneration}:lease-expired`,
          occurredAt: now,
          reviewRequired: true,
          details: { alertId: alert.id, attemptCount: alert.attemptCount, reason: "final_delivery_lease_expired" },
        });
      }
      const candidates = await client.query(
        `SELECT id FROM platform_security_alert_outbox
         WHERE attempt_count<max_attempts AND (
           (status IN ('pending','retry') AND available_at<=$1)
           OR (status='delivering' AND claimed_at<=$1::timestamptz-interval '5 minutes')
         )
         ORDER BY available_at,created_at,id
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      const claimed: ClaimedPlatformSecurityAlert[] = [];
      for (const candidate of candidates.rows) {
        const leaseToken = randomUUID();
        const result = await client.query(
          `UPDATE platform_security_alert_outbox SET
             status='delivering',attempt_count=attempt_count+1,claimed_at=$2,
             lease_token=$3,lease_generation=lease_generation+1,updated_at=$2,last_error=NULL
           WHERE id=$1 RETURNING *`,
          [candidate.id, now, leaseToken],
        );
        claimed.push({ ...mapSecurityAlert(result.rows[0]), leaseToken });
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

  async completeSecurityAlert(alertId: string, leaseToken: string, deliveredAt = new Date()) {
    const parsedLeaseToken = z.uuid().parse(leaseToken);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE platform_security_alert_outbox SET
           status='delivered',delivered_at=$3,updated_at=$3,last_error=NULL,lease_token=NULL
         WHERE id=$1 AND status='delivering' AND lease_token=$2 RETURNING *`,
        [alertId, parsedLeaseToken, deliveredAt],
      );
      if (!updated.rowCount) throw new LemmaComputerError("PLATFORM_SECURITY_ALERT_LEASE_LOST", "Security alert delivery lease is no longer current", 409);
      const alert = mapSecurityAlert(updated.rows[0]);
      await this.audit(client, {
        operatorId: alert.operatorId,
        targetOrganizationId: alert.targetOrganizationId,
        elevationId: alert.elevationId,
        eventType: "break_glass.alert_delivered",
        correlationId: `security-alert:${alert.id}:attempt:${alert.attemptCount}:delivered`,
        occurredAt: deliveredAt,
        reviewRequired: true,
        details: { alertId: alert.id, attemptCount: alert.attemptCount },
      });
      await client.query("COMMIT");
      return alert;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failSecurityAlert(alertId: string, leaseToken: string, input: { error: string; failedAt?: Date; retryAt: Date }) {
    const parsedLeaseToken = z.uuid().parse(leaseToken);
    const error = z.string().trim().min(1).max(2000).parse(input.error);
    const failedAt = input.failedAt ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE platform_security_alert_outbox SET
           status=CASE WHEN attempt_count>=max_attempts THEN 'escalated' ELSE 'retry' END,
           available_at=CASE WHEN attempt_count>=max_attempts THEN available_at ELSE $5 END,
           last_error=$4,updated_at=$3,lease_token=NULL
         WHERE id=$1 AND status='delivering' AND lease_token=$2 RETURNING *`,
        [alertId, parsedLeaseToken, failedAt, error, input.retryAt],
      );
      if (!updated.rowCount) throw new LemmaComputerError("PLATFORM_SECURITY_ALERT_LEASE_LOST", "Security alert delivery lease is no longer current", 409);
      const alert = mapSecurityAlert(updated.rows[0]);
      await this.audit(client, {
        operatorId: alert.operatorId,
        targetOrganizationId: alert.targetOrganizationId,
        elevationId: alert.elevationId,
        eventType: alert.status === "escalated" ? "break_glass.alert_escalated" : "break_glass.alert_delivery_failed",
        correlationId: `security-alert:${alert.id}:attempt:${alert.attemptCount}:failed`,
        occurredAt: failedAt,
        reviewRequired: true,
        details: { alertId: alert.id, attemptCount: alert.attemptCount, nextStatus: alert.status, error },
      });
      await client.query("COMMIT");
      return alert;
    } catch (error_) {
      await client.query("ROLLBACK");
      throw error_;
    } finally {
      client.release();
    }
  }

  async listTenantCleanupJobs(filter: { status?: PlatformTenantCleanupJob["status"] } = {}) {
    const result = filter.status
      ? await this.pool.query("SELECT * FROM platform_tenant_cleanup_jobs WHERE status=$1 ORDER BY created_at,id", [filter.status])
      : await this.pool.query("SELECT * FROM platform_tenant_cleanup_jobs ORDER BY created_at,id");
    return result.rows.map(mapTenantCleanupJob);
  }

  async claimTenantCleanupJobs(input: { limit: number; now?: Date }): Promise<ClaimedPlatformTenantCleanupJob[]> {
    const limit = z.number().int().min(1).max(100).parse(input.limit);
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE platform_tenant_cleanup_jobs SET status='escalated',lease_token=NULL,
           last_error='Cleanup lease expired after final attempt',updated_at=$1
         WHERE id IN (
           SELECT id FROM platform_tenant_cleanup_jobs
           WHERE status='delivering' AND attempt_count>=max_attempts
             AND claimed_at<=$1::timestamptz-interval '5 minutes'
           ORDER BY claimed_at,id FOR UPDATE SKIP LOCKED LIMIT $2
         )`,
        [now, limit],
      );
      const candidates = await client.query(
        `SELECT id FROM platform_tenant_cleanup_jobs
         WHERE attempt_count<max_attempts AND (
           (status IN ('pending','retry') AND available_at<=$1)
           OR (status='delivering' AND claimed_at<=$1::timestamptz-interval '5 minutes')
         )
         ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      const claimed: ClaimedPlatformTenantCleanupJob[] = [];
      for (const candidate of candidates.rows) {
        const leaseToken = randomUUID();
        const result = await client.query(
          `UPDATE platform_tenant_cleanup_jobs SET status='delivering',attempt_count=attempt_count+1,
             claimed_at=$2,lease_token=$3,lease_generation=lease_generation+1,last_error=NULL,updated_at=$2
           WHERE id=$1 RETURNING *`,
          [candidate.id, now, leaseToken],
        );
        claimed.push({ ...mapTenantCleanupJob(result.rows[0]), leaseToken });
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

  async recordTenantCleanupProgress(
    jobId: string,
    leaseToken: string,
    stage: "controller" | "gateway" | "storage",
    completedAt = new Date(),
  ) {
    const column = stage === "controller" ? "controller_destroyed_at" : stage === "gateway" ? "gateway_revoked_at" : "storage_purged_at";
    const result = await this.pool.query(
      `UPDATE platform_tenant_cleanup_jobs SET ${column}=COALESCE(${column},$3),updated_at=$3
       WHERE id=$1 AND status='delivering' AND lease_token=$2 RETURNING *`,
      [jobId, z.uuid().parse(leaseToken), completedAt],
    );
    if (!result.rowCount) throw new LemmaComputerError("PLATFORM_TENANT_CLEANUP_LEASE_LOST", "Tenant cleanup lease is no longer current", 409);
    return mapTenantCleanupJob(result.rows[0]);
  }

  async renewTenantCleanupLease(jobId: string, leaseToken: string, accessGeneration: number, renewedAt = new Date()) {
    const result = await this.pool.query(
      `UPDATE platform_tenant_cleanup_jobs cleanup SET claimed_at=$4,updated_at=$4
       FROM workspaces workspace, platform_tenant_lifecycle lifecycle
       WHERE cleanup.id=$1 AND cleanup.status='delivering' AND cleanup.lease_token=$2
         AND cleanup.access_generation=$3
         AND workspace.id=cleanup.workspace_id AND workspace.access_generation=$3 AND workspace.state='stopping'
         AND lifecycle.tenant_id=cleanup.tenant_id
         AND ((cleanup.action='suspend' AND lifecycle.lifecycle_state='suspended')
           OR (cleanup.action='close' AND lifecycle.lifecycle_state='closed'))
       RETURNING cleanup.*`,
      [jobId, z.uuid().parse(leaseToken), z.number().int().positive().parse(accessGeneration), renewedAt],
    );
    if (!result.rowCount) throw new LemmaComputerError("PLATFORM_TENANT_CLEANUP_LEASE_LOST", "Tenant cleanup lease or access generation is no longer current", 409);
    return mapTenantCleanupJob(result.rows[0]);
  }

  async completeTenantCleanupJob(jobId: string, leaseToken: string, completedAt = new Date()) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT * FROM platform_tenant_cleanup_jobs WHERE id=$1 AND status='delivering' AND lease_token=$2 FOR UPDATE",
        [jobId, z.uuid().parse(leaseToken)],
      );
      if (!current.rowCount) throw new LemmaComputerError("PLATFORM_TENANT_CLEANUP_LEASE_LOST", "Tenant cleanup lease is no longer current", 409);
      const job = mapTenantCleanupJob(current.rows[0]);
      if (!job.controllerDestroyedAt || !job.gatewayRevokedAt || (job.action === "close" && !job.storagePurgedAt)) {
        throw new LemmaComputerError("PLATFORM_TENANT_CLEANUP_INCOMPLETE", "Tenant cleanup stages are incomplete", 409);
      }
      const workspace = await client.query(
        `UPDATE workspaces SET state='stopped',provider_id=NULL,operation_token=NULL,updated_at=$3
         WHERE id=$1 AND access_generation=$2 AND state='stopping' RETURNING id`,
        [job.workspaceId, job.accessGeneration, completedAt],
      );
      if (!workspace.rowCount) throw new LemmaComputerError("PLATFORM_TENANT_CLEANUP_GENERATION_LOST", "Workspace cleanup generation is no longer current", 409);
      const updated = await client.query(
        `UPDATE platform_tenant_cleanup_jobs SET status='completed',completed_at=$3,
           lease_token=NULL,last_error=NULL,updated_at=$3 WHERE id=$1 AND lease_token=$2 RETURNING *`,
        [jobId, leaseToken, completedAt],
      );
      await client.query("COMMIT");
      return mapTenantCleanupJob(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failTenantCleanupJob(jobId: string, leaseToken: string, input: { error: string; failedAt?: Date; retryAt: Date }) {
    const failedAt = input.failedAt ?? new Date();
    const result = await this.pool.query(
      `UPDATE platform_tenant_cleanup_jobs SET
         status=CASE WHEN attempt_count>=max_attempts THEN 'escalated' ELSE 'retry' END,
         available_at=CASE WHEN attempt_count>=max_attempts THEN available_at ELSE $5 END,
         last_error=$4,lease_token=NULL,updated_at=$3
       WHERE id=$1 AND status='delivering' AND lease_token=$2 RETURNING *`,
      [jobId, z.uuid().parse(leaseToken), failedAt, z.string().trim().min(1).max(2000).parse(input.error), input.retryAt],
    );
    if (!result.rowCount) throw new LemmaComputerError("PLATFORM_TENANT_CLEANUP_LEASE_LOST", "Tenant cleanup lease is no longer current", 409);
    return mapTenantCleanupJob(result.rows[0]);
  }

  async approveElevation(
    session: PlatformOperatorSession,
    elevationId: string,
    correlationId: string,
    now = new Date(),
  ): Promise<PlatformSupportElevation> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const principal = (await this.requireCurrentSessionAuthority(client, session, "support.elevation.approve", now)).principal;
      const current = await client.query("SELECT * FROM platform_support_elevations WHERE id=$1 FOR UPDATE", [elevationId]);
      if (!current.rowCount) throw new LemmaComputerError("PLATFORM_ELEVATION_NOT_FOUND", "Support elevation was not found", 404);
      const value = current.rows[0];
      if (String(value.operator_id) === principal.operatorId) {
        throw new LemmaComputerError("PLATFORM_ELEVATION_SELF_APPROVAL_DENIED", "Support elevation requires a different approver", 403);
      }
      if (!value.approval_required || value.approved_by_operator_id || value.revoked_at || new Date(value.expires_at) <= now) {
        throw new LemmaComputerError("PLATFORM_ELEVATION_NOT_APPROVABLE", "Support elevation cannot be approved", 409);
      }
      const updated = await client.query(
        `UPDATE platform_support_elevations
         SET approved_by_operator_id=$2,approved_at=$3 WHERE id=$1 RETURNING *`,
        [elevationId, principal.operatorId, now],
      );
      for (const eventType of ["support_elevation.approved", "support_elevation.started"] as const) await this.audit(client, {
        operatorId: principal.operatorId,
        targetOrganizationId: String(value.target_organization_id),
        elevationId,
        eventType,
        correlationId,
        occurredAt: now,
        details: { requestedByOperatorId: String(value.operator_id) },
      });
      await client.query("COMMIT");
      return mapElevation(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readTenantDiagnostics(
    session: PlatformOperatorSession,
    input: {
      elevationId: string;
      targetOrganizationId: string;
      correlationId: string;
      now?: Date;
    },
  ): Promise<{ tenantId: string; displayName: string; lifecycleState: PlatformTenantLifecycleState; activeUsers: number; workspaces: number } | null> {
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentSession = await this.requireCurrentSessionAuthority(client, session, "support.elevation.use", now);
      const target = await client.query(
        `SELECT tenant.id,tenant.display_name,COALESCE(lifecycle.lifecycle_state,'active') AS lifecycle_state,
           (SELECT count(*)::int FROM users WHERE tenant_id=tenant.id AND status='active') AS active_users,
           (SELECT count(*)::int FROM workspaces WHERE tenant_id=tenant.id) AS workspaces
         FROM tenants tenant
         LEFT JOIN platform_tenant_lifecycle lifecycle ON lifecycle.tenant_id=tenant.id
         WHERE tenant.id=$1 FOR SHARE OF tenant`,
        [input.targetOrganizationId],
      );
      if (!target.rowCount) {
        await this.audit(client, {
          operatorId: currentSession.principal.operatorId,
          targetOrganizationId: null,
          elevationId: null,
          eventType: "support_operation.denied",
          correlationId: input.correlationId,
          occurredAt: now,
          details: { operation: "tenant.diagnostics.read", attemptedTargetOrganizationId: input.targetOrganizationId, decision: "deny", reason: "target_not_found" },
        });
        await client.query("COMMIT");
        return null;
      }
      const result = await client.query("SELECT * FROM platform_support_elevations WHERE id=$1 FOR UPDATE", [input.elevationId]);
      const elevation = result.rowCount ? mapElevation(result.rows[0]) : null;
      const allowed = elevation !== null && platformSupportElevationAllows(elevation, {
        operatorId: currentSession.principal.operatorId,
        operatorSessionId: currentSession.principal.operatorSessionId,
        targetOrganizationId: input.targetOrganizationId,
        scope: "support.diagnostics.read",
      }, now);
      await this.audit(client, {
        operatorId: currentSession.principal.operatorId,
        targetOrganizationId: input.targetOrganizationId,
        elevationId: elevation?.id ?? null,
        eventType: allowed ? "support_operation.diagnostics_read" : "support_operation.denied",
        correlationId: input.correlationId,
        occurredAt: now,
        reviewRequired: allowed && elevation?.kind === "break-glass",
        details: { operation: "tenant.diagnostics.read", scope: "support.diagnostics.read", decision: allowed ? "allow" : "deny" },
      });
      if (allowed && elevation?.kind === "break-glass") await this.audit(client, {
        operatorId: currentSession.principal.operatorId,
        targetOrganizationId: input.targetOrganizationId,
        elevationId: elevation.id,
        eventType: "break_glass.review_required",
        correlationId: input.correlationId,
        occurredAt: now,
        reviewRequired: true,
        details: { operation: "tenant.diagnostics.read", scope: "support.diagnostics.read" },
      });
      await client.query("COMMIT");
      if (!allowed) return null;
      return {
        tenantId: String(target.rows[0].id),
        displayName: String(target.rows[0].display_name),
        lifecycleState: platformTenantLifecycleStateSchema.parse(target.rows[0].lifecycle_state),
        activeUsers: Number(target.rows[0].active_users),
        workspaces: Number(target.rows[0].workspaces),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeElevation(
    session: PlatformOperatorSession,
    elevationId: string,
    correlationId: string,
    now = new Date(),
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentSession = await this.requireCurrentSessionAuthority(client, session, "support.elevation.revoke", now);
      const principal = currentSession.principal;
      const current = await client.query("SELECT * FROM platform_support_elevations WHERE id=$1 FOR UPDATE", [elevationId]);
      if (!current.rowCount || current.rows[0].revoked_at !== null) {
        throw new LemmaComputerError("PLATFORM_ELEVATION_NOT_ACTIVE", "Support elevation is not active", 409);
      }
      const canRevokeAny = currentSession.roles.some((role) => role === "platform-administrator" || role === "security-auditor");
      if (!canRevokeAny && String(current.rows[0].operator_id) !== principal.operatorId) {
        throw new LemmaComputerError("PLATFORM_ELEVATION_REVOKE_DENIED", "Support operators may revoke only their own elevation", 403);
      }
      const updated = await client.query(
        `UPDATE platform_support_elevations
         SET revoked_at=$3,revoked_by_operator_id=$2
         WHERE id=$1 AND revoked_at IS NULL RETURNING *`,
        [elevationId, principal.operatorId, now],
      );
      if (!updated.rowCount) throw new LemmaComputerError("PLATFORM_ELEVATION_NOT_ACTIVE", "Support elevation is not active", 409);
      const elevation = mapElevation(updated.rows[0]);
      await this.audit(client, {
        operatorId: principal.operatorId,
        targetOrganizationId: elevation.targetOrganizationId,
        elevationId,
        eventType: "support_elevation.revoked",
        correlationId,
        occurredAt: now,
      });
      await client.query("COMMIT");
      return elevation;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAuditEvents(filter: { targetOrganizationId?: string; operatorId?: string } = {}) {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter.targetOrganizationId) {
      values.push(filter.targetOrganizationId);
      conditions.push(`target_organization_id=$${values.length}`);
    }
    if (filter.operatorId) {
      values.push(filter.operatorId);
      conditions.push(`operator_id=$${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM platform_operator_audit_events
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY occurred_at DESC,id DESC LIMIT 500`,
      values,
    );
    return result.rows.map(mapAudit);
  }

  private requireSessionAuthority(
    session: PlatformOperatorSession,
    action: Parameters<typeof platformRoleAllowsAction>[1],
    now = new Date(),
  ) {
    const principal = platformOperatorPrincipalSchema.safeParse(session.principal);
    if (!principal.success || !platformRoleAllowsAction(session.roles, action)) {
      throw new LemmaComputerError("PLATFORM_OPERATOR_FORBIDDEN", "Platform operator authority is required", 403);
    }
    if (!hasRecentPlatformOperatorStepUp(principal.data, now)) {
      throw new LemmaComputerError("PLATFORM_OPERATOR_STEP_UP_REQUIRED", "Recent workforce step-up is required", 403);
    }
    return principal.data;
  }

  private requireRoleAuthority(
    session: PlatformOperatorSession,
    action: Parameters<typeof platformRoleAllowsAction>[1],
  ) {
    const principal = platformOperatorPrincipalSchema.safeParse(session.principal);
    if (!principal.success || !platformRoleAllowsAction(session.roles, action)) {
      throw new LemmaComputerError("PLATFORM_OPERATOR_FORBIDDEN", "Platform operator authority is required", 403);
    }
    return principal.data;
  }

  private async requireCurrentSessionAuthority(
    client: pg.PoolClient,
    session: PlatformOperatorSession,
    action: Parameters<typeof platformRoleAllowsAction>[1],
    now: Date,
  ) {
    const claimed = platformOperatorPrincipalSchema.safeParse(session.principal);
    if (!claimed.success) throw new LemmaComputerError("PLATFORM_OPERATOR_FORBIDDEN", "Platform operator authority is required", 403);
    const result = await client.query(
      `SELECT operator.id,operator.workforce_issuer,operator.workforce_subject,
         session.id AS session_id,session.assurance_level,session.assurance_factors,
         session.authenticated_at,session.recent_step_up_at
       FROM platform_operator_sessions session
       JOIN platform_operators operator ON operator.id=session.operator_id
       WHERE session.id=$1 AND operator.id=$2 AND session.revoked_at IS NULL
         AND session.expires_at>$3 AND operator.status='active'
       FOR UPDATE OF session,operator`,
      [claimed.data.operatorSessionId, claimed.data.operatorId, now],
    );
    if (!result.rowCount) throw new LemmaComputerError("PLATFORM_OPERATOR_FORBIDDEN", "Platform operator authority is required", 403);
    const roleRows = await client.query(
      "SELECT role FROM platform_operator_role_assignments WHERE operator_id=$1 ORDER BY role",
      [claimed.data.operatorId],
    );
    const current = this.mapSession({ ...result.rows[0], roles: roleRows.rows.map((row) => row.role) });
    if (!platformRoleAllowsAction(current.roles, action) || !hasRecentPlatformOperatorStepUp(current.principal, now)) {
      throw new LemmaComputerError("PLATFORM_OPERATOR_FORBIDDEN", "Current platform operator authority and recent step-up are required", 403);
    }
    return current;
  }

  private mapIncident(row: Record<string, unknown>): PlatformIncident {
    return {
      id: String(row.id),
      title: String(row.title),
      summary: String(row.summary),
      severity: platformIncidentSeveritySchema.parse(row.severity),
      status: platformIncidentStatusSchema.parse(row.status),
      createdByOperatorId: String(row.created_by_operator_id),
      updatedByOperatorId: String(row.updated_by_operator_id),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }

  private async lockActiveOperator(client: pg.PoolClient, operatorId: string) {
    const result = await client.query(
      `SELECT operator.* FROM platform_operators operator
       WHERE operator.id=$1 AND operator.status='active' FOR UPDATE`,
      [operatorId],
    );
    if (!result.rowCount) throw new LemmaComputerError("PLATFORM_OPERATOR_NOT_ACTIVE", "Platform operator is not active", 403);
    const roles = await client.query(
      "SELECT role FROM platform_operator_role_assignments WHERE operator_id=$1 ORDER BY role",
      [operatorId],
    );
    return { ...result.rows[0], roles: roles.rows.map((row) => row.role) };
  }

  private sessionFrom(
    operator: Record<string, unknown>,
    sessionId: string,
    assurance: AuthenticationAssurance,
    authenticatedAt: Date,
    recentStepUpAt: Date | null,
  ): PlatformOperatorSession {
    return {
      principal: platformOperatorPrincipalSchema.parse({
        realm: "platform-operator",
        operatorSessionId: sessionId,
        operatorId: operator.id,
        identity: {
          provider: operator.workforce_issuer === platformBetterAuthIssuer ? "better-auth" : "workforce-entra",
          issuer: operator.workforce_issuer,
          subject: operator.workforce_subject,
        },
        assurance,
        authenticatedAt: authenticatedAt.toISOString(),
        recentStepUpAt: recentStepUpAt?.toISOString() ?? null,
      }),
      roles: (operator.roles as unknown[]).map((role) => platformRoleSchema.parse(role)),
    };
  }

  private mapSession(row: Record<string, unknown>): PlatformOperatorSession {
    return this.sessionFrom(
      row,
      String(row.session_id),
      {
        level: String(row.assurance_level) as AuthenticationAssurance["level"],
        factors: row.assurance_factors as AuthenticationAssurance["factors"],
      },
      new Date(String(row.authenticated_at)),
      row.recent_step_up_at === null ? null : new Date(String(row.recent_step_up_at)),
    );
  }

  private sessionSelect() {
    return `SELECT
      operator.id,operator.workforce_issuer,operator.workforce_subject,
      session.id AS session_id,session.assurance_level,session.assurance_factors,
      session.authenticated_at,session.recent_step_up_at,
      COALESCE(array_agg(role.role ORDER BY role.role) FILTER (WHERE role.role IS NOT NULL),'{}') AS roles
    FROM platform_operator_sessions session
    JOIN platform_operators operator ON operator.id=session.operator_id
    LEFT JOIN platform_operator_role_assignments role ON role.operator_id=operator.id`;
  }

  private async audit(query: Queryable, input: {
    operatorId?: string | null;
    targetOrganizationId?: string | null;
    elevationId?: string | null;
    eventType: string;
    correlationId: string;
    reviewRequired?: boolean;
    details?: Record<string, unknown>;
    occurredAt: Date;
  }) {
    await query.query(
      `INSERT INTO platform_operator_audit_events (
         id,operator_id,target_organization_id,elevation_id,event_type,
         correlation_id,review_required,details,occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        input.operatorId ?? null,
        input.targetOrganizationId ?? null,
        input.elevationId ?? null,
        input.eventType,
        input.correlationId,
        input.reviewRequired ?? false,
        JSON.stringify(input.details ?? {}),
        input.occurredAt,
      ],
    );
  }
}
