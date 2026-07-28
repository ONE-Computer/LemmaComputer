-- id: 01KYK85KWH0W3JV2AAW7ZCACNA
-- depends-on: 028

-- Safe tenant-scoped metadata for LiteLLM-managed provider routes. Raw
-- provider keys remain encrypted in LiteLLM's database and are never stored
-- here.
CREATE TABLE provider_settings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(model_ids) = 'array' AND jsonb_array_length(model_ids) <= 8),
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
  credential_fingerprint TEXT NULL CHECK (credential_fingerprint ~ '^fp_[a-zA-Z0-9_-]{8,92}$'),
  last_tested_at TIMESTAMPTZ NULL,
  last_error_code TEXT NULL CHECK (char_length(last_error_code) <= 96),
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE INDEX provider_settings_tenant_state_idx ON provider_settings (tenant_id, state);
