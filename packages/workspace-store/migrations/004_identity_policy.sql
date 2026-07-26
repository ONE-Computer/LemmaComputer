CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  external_tenant_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  administrator_bootstrapped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS administrator_bootstrapped_at timestamptz;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS external_identities (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  issuer text NOT NULL,
  external_subject text NOT NULL,
  external_tenant_id text NOT NULL,
  email text NOT NULL,
  last_authenticated_at timestamptz NOT NULL,
  UNIQUE (provider, issuer, external_subject)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('employee','administrator')),
  assigned_by text NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS browser_sessions_active_idx
  ON browser_sessions (token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS oidc_login_attempts (
  state_hash text PRIMARY KEY,
  verifier_ciphertext text NOT NULL,
  nonce text NOT NULL,
  return_path text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_identities (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  owner_user_id text NOT NULL REFERENCES users(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);

CREATE TABLE IF NOT EXISTS vendor_identity_mappings (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id text NOT NULL REFERENCES users(id),
  vendor text NOT NULL,
  vendor_user_id text NOT NULL,
  mapping_kind text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, vendor, mapping_kind),
  UNIQUE (vendor, vendor_user_id, mapping_kind)
);

CREATE TABLE IF NOT EXISTS capabilities (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  risk text NOT NULL CHECK (risk IN ('standard','protected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_bundles (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE policy_bundles ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES tenants(id);
ALTER TABLE policy_bundles ALTER COLUMN tenant_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS policy_bundles_tenant_name_idx ON policy_bundles (tenant_id, display_name);

CREATE TABLE IF NOT EXISTS policy_versions (
  id uuid PRIMARY KEY,
  policy_bundle_id text NOT NULL REFERENCES policy_bundles(id),
  version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL,
  document_hash text NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_bundle_id, version),
  UNIQUE (policy_bundle_id, document_hash)
);

CREATE TABLE IF NOT EXISTS policy_assignments (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id text NOT NULL REFERENCES users(id),
  agent_id uuid NOT NULL REFERENCES agent_identities(id),
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id),
  assigned_by text NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text REFERENCES users(id),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS policy_assignments_one_active_idx
  ON policy_assignments (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS capability_assignments (
  policy_assignment_id uuid NOT NULL REFERENCES policy_assignments(id) ON DELETE CASCADE,
  capability_id text NOT NULL REFERENCES capabilities(id),
  PRIMARY KEY (policy_assignment_id, capability_id)
);

CREATE OR REPLACE FUNCTION reject_policy_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'policy versions are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS policy_versions_immutable_update ON policy_versions;
CREATE TRIGGER policy_versions_immutable_update BEFORE UPDATE OR DELETE ON policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_policy_version_mutation();
