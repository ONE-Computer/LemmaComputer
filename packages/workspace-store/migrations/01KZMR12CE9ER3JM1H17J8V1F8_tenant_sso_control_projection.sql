-- id: 01KZMR12CE9ER3JM1H17J8V1F8
-- depends-on: 01KZKG6E5JK9QX7ES61M5VEENA

CREATE TABLE organization_sso_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  authentication_provider_id text NOT NULL UNIQUE,
  protocol text NOT NULL CHECK (protocol IN ('oidc','saml')),
  domain text NOT NULL CHECK (domain=lower(domain) AND domain ~ '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$'),
  issuer text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','enforced','suspended','disconnected')),
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  domain_verified_at timestamptz,
  last_tested_at timestamptz,
  recovery_confirmed_at timestamptz,
  enforced_at timestamptz,
  suspended_at timestamptz,
  disconnected_at timestamptz,
  created_by text NOT NULL REFERENCES users(id),
  updated_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organization_sso_connections_active_domain_idx
  ON organization_sso_connections(lower(domain))
  WHERE state <> 'disconnected';
CREATE INDEX organization_sso_connections_org_state_idx
  ON organization_sso_connections(organization_id,state,created_at,id);

CREATE TABLE organization_sso_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES organization_sso_connections(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL REFERENCES users(id),
  event_type text NOT NULL CHECK (event_type IN (
    'sso.created','sso.domain_verified','sso.test_succeeded','sso.recovery_confirmed',
    'sso.enforced','sso.suspended','sso.rolled_back','sso.disconnected',
    'sso.rotated','sso.metadata_refreshed'
  )),
  old_state text,
  new_state text NOT NULL,
  config_version integer NOT NULL CHECK (config_version > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX organization_sso_audit_events_org_time_idx
  ON organization_sso_audit_events(organization_id,occurred_at DESC,id DESC);
