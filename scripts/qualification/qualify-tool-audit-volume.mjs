#!/usr/bin/env node
import crypto from "node:crypto";
import pg from "pg";

const connectionString = process.env.WORKSPACE_SETTINGS_TEST_DATABASE_URL;
if (!connectionString) throw new Error("WORKSPACE_SETTINGS_TEST_DATABASE_URL is required");
const rows = Number(process.env.TOOL_AUDIT_VOLUME_ROWS ?? 5_000_000);
if (!Number.isSafeInteger(rows) || rows < 10_000 || rows > 10_000_000) {
  throw new Error("TOOL_AUDIT_VOLUME_ROWS must be between 10000 and 10000000");
}

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();
const suffix = crypto.randomUUID();
const tenantId = `tool-audit-volume-${suffix}`;
const subjectId = `volume-user-${suffix}`;
const workspaceId = crypto.randomUUID();
const agentInstanceId = crypto.randomUUID();
const policyHash = "a".repeat(64);
const startedAt = performance.now();
const queryPlan = async (sql, values) => {
  const result = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values);
  return result.rows[0]["QUERY PLAN"][0];
};

try {
  await client.query("BEGIN");
  await client.query("SET LOCAL synchronous_commit=off");
  await client.query(
    `INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Tool audit volume qualification')`,
    [tenantId, `external-${tenantId}`],
  );
  await client.query(
    `INSERT INTO users (id,tenant_id,email,display_name) VALUES ($1,$2,$3,'Volume User')`,
    [subjectId, tenantId, `${subjectId}@example.test`],
  );
  await client.query(
    `INSERT INTO workspaces (
       id,tenant_id,subject_id,grant_id,state,provider_id,failure_code,operation_token,
       access_generation,created_at,updated_at
     ) VALUES ($1,$2,$3,'volume','ready','volume-provider',NULL,NULL,1,'2026-08-01','2026-08-01')`,
    [workspaceId, tenantId, subjectId],
  );
  await client.query(
    `INSERT INTO agent_instances (
       id,tenant_id,owner_subject_id,workspace_id,agent_catalog_id,logical_agent_id,
       access_generation,provider_runtime_id,policy_version_id,policy_version,policy_hash,
       launch_idempotency_key,status,launch_requested_at,started_at,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,'claude-cli','volume-agent',1,'volume-runtime','policy-volume',1,$5,$6,
       'running','2026-08-01','2026-08-01','2026-08-01','2026-08-01')`,
    [agentInstanceId, tenantId, subjectId, workspaceId, policyHash, `volume-${suffix}`],
  );

  const keyStart = performance.now();
  await client.query(
    `INSERT INTO tool_audit_invocation_keys (
       tenant_id,source_system,source_invocation_id,invocation_id,semantic_hash,admitted_at
     ) SELECT $1,'workspace_broker','volume-'||n,md5(n::text)::uuid,md5(n::text)||md5((n+1)::text),
       '2026-08-01 00:00:00+00'::timestamptz
       + (((n-1)/500000)::text||' days')::interval
       + (((n-1)%500000) * interval '0.1728 seconds')
     FROM generate_series(1,$2) AS n`,
    [tenantId, rows],
  );
  const eventStart = performance.now();
  // The production path updates rollups transactionally one invocation at a
  // time (covered by the PostgreSQL feature test). This qualification bulk
  // loads the retained-history shape, then rebuilds the same aggregates in
  // one grouped pass so five million synthetic rows remain a bounded gate.
  await client.query("ALTER TABLE tool_audit_events DISABLE TRIGGER tool_audit_events_rollup");
  await client.query(
    `INSERT INTO tool_audit_events (
       tenant_id,invocation_id,subject_id,workspace_id,agent_id,agent_instance_id,
       context_kind,task_id,session_id,turn_id,source_system,source_invocation_id,
       correlation_id,connector_id,server_id,server_name,tool_name,policy_decision,
       policy_code,policy_version_id,policy_hash,governed_operation_id,target_type,
       target_summary,target_provenance,target_redacted,admitted_at,outcome,latency_ms,
       failure_class,completed_at
     ) SELECT $1,md5(n::text)::uuid,$2,$3,'volume-agent',$4,'workspace_native',NULL,NULL,NULL,
       'workspace_broker','volume-'||n,'volume-correlation-'||n,
       'connector-'||(n%4),'server-'||(n%4),'volume-server-'||(n%4),'tool-'||(n%20),'allow',
       'MCP_POLICY_ALLOWED','policy-volume',$5,NULL,'connector','Connector tool invocation',
       'generic_template',false,occurred_at,
       CASE WHEN n%100=0 THEN 'failed' WHEN n%250=0 THEN 'timed_out' ELSE 'succeeded' END,
       (n%5000)::integer,
       CASE WHEN n%100=0 THEN 'MCP_TOOL_RESULT_ERROR' WHEN n%250=0 THEN 'MCP_UPSTREAM_TIMEOUT' ELSE NULL END,
       occurred_at + ((n%5000)::text||' milliseconds')::interval
     FROM (
       SELECT n,'2026-08-01 00:00:00+00'::timestamptz
         + (((n-1)/500000)::text||' days')::interval
         + (((n-1)%500000) * interval '0.1728 seconds') AS occurred_at
       FROM generate_series(1,$6) AS n
     ) generated`,
    [tenantId, subjectId, workspaceId, agentInstanceId, policyHash, rows],
  );
  const terminalInsertFinished = performance.now();
  await client.query(
    `INSERT INTO tool_audit_hourly_rollups (
       tenant_id,period_start,connector_id,tool_name,policy_decision,outcome,
       invocation_count,total_latency_ms,max_latency_ms
     ) SELECT tenant_id,date_trunc('hour',completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
       connector_id,tool_name,policy_decision,outcome,count(*),sum(latency_ms),max(latency_ms)
     FROM tool_audit_events WHERE tenant_id=$1
     GROUP BY tenant_id,2,connector_id,tool_name,policy_decision,outcome`,
    [tenantId],
  );
  await client.query(
    `INSERT INTO tool_audit_daily_rollups (
       tenant_id,period_start,connector_id,tool_name,policy_decision,outcome,
       invocation_count,total_latency_ms,max_latency_ms
     ) SELECT tenant_id,(completed_at AT TIME ZONE 'UTC')::date,
       connector_id,tool_name,policy_decision,outcome,count(*),sum(latency_ms),max(latency_ms)
     FROM tool_audit_events WHERE tenant_id=$1
     GROUP BY tenant_id,2,connector_id,tool_name,policy_decision,outcome`,
    [tenantId],
  );
  await client.query("ALTER TABLE tool_audit_events ENABLE TRIGGER tool_audit_events_rollup");
  const insertFinished = performance.now();

  await client.query("ANALYZE tool_audit_events");
  await client.query("ANALYZE tool_audit_hourly_rollups");
  const pagePlan = await queryPlan(
    `SELECT * FROM tool_audit_events WHERE tenant_id=$1
     AND completed_at >= '2026-08-01' AND completed_at < '2026-08-11'
     ORDER BY completed_at DESC,invocation_id DESC LIMIT 50`,
    [tenantId],
  );
  const filteredPlan = await queryPlan(
    `SELECT * FROM tool_audit_events WHERE tenant_id=$1 AND connector_id='connector-1' AND tool_name='tool-1'
     AND completed_at >= '2026-08-01' AND completed_at < '2026-08-11'
     ORDER BY completed_at DESC,invocation_id DESC LIMIT 50`,
    [tenantId],
  );
  const rollupPlan = await queryPlan(
    `SELECT outcome,sum(invocation_count) FROM tool_audit_hourly_rollups
     WHERE tenant_id=$1 AND period_start >= '2026-08-01' AND period_start < '2026-08-11'
     GROUP BY outcome`,
    [tenantId],
  );
  const counts = await client.query(
    `SELECT
       (SELECT count(*)::integer FROM tool_audit_events WHERE tenant_id=$1) AS events,
       (SELECT count(*)::integer FROM tool_audit_events_default WHERE tenant_id=$1) AS default_events,
       (SELECT sum(invocation_count)::bigint FROM tool_audit_hourly_rollups WHERE tenant_id=$1) AS hourly_events,
       (SELECT sum(invocation_count)::bigint FROM tool_audit_daily_rollups WHERE tenant_id=$1) AS daily_events`,
    [tenantId],
  );
  const sizes = await client.query(
    `SELECT coalesce(sum(pg_total_relation_size(inhrelid)),0)::bigint AS partition_bytes
     FROM pg_inherits WHERE inhparent='tool_audit_events'::regclass`,
  );
  const result = {
    rows,
    elapsedMs: Math.round(performance.now() - startedAt),
    keyInsertMs: Math.round(eventStart - keyStart),
    terminalInsertMs: Math.round(terminalInsertFinished - eventStart),
    rollupBuildMs: Math.round(insertFinished - terminalInsertFinished),
    counts: counts.rows[0],
    partitionBytes: sizes.rows[0].partition_bytes,
    queryExecutionMs: {
      latestPage: pagePlan["Execution Time"],
      connectorToolPage: filteredPlan["Execution Time"],
      rollupSummary: rollupPlan["Execution Time"],
    },
    plans: {
      latestPage: pagePlan.Plan["Node Type"],
      connectorToolPage: filteredPlan.Plan["Node Type"],
      rollupSummary: rollupPlan.Plan["Node Type"],
    },
  };
  if (Number(result.counts.events) !== rows || Number(result.counts.hourly_events) !== rows || Number(result.counts.daily_events) !== rows) {
    throw new Error(`Tool audit qualification lost rows: ${JSON.stringify(result.counts)}`);
  }
  if (Number(result.counts.default_events) !== 0) throw new Error("Tool audit qualification used the default partition");
  if (Object.values(result.queryExecutionMs).some((value) => Number(value) > 2_000)) {
    throw new Error(`Tool audit qualification query exceeded 2000ms: ${JSON.stringify(result.queryExecutionMs)}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (process.env.TOOL_AUDIT_VOLUME_COMMIT === "1") await client.query("COMMIT");
  else await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
