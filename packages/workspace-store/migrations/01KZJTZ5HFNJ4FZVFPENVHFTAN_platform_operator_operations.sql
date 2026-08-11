-- id: 01KZJTZ5HFNJ4FZVFPENVHFTAN
-- depends-on: 01KZJTB13VRQ8G7E0114QYBP02

CREATE TABLE platform_tenant_lifecycle (
  tenant_id text PRIMARY KEY REFERENCES tenants(id),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active','suspended','offboarding','closed')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 12 AND 1000),
  updated_by_operator_id uuid NOT NULL REFERENCES platform_operators(id),
  updated_at timestamptz NOT NULL
);

CREATE TABLE platform_incidents (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 4 AND 200),
  summary text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 12 AND 4000),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL CHECK (status IN ('open','monitoring','resolved')),
  created_by_operator_id uuid NOT NULL REFERENCES platform_operators(id),
  updated_by_operator_id uuid NOT NULL REFERENCES platform_operators(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX platform_incidents_status_updated_idx ON platform_incidents (status,updated_at DESC,id);

CREATE TABLE platform_configuration (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$'),
  value jsonb NOT NULL CHECK (pg_column_size(value) <= 16384),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 12 AND 1000),
  updated_by_operator_id uuid NOT NULL REFERENCES platform_operators(id),
  updated_at timestamptz NOT NULL
);

ALTER TABLE platform_operator_audit_events
  DROP CONSTRAINT platform_operator_audit_events_event_type_check;
ALTER TABLE platform_operator_audit_events
  ADD CONSTRAINT platform_operator_audit_events_event_type_check CHECK (event_type IN (
    'operator.login',
    'operator.logout',
    'support_elevation.requested',
    'support_elevation.started',
    'support_elevation.approved',
    'support_elevation.revoked',
    'support_elevation.used',
    'support_elevation.use_denied',
    'break_glass.security_alert',
    'break_glass.review_required',
    'tenant_lifecycle.updated',
    'incident.created',
    'incident.updated',
    'platform_configuration.updated'
  ));
