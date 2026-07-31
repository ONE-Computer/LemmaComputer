-- id: 01KYTRRJP6JWRQ79676AEQCJHJ
-- depends-on: 01KYRNFY5DC9953FMDC85ZV38C

-- Teams are the first user-facing allocation unit. The allocation_type column
-- keeps the internal boundary open to future allocation kinds without exposing
-- that complexity in the current product.
CREATE UNIQUE INDEX users_tenant_id_id_unique_idx ON users (tenant_id, id);

CREATE TABLE allocation_units (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  allocation_type text NOT NULL DEFAULT 'team',
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_user_id text NOT NULL REFERENCES users(id),
  cost_center_code text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  is_rollout_fallback boolean NOT NULL DEFAULT false,
  created_by text NOT NULL REFERENCES users(id),
  updated_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (allocation_type <> ''),
  CHECK (display_name <> ''),
  CHECK (lower(btrim(display_name)) <> 'unallocated' OR is_rollout_fallback),
  CHECK (cost_center_code IS NULL OR cost_center_code <> ''),
  CHECK (
    (status = 'active' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX allocation_units_active_name_idx
  ON allocation_units (tenant_id, allocation_type, lower(display_name))
  WHERE status = 'active';

CREATE UNIQUE INDEX allocation_units_one_rollout_fallback_idx
  ON allocation_units (tenant_id, allocation_type)
  WHERE is_rollout_fallback AND status = 'active';

CREATE INDEX allocation_units_tenant_status_idx
  ON allocation_units (tenant_id, allocation_type, status, display_name);

CREATE TABLE allocation_memberships (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  allocation_unit_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  assigned_by text NOT NULL REFERENCES users(id),
  ended_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, allocation_unit_id)
    REFERENCES allocation_units(tenant_id, id),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX allocation_memberships_one_active_idx
  ON allocation_memberships (tenant_id, allocation_unit_id, user_id)
  WHERE effective_to IS NULL;

CREATE INDEX allocation_memberships_user_history_idx
  ON allocation_memberships (tenant_id, user_id, effective_from DESC);

CREATE TABLE default_spending_team_assignments (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  allocation_unit_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  assigned_by text NOT NULL REFERENCES users(id),
  ended_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, allocation_unit_id)
    REFERENCES allocation_units(tenant_id, id),
  UNIQUE (tenant_id, id)
);

-- PostgreSQL enforces the concurrency-sensitive half of "exactly one": even
-- concurrent writers cannot create two active defaults for one tenant user.
-- The store resolves the required default (including rollout fallback) before
-- spend allocation.
CREATE UNIQUE INDEX default_spending_team_one_active_idx
  ON default_spending_team_assignments (tenant_id, user_id)
  WHERE effective_to IS NULL;

CREATE INDEX default_spending_team_history_idx
  ON default_spending_team_assignments (tenant_id, user_id, effective_from DESC);

CREATE TABLE team_administrator_audit_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('team','membership','default_spending_team')),
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id)
);

CREATE INDEX team_administrator_audit_events_tenant_time_idx
  ON team_administrator_audit_events (tenant_id, occurred_at DESC);
