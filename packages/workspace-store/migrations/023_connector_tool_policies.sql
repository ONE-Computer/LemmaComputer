ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS tool_policies JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE connector_registry
  DROP CONSTRAINT IF EXISTS connector_registry_tool_policies_object;

ALTER TABLE connector_registry
  ADD CONSTRAINT connector_registry_tool_policies_object
  CHECK (jsonb_typeof(tool_policies) = 'object');
