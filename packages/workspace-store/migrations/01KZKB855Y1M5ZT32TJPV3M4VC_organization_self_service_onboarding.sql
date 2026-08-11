-- id: 01KZKB855Y1M5ZT32TJPV3M4VC
-- depends-on: 01KZK02368S1G7NB3ZRWPCP899

-- Self-service onboarding adds only nullable organization presentation data
-- and new tenant-scoped aggregate tables. Existing organizations remain valid
-- and can receive slugs/settings through a later resumable backfill.

ALTER TABLE organizations ADD COLUMN slug text;

ALTER TABLE organizations ADD CONSTRAINT organizations_slug_format_check
  CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

CREATE UNIQUE INDEX organizations_slug_unique_idx
  ON organizations (slug) WHERE slug IS NOT NULL;

CREATE TABLE organization_settings (
  organization_id text PRIMARY KEY REFERENCES organizations(id),
  onboarding_state text NOT NULL DEFAULT 'ready' CHECK (onboarding_state IN ('ready')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_onboarding_requests (
  account_user_id uuid NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  idempotency_key_hash char(64) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  organization_id text NOT NULL UNIQUE REFERENCES organizations(id),
  membership_id uuid NOT NULL UNIQUE REFERENCES organization_memberships(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_user_id,idempotency_key_hash),
  FOREIGN KEY (organization_id,membership_id)
    REFERENCES organization_memberships(organization_id,id)
);

CREATE INDEX organization_onboarding_account_time_idx
  ON organization_onboarding_requests (account_user_id,created_at DESC);

CREATE TABLE customer_owner_step_up_proofs (
  authentication_session_id uuid PRIMARY KEY,
  account_user_id uuid NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customer_owner_step_up_account_time_idx
  ON customer_owner_step_up_proofs (account_user_id,authenticated_at DESC);

CREATE TABLE organization_lifecycle_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  event_type text NOT NULL CHECK (event_type IN (
    'organization.created',
    'organization.ownership_transferred',
    'organization.recovery_completed',
    'organization.closure_requested',
    'organization.closed'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,actor_user_id) REFERENCES users(tenant_id,id)
);

CREATE INDEX organization_lifecycle_audit_org_time_idx
  ON organization_lifecycle_audit_events (organization_id,occurred_at DESC,id DESC);

CREATE TABLE organization_closure_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id),
  requested_by text NOT NULL REFERENCES users(id),
  idempotency_key_hash char(64) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','completed')),
  recent_step_up_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  execute_after timestamptz NOT NULL,
  cancelled_at timestamptz,
  completed_at timestamptz,
  UNIQUE (organization_id,idempotency_key_hash),
  FOREIGN KEY (organization_id,requested_by) REFERENCES users(tenant_id,id)
);

CREATE UNIQUE INDEX organization_closure_one_pending_idx
  ON organization_closure_requests (organization_id) WHERE status='pending';

CREATE INDEX organization_closure_org_time_idx
  ON organization_closure_requests (organization_id,requested_at DESC,id DESC);
