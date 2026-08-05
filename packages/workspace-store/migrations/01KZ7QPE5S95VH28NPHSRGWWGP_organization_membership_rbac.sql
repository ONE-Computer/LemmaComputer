-- id: 01KZ7QPE5S95VH28NPHSRGWWGP
-- depends-on: 01KZ7KNTPA69RM4868J4SB2H9V

-- Expand the legacy tenant-local user/role shape into an organization membership
-- model. The legacy columns and user_roles table remain readable during the
-- expand/migrate window so the previous application version can still roll back.
-- Existing identity rows are populated by the explicit, resumable
-- db:backfill:organization-rbac job after this bounded schema transaction.

CREATE TABLE organizations (
  id text PRIMARY KEY REFERENCES tenants(id),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_user_id text UNIQUE REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN account_user_id uuid REFERENCES account_users(id);

ALTER TABLE users
  ADD CONSTRAINT users_subject_account_key UNIQUE (id,account_user_id),
  ADD CONSTRAINT users_organization_subject_account_key UNIQUE (tenant_id,id,account_user_id);

-- Email is display/contact data, not an identity key. Immutable provider
-- issuer/subject identifiers own identity uniqueness.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tenant_id_email_key;
CREATE INDEX users_tenant_email_lookup_idx ON users (tenant_id,email);

CREATE INDEX users_account_organization_idx ON users (account_user_id,tenant_id);

ALTER TABLE external_identities
  ADD COLUMN account_user_id uuid REFERENCES account_users(id),
  ADD COLUMN provider_object_id text;

ALTER TABLE external_identities
  ADD CONSTRAINT external_identities_subject_account_fk
  FOREIGN KEY (user_id,account_user_id) REFERENCES users(id,account_user_id);

CREATE UNIQUE INDEX external_identities_provider_object_idx
  ON external_identities (provider, external_tenant_id, provider_object_id)
  WHERE provider_object_id IS NOT NULL;

CREATE TABLE organization_permission_catalog_versions (
  version integer PRIMARY KEY CHECK (version > 0),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organization_permission_catalog_versions (version, description)
VALUES (1, 'Built-in LemmaComputer organization permissions')
ON CONFLICT (version) DO NOTHING;

CREATE TABLE organization_permissions (
  catalog_version integer NOT NULL REFERENCES organization_permission_catalog_versions(version),
  permission_key text NOT NULL,
  description text NOT NULL,
  PRIMARY KEY (catalog_version, permission_key)
);

INSERT INTO organization_permissions (catalog_version, permission_key, description) VALUES
  (1, 'organization.read', 'Read organization information'),
  (1, 'organization.manage_members', 'Create, suspend, reactivate, and revoke memberships'),
  (1, 'organization.manage_roles', 'Assign member and administrator roles'),
  (1, 'organization.transfer_ownership', 'Transfer organization ownership'),
  (1, 'organization.manage_settings', 'Manage organization-wide settings'),
  (1, 'workspace.use', 'Use an assigned workspace'),
  (1, 'workspace.manage', 'Manage organization workspaces'),
  (1, 'policy.manage', 'Manage execution policies'),
  (1, 'provider.manage', 'Manage provider connections and credentials'),
  (1, 'audit.read', 'Read organization audit records'),
  (1, 'usage.read', 'Read organization usage and spend records'),
  (1, 'usage.manage', 'Manage quotas, budgets, and usage configuration')
ON CONFLICT (catalog_version, permission_key) DO NOTHING;

CREATE TABLE organization_role_permissions (
  catalog_version integer NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  permission_key text NOT NULL,
  PRIMARY KEY (catalog_version, role, permission_key),
  FOREIGN KEY (catalog_version, permission_key)
    REFERENCES organization_permissions(catalog_version, permission_key)
);

INSERT INTO organization_role_permissions (catalog_version, role, permission_key)
SELECT 1, 'owner', permission_key FROM organization_permissions WHERE catalog_version=1
ON CONFLICT DO NOTHING;

INSERT INTO organization_role_permissions (catalog_version, role, permission_key) VALUES
  (1, 'admin', 'organization.read'),
  (1, 'admin', 'organization.manage_members'),
  (1, 'admin', 'organization.manage_roles'),
  (1, 'admin', 'organization.manage_settings'),
  (1, 'admin', 'workspace.use'),
  (1, 'admin', 'workspace.manage'),
  (1, 'admin', 'policy.manage'),
  (1, 'admin', 'provider.manage'),
  (1, 'admin', 'audit.read'),
  (1, 'admin', 'usage.read'),
  (1, 'admin', 'usage.manage'),
  (1, 'member', 'organization.read'),
  (1, 'member', 'workspace.use')
ON CONFLICT DO NOTHING;

CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id),
  account_user_id uuid NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  subject_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('invited','active','suspended','revoked')),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  permission_catalog_version integer NOT NULL DEFAULT 1 REFERENCES organization_permission_catalog_versions(version),
  created_by text NOT NULL REFERENCES users(id),
  updated_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, account_user_id),
  UNIQUE (organization_id, subject_user_id),
  UNIQUE (organization_id, id),
  UNIQUE (subject_user_id, id),
  FOREIGN KEY (organization_id,subject_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (organization_id,subject_user_id,account_user_id)
    REFERENCES users(tenant_id,id,account_user_id),
  FOREIGN KEY (organization_id,created_by) REFERENCES users(tenant_id,id),
  FOREIGN KEY (organization_id,updated_by) REFERENCES users(tenant_id,id)
);

CREATE INDEX organization_memberships_user_idx
  ON organization_memberships (subject_user_id, organization_id);

CREATE INDEX organization_memberships_account_idx
  ON organization_memberships (account_user_id, organization_id);

CREATE INDEX organization_memberships_active_owner_idx
  ON organization_memberships (organization_id, role)
  WHERE status='active';

CREATE TABLE organization_membership_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES tenants(id),
  membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  event_type text NOT NULL CHECK (event_type IN ('membership.created','membership.changed')),
  old_status text CHECK (old_status IS NULL OR old_status IN ('invited','active','suspended','revoked')),
  new_status text NOT NULL CHECK (new_status IN ('invited','active','suspended','revoked')),
  old_role text CHECK (old_role IS NULL OR old_role IN ('owner','admin','member')),
  new_role text NOT NULL CHECK (new_role IN ('owner','admin','member')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,membership_id)
    REFERENCES organization_memberships(organization_id,id),
  FOREIGN KEY (organization_id,actor_user_id)
    REFERENCES users(tenant_id,id)
);

CREATE INDEX organization_membership_audit_events_org_time_idx
  ON organization_membership_audit_events (organization_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION record_organization_membership_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO organization_membership_audit_events (
      organization_id,membership_id,actor_user_id,event_type,new_status,new_role
    ) VALUES (
      NEW.organization_id,NEW.id,NEW.updated_by,'membership.created',NEW.status,NEW.role
    );
  ELSIF OLD.status IS DISTINCT FROM NEW.status OR OLD.role IS DISTINCT FROM NEW.role THEN
    INSERT INTO organization_membership_audit_events (
      organization_id,membership_id,actor_user_id,event_type,
      old_status,new_status,old_role,new_role
    ) VALUES (
      NEW.organization_id,NEW.id,NEW.updated_by,'membership.changed',
      OLD.status,NEW.status,OLD.role,NEW.role
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organization_membership_audit
AFTER INSERT OR UPDATE ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION record_organization_membership_change();

CREATE OR REPLACE FUNCTION preserve_last_active_organization_owner() RETURNS trigger AS $$
BEGIN
  IF OLD.role='owner' AND OLD.status='active'
     AND (TG_OP='DELETE' OR NEW.role<>'owner' OR NEW.status<>'active')
     AND NOT EXISTS (
       SELECT 1 FROM organization_memberships other
       WHERE other.organization_id=OLD.organization_id
         AND other.id<>OLD.id
         AND other.role='owner'
         AND other.status='active'
     ) THEN
    RAISE EXCEPTION 'organization must retain at least one active owner'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organization_membership_last_owner
BEFORE UPDATE OF role,status OR DELETE ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION preserve_last_active_organization_owner();

ALTER TABLE browser_sessions
  ADD COLUMN membership_id uuid REFERENCES organization_memberships(id);

ALTER TABLE browser_sessions
  ADD CONSTRAINT browser_sessions_subject_membership_fk
  FOREIGN KEY (user_id,membership_id)
    REFERENCES organization_memberships(subject_user_id,id);

CREATE INDEX browser_sessions_membership_active_idx
  ON browser_sessions (membership_id, expires_at)
  WHERE revoked_at IS NULL;
