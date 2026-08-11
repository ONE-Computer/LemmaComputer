-- id: 01KZJSHAKHV0E5FKK58XAG59A3
-- depends-on: 01KZDMJVTS4Y1K48DEZMFQ65VE

-- Add tenant-owned roles beside the protected built-in membership role. The
-- existing role column remains authoritative for Owner/Administrator/Member,
-- so rollback does not reinterpret ownership or weaken the last-owner guard.

CREATE TABLE organization_custom_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  current_version integer NOT NULL CHECK (current_version > 0),
  catalog_version integer NOT NULL REFERENCES organization_permission_catalog_versions(version),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,created_by) REFERENCES users(tenant_id,id),
  FOREIGN KEY (organization_id,updated_by) REFERENCES users(tenant_id,id)
);

CREATE UNIQUE INDEX organization_custom_roles_active_name_idx
  ON organization_custom_roles (organization_id,lower(name))
  WHERE status='active';

CREATE TABLE organization_custom_role_versions (
  organization_id text NOT NULL,
  role_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  catalog_version integer NOT NULL REFERENCES organization_permission_catalog_versions(version),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,role_id,version),
  FOREIGN KEY (organization_id,role_id)
    REFERENCES organization_custom_roles(organization_id,id),
  FOREIGN KEY (organization_id,created_by) REFERENCES users(tenant_id,id)
);

ALTER TABLE organization_custom_roles
  ADD CONSTRAINT organization_custom_roles_current_version_fk
  FOREIGN KEY (organization_id,id,current_version)
    REFERENCES organization_custom_role_versions(organization_id,role_id,version)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE organization_custom_role_grants (
  organization_id text NOT NULL,
  role_id uuid NOT NULL,
  role_version integer NOT NULL,
  catalog_version integer NOT NULL,
  permission_key text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('organization','workspace','provider')),
  resource_id text NOT NULL DEFAULT '',
  PRIMARY KEY (organization_id,role_id,role_version,permission_key,scope_type,resource_id),
  CHECK ((scope_type='organization' AND resource_id='') OR (scope_type<>'organization' AND resource_id<>'')),
  FOREIGN KEY (organization_id,role_id,role_version)
    REFERENCES organization_custom_role_versions(organization_id,role_id,version) ON DELETE CASCADE,
  FOREIGN KEY (catalog_version,permission_key)
    REFERENCES organization_permissions(catalog_version,permission_key)
);

CREATE TABLE organization_membership_role_assignments (
  organization_id text NOT NULL,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  role_version integer NOT NULL,
  assigned_by text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,membership_id,role_id),
  FOREIGN KEY (organization_id,membership_id)
    REFERENCES organization_memberships(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,role_id,role_version)
    REFERENCES organization_custom_role_versions(organization_id,role_id,version),
  FOREIGN KEY (organization_id,assigned_by) REFERENCES users(tenant_id,id)
);

CREATE INDEX organization_membership_role_assignments_role_idx
  ON organization_membership_role_assignments (organization_id,role_id,membership_id);

CREATE TABLE organization_role_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id),
  role_id uuid NOT NULL,
  role_version integer NOT NULL,
  membership_id uuid,
  actor_user_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'role.created','role.updated','role.archived','role.assigned','role.unassigned'
  )),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,role_id)
    REFERENCES organization_custom_roles(organization_id,id),
  FOREIGN KEY (organization_id,membership_id)
    REFERENCES organization_memberships(organization_id,id),
  FOREIGN KEY (organization_id,actor_user_id) REFERENCES users(tenant_id,id)
);

CREATE INDEX organization_role_audit_events_org_time_idx
  ON organization_role_audit_events (organization_id,occurred_at DESC,id DESC);
