CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_catalog_id text NOT NULL CHECK (agent_catalog_id IN ('hermes-claw','claude-cli','codex-cli')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  prompt_ciphertext text NOT NULL,
  cron_expression text NOT NULL CHECK (char_length(cron_expression) BETWEEN 9 AND 120),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 100),
  state text NOT NULL CHECK (state IN ('enabled','paused')),
  next_run_at timestamptz NULL,
  last_run_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedules_owner_idx
  ON schedules (tenant_id, subject_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS schedules_due_idx
  ON schedules (next_run_at, id)
  WHERE state = 'enabled' AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS schedule_runs (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed','running','succeeded','failed','skipped')),
  lease_token uuid NULL,
  lease_expires_at timestamptz NULL,
  session_id text NULL,
  failure_code text NULL,
  failure_summary text NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx
  ON schedule_runs (schedule_id, scheduled_for DESC);

CREATE INDEX IF NOT EXISTS schedule_runs_claim_idx
  ON schedule_runs (state, lease_expires_at)
  WHERE state = 'claimed';
