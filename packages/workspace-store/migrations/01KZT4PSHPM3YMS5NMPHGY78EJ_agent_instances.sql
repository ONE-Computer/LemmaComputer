-- id: 01KZT4PSHPM3YMS5NMPHGY78EJ
-- depends-on: 01KZP5PQK4ZC0B1WG1HD8RWV0A

CREATE TABLE agent_instances (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  owner_subject_id text NOT NULL,
  workspace_id uuid NOT NULL,
  agent_catalog_id text NOT NULL CHECK (
    agent_catalog_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'
  ),
  logical_agent_id text NOT NULL CHECK (length(logical_agent_id) BETWEEN 1 AND 128),
  access_generation integer NOT NULL CHECK (access_generation > 0),
  provider_runtime_id text CHECK (
    provider_runtime_id IS NULL OR length(provider_runtime_id) BETWEEN 1 AND 300
  ),
  image_digest text CHECK (
    image_digest IS NULL OR image_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  image_version text CHECK (
    image_version IS NULL OR length(image_version) BETWEEN 1 AND 200
  ),
  policy_version_id text NOT NULL CHECK (length(policy_version_id) BETWEEN 1 AND 128),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  launch_idempotency_key text NOT NULL CHECK (
    length(launch_idempotency_key) BETWEEN 1 AND 200
  ),
  status text NOT NULL DEFAULT 'starting' CHECK (
    status IN ('starting','running','ended')
  ),
  launch_requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text CHECK (
    end_reason IS NULL OR end_reason IN (
      'process_exited',
      'workspace_restarted',
      'workspace_stopped',
      'workspace_terminated',
      'launch_failed',
      'provider_failed',
      'reconciled_abandoned'
    )
  ),
  cleanup_status text NOT NULL DEFAULT 'not_required' CHECK (
    cleanup_status IN ('not_required','pending','confirmed','incomplete')
  ),
  cleanup_failure_code text CHECK (
    cleanup_failure_code IS NULL OR cleanup_failure_code ~ '^[A-Z0-9][A-Z0-9_:-]{0,127}$'
  ),
  cleanup_failure_at timestamptz,
  cleanup_confirmed_at timestamptz,
  cleanup_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,owner_subject_id) REFERENCES users(tenant_id,id),
  -- workspace_id is an immutable evidence snapshot rather than a cascading FK:
  -- terminating/deleting a workspace must not erase its process history.
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,owner_subject_id,workspace_id,launch_idempotency_key),
  CHECK (
    (status='starting' AND started_at IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (status='running' AND started_at IS NOT NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (status='ended' AND ended_at IS NOT NULL AND end_reason IS NOT NULL)
  ),
  CHECK (started_at IS NULL OR started_at >= launch_requested_at),
  CHECK (ended_at IS NULL OR ended_at >= COALESCE(started_at,launch_requested_at)),
  CHECK ((cleanup_failure_code IS NULL) = (cleanup_failure_at IS NULL)),
  CHECK (cleanup_status <> 'incomplete' OR cleanup_failure_code IS NOT NULL),
  CHECK (cleanup_status <> 'confirmed' OR cleanup_confirmed_at IS NOT NULL),
  CHECK (status='ended' OR cleanup_status='not_required')
);

CREATE INDEX agent_instances_workspace_history_idx
  ON agent_instances (tenant_id,owner_subject_id,workspace_id,launch_requested_at DESC,id);

CREATE INDEX agent_instances_active_reconciliation_idx
  ON agent_instances (tenant_id,workspace_id,access_generation,agent_catalog_id,status)
  WHERE status IN ('starting','running');

CREATE INDEX agent_instances_provider_runtime_idx
  ON agent_instances (tenant_id,provider_runtime_id)
  WHERE provider_runtime_id IS NOT NULL;
