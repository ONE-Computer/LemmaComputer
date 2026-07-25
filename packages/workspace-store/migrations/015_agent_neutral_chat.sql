ALTER TABLE sandbox_settings
  DROP CONSTRAINT IF EXISTS sandbox_settings_agent_ids_array;

ALTER TABLE sandbox_settings
  ADD CONSTRAINT sandbox_settings_agent_ids_array
  CHECK (
    jsonb_typeof(agent_ids) = 'array'
    AND jsonb_array_length(agent_ids) BETWEEN 1 AND 5
  );
