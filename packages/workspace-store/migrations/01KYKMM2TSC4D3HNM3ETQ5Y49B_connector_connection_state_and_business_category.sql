-- id: 01KYKMM2TSC4D3HNM3ETQ5Y49B
-- depends-on: 01KYK8E3ZXZDZ2XS2367HWHMA7

-- Expand the catalog taxonomy without changing existing connector records.
ALTER TABLE connector_registry
  DROP CONSTRAINT IF EXISTS connector_registry_category_check;

ALTER TABLE connector_registry
  ADD CONSTRAINT connector_registry_category_check
  CHECK (category IN ('Productivity','Developer tools','Business','Communication','Data and analytics','Other'));

-- This index records only a person's explicit connection state and timestamps.
-- Provider OAuth credentials and account data remain exclusively in LiteLLM.
CREATE TABLE IF NOT EXISTS connector_connection_state (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('connected','expired')),
  connected_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id, connector_id),
  FOREIGN KEY (tenant_id, connector_id) REFERENCES connector_registry (tenant_id, id) ON DELETE CASCADE
);
