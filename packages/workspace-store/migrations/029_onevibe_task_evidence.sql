CREATE TABLE IF NOT EXISTS onevibe_task_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS onevibe_task_runs_owner_idx
  ON onevibe_task_runs (tenant_id, subject_id, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS onevibe_task_events (
  task_id uuid NOT NULL REFERENCES onevibe_task_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  kind text NOT NULL CHECK (kind IN ('system','chat','tool','approval','workspace-frame','artifact')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  previous_event_hash text CHECK (previous_event_hash IS NULL OR previous_event_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, sequence)
);
