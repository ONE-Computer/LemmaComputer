-- id: 01KZJXVP8M97QZDDJKDEVKHWB7
-- depends-on: 01KZJTZ5HFNJ4FZVFPENVHFTAN

-- Forward-only migration. Add safe, bounded SQL below.

ALTER TABLE platform_operator_oidc_attempts
  ADD COLUMN purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login','step-up')),
  ADD COLUMN operator_session_id uuid REFERENCES platform_operator_sessions(id) ON DELETE CASCADE;

CREATE TABLE platform_security_alert_outbox (
  id uuid PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES platform_operators(id),
  target_organization_id text NOT NULL REFERENCES tenants(id),
  elevation_id uuid NOT NULL REFERENCES platform_support_elevations(id),
  correlation_id text NOT NULL CHECK (char_length(btrim(correlation_id)) BETWEEN 1 AND 256),
  alert_type text NOT NULL CHECK (alert_type IN ('break-glass')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','retry','delivered','escalated')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at timestamptz NOT NULL,
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (alert_type,correlation_id),
  CHECK (attempt_count BETWEEN 0 AND max_attempts),
  CHECK (status <> 'delivered' OR delivered_at IS NOT NULL),
  CHECK (status <> 'delivering' OR claimed_at IS NOT NULL)
);
CREATE INDEX platform_security_alert_outbox_delivery_idx
  ON platform_security_alert_outbox (status,available_at,created_at,id)
  WHERE status IN ('pending','retry','delivering');

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
    'platform_configuration.updated'
  ));
