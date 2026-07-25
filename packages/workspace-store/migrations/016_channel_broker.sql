CREATE TABLE IF NOT EXISTS channel_credentials (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  kind text NOT NULL CHECK (kind = 'telegram_bot_token'),
  credential_ciphertext text NOT NULL,
  credential_key_version integer NOT NULL CHECK (credential_key_version > 0),
  version integer NOT NULL CHECK (version > 0),
  fingerprint text NOT NULL,
  display_name text NOT NULL,
  bot_username text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, fingerprint)
);

CREATE INDEX IF NOT EXISTS channel_credentials_owner_idx
  ON channel_credentials (tenant_id, subject_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS channel_connections (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  adapter text NOT NULL CHECK (adapter = 'telegram'),
  credential_id uuid NOT NULL UNIQUE REFERENCES channel_credentials(id) ON DELETE CASCADE,
  allowed_user_ids jsonb NOT NULL,
  default_agent_id text NOT NULL CHECK (default_agent_id IN ('hermes-claw','claude-cli','codex-cli')),
  allow_agent_switch boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active')),
  telegram_update_offset bigint NOT NULL DEFAULT 0 CHECK (telegram_update_offset >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, adapter),
  CONSTRAINT channel_connections_allowed_user_ids CHECK (
    jsonb_typeof(allowed_user_ids) = 'array'
    AND jsonb_array_length(allowed_user_ids) BETWEEN 1 AND 20
  )
);

CREATE INDEX IF NOT EXISTS channel_connections_active_idx
  ON channel_connections (adapter, state, updated_at);

CREATE TABLE IF NOT EXISTS channel_sender_routes (
  connection_id uuid NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  sender_id text NOT NULL CHECK (sender_id ~ '^[0-9]{1,20}$'),
  agent_catalog_id text NOT NULL CHECK (agent_catalog_id IN ('hermes-claw','claude-cli','codex-cli')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, sender_id)
);

CREATE TABLE IF NOT EXISTS channel_sessions (
  connection_id uuid NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  sender_id text NOT NULL CHECK (sender_id ~ '^[0-9]{1,20}$'),
  agent_catalog_id text NOT NULL CHECK (agent_catalog_id IN ('hermes-claw','claude-cli','codex-cli')),
  session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, sender_id, agent_catalog_id)
);

CREATE TABLE IF NOT EXISTS channel_updates (
  connection_id uuid NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  update_id bigint NOT NULL CHECK (update_id >= 0),
  sender_id text NOT NULL CHECK (sender_id ~ '^[0-9]{1,20}$'),
  state text NOT NULL CHECK (state IN ('reserved','dispatched','delivered','rejected','failed')),
  failure_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, update_id)
);
