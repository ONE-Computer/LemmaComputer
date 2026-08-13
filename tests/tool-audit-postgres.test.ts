import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { LemmaComputerError, type ToolAuditAdmissionInput } from "@lemmacomputer/contracts";
import { PostgresToolAuditStore, PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.WORKSPACE_SETTINGS_TEST_DATABASE_URL;

test("PostgreSQL tool audit persists one partitioned terminal, rolls up, redacts, and isolates tenants", {
  skip: !connectionString,
}, async () => {
  const migrationStore = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const now = new Date("2026-08-13T02:00:00.000Z");
  const store = new PostgresToolAuditStore(new pg.Pool({ connectionString }), () => now);
  const pool = new pg.Pool({ connectionString });
  const suffix = crypto.randomUUID();
  const tenantId = `tool-audit-${suffix}`;
  const outsiderTenantId = `tool-audit-outsider-${suffix}`;
  const subjectId = `tool-audit-user-${suffix}`;
  const workspaceId = crypto.randomUUID();
  const agentInstanceId = crypto.randomUUID();
  const sourceInvocationId = crypto.randomUUID();
  const policyHash = "a".repeat(64);

  const admission: ToolAuditAdmissionInput = {
    tenantId,
    subjectId,
    workspaceId,
    agentId: `logical-agent:${suffix}`,
    agentInstanceId,
    context: { kind: "chat", taskId: null, sessionId: "session-1", turnId: "turn-1" },
    sourceSystem: "workspace_broker",
    sourceInvocationId,
    correlationId: "request-1",
    connectorId: "microsoft-365",
    serverId: "microsoft-365-server",
    serverName: "lemmacomputer_ms365",
    toolName: "get-mail-message",
    policyDecision: "allow",
    policyCode: "MCP_POLICY_ALLOWED",
    policyVersionId: "policy-v1",
    policyHash,
    governedOperationId: null,
    target: {
      provenance: "managed_schema",
      targetType: "message",
      target: "https://graph.example/messages/secret?token=sk-test-secret-value",
    },
  };

  try {
    await migrationStore.migrate();
    await store.ensureMonthlyPartitions(new Date("2026-08-13T00:00:00.000Z"), 3);
    assert.equal((await pool.query("SELECT to_regclass('tool_audit_events_2026_11') AS partition")).rows[0].partition, "tool_audit_events_2026_11");
    await pool.query(
      `INSERT INTO tenants (id,external_tenant_id,display_name)
       VALUES ($1,$2,'Tool audit tenant'),($3,$4,'Tool audit outsider')`,
      [tenantId, `external-${tenantId}`, outsiderTenantId, `external-${outsiderTenantId}`],
    );
    await pool.query(
      `INSERT INTO users (id,tenant_id,email,display_name)
       VALUES ($1,$2,$3,'Tool audit user')`,
      [subjectId, tenantId, `${subjectId}@example.test`],
    );
    await pool.query(
      `INSERT INTO workspaces (
         id,tenant_id,subject_id,grant_id,state,provider_id,failure_code,operation_token,
         access_generation,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,'ready','provider-tool-audit',NULL,NULL,1,$5,$5)`,
      [workspaceId, tenantId, subjectId, `grant-${suffix}`, now],
    );
    await pool.query(
      `INSERT INTO agent_instances (
         id,tenant_id,owner_subject_id,workspace_id,agent_catalog_id,logical_agent_id,
         access_generation,provider_runtime_id,policy_version_id,policy_version,policy_hash,
         launch_idempotency_key,status,launch_requested_at,started_at,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,'claude-cli',$5,1,'runtime-tool-audit','policy-v1',1,$6,$7,'running',$8,$8,$8,$8)`,
      [agentInstanceId, tenantId, subjectId, workspaceId, admission.agentId, policyHash, `launch-${suffix}`, now],
    );

    const created = await store.admit(admission);
    assert.equal(created.status, "created");
    assert.equal(created.terminal, null);
    assert.equal(created.admission.targetSummary.text, "Message: https://graph.example");
    assert.equal(created.admission.targetSummary.redacted, true);

    const replay = await store.admit(admission);
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.admission.invocationId, created.admission.invocationId);
    await assert.rejects(
      store.admit({ ...admission, toolName: "list-mail-messages" }),
      (error) => error instanceof LemmaComputerError && error.code === "TOOL_AUDIT_IDEMPOTENCY_CONFLICT",
    );

    const scope = { tenantId, subjectId, workspaceId, agentInstanceId };
    const terminal = await store.finalizeBySource({
      ...scope,
      sourceSystem: "workspace_broker",
      sourceInvocationId,
      outcome: "succeeded",
      latencyMs: 125,
      failureClass: null,
    });
    assert.equal(terminal.status, "created");
    assert.equal(terminal.record.outcome, "succeeded");
    assert.equal(await store.getPending(tenantId, terminal.record.invocationId), null);
    assert.equal((await store.getTerminal(tenantId, terminal.record.invocationId))?.latencyMs, 125);
    assert.equal(await store.getTerminal(outsiderTenantId, terminal.record.invocationId), null);

    const page = await store.queryTerminal({
      tenantId,
      from: "2026-08-13T00:00:00.000Z",
      to: "2026-08-14T00:00:00.000Z",
      subjectId,
      workspaceId,
      agentInstanceId,
      connectorId: "microsoft-365",
      toolName: "get-mail-message",
      policyDecision: "allow",
      outcome: "succeeded",
      pageSize: 1,
      asOf: now,
      after: null,
    });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.invocationId, terminal.record.invocationId);
    assert.equal(page.total, 1);
    assert.deepEqual(page.summary, [{ outcome: "succeeded", count: 1 }]);
    assert.equal(page.detailState, "complete");
    assert.equal(page.retainedDetailFrom?.toISOString(), now.toISOString());
    const outsiderPage = await store.queryTerminal({
      tenantId: outsiderTenantId,
      from: "2026-08-13T00:00:00.000Z",
      to: "2026-08-14T00:00:00.000Z",
      subjectId: null,
      workspaceId: null,
      agentInstanceId: null,
      connectorId: null,
      toolName: null,
      policyDecision: null,
      outcome: null,
      pageSize: 50,
      asOf: now,
      after: null,
    });
    assert.equal(outsiderPage.events.length, 0);
    assert.equal(outsiderPage.total, 0);

    const terminalReplay = await store.finalizeBySource({
      ...scope,
      sourceSystem: "workspace_broker",
      sourceInvocationId,
      outcome: "succeeded",
      latencyMs: 125,
      failureClass: null,
    });
    assert.equal(terminalReplay.status, "duplicate");
    await assert.rejects(
      store.finalizeBySource({
        ...scope,
        sourceSystem: "workspace_broker",
        sourceInvocationId,
        outcome: "failed",
        latencyMs: 125,
        failureClass: "PROVIDER_FAILED",
      }),
      (error) => error instanceof LemmaComputerError && error.code === "TOOL_AUDIT_TERMINAL_CONFLICT",
    );
    await assert.rejects(
      store.finalizeBySource({
        ...scope,
        tenantId: outsiderTenantId,
        sourceSystem: "workspace_broker",
        sourceInvocationId,
        outcome: "succeeded",
        latencyMs: 125,
        failureClass: null,
      }),
      (error) => error instanceof LemmaComputerError && error.code === "TOOL_AUDIT_INVOCATION_NOT_FOUND",
    );

    const denied = await store.admit({
      ...admission,
      sourceInvocationId: crypto.randomUUID(),
      policyDecision: "deny",
      policyCode: "MCP_TOOL_BLOCKED_BY_POLICY",
    });
    assert.equal(denied.terminal?.outcome, "denied");

    const stale = await store.admit({
      ...admission,
      sourceInvocationId: crypto.randomUUID(),
      correlationId: "request-stale",
    });
    await pool.query(
      `UPDATE tool_audit_pending_admissions SET admitted_at=$3
       WHERE tenant_id=$1 AND invocation_id=$2`,
      [tenantId, stale.admission.invocationId, new Date("2026-08-13T01:00:00.000Z")],
    );
    assert.equal(await store.reconcileUnconfirmed(new Date("2026-08-13T01:30:00.000Z"), now), 1);
    assert.equal((await store.getTerminal(tenantId, stale.admission.invocationId))?.outcome, "unconfirmed");

    const evidence = await pool.query(
      `SELECT tableoid::regclass::text AS partition,target_summary,
         (SELECT sum(invocation_count)::integer FROM tool_audit_hourly_rollups WHERE tenant_id=$1) AS hourly_count,
         (SELECT sum(invocation_count)::integer FROM tool_audit_daily_rollups WHERE tenant_id=$1) AS daily_count
       FROM tool_audit_events WHERE tenant_id=$1 AND invocation_id=$2`,
      [tenantId, terminal.record.invocationId],
    );
    assert.equal(evidence.rows[0].partition, "tool_audit_events_2026_08");
    assert.equal(evidence.rows[0].target_summary, "Message: https://graph.example");
    assert.equal(evidence.rows[0].hourly_count, 3);
    assert.equal(evidence.rows[0].daily_count, 3);
    assert.doesNotMatch(JSON.stringify(evidence.rows), /secret-value|sk-test/u);
    await assert.rejects(
      pool.query(
        `UPDATE tool_audit_events SET target_summary='tampered'
         WHERE tenant_id=$1 AND invocation_id=$2`,
        [tenantId, terminal.record.invocationId],
      ),
      /append-only/,
    );
  } finally {
    await Promise.all([store.close(), migrationStore.close(), pool.end()]);
  }
});
