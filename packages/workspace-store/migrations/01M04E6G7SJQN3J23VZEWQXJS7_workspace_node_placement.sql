-- id: 01M04E6G7SJQN3J23VZEWQXJS7
-- depends-on: 01M02Z61C4FFSTCSPEZQ1NV3F5

-- Expand-only C-minus placement model. Node credentials remain runtime
-- secrets; this registry stores only the private endpoint and its expected
-- certificate name.
CREATE TABLE workspace_nodes (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'),
  endpoint_url text NOT NULL UNIQUE CHECK (endpoint_url ~ '^https://'),
  tls_server_name text NOT NULL CHECK (tls_server_name ~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}[A-Za-z0-9]$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','draining','disabled')),
  reason text NOT NULL,
  created_by_operator_id uuid NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  updated_by_operator_id uuid NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE tenant_workspace_node_assignments (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_node_id text NOT NULL REFERENCES workspace_nodes(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  updated_by_operator_id uuid NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE workspaces
  ADD COLUMN workspace_node_id text REFERENCES workspace_nodes(id) ON DELETE RESTRICT;

ALTER TABLE platform_tenant_cleanup_jobs
  ADD COLUMN workspace_node_id text REFERENCES workspace_nodes(id) ON DELETE RESTRICT;

CREATE INDEX workspaces_workspace_node_idx
  ON workspaces(workspace_node_id)
  WHERE workspace_node_id IS NOT NULL;

CREATE INDEX tenant_workspace_node_assignments_node_idx
  ON tenant_workspace_node_assignments(workspace_node_id);

ALTER TABLE platform_operator_audit_events
  DROP CONSTRAINT platform_operator_audit_events_event_type_check;
ALTER TABLE platform_operator_audit_events
  ADD CONSTRAINT platform_operator_audit_events_event_type_check CHECK (event_type IN (
    'operator.login',
    'operator.logout',
    'operator.step_up',
    'operator.access_changed',
    'support_elevation.requested',
    'support_elevation.started',
    'support_elevation.approved',
    'support_elevation.revoked',
    'support_elevation.used',
    'support_elevation.use_denied',
    'support_operation.diagnostics_read',
    'support_operation.denied',
    'break_glass.security_alert',
    'break_glass.review_required',
    'break_glass.alert_delivered',
    'break_glass.alert_delivery_failed',
    'break_glass.alert_escalated',
    'tenant_lifecycle.updated',
    'incident.created',
    'incident.updated',
    'platform_configuration.updated',
    'workspace_node.registered',
    'workspace_node.state_updated',
    'tenant.workspace_node_assigned'
  ));
