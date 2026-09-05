-- id: 01M1PH5NYR7TFTMXJXNG34PW72
-- depends-on: 01M1JWWKHFG5C31ZEQDFN5VSVK

-- Forward-only migration. Add safe, bounded SQL below.

-- Replace the unreleased single-document Sites MVP. There is intentionally no
-- compatibility or backfill path: existing development-only site rows and
-- their database-resident HTML payloads are discarded.

ALTER TABLE sites
  ADD COLUMN handle text CHECK (handle ~ '^[A-Za-z0-9_-]{24}$'),
  ADD COLUMN visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','organization','restricted')),
  ADD COLUMN published_version_id uuid,
  ADD COLUMN creator_account_user_id uuid REFERENCES account_users(id),
  ADD COLUMN deleted_at timestamptz;

DELETE FROM sites;
DROP TABLE site_revisions;

ALTER TABLE sites
  ALTER COLUMN handle SET NOT NULL,
  DROP CONSTRAINT sites_state_check,
  ADD CONSTRAINT sites_state_check CHECK (state IN ('draft','ready','failed'));

CREATE UNIQUE INDEX sites_handle_idx ON sites (handle);
CREATE INDEX sites_tenant_visibility_idx
  ON sites (tenant_id,visibility,updated_at DESC,id)
  WHERE deleted_at IS NULL;

CREATE TABLE site_versions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  site_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('staging','ready','failed')),
  storage_backend text NOT NULL CHECK (storage_backend IN ('filesystem','s3')),
  storage_locator text CHECK (storage_locator IS NULL OR char_length(storage_locator) BETWEEN 1 AND 1024),
  staging_locator text CHECK (staging_locator IS NULL OR char_length(staging_locator) BETWEEN 1 AND 1024),
  archive_sha256 char(64) NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
  archive_size_bytes integer NOT NULL CHECK (archive_size_bytes BETWEEN 1 AND 20971520),
  manifest_sha256 char(64) NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  extracted_size_bytes integer NOT NULL CHECK (extracted_size_bytes BETWEEN 1 AND 52428800),
  file_count integer NOT NULL CHECK (file_count BETWEEN 1 AND 500),
  source_workspace_id uuid NOT NULL,
  source_workspace_generation integer NOT NULL CHECK (source_workspace_generation > 0),
  source_agent_id text NOT NULL CHECK (char_length(source_agent_id) BETWEEN 1 AND 128),
  source_project_path text NOT NULL
    CHECK (char_length(source_project_path) BETWEEN 1 AND 1024)
    CHECK (source_project_path !~ '(^/|(^|/)\.\.(/|$)|\\\\)'),
  created_by_account_user_id uuid REFERENCES account_users(id),
  idempotency_key_hash char(64) NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL,
  ready_at timestamptz,
  failed_at timestamptz,
  UNIQUE (tenant_id,subject_id,site_id,version),
  UNIQUE (tenant_id,subject_id,site_id,idempotency_key_hash),
  UNIQUE (id,tenant_id,subject_id,site_id),
  FOREIGN KEY (site_id,tenant_id,subject_id)
    REFERENCES sites (id,tenant_id,subject_id)
    ON DELETE CASCADE
);

CREATE INDEX site_versions_site_state_idx
  ON site_versions (tenant_id,subject_id,site_id,state,version DESC);
CREATE INDEX site_versions_staging_idx
  ON site_versions (state,created_at,id)
  WHERE state='staging';

ALTER TABLE sites
  ADD CONSTRAINT sites_published_version_fk
  FOREIGN KEY (published_version_id,tenant_id,subject_id,id)
  REFERENCES site_versions (id,tenant_id,subject_id,site_id);

CREATE TABLE site_grants (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  site_id uuid NOT NULL,
  grantee_account_user_id uuid NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission='viewer'),
  granted_by text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  UNIQUE (tenant_id,subject_id,site_id,grantee_account_user_id),
  FOREIGN KEY (site_id,tenant_id,subject_id)
    REFERENCES sites (id,tenant_id,subject_id)
    ON DELETE CASCADE
);

CREATE INDEX site_grants_account_idx
  ON site_grants (grantee_account_user_id,tenant_id,site_id)
  WHERE revoked_at IS NULL;

CREATE TABLE site_invitations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  site_id uuid NOT NULL,
  email text NOT NULL CHECK (email=lower(email) AND char_length(email) BETWEEN 3 AND 320),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key_hash char(64) NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','accepted','expired','revoked')),
  delivery_generation integer NOT NULL CHECK (delivery_generation > 0),
  expires_at timestamptz NOT NULL,
  accepted_account_user_id uuid REFERENCES account_users(id),
  accepted_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (tenant_id,subject_id,site_id,idempotency_key_hash),
  UNIQUE (id,tenant_id,subject_id,site_id),
  FOREIGN KEY (site_id,tenant_id,subject_id)
    REFERENCES sites (id,tenant_id,subject_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX site_invitations_pending_email_idx
  ON site_invitations (tenant_id,subject_id,site_id,email)
  WHERE status='pending';
CREATE INDEX site_invitations_site_status_idx
  ON site_invitations (tenant_id,subject_id,site_id,status,expires_at,id);

CREATE TABLE site_invitation_audit_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  site_id uuid NOT NULL,
  invitation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'invitation.created','invitation.resent','invitation.expired',
    'invitation.revoked','invitation.accepted'
  )),
  actor_user_id text,
  delivery_generation integer NOT NULL CHECK (delivery_generation > 0),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (invitation_id,tenant_id,subject_id,site_id)
    REFERENCES site_invitations (id,tenant_id,subject_id,site_id)
    ON DELETE CASCADE
);

CREATE INDEX site_invitation_audit_site_time_idx
  ON site_invitation_audit_events (tenant_id,subject_id,site_id,occurred_at DESC,id DESC);
