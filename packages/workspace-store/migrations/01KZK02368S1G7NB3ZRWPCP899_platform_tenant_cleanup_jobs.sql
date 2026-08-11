-- id: 01KZK02368S1G7NB3ZRWPCP899
-- depends-on: 01KZJZA8SA83R60W30EZMXEQ3X

-- Forward-only migration. Add safe, bounded SQL below.

-- The generation now fences every workspace data plane, not only the
-- workspace-to-Control bridge.
ALTER TABLE workspaces RENAME COLUMN bridge_grant_generation TO access_generation;
ALTER TABLE workspaces RENAME CONSTRAINT workspaces_bridge_grant_generation_positive TO workspaces_access_generation_positive;

CREATE TABLE platform_tenant_cleanup_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL,
  access_generation integer NOT NULL CHECK (access_generation > 0),
  provider_id text,
  action text NOT NULL CHECK (action IN ('suspend','close')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','retry','completed','escalated')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL,
  claimed_at timestamptz,
  lease_token uuid,
  lease_generation integer NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  controller_destroyed_at timestamptz,
  gateway_revoked_at timestamptz,
  storage_purged_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(workspace_id,access_generation),
  CHECK (
    (status='delivering' AND lease_token IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status<>'delivering' AND lease_token IS NULL)
  )
);

CREATE INDEX platform_tenant_cleanup_jobs_claim_idx
  ON platform_tenant_cleanup_jobs(status,available_at,created_at)
  WHERE status IN ('pending','retry','delivering');
