ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS members_can_manage BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS access_policy_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS access_policy_updated_by TEXT;

ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS access_policy_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE connector_registry
  DROP CONSTRAINT IF EXISTS connector_registry_access_policy_version_positive;

ALTER TABLE connector_registry
  ADD CONSTRAINT connector_registry_access_policy_version_positive
  CHECK (access_policy_version > 0);
