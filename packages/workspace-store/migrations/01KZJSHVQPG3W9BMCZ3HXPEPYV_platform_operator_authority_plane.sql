-- id: 01KZJSHVQPG3W9BMCZ3HXPEPYV
-- depends-on: 01KZDMJVTS4Y1K48DEZMFQ65VE

-- Hosted-only authority is runtime-gated. The shared forward-only schema keeps
-- customer-managed backups portable while containing no provisioned operator.
CREATE TABLE platform_operators (
  id uuid PRIMARY KEY,
  workforce_issuer text NOT NULL,
  workforce_subject text NOT NULL,
  workforce_tenant_id text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workforce_issuer,workforce_subject)
);

CREATE TABLE platform_operator_role_assignments (
  operator_id uuid NOT NULL REFERENCES platform_operators(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('platform-administrator','support-operator','security-auditor','billing-operator')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id,role)
);

CREATE TABLE platform_operator_sessions (
  id uuid PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES platform_operators(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  assurance_level text NOT NULL CHECK (assurance_level IN ('aal1','aal2')),
  assurance_factors text[] NOT NULL CHECK (
    cardinality(assurance_factors) > 0
    AND assurance_factors <@ ARRAY['password','totp','passkey','federated']::text[]
  ),
  authenticated_at timestamptz NOT NULL,
  recent_step_up_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > authenticated_at),
  CHECK (recent_step_up_at IS NULL OR recent_step_up_at >= authenticated_at),
  CHECK (recent_step_up_at IS NULL OR recent_step_up_at <= expires_at)
);
CREATE INDEX platform_operator_sessions_active_idx
  ON platform_operator_sessions (operator_id,expires_at) WHERE revoked_at IS NULL;

CREATE TABLE platform_support_elevations (
  id uuid PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES platform_operators(id),
  operator_session_id uuid NOT NULL REFERENCES platform_operator_sessions(id),
  target_organization_id text NOT NULL REFERENCES tenants(id),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 12 AND 1000),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY[
      'support.diagnostics.read',
      'support.configuration.read',
      'support.customer-content.read',
      'support.identity-recovery.manage'
    ]::text[]
  ),
  kind text NOT NULL CHECK (kind IN ('support','break-glass')),
  approval_required boolean NOT NULL,
  approved_by_operator_id uuid REFERENCES platform_operators(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_operator_id uuid REFERENCES platform_operators(id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes'),
  CHECK (kind <> 'break-glass' OR expires_at <= created_at + interval '15 minutes'),
  CHECK (approved_by_operator_id IS NULL OR approved_by_operator_id <> operator_id),
  CHECK ((approved_by_operator_id IS NULL) = (approved_at IS NULL)),
  CHECK (approval_required OR approved_by_operator_id IS NULL),
  CHECK (
    NOT (scopes && ARRAY['support.customer-content.read','support.identity-recovery.manage']::text[])
    OR approval_required
  )
);
CREATE INDEX platform_support_elevations_active_idx
  ON platform_support_elevations (operator_id,target_organization_id,expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE platform_operator_audit_events (
  id uuid PRIMARY KEY,
  operator_id uuid REFERENCES platform_operators(id),
  target_organization_id text REFERENCES tenants(id),
  elevation_id uuid REFERENCES platform_support_elevations(id),
  event_type text NOT NULL CHECK (event_type IN (
    'operator.login',
    'operator.logout',
    'support_elevation.requested',
    'support_elevation.started',
    'support_elevation.approved',
    'support_elevation.revoked',
    'support_elevation.used',
    'support_elevation.use_denied',
    'break_glass.security_alert',
    'break_glass.review_required'
  )),
  correlation_id text NOT NULL CHECK (char_length(btrim(correlation_id)) BETWEEN 1 AND 256),
  review_required boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  occurred_at timestamptz NOT NULL,
  UNIQUE (event_type,correlation_id)
);
CREATE INDEX platform_operator_audit_target_idx
  ON platform_operator_audit_events (target_organization_id,occurred_at DESC,id);
CREATE INDEX platform_operator_audit_operator_idx
  ON platform_operator_audit_events (operator_id,occurred_at DESC,id);
