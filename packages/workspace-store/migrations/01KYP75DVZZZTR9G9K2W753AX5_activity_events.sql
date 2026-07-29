-- id: 01KYP75DVZZZTR9G9K2W753AX5
-- depends-on: 01KYMCGYEEWFJJ8C91S2NE3YD2

CREATE TABLE activity_events (
  event_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_catalog_id text NOT NULL,
  session_id text NOT NULL,
  turn_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 0 AND 100000),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'plan','progress','provider_summary','tool','web_action','source',
    'approval','computer_action','notice','error','terminal'
  )),
  state text NOT NULL CHECK (state IN (
    'pending','running','requires_action','completed','failed','cancelled'
  )),
  provenance text NOT NULL CHECK (provenance IN (
    'deterministic_system','provider_generated','tool'
  )),
  visibility text NOT NULL CHECK (visibility = 'user'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, workspace_id, agent_catalog_id, session_id, turn_id, sequence),
  UNIQUE (tenant_id, subject_id, workspace_id, agent_catalog_id, session_id, turn_id, dedupe_key)
);

CREATE INDEX activity_events_owned_turn_replay_idx
  ON activity_events (
    tenant_id, subject_id, workspace_id, agent_catalog_id, session_id, turn_id, sequence
  );

CREATE INDEX activity_events_retention_idx
  ON activity_events (created_at);
