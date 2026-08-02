-- id: 01KZ1D25Q454AJ8Y2H1ZP8JGB7
-- depends-on: 01KZ18F093A12HFFKCZ0NDNXYD

-- Bind an administrator's tool decision to the definition they reviewed.
-- Existing rows deliberately start with no digests, so older allow policies
-- remain distinguishable from a review of a current provider definition.
ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS tool_definition_hashes JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE connector_registry
  DROP CONSTRAINT IF EXISTS connector_registry_tool_definition_hashes_object;

ALTER TABLE connector_registry
  ADD CONSTRAINT connector_registry_tool_definition_hashes_object
  CHECK (jsonb_typeof(tool_definition_hashes) = 'object');

-- A permit can cover several HTTPS origins, but every row is tenant-owned so
-- a tenant may only delete its own temporary discovery exception. The global
-- egress lookup intentionally sees only unexpired destinations, never tenant
-- identifiers or connector credentials.
CREATE TABLE IF NOT EXISTS connector_discovery_egress_permits (
  id UUID NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 128),
  origin TEXT NOT NULL CHECK (char_length(origin) BETWEEN 1 AND 2048 AND origin = btrim(origin)),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id,origin),
  CONSTRAINT connector_discovery_egress_permits_expiry_after_create
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);

-- Supports the global active-permit lookup without scanning expired entries.
CREATE INDEX IF NOT EXISTS connector_discovery_egress_permits_expiry_idx
  ON connector_discovery_egress_permits (expires_at,origin);
