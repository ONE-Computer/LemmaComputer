-- id: 01KZWFJ3NEHVJN5T1FBZTEC52Q
-- depends-on: 01KZW759V3DGWYT2WD89S4BM54

CREATE TABLE tool_audit_invocation_keys (
  tenant_id text NOT NULL REFERENCES tenants(id),
  source_system text NOT NULL CHECK (source_system IN ('litellm_mcp','governed_operation','workspace_broker')),
  source_invocation_id text NOT NULL CHECK (length(source_invocation_id) BETWEEN 1 AND 200),
  invocation_id uuid NOT NULL,
  semantic_hash text NOT NULL CHECK (semantic_hash ~ '^[a-f0-9]{64}$'),
  admitted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,source_system,source_invocation_id),
  UNIQUE (tenant_id,invocation_id)
);

-- Pending admissions are operational state, not compliance history. They are
-- removed only after the transaction that inserts the terminal event commits.
CREATE TABLE tool_audit_pending_admissions (
  tenant_id text NOT NULL,
  invocation_id uuid NOT NULL,
  subject_id text NOT NULL,
  workspace_id uuid NOT NULL,
  agent_id text NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  agent_instance_id uuid NOT NULL,
  context_kind text NOT NULL CHECK (context_kind IN ('chat','channel','schedule','background','interactive','workspace_native')),
  task_id text CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 200),
  session_id text CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 200),
  turn_id text CHECK (turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 200),
  source_system text NOT NULL CHECK (source_system IN ('litellm_mcp','governed_operation','workspace_broker')),
  source_invocation_id text NOT NULL CHECK (length(source_invocation_id) BETWEEN 1 AND 200),
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
  connector_id text NOT NULL CHECK (length(connector_id) BETWEEN 1 AND 128),
  server_id text NOT NULL CHECK (length(server_id) BETWEEN 1 AND 128),
  server_name text NOT NULL CHECK (length(server_name) BETWEEN 1 AND 128),
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
  policy_decision text NOT NULL CHECK (policy_decision IN ('allow','deny','approval_required')),
  policy_code text NOT NULL CHECK (policy_code ~ '^[A-Z0-9][A-Z0-9_:-]{0,127}$'),
  policy_version_id text CHECK (policy_version_id IS NULL OR length(policy_version_id) BETWEEN 1 AND 128),
  policy_hash text CHECK (policy_hash IS NULL OR policy_hash ~ '^[a-f0-9]{64}$'),
  governed_operation_id uuid,
  target_type text NOT NULL CHECK (target_type IN ('recipient','chat','channel','file','folder','event','message','item','destination','connector')),
  target_summary text NOT NULL CHECK (length(target_summary) BETWEEN 1 AND 200),
  target_provenance text NOT NULL CHECK (target_provenance IN ('managed_schema','generic_template')),
  target_redacted boolean NOT NULL,
  admitted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,invocation_id),
  FOREIGN KEY (tenant_id,invocation_id) REFERENCES tool_audit_invocation_keys(tenant_id,invocation_id),
  FOREIGN KEY (tenant_id,subject_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,agent_instance_id) REFERENCES agent_instances(tenant_id,id),
  CHECK (policy_decision <> 'approval_required' OR governed_operation_id IS NOT NULL)
);

CREATE INDEX tool_audit_pending_reconciliation_idx
  ON tool_audit_pending_admissions (admitted_at,tenant_id,invocation_id);

CREATE TABLE tool_audit_events (
  tenant_id text NOT NULL,
  invocation_id uuid NOT NULL,
  subject_id text NOT NULL,
  workspace_id uuid NOT NULL,
  agent_id text NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  agent_instance_id uuid NOT NULL,
  context_kind text NOT NULL CHECK (context_kind IN ('chat','channel','schedule','background','interactive','workspace_native')),
  task_id text CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 200),
  session_id text CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 200),
  turn_id text CHECK (turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 200),
  source_system text NOT NULL CHECK (source_system IN ('litellm_mcp','governed_operation','workspace_broker')),
  source_invocation_id text NOT NULL CHECK (length(source_invocation_id) BETWEEN 1 AND 200),
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
  connector_id text NOT NULL CHECK (length(connector_id) BETWEEN 1 AND 128),
  server_id text NOT NULL CHECK (length(server_id) BETWEEN 1 AND 128),
  server_name text NOT NULL CHECK (length(server_name) BETWEEN 1 AND 128),
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
  policy_decision text NOT NULL CHECK (policy_decision IN ('allow','deny','approval_required')),
  policy_code text NOT NULL CHECK (policy_code ~ '^[A-Z0-9][A-Z0-9_:-]{0,127}$'),
  policy_version_id text CHECK (policy_version_id IS NULL OR length(policy_version_id) BETWEEN 1 AND 128),
  policy_hash text CHECK (policy_hash IS NULL OR policy_hash ~ '^[a-f0-9]{64}$'),
  governed_operation_id uuid,
  target_type text NOT NULL CHECK (target_type IN ('recipient','chat','channel','file','folder','event','message','item','destination','connector')),
  target_summary text NOT NULL CHECK (length(target_summary) BETWEEN 1 AND 200),
  target_provenance text NOT NULL CHECK (target_provenance IN ('managed_schema','generic_template')),
  target_redacted boolean NOT NULL,
  admitted_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded','denied','approval_required','failed','cancelled','timed_out','unconfirmed')),
  latency_ms integer NOT NULL CHECK (latency_ms BETWEEN 0 AND 604800000),
  failure_class text CHECK (failure_class IS NULL OR failure_class ~ '^[A-Z0-9][A-Z0-9_:-]{0,127}$'),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (completed_at,invocation_id),
  FOREIGN KEY (tenant_id,invocation_id) REFERENCES tool_audit_invocation_keys(tenant_id,invocation_id),
  FOREIGN KEY (tenant_id,subject_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,agent_instance_id) REFERENCES agent_instances(tenant_id,id),
  CHECK (completed_at >= admitted_at),
  CHECK (policy_decision <> 'approval_required' OR governed_operation_id IS NOT NULL),
  CHECK ((outcome IN ('failed','cancelled','timed_out','unconfirmed')) = (failure_class IS NOT NULL)),
  CHECK (policy_decision <> 'deny' OR outcome='denied'),
  CHECK (policy_decision <> 'approval_required' OR outcome='approval_required'),
  CHECK (policy_decision <> 'allow' OR outcome NOT IN ('denied','approval_required'))
) PARTITION BY RANGE (completed_at);

CREATE TABLE tool_audit_events_2026_07 PARTITION OF tool_audit_events
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
CREATE TABLE tool_audit_events_2026_08 PARTITION OF tool_audit_events
  FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
CREATE TABLE tool_audit_events_2026_09 PARTITION OF tool_audit_events
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE tool_audit_events_2026_10 PARTITION OF tool_audit_events
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE tool_audit_events_default PARTITION OF tool_audit_events DEFAULT;

CREATE INDEX tool_audit_events_tenant_time_idx
  ON tool_audit_events (tenant_id,completed_at DESC,invocation_id DESC);
CREATE INDEX tool_audit_events_member_time_idx
  ON tool_audit_events (tenant_id,subject_id,completed_at DESC);
CREATE INDEX tool_audit_events_workspace_time_idx
  ON tool_audit_events (tenant_id,workspace_id,completed_at DESC);
CREATE INDEX tool_audit_events_agent_instance_time_idx
  ON tool_audit_events (tenant_id,agent_instance_id,completed_at DESC);
CREATE INDEX tool_audit_events_connector_tool_time_idx
  ON tool_audit_events (tenant_id,connector_id,tool_name,completed_at DESC);

CREATE TABLE tool_audit_hourly_rollups (
  tenant_id text NOT NULL REFERENCES tenants(id),
  period_start timestamptz NOT NULL,
  connector_id text NOT NULL,
  tool_name text NOT NULL,
  policy_decision text NOT NULL CHECK (policy_decision IN ('allow','deny','approval_required')),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','denied','approval_required','failed','cancelled','timed_out','unconfirmed')),
  invocation_count bigint NOT NULL CHECK (invocation_count > 0),
  total_latency_ms numeric(30,0) NOT NULL CHECK (total_latency_ms >= 0),
  max_latency_ms integer NOT NULL CHECK (max_latency_ms >= 0),
  PRIMARY KEY (tenant_id,period_start,connector_id,tool_name,policy_decision,outcome)
);

CREATE TABLE tool_audit_daily_rollups (
  tenant_id text NOT NULL REFERENCES tenants(id),
  period_start date NOT NULL,
  connector_id text NOT NULL,
  tool_name text NOT NULL,
  policy_decision text NOT NULL CHECK (policy_decision IN ('allow','deny','approval_required')),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','denied','approval_required','failed','cancelled','timed_out','unconfirmed')),
  invocation_count bigint NOT NULL CHECK (invocation_count > 0),
  total_latency_ms numeric(30,0) NOT NULL CHECK (total_latency_ms >= 0),
  max_latency_ms integer NOT NULL CHECK (max_latency_ms >= 0),
  PRIMARY KEY (tenant_id,period_start,connector_id,tool_name,policy_decision,outcome)
);

CREATE FUNCTION lemmacomputer_tool_audit_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tool_audit_hourly_rollups (
    tenant_id,period_start,connector_id,tool_name,policy_decision,outcome,
    invocation_count,total_latency_ms,max_latency_ms
  ) VALUES (
    NEW.tenant_id,date_trunc('hour',NEW.completed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
    NEW.connector_id,NEW.tool_name,NEW.policy_decision,NEW.outcome,1,NEW.latency_ms,NEW.latency_ms
  ) ON CONFLICT (tenant_id,period_start,connector_id,tool_name,policy_decision,outcome)
  DO UPDATE SET
    invocation_count=tool_audit_hourly_rollups.invocation_count+1,
    total_latency_ms=tool_audit_hourly_rollups.total_latency_ms+EXCLUDED.total_latency_ms,
    max_latency_ms=GREATEST(tool_audit_hourly_rollups.max_latency_ms,EXCLUDED.max_latency_ms);

  INSERT INTO tool_audit_daily_rollups (
    tenant_id,period_start,connector_id,tool_name,policy_decision,outcome,
    invocation_count,total_latency_ms,max_latency_ms
  ) VALUES (
    NEW.tenant_id,(NEW.completed_at AT TIME ZONE 'UTC')::date,
    NEW.connector_id,NEW.tool_name,NEW.policy_decision,NEW.outcome,1,NEW.latency_ms,NEW.latency_ms
  ) ON CONFLICT (tenant_id,period_start,connector_id,tool_name,policy_decision,outcome)
  DO UPDATE SET
    invocation_count=tool_audit_daily_rollups.invocation_count+1,
    total_latency_ms=tool_audit_daily_rollups.total_latency_ms+EXCLUDED.total_latency_ms,
    max_latency_ms=GREATEST(tool_audit_daily_rollups.max_latency_ms,EXCLUDED.max_latency_ms);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tool_audit_events_rollup
AFTER INSERT ON tool_audit_events
FOR EACH ROW EXECUTE FUNCTION lemmacomputer_tool_audit_rollup();

CREATE FUNCTION lemmacomputer_reject_tool_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tool call compliance history is append-only';
END;
$$;

CREATE TRIGGER tool_audit_events_immutable
BEFORE UPDATE OR DELETE ON tool_audit_events
FOR EACH ROW EXECUTE FUNCTION lemmacomputer_reject_tool_audit_mutation();
