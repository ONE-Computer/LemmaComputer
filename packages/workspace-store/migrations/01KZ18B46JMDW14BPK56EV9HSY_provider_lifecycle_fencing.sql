-- id: 01KZ18B46JMDW14BPK56EV9HSY
-- depends-on: 01KYYCNT4QCA6S1EMCK79AVTZD

-- A provider route is mutated outside PostgreSQL, so its desired state and
-- generation must remain durable even when the provider_settings record is
-- deleted or LiteLLM cleanup is retried later.
CREATE TABLE provider_lifecycle_fences (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'glm', 'bedrock')),
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('active', 'disabled', 'deleted')),
  pending_cleanup_model_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(pending_cleanup_model_ids) = 'array'
    AND jsonb_array_length(pending_cleanup_model_ids) <= 16
  ),
  reconciliation_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (reconciliation_status IN ('not_required', 'pending')),
  reconciliation_error_code TEXT NULL CHECK (char_length(reconciliation_error_code) <= 96),
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE INDEX provider_lifecycle_fences_pending_reconciliation_idx
  ON provider_lifecycle_fences (updated_at)
  WHERE reconciliation_status = 'pending';

-- The primary key makes a lifecycle phase idempotently auditable: retries can
-- observe or re-record the same phase without producing conflicting history.
CREATE TABLE provider_lifecycle_events (
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 0),
  event_key TEXT NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 96),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('active', 'disabled', 'deleted')),
  actor_user_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, generation, event_key),
  FOREIGN KEY (tenant_id, provider)
    REFERENCES provider_lifecycle_fences (tenant_id, provider)
    ON DELETE CASCADE
);
